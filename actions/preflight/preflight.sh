#!/usr/bin/env bash
# The checks before a deployment, and the record of the tested versions.
#
# The actions pipeline-info and preflight call this script. The README of this repository explains the rules.
#
# Usage:
#   preflight.sh validate [pipeline.json]   Checks the file and prints the name of the service.
#   preflight.sh tested-with                Prints the JSON of the tested versions (see below).
#   preflight.sh check                      Reads the deployed versions from SSM and compares them. Needs AWS access.
#
# Settings come from environment variables:
#   validate:    PF_PIPELINE_FILE (default pipeline.json)
#   tested-with: PF_TAG, PF_VERSION, PF_SERVICE, PF_COMMIT, PF_E2E_COMMIT, PF_WEB, PF_CATALOGUE, PF_ACCOUNT, PF_CORE
#   check:       PF_ENVIRONMENT (test, staging or production), PF_PIPELINE_FILE, PF_VERSION,
#                PF_TESTED_WITH (the JSON text of tested-with, may be empty), PF_MODE (release or redeploy),
#                PF_REQUIRES_OVERRIDE (a JSON object that replaces "requires", for a dry run)
# GitHub sets GITHUB_OUTPUT and GITHUB_STEP_SUMMARY.
#
# The script uses no associative arrays, so it also runs with the bash 3.2 of macOS.
set -euo pipefail

readonly DEFAULT_PIPELINE_FILE='pipeline.json'
readonly VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+$'
readonly NAME_PATTERN='^[a-z][a-z0-9-]{0,30}$'
# The applications that the E2E suite records, in the order of the tables.
readonly APPLICATIONS='web catalogue account core'

# ---------------------------------------------------------------------------
# Pure functions. They call no AWS API. test.sh tests them.
# ---------------------------------------------------------------------------

# valid_version <text>   A version has the form 1.2.3.
valid_version() {
  [[ "${1:-}" =~ $VERSION_PATTERN ]]
}

# compare_versions <a> <b>   Prints -1 if a is older than b, 0 if equal, 1 if a is newer. Both must be valid.
# Bash reads a number with a leading zero as octal. The prefix 10# makes the comparison decimal.
compare_versions() {
  local left right i a b
  local IFS=.
  # shellcheck disable=SC2206 # the split on dots is the aim
  left=($1)
  # shellcheck disable=SC2206
  right=($2)
  for i in 0 1 2; do
    a=$((10#${left[i]}))
    b=$((10#${right[i]}))
    if ((a < b)); then
      echo -1
      return 0
    fi
    if ((a > b)); then
      echo 1
      return 0
    fi
  done
  echo 0
}

# split_comparator <comparator>   Prints "<operator> <version>". Returns 1 if the comparator is wrong.
# The operators are >=, >, <=, < and =. A bare version means =.
split_comparator() {
  local text="$1" operator version
  case "$text" in
    '>='*) operator='>=' ;;
    '<='*) operator='<=' ;;
    '>'*) operator='>' ;;
    '<'*) operator='<' ;;
    '='*) operator='=' ;;
    *) operator='' ;;
  esac
  version="${text#"$operator"}"
  valid_version "$version" || return 1
  echo "${operator:-=} $version"
}

# valid_range <range>   A range is one or more comparators with spaces between them. All of them must hold.
valid_range() {
  local range="${1:-}" comparator count=0
  for comparator in $range; do
    split_comparator "$comparator" > /dev/null || return 1
    count=$((count + 1))
  done
  ((count > 0))
}

# satisfies <version> <range>   Returns 0 if the version is inside the range. Returns 1 if not, 2 if the range is wrong.
satisfies() {
  local version="$1" range="$2" comparator parsed operator limit result
  valid_range "$range" || return 2
  for comparator in $range; do
    parsed="$(split_comparator "$comparator")"
    operator="${parsed%% *}"
    limit="${parsed#* }"
    result="$(compare_versions "$version" "$limit")"
    case "$operator" in
      '>=') ((result >= 0)) || return 1 ;;
      '>') ((result > 0)) || return 1 ;;
      '<=') ((result <= 0)) || return 1 ;;
      '<') ((result < 0)) || return 1 ;;
      '=') ((result == 0)) || return 1 ;;
    esac
  done
  return 0
}

# repository_of <service>   The repository that holds the service. The lab names it lab-svc-<name>, except for web.
repository_of() {
  if [[ "$1" == web ]]; then
    echo 'lab-web'
  else
    echo "lab-svc-$1"
  fi
}

# lookup <name> <map>   A map is text with one "name<TAB>value" pair on each line. Prints the value, or nothing.
lookup() {
  awk -F'\t' -v name="$1" '$1 == name { print $2; exit }' <<< "$2"
}

# self_verdict <deployed> <release>
# Compares the version in the environment with this release. Prints one word:
#   first      the environment has no version of this service
#   newer      this release is newer than the environment: a normal release
#   same       the environment runs this release: a run again
#   superseded the environment runs a newer version: this release is old and must not deploy
self_verdict() {
  local deployed="$1" release="$2"
  if [[ -z "$deployed" ]]; then
    echo first
    return 0
  fi
  case "$(compare_versions "$release" "$deployed")" in
    1) echo newer ;;
    0) echo same ;;
    *) echo superseded ;;
  esac
}

# provider_verdict <deployed> <range>   Prints missing, too-old or ok.
provider_verdict() {
  local deployed="$1" range="$2"
  if [[ -z "$deployed" ]]; then
    echo missing
  elif satisfies "$deployed" "$range"; then
    echo ok
  else
    echo too-old
  fi
}

# neighbour_verdict <tested> <deployed> <accepted range, may be empty>
# Compares the version in the environment with the version that the E2E suite tested. Prints one word:
#   absent    the environment has no version of this neighbour: there is nothing to compare
#   same      the same version as in the tested set
#   newer     the environment is newer than the tested set
#   accepted  older than the tested set, but inside the range of pipeline.json
#   older     older than the tested set, and no range accepts it: the release must not go on
neighbour_verdict() {
  local tested="$1" deployed="$2" range="${3:-}"
  if [[ -z "$deployed" ]]; then
    echo absent
    return 0
  fi
  case "$(compare_versions "$deployed" "$tested")" in
    0) echo same ;;
    1) echo newer ;;
    *)
      if [[ -n "$range" ]] && satisfies "$deployed" "$range"; then
        echo accepted
      else
        echo older
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# The file pipeline.json
# ---------------------------------------------------------------------------

# validate_pipeline <file>
# Reads the file with one call of jq. Sets these variables, and returns 1 if there is a problem:
#   PROBLEMS             one line of text for each problem
#   PIPELINE_SERVICE     the name of the service
#   PIPELINE_REQUIRES    one "service<TAB>range" line for each provider that the service needs
#   PIPELINE_COMPATIBLE  one "service<TAB>range" line for each neighbour that may be older
PROBLEMS=''
PIPELINE_SERVICE=''
PIPELINE_REQUIRES=''
PIPELINE_COMPATIBLE=''

# The program of jq gives one line for each fact: K key, S service, T section and its type, E section, service and range.
# shellcheck disable=SC2016 # the dollar signs are variables of jq
readonly PIPELINE_FACTS='
  if type != "object" then "N"
  else
    (keys[] | "K\t" + .),
    ("S\t" + (if (.service | type) == "string" then .service else "" end)),
    (["requires", "compatible"][] as $s | "T\t" + $s + "\t" + ((.[$s] // {}) | type)),
    (["requires", "compatible"][] as $s | (.[$s] // {}) | select(type == "object") | to_entries[]
      | "E\t" + $s + "\t" + .key + "\t" + (.value | if type == "string" then . else "(not text)" end))
  end'

validate_pipeline() {
  local file="$1" facts kind a b c problems=''
  PROBLEMS=''
  PIPELINE_SERVICE=''
  PIPELINE_REQUIRES=''
  PIPELINE_COMPATIBLE=''
  if [[ ! -f "$file" ]]; then
    PROBLEMS="$file does not exist. A service repository needs this file. The README of lab-workflows describes its format."
    return 1
  fi
  if ! facts="$(jq -r "$PIPELINE_FACTS" "$file" 2> /dev/null)"; then
    PROBLEMS="$file is not valid JSON."
    return 1
  fi
  if [[ "$facts" == N ]]; then
    PROBLEMS="$file is not a JSON object."
    return 1
  fi

  while IFS=$'\t' read -r kind a b c; do
    case "$kind" in
      K)
        case "$a" in
          service | requires | compatible) ;;
          *) problems+="$file has the unknown key \"$a\". The keys are service, requires and compatible."$'\n' ;;
        esac
        ;;
      S)
        PIPELINE_SERVICE="$a"
        if [[ ! "$a" =~ $NAME_PATTERN ]]; then
          problems+="$file needs \"service\": a name with lower case letters, digits and hyphens, for example \"catalogue\"."$'\n'
        fi
        ;;
      T)
        if [[ "$b" != object ]]; then
          problems+="\"$a\" in $file must be an object. Each key is a service and each value is a range."$'\n'
        fi
        ;;
      E)
        if [[ ! "$b" =~ $NAME_PATTERN ]]; then
          problems+="\"$a\" in $file has the bad service name \"$b\"."$'\n'
        elif [[ "$b" == "$PIPELINE_SERVICE" ]]; then
          problems+="\"$a\" in $file names the service itself (\"$b\")."$'\n'
        fi
        if ! valid_range "$c"; then
          problems+="\"$a\" in $file: the range \"$c\" of \"$b\" is wrong. Use comparators such as \">=0.5.0\" or \">=0.5.0 <1.0.0\"."$'\n'
        elif [[ "$a" == requires ]]; then
          PIPELINE_REQUIRES+="$b"$'\t'"$c"$'\n'
        else
          PIPELINE_COMPATIBLE+="$b"$'\t'"$c"$'\n'
        fi
        ;;
    esac
  done <<< "$facts"

  if [[ -n "$problems" ]]; then
    PROBLEMS="${problems%$'\n'}"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# The record of the tested versions
# ---------------------------------------------------------------------------

# tested_with_json
# Builds the JSON from the variables. It fails if a version is missing, if a text is not a version,
# or if the version of the service itself is not the version of the release.
tested_with_json() {
  local service="${PF_SERVICE:-}" version="${PF_VERSION:-}" tag="${PF_TAG:-}" name value problems=0 own=''
  if [[ ! "$service" =~ $NAME_PATTERN ]]; then
    echo "::error::The name of the service is missing or wrong (\"$service\")." >&2
    return 1
  fi
  if ! valid_version "$version"; then
    echo "::error::The version of the release is missing or wrong (\"$version\")." >&2
    return 1
  fi
  for name in $APPLICATIONS; do
    case "$name" in
      web) value="${PF_WEB:-}" ;;
      catalogue) value="${PF_CATALOGUE:-}" ;;
      account) value="${PF_ACCOUNT:-}" ;;
      core) value="${PF_CORE:-}" ;;
    esac
    if ! valid_version "$value"; then
      echo "::error::The E2E run did not record a version of $name (\"$value\"). The tested set is not complete." >&2
      problems=$((problems + 1))
    fi
    [[ "$name" == "$service" ]] && own="$value"
  done
  ((problems == 0)) || return 1

  if [[ -n "$own" && "$own" != "$version" ]]; then
    echo "::error::The E2E run tested $service $own, but this release is $version. The suite did not test this release." >&2
    return 1
  fi

  jq -n -c \
    --arg tag "$tag" --arg service "$service" --arg version "$version" \
    --arg commit "${PF_COMMIT:-}" --arg e2eCommit "${PF_E2E_COMMIT:-}" \
    --arg web "${PF_WEB}" --arg catalogue "${PF_CATALOGUE}" --arg account "${PF_ACCOUNT}" --arg core "${PF_CORE}" \
    '{release: $tag, service: $service, version: $version, commit: $commit, e2eCommit: $e2eCommit,
      versions: {web: $web, catalogue: $catalogue, account: $account, core: $core}}'
}

# The program of jq for the tested set: R is the release, V is a service and its version, X means a wrong shape.
# shellcheck disable=SC2016
readonly TESTED_FACTS='
  if (.versions | type) != "object" then "X"
  else ("R\t" + (.release // "")), (.versions | to_entries[] | "V\t" + .key + "\t" + (.value | tostring)) end'

# ---------------------------------------------------------------------------
# The AWS call. A test replaces the command "aws".
# ---------------------------------------------------------------------------

# fetch_deployed <service>...
# Prints "service<TAB>version" for each service that has the parameter /lab/<service>/version.
# A service with no parameter is not printed. Returns 1 if AWS gives an error.
fetch_deployed() {
  local names=() name output
  for name in "$@"; do
    names+=("/lab/${name}/version")
  done
  output="$(aws ssm get-parameters --names "${names[@]}" --query 'Parameters[].[Name,Value]' --output text)" || return 1
  if [[ -z "$output" || "$output" == 'None' ]]; then
    return 0
  fi
  awk -F'\t' 'NF == 2 { name = $1; sub("^/lab/", "", name); sub("/version$", "", name); print name "\t" $2 }' <<< "$output"
}

# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------

# The table of the summary. The variables ROWS, NOTICES and FAILURES collect the result.
ROWS=''
NOTICES=''
FAILURES=0

# add_row <check> <service> <needed> <found> <result text>
add_row() {
  ROWS+="| $1 | $2 | $3 | $4 | $5 |"$'\n'
}

fail() {
  FAILURES=$((FAILURES + 1))
  echo "::error title=$1::$2"
}

# notice <title> <text>
notice() {
  NOTICES+="- $2"$'\n'
  echo "::notice title=$1::$2"
}

# write_summary <environment> <service> <version> <mode>
write_summary() {
  local environment="$1" service="$2" version="$3" mode="$4" title text release=''
  if ((FAILURES > 0)); then title="stopped, $FAILURES check(s) failed"; else title='passed'; fi
  [[ -n "$version" ]] && release="release \`${version}\`, "
  text="### Checks before the deployment to ${environment}: ${title}"$'\n\n'
  text+="Service \`${service}\`, ${release}mode \`${mode}\`."$'\n\n'
  text+='| Check | Service | Needed or tested | In the environment | Result |'$'\n'
  text+='| --- | --- | --- | --- | --- |'$'\n'
  text+="$ROWS"
  if [[ -n "$NOTICES" ]]; then
    text+=$'\n'"$NOTICES"
  fi
  printf '%s\n' "$text"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$text" >> "$GITHUB_STEP_SUMMARY"
  fi
}

check() {
  local environment="${PF_ENVIRONMENT:-}" file="${PF_PIPELINE_FILE:-$DEFAULT_PIPELINE_FILE}" version="${PF_VERSION:-}"
  local tested="${PF_TESTED_WITH:-}" mode="${PF_MODE:-release}" override="${PF_REQUIRES_OVERRIDE:-}"
  local service requires compatible deployed own names facts kind a b
  local tested_release='' tested_versions='' name range found verdict accepted tested_version line

  case "$environment" in
    test | staging | production) ;;
    *)
      echo "::error::PF_ENVIRONMENT must be test, staging or production, but it is \"$environment\"." >&2
      return 1
      ;;
  esac
  case "$mode" in
    release | redeploy) ;;
    *)
      echo "::error::PF_MODE must be release or redeploy, but it is \"$mode\"." >&2
      return 1
      ;;
  esac
  # A dry run gives no version. Then the check of the release itself is left out.
  if [[ -n "$version" ]] && ! valid_version "$version"; then
    echo "::error::PF_VERSION must have the form 1.2.3, but it is \"$version\"." >&2
    return 1
  fi

  if ! validate_pipeline "$file"; then
    while IFS= read -r line; do
      echo "::error file=${file}::${line}"
    done <<< "$PROBLEMS"
    return 1
  fi
  service="$PIPELINE_SERVICE"
  requires="$PIPELINE_REQUIRES"
  compatible="$PIPELINE_COMPATIBLE"

  if [[ -n "$override" ]]; then
    if ! requires="$(jq -r 'if type == "object" then to_entries[] | [.key, (.value | tostring)] | @tsv else error("not an object") end' <<< "$override" 2> /dev/null)"; then
      echo "::error::PF_REQUIRES_OVERRIDE must be a JSON object. Each key is a service and each value is a range." >&2
      return 1
    fi
    while IFS=$'\t' read -r name range; do
      [[ -n "$name" ]] || continue
      if [[ ! "$name" =~ $NAME_PATTERN ]] || ! valid_range "$range"; then
        echo "::error::PF_REQUIRES_OVERRIDE has a bad service name or range (\"$name\", \"$range\")." >&2
        return 1
      fi
    done <<< "$requires"
  fi

  if [[ -n "$tested" ]]; then
    if ! facts="$(jq -r "$TESTED_FACTS" <<< "$tested" 2> /dev/null)" || [[ "$facts" == X || -z "$facts" ]]; then
      echo "::error::The record of the tested versions is not valid JSON with a \"versions\" object." >&2
      return 1
    fi
    while IFS=$'\t' read -r kind a b; do
      case "$kind" in
        R) tested_release="$a" ;;
        V) tested_versions+="$a"$'\t'"$b"$'\n' ;;
      esac
    done <<< "$facts"
    found="$(lookup "$service" "$tested_versions")"
    if [[ -n "$version" && -n "$found" && "$found" != "$version" ]]; then
      echo "::error title=Wrong record of tested versions::The record belongs to $service $found, but this deployment is $service $version." >&2
      return 1
    fi
  fi

  # The names to read: the service itself, its providers, its neighbours with a range, and the tested set.
  names="$(
    {
      echo "$service"
      cut -f 1 <<< "$requires"
      cut -f 1 <<< "$compatible"
      cut -f 1 <<< "$tested_versions"
    } | awk 'NF' | sort -u
  )"
  # shellcheck disable=SC2086 # the names have no spaces
  if ! deployed="$(fetch_deployed $names)"; then
    echo "::error::The versions in $environment could not be read from SSM. This is not a result of the check. Check the AWS login and the permission ssm:GetParameters on /lab/*." >&2
    return 1
  fi
  own="$(lookup "$service" "$deployed")"

  # 1. This release against the environment: the environment must not go back.
  if [[ -n "$version" ]]; then
    verdict="$(self_verdict "$own" "$version")"
    case "$verdict" in
      first) add_row 'this release' "$service" "$version" 'none' 'ok: the first deployment' ;;
      newer) add_row 'this release' "$service" "$version" "$own" 'ok: newer than the environment' ;;
      same) add_row 'this release' "$service" "$version" "$own" 'ok: the same version (a run again)' ;;
      superseded)
        if [[ "$mode" == release ]]; then
          add_row 'this release' "$service" "$version" "$own" 'FAILED: the environment is newer'
          fail 'Release superseded' "$environment runs $service $own. This release is $service $version, which is older. A deployment would move $environment back. This release stops, and $environment keeps $own."
        else
          add_row 'this release' "$service" "$version" "$own" 'ok: older on purpose (a redeploy)'
        fi
        ;;
    esac
  fi

  # 2. The providers that the service needs (issue 16).
  while IFS=$'\t' read -r name range; do
    [[ -n "$name" ]] || continue
    found="$(lookup "$name" "$deployed")"
    verdict="$(provider_verdict "$found" "$range")"
    case "$verdict" in
      ok) add_row 'provider' "$name" "$range" "$found" 'ok' ;;
      too-old)
        add_row 'provider' "$name" "$range" "$found" 'FAILED: too old'
        fail 'Provider too old' "$service needs $name $range, but $environment runs $name $found. Release $name to $environment first (repository $(repository_of "$name")), then run this job again."
        ;;
      missing)
        add_row 'provider' "$name" "$range" 'none' 'FAILED: not deployed'
        fail 'Provider missing' "$service needs $name $range, but $environment has no version of $name (the SSM parameter /lab/$name/version does not exist). Deploy $name to $environment first (repository $(repository_of "$name")). If $name runs there already, release it once with a stack that publishes its version."
        ;;
    esac
  done <<< "$requires"

  # 3. The tested set against the environment (issue 21).
  if [[ -n "$tested" ]]; then
    while IFS=$'\t' read -r name tested_version; do
      [[ -n "$name" && "$name" != "$service" ]] || continue
      found="$(lookup "$name" "$deployed")"
      accepted="$(lookup "$name" "$compatible")"
      [[ -n "$accepted" ]] || accepted="$(lookup "$name" "$requires")"
      verdict="$(neighbour_verdict "$tested_version" "$found" "$accepted")"
      case "$verdict" in
        same) add_row 'tested together' "$name" "$tested_version" "$found" 'ok: the same version' ;;
        newer)
          add_row 'tested together' "$name" "$tested_version" "$found" 'ok: newer than tested'
          notice 'Newer neighbour' "$environment runs $name $found, which is newer than the $tested_version that the suite tested with $service ${version:-this release}."
          ;;
        accepted) add_row 'tested together' "$name" "$tested_version" "$found" "ok: older, but pipeline.json accepts $accepted" ;;
        absent)
          add_row 'tested together' "$name" "$tested_version" 'none' 'ok: not deployed, nothing to compare'
          notice 'Neighbour not deployed' "$environment has no version of $name. The suite tested with $name $tested_version, but there is nothing to compare."
          ;;
        older)
          if [[ "$mode" == release ]]; then
            add_row 'tested together' "$name" "$tested_version" "$found" 'FAILED: missing release'
            fail 'Missing release' "$name $tested_version was in the set that the E2E suite tested with $service ${version:-this release} (release ${tested_release:-unknown} of $service), but $environment runs $name $found. Release $name $tested_version to $environment first (repository $(repository_of "$name")), then run this job again. Or add a range for $name to pipeline.json, if $service works with the older version."
          else
            add_row 'tested together' "$name" "$tested_version" "$found" 'warning: older than tested (a redeploy does not stop)'
            notice 'Older neighbour' "$environment runs $name $found, which is older than the $tested_version of the tested set. A redeploy does not stop for this."
          fi
          ;;
      esac
    done <<< "$tested_versions"
  elif [[ "$mode" == release && "$environment" != test ]]; then
    # In Test there is no record yet: the E2E suite runs after the deployment to Test and makes the record.
    notice 'No tested set' 'No record of tested versions exists for this release, so the set was not compared.'
  fi

  write_summary "$environment" "$service" "$version" "$mode"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      echo "previous-version=${own}"
      if ((FAILURES == 0)); then echo 'result=pass'; else echo 'result=fail'; fi
    } >> "$GITHUB_OUTPUT"
  fi
  ((FAILURES == 0))
}

main() {
  case "${1:-}" in
    validate)
      local file="${2:-${PF_PIPELINE_FILE:-$DEFAULT_PIPELINE_FILE}}" line
      if ! validate_pipeline "$file"; then
        while IFS= read -r line; do
          echo "::error file=${file}::${line}"
        done <<< "$PROBLEMS"
        return 1
      fi
      echo "$PIPELINE_SERVICE"
      ;;
    tested-with) tested_with_json ;;
    check) check ;;
    *)
      echo "usage: preflight.sh validate [file] | tested-with | check" >&2
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
