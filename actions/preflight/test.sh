#!/usr/bin/env bash
# Tests for preflight.sh. Run: bash actions/preflight/test.sh   (it needs jq)
#
# Part 1 tests the pure functions: versions, ranges and the verdicts.
# Part 2 tests the file pipeline.json and the record of the tested versions.
# Part 3 tests the whole check against a fake "aws" command.
# The tests never call AWS and never wait.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# On Windows, jq.exe ends each line with CR LF. The runner of GitHub does not. This function strips the CR,
# so the tests give the same result in both places. "export -f" lets the scripts that the tests start use it too.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  jq() { command jq "$@" | tr -d '\r'; }
  export -f jq
fi
# shellcheck source=actions/preflight/preflight.sh
source "$here/preflight.sh"

failures=0

check_equal() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "ok    $name"
  else
    echo "FAIL  $name: expected \"$expected\", got \"$actual\""
    failures=$((failures + 1))
  fi
}

# contains <name> <text that must be in the output> <output>
contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "ok    $name"
  else
    echo "FAIL  $name: \"$needle\" is not in the output:"
    while IFS= read -r line; do
      echo "        $line"
    done <<< "$haystack"
    failures=$((failures + 1))
  fi
}

# lacks <name> <text that must not be in the output> <output>
lacks() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "ok    $name"
  else
    echo "FAIL  $name: \"$needle\" is in the output"
    failures=$((failures + 1))
  fi
}

if ! command -v jq > /dev/null; then
  echo 'FAIL  jq is not installed. These tests need it.'
  exit 1
fi

# --- Part 1: the pure functions ---

echo '--- versions'

check_equal 'a version has three numbers' 'ok' "$(valid_version 1.2.3 && echo ok)"
check_equal 'a version with a leading zero is still a version' 'ok' "$(valid_version 0.05.1 && echo ok)"
check_equal 'two numbers are not a version' 'no' "$(valid_version 1.2 || echo no)"
check_equal 'a prerelease is not a version' 'no' "$(valid_version 1.2.3-dev || echo no)"
check_equal 'text is not a version' 'no' "$(valid_version latest || echo no)"
check_equal 'an empty text is not a version' 'no' "$(valid_version '' || echo no)"

check_equal 'equal versions' '0' "$(compare_versions 1.2.3 1.2.3)"
check_equal 'a newer patch' '1' "$(compare_versions 1.2.4 1.2.3)"
check_equal 'an older patch' '-1' "$(compare_versions 1.2.3 1.2.4)"
check_equal 'a newer minor beats an older patch' '1' "$(compare_versions 1.3.0 1.2.9)"
check_equal 'a newer major beats everything below' '1' "$(compare_versions 2.0.0 1.99.99)"
check_equal '0.10.0 is newer than 0.9.0, as numbers and not as text' '1' "$(compare_versions 0.10.0 0.9.0)"
check_equal 'a leading zero is decimal: 0.08.0 equals 0.8.0' '0' "$(compare_versions 0.08.0 0.8.0)"
check_equal 'a leading zero is decimal: 0.010.0 is newer than 0.9.0' '1' "$(compare_versions 0.010.0 0.9.0)"

echo '--- ranges'

check_equal 'comparator >=' '>= 0.5.0' "$(split_comparator '>=0.5.0')"
check_equal 'comparator >' '> 0.5.0' "$(split_comparator '>0.5.0')"
check_equal 'comparator <=' '<= 1.0.0' "$(split_comparator '<=1.0.0')"
check_equal 'comparator <' '< 1.0.0' "$(split_comparator '<1.0.0')"
check_equal 'comparator =' '= 1.0.0' "$(split_comparator '=1.0.0')"
check_equal 'a bare version means =' '= 1.0.0' "$(split_comparator '1.0.0')"
check_equal 'a comparator with a bad version fails' 'no' "$(split_comparator '>=1.0' > /dev/null || echo no)"
check_equal 'a caret range is not supported' 'no' "$(split_comparator '^1.0.0' > /dev/null || echo no)"

check_equal 'a range with one comparator is valid' 'ok' "$(valid_range '>=0.5.0' && echo ok)"
check_equal 'a range with two comparators is valid' 'ok' "$(valid_range '>=0.5.0 <1.0.0' && echo ok)"
check_equal 'an empty range is not valid' 'no' "$(valid_range '' || echo no)"
check_equal 'a range with a bad comparator is not valid' 'no' "$(valid_range '>=0.5.0 latest' || echo no)"

check_equal '>= accepts the limit' 'ok' "$(satisfies 0.5.0 '>=0.5.0' && echo ok)"
check_equal '>= accepts a newer version' 'ok' "$(satisfies 0.6.0 '>=0.5.0' && echo ok)"
check_equal '>= refuses an older version' 'no' "$(satisfies 0.4.9 '>=0.5.0' || echo no)"
check_equal '> refuses the limit' 'no' "$(satisfies 0.5.0 '>0.5.0' || echo no)"
check_equal '> accepts a newer version' 'ok' "$(satisfies 0.5.1 '>0.5.0' && echo ok)"
check_equal '<= accepts the limit' 'ok' "$(satisfies 1.0.0 '<=1.0.0' && echo ok)"
check_equal '< refuses the limit' 'no' "$(satisfies 1.0.0 '<1.0.0' || echo no)"
check_equal '= accepts only the same version' 'no' "$(satisfies 1.0.1 '=1.0.0' || echo no)"
check_equal 'two comparators: inside' 'ok' "$(satisfies 0.9.0 '>=0.5.0 <1.0.0' && echo ok)"
check_equal 'two comparators: above' 'no' "$(satisfies 1.0.0 '>=0.5.0 <1.0.0' || echo no)"
check_equal 'two comparators: below' 'no' "$(satisfies 0.4.0 '>=0.5.0 <1.0.0' || echo no)"
check_equal 'a wrong range gives code 2' '2' "$(
  rc=0
  satisfies 1.0.0 'soon' || rc=$?
  echo "$rc"
)"

echo '--- verdicts'

check_equal 'self: no version in the environment' 'first' "$(self_verdict '' 1.0.0)"
check_equal 'self: a newer release' 'newer' "$(self_verdict 1.0.0 1.0.1)"
check_equal 'self: the same version' 'same' "$(self_verdict 1.0.0 1.0.0)"
check_equal 'self: an older release is superseded' 'superseded' "$(self_verdict 1.0.1 1.0.0)"
check_equal 'self: 0.10.0 is not older than 0.9.0' 'newer' "$(self_verdict 0.9.0 0.10.0)"

check_equal 'provider: ok' 'ok' "$(provider_verdict 0.5.1 '>=0.5.0')"
check_equal 'provider: too old' 'outside' "$(provider_verdict 0.4.0 '>=0.5.0')"
check_equal 'provider: too new for an upper bound' 'outside' "$(provider_verdict 2.0.0 '>=0.5.0 <1.0.0')"
check_equal 'provider: missing' 'missing' "$(provider_verdict '' '>=0.5.0')"

check_equal 'neighbour: absent' 'absent' "$(neighbour_verdict 0.5.2 '' '')"
check_equal 'neighbour: same' 'same' "$(neighbour_verdict 0.5.2 0.5.2 '')"
check_equal 'neighbour: newer' 'newer' "$(neighbour_verdict 0.5.2 0.5.3 '')"
check_equal 'neighbour: older with no range' 'older' "$(neighbour_verdict 0.5.2 0.5.1 '')"
check_equal 'neighbour: older but inside the range' 'accepted' "$(neighbour_verdict 0.5.2 0.5.1 '>=0.5.0')"
check_equal 'neighbour: older and outside the range' 'older' "$(neighbour_verdict 0.5.2 0.4.0 '>=0.5.0')"

echo '--- the rollback floor'

check_equal 'floor: no floor recorded' 'none' "$(floor_verdict 0.7.0 '')"
check_equal 'floor: the version equals the floor' 'ok' "$(floor_verdict 0.8.0 0.8.0)"
check_equal 'floor: the version is above the floor' 'ok' "$(floor_verdict 0.8.1 0.8.0)"
check_equal 'floor: the version is above the floor by a minor' 'ok' "$(floor_verdict 0.9.0 0.8.5)"
check_equal 'floor: the version is below the floor' 'below' "$(floor_verdict 0.7.9 0.8.0)"
check_equal 'floor: the major counts first' 'below' "$(floor_verdict 0.99.99 1.0.0)"
check_equal 'floor: 0.9.0 is below 0.10.0, as numbers and not as text' 'below' "$(floor_verdict 0.9.0 0.10.0)"
check_equal 'floor: 0.10.0 is above 0.9.0' 'ok' "$(floor_verdict 0.10.0 0.9.0)"
check_equal 'floor: a leading zero is decimal' 'ok' "$(floor_verdict 0.8.0 0.08.0)"

# The words of the refusal are part of the contract with the person who reads it. They must stay the same.
expected_refusal='Rollback refused: core 0.7.0 cannot run against the data in production. A migration changed the data in a way that an older version cannot read. The oldest version that can run is core 0.8.0 (SSM parameter /lab/core/min-rollback-version). Do not roll back to 0.7.0. Go back to 0.8.0 or newer, or fix forward with a new release. If the data itself is wrong, restore it first: see "Restore" in the README of lab-svc-core.'
check_equal 'the refusal has the exact words' "$expected_refusal" "$(rollback_refusal core 0.7.0 production 0.8.0)"
check_equal 'the refusal uses the repository of the service' \
  'Rollback refused: web 0.3.0 cannot run against the data in staging. A migration changed the data in a way that an older version cannot read. The oldest version that can run is web 0.4.0 (SSM parameter /lab/web/min-rollback-version). Do not roll back to 0.3.0. Go back to 0.4.0 or newer, or fix forward with a new release. If the data itself is wrong, restore it first: see "Restore" in the README of lab-web.' \
  "$(rollback_refusal web 0.3.0 staging 0.4.0)"

check_equal 'repository of core' 'lab-svc-core' "$(repository_of core)"
check_equal 'repository of catalogue' 'lab-svc-catalogue' "$(repository_of catalogue)"
check_equal 'repository of web' 'lab-web' "$(repository_of web)"
check_equal 'repository of flags is lab-flags, not lab-svc-flags' 'lab-flags' "$(repository_of flags)"

check_equal 'lookup finds a value' '0.5.1' "$(lookup core $'core\t0.5.1\nweb\t0.3.1')"
check_equal 'lookup finds the second line' '0.3.1' "$(lookup web $'core\t0.5.1\nweb\t0.3.1')"
check_equal 'lookup does not match a prefix' '' "$(lookup cor $'core\t0.5.1')"
check_equal 'lookup of an empty map is empty' '' "$(lookup core '')"

# --- Part 2: pipeline.json and the tested versions ---

work="$(mktemp -d)"
finished=0
exec 3>&1
trap 'rm -rf "$work"; if [[ "$finished" -ne 1 ]]; then echo "FAIL  the test script stopped before the end" >&3; fi' EXIT

write_pipeline() {
  printf '%s\n' "$1" > "$work/pipeline.json"
}

# validate <json> : prints the problems. Sets $status and $output.
validate() {
  write_pipeline "$1"
  status=0
  validate_pipeline "$work/pipeline.json" || status=$?
  output="$PROBLEMS"
}

echo '--- pipeline.json'

validate '{"service":"catalogue","requires":{"core":">=0.5.0"}}'
check_equal 'a good file is valid' '0' "$status"
check_equal 'the service name is read' 'catalogue' "$PIPELINE_SERVICE"
check_equal 'the providers are read as service and range' $'core\t>=0.5.0' "$(tr -d '\n' <<< "$PIPELINE_REQUIRES")"
validate '{"service":"core","requires":{}}'
check_equal 'a service with no providers is valid' '0' "$status"
check_equal 'a service with no providers has no requires lines' '' "$PIPELINE_REQUIRES"
validate '{"service":"core"}'
check_equal 'requires may be missing' '0' "$status"
validate '{"service":"web","requires":{"catalogue":">=0.3.0","account":">=0.3.0"},"compatible":{"core":">=0.5.0 <1.0.0"}}'
check_equal 'a file with compatible is valid' '0' "$status"
check_equal 'the compatible ranges are read' $'core\t>=0.5.0 <1.0.0' "$(tr -d '\n' <<< "$PIPELINE_COMPATIBLE")"
check_equal 'two providers are two lines' '2' "$(grep -c . <<< "$PIPELINE_REQUIRES")"
# The service flags (issue 32) has no providers, and a service may list flags as a provider.
validate '{"service":"flags","requires":{}}'
check_equal 'the file of flags with an empty requires is valid' '0' "$status"
check_equal 'the name flags is read' 'flags' "$PIPELINE_SERVICE"
check_equal 'flags has no requires lines' '' "$PIPELINE_REQUIRES"
validate '{"service":"catalogue","requires":{"core":">=0.5.0","flags":">=0.1.0"}}'
check_equal 'a service may list flags in requires' '0' "$status"
check_equal 'the range of flags is read' '>=0.1.0' "$(lookup flags "$PIPELINE_REQUIRES")"
check_equal 'the range of core is still read' '>=0.5.0' "$(lookup core "$PIPELINE_REQUIRES")"

validate '{"requires":{}}'
check_equal 'a missing service is a problem' '1' "$status"
contains 'the message asks for the service' 'needs "service"' "$output"
validate '{"service":"Catalogue"}'
check_equal 'a service name with a capital is a problem' '1' "$status"
validate '{"service":5}'
check_equal 'a service that is not text is a problem' '1' "$status"
validate '{"service":"web","require":{}}'
check_equal 'an unknown key is a problem (a typo)' '1' "$status"
contains 'the message names the unknown key' 'unknown key "require"' "$output"
validate '{"service":"web","requires":[]}'
check_equal 'requires as a list is a problem' '1' "$status"
contains 'the message says that requires must be an object' '"requires" in' "$output"
validate '{"service":"web","requires":{"core":"latest"}}'
check_equal 'a bad range is a problem' '1' "$status"
contains 'the message names the bad range' 'the range "latest" of "core" is wrong' "$output"
validate '{"service":"web","requires":{"core":5}}'
check_equal 'a range that is not text is a problem' '1' "$status"
validate '{"service":"web","requires":{"web":">=1.0.0"}}'
check_equal 'a service that requires itself is a problem' '1' "$status"
validate '{"service":"web","compatible":{"Core":">=1.0.0"}}'
check_equal 'a bad name in compatible is a problem' '1' "$status"
validate 'not json'
check_equal 'text that is not JSON is a problem' '1' "$status"
validate '[1,2]'
check_equal 'a JSON list is a problem' '1' "$status"
status=0
validate_pipeline "$work/missing.json" || status=$?
output="$PROBLEMS"
check_equal 'a missing file is a problem' '1' "$status"
contains 'the message for a missing file explains the file' 'A service repository needs this file' "$output"

echo '--- pipeline.json: minRollbackVersion'

validate '{"service":"core","minRollbackVersion":"0.8.0"}'
check_equal 'a file with a rollback floor is valid' '0' "$status"
check_equal 'the rollback floor is read' '0.8.0' "$PIPELINE_MIN_ROLLBACK"
validate '{"service":"core"}'
check_equal 'the rollback floor may be missing' '0' "$status"
check_equal 'a missing rollback floor is empty' '' "$PIPELINE_MIN_ROLLBACK"
validate '{"service":"core","requires":{},"minRollbackVersion":"10.20.30"}'
check_equal 'a floor is read next to the other keys' '10.20.30' "$PIPELINE_MIN_ROLLBACK"
validate '{"service":"core","minRollbackVersion":8}'
check_equal 'a floor that is a number is a problem' '1' "$status"
contains 'the message says that the floor must be text' '"minRollbackVersion" in' "$output"
contains 'the message for a number names the type' 'but it is a number' "$output"
contains 'the message names the file' "$work/pipeline.json" "$output"
validate '{"service":"core","minRollbackVersion":null}'
check_equal 'a floor that is null is a problem' '1' "$status"
validate '{"service":"core","minRollbackVersion":["0.8.0"]}'
check_equal 'a floor that is a list is a problem' '1' "$status"
validate '{"service":"core","minRollbackVersion":"latest"}'
check_equal 'a floor that is not a version is a problem' '1' "$status"
contains 'the message names the bad floor' '"minRollbackVersion" in' "$output"
contains 'the message says that the text is not a version' '"latest", which is not a version of the form 1.2.3' "$output"
check_equal 'a bad floor is not kept' '' "$PIPELINE_MIN_ROLLBACK"
validate '{"service":"core","minRollbackVersion":"v0.8.0"}'
check_equal 'a floor with a v in front is a problem' '1' "$status"
validate '{"service":"core","minRollbackVersion":"0.8"}'
check_equal 'a floor with two numbers is a problem' '1' "$status"
validate '{"service":"core","minRollbackVersion":"0.8.0-rc1"}'
check_equal 'a floor with a prerelease is a problem' '1' "$status"
validate '{"service":"core","minRollbackVersion":""}'
check_equal 'an empty floor is a problem' '1' "$status"
validate '{"service":"core","minRollbackVersion":"latest","require":{}}'
check_equal 'a bad floor and a typo are two problems' '2' "$(grep -c . <<< "$PROBLEMS")"
validate '{"service":"core","minRolbackVersion":"0.8.0"}'
check_equal 'a typo in the key of the floor is a problem' '1' "$status"
contains 'the unknown key message lists the floor key' 'The keys are service, requires, compatible and minRollbackVersion.' "$output"

write_pipeline '{"service":"account","requires":{"core":">=0.5.0"}}'
check_equal 'the service name is printed by validate' 'account' "$(bash "$here/preflight.sh" validate "$work/pipeline.json")"
status=0
output="$(bash "$here/preflight.sh" validate "$work/nothing.json" 2>&1)" || status=$?
check_equal 'the validate command fails for a missing file' '1' "$status"
contains 'the validate command writes an error annotation' '::error file=' "$output"

echo '--- the record of the tested versions'

record() {
  status=0
  output="$(
    PF_SERVICE="${S:-web}" PF_VERSION="${V:-0.4.0}" PF_TAG='v0.4.0' PF_COMMIT='abc123' PF_E2E_COMMIT='def456' \
      PF_WEB="${W-0.4.0}" PF_CATALOGUE="${C-0.3.1}" PF_ACCOUNT="${A-0.3.1}" PF_CORE="${K-0.5.1}" \
      tested_with_json 2>&1
  )" || status=$?
}

record
check_equal 'a complete record is made' '0' "$status"
check_equal 'the record has the four versions' '0.4.0 0.3.1 0.3.1 0.5.1' "$(jq -r '[.versions.web, .versions.catalogue, .versions.account, .versions.core] | join(" ")' <<< "$output")"
check_equal 'the record names the release, the service and the commits' 'v0.4.0 web 0.4.0 abc123 def456' \
  "$(jq -r '[.release, .service, .version, .commit, .e2eCommit] | join(" ")' <<< "$output")"
check_equal 'the record is one line' '1' "$(wc -l <<< "$output" | tr -d ' ')"

K='' record
check_equal 'a missing version of core is an error' '1' "$status"
contains 'the message names the missing application' 'did not record a version of core' "$output"
A='latest' record
check_equal 'a version that is not a version is an error' '1' "$status"
W='0.3.9' record
check_equal 'the suite must have tested this release' '1' "$status"
contains 'the message says that the suite tested another version' 'tested web 0.3.9, but this release is 0.4.0' "$output"
S='core' V='0.5.1' K='0.5.1' W='0.4.0' record
check_equal 'the own version of a core release is checked against core' '0' "$status"
S='core' V='0.5.2' K='0.5.1' record
check_equal 'a core release that the suite did not test is an error' '1' "$status"
S='Core' record
check_equal 'a bad service name is an error' '1' "$status"
V='latest' record
check_equal 'a bad release version is an error' '1' "$status"

# The four applications keep the record as it was: the same line, four versions and no more (issue 32).
record
check_equal 'the record of a web release is the same line as before' \
  '{"release":"v0.4.0","service":"web","version":"0.4.0","commit":"abc123","e2eCommit":"def456","versions":{"web":"0.4.0","catalogue":"0.3.1","account":"0.3.1","core":"0.5.1"}}' "$output"
for app in web catalogue account core; do
  case "$app" in
    web) app_version='0.4.0' ;;
    core) app_version='0.5.1' ;;
    *) app_version='0.3.1' ;;
  esac
  S="$app" V="$app_version" record
  check_equal "a $app release is recorded" '0' "$status"
  check_equal "the record of a $app release has the four versions and no more" 'account,catalogue,core,web' "$(jq -r '.versions | keys | join(",")' <<< "$output")"
done

# A release of a service outside the four (issue 32). The suite does not report its version, so the record also holds
# the version of the release itself. The check then treats it like any other entry.
S='flags' V='0.1.0' record
check_equal 'a release of a service outside the four is recorded' '0' "$status"
check_equal 'the record holds the five versions, the own version last' '0.4.0 0.3.1 0.3.1 0.5.1 0.1.0' \
  "$(jq -r '[.versions.web, .versions.catalogue, .versions.account, .versions.core, .versions.flags] | join(" ")' <<< "$output")"
check_equal 'the record names the service and the version of the release' 'flags 0.1.0' "$(jq -r '[.service, .version] | join(" ")' <<< "$output")"
check_equal 'the record of a flags release is one line' '1' "$(wc -l <<< "$output" | tr -d ' ')"
S='flags' V='0.1.0' K='' record
check_equal 'a missing neighbour is still an error for a release outside the four' '1' "$status"
contains 'the message for a missing neighbour is the same' 'The E2E run did not record a version of core (""). The tested set is not complete.' "$output"
S='flags' V='latest' record
check_equal 'a bad version of a release outside the four is an error' '1' "$status"
contains 'the message for a bad release version is the same' 'The version of the release is missing or wrong ("latest").' "$output"

unset S V W C A K

# --- Part 3: the whole check against a fake AWS ---

bin="$work/bin"
mkdir -p "$bin"
# A fake of the AWS CLI. It answers two calls like the real command:
#   ssm get-parameters  reads the versions. FAKE_DEPLOYED lists "service version" lines.
#   ssm get-parameter   reads the rollback floor. FAKE_FLOORS lists "service floor" lines.
#                       A service with no line gives the error ParameterNotFound, like the real command.
# FAKE_ERROR (versions) and FAKE_FLOOR_ERROR (floors) hold the text of an AWS error. A non-empty file makes the call fail.
cat > "$bin/aws" << 'FAKE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == ssm ]] || { echo "fake aws: unexpected call $*" >&2; exit 99; }
case "$2" in
  get-parameters)
    echo "$*" >> "$FAKE_CALLS"
    if [[ -s "$FAKE_ERROR" ]]; then
      cat "$FAKE_ERROR" >&2
      exit 254
    fi
    shift 2
    names=()
    while (($#)); do
      case "$1" in
        --names)
          shift
          while (($#)) && [[ "$1" != --* ]]; do
            names+=("$1")
            shift
          done
          ;;
        *) shift ;;
      esac
    done
    for name in "${names[@]}"; do
      service="${name#/lab/}"
      service="${service%/version}"
      version="$(awk -v s="$service" '$1 == s { print $2 }' "$FAKE_DEPLOYED")"
      if [[ -n "$version" ]]; then printf '%s\t%s\n' "$name" "$version"; fi
    done
    ;;
  get-parameter)
    echo "$*" >> "$FAKE_CALLS"
    if [[ -s "$FAKE_FLOOR_ERROR" ]]; then
      cat "$FAKE_FLOOR_ERROR" >&2
      exit 254
    fi
    name=''
    shift 2
    while (($#)); do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    service="${name#/lab/}"
    service="${service%/min-rollback-version}"
    floor="$(awk -v s="$service" '$1 == s { print $2 }' "$FAKE_FLOORS")"
    if [[ -z "$floor" ]]; then
      echo 'An error occurred (ParameterNotFound) when calling the GetParameter operation: ' >&2
      exit 254
    fi
    echo "$floor"
    ;;
  *)
    echo "fake aws: unexpected call $*" >&2
    exit 99
    ;;
esac
FAKE
chmod +x "$bin/aws"
export PATH="$bin:$PATH"
export FAKE_DEPLOYED="$work/deployed" FAKE_CALLS="$work/calls" FAKE_ERROR="$work/error"
export FAKE_FLOORS="$work/floors" FAKE_FLOOR_ERROR="$work/floor-error"
export GITHUB_OUTPUT="$work/github-output" GITHUB_STEP_SUMMARY="$work/summary"

# setup <deployed lines...>
setup() {
  : > "$FAKE_CALLS"
  : > "$FAKE_ERROR"
  : > "$FAKE_FLOORS"
  : > "$FAKE_FLOOR_ERROR"
  : > "$GITHUB_OUTPUT"
  : > "$GITHUB_STEP_SUMMARY"
  printf '%s\n' "$@" > "$FAKE_DEPLOYED"
}

# tested_json <web> <catalogue> <account> <core>  (the service is web, the release 0.4.0)
tested_json() {
  jq -n -c --arg w "$1" --arg c "$2" --arg a "$3" --arg k "$4" \
    '{release: "v0.4.0", service: "web", version: $w, versions: {web: $w, catalogue: $c, account: $a, core: $k}}'
}

# run_check : runs the check in a subshell with the variables PF_* from the caller. Sets $status and $output.
run_check() {
  status=0
  output="$(check 2>&1)" || status=$?
}

write_pipeline '{"service":"web","requires":{"catalogue":">=0.3.0","account":">=0.3.0"}}'
export PF_PIPELINE_FILE="$work/pipeline.json" PF_ENVIRONMENT=production PF_VERSION=0.4.0 PF_MODE=release
export PF_TESTED_WITH='' PF_REQUIRES_OVERRIDE=''

echo '--- check: providers (order)'

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
run_check
check_equal 'a release with its providers in place passes' '0' "$status"
contains 'the summary says passed' 'Checks before the deployment to production: passed' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the summary has a row for the provider' '| provider | catalogue | >=0.3.0 | 0.3.1 | ok |' "$(cat "$GITHUB_STEP_SUMMARY")"
check_equal 'the output has the previous version of the service, the floor and the result' 'previous-version=0.3.1 min-rollback-version= result=pass' "$(tr '\n' ' ' < "$GITHUB_OUTPUT" | sed 's/ $//')"
check_equal 'one SSM call reads all the versions' '1' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"
contains 'the call asks for the version parameters' '/lab/account/version /lab/catalogue/version /lab/web/version' "$(cat "$FAKE_CALLS")"

setup 'core 0.5.1' 'catalogue 0.2.0' 'account 0.3.1' 'web 0.3.1'
run_check
check_equal 'a provider that is too old stops the release' '1' "$status"
contains 'the message names the provider, the range and the version found' 'web needs catalogue >=0.3.0, but production runs catalogue 0.2.0, which is outside the range.' "$output"
contains 'the message names the repository to release' 'repository lab-svc-catalogue' "$output"
contains 'the summary row says failed' '| provider | catalogue | >=0.3.0 | 0.2.0 | FAILED: outside the range |' "$(cat "$GITHUB_STEP_SUMMARY")"
check_equal 'the result output says fail' 'result=fail' "$(grep result "$GITHUB_OUTPUT")"

setup 'core 0.5.1' 'account 0.3.1' 'web 0.3.1'
run_check
check_equal 'a provider that is not deployed stops the release' '1' "$status"
contains 'the message says that the provider is not deployed' 'production has no version of catalogue (the SSM parameter /lab/catalogue/version does not exist)' "$output"
contains 'the message says what to do for a provider with no parameter' 'release it once with a stack that publishes its version' "$output"

setup 'core 0.5.1' 'catalogue 0.1.0' 'web 0.3.1'
run_check
check_equal 'two providers that fail are two errors' '2' "$(grep -c '::error title=' <<< "$output" || true)"

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
PF_ENVIRONMENT=staging run_check
contains 'the title uses the environment' 'deployment to staging: passed' "$(cat "$GITHUB_STEP_SUMMARY")"

setup 'core 0.5.1' 'catalogue 0.2.0' 'account 0.3.1' 'web 0.4.5'
PF_MODE=redeploy run_check
check_equal 'in a redeploy a provider that is too old still stops' '1' "$status"
contains 'the redeploy message names the provider' 'web needs catalogue >=0.3.0' "$output"

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.4.5'
PF_MODE=redeploy run_check
check_equal 'in a redeploy a good case passes, also with a newer version in the environment' '0' "$status"

: > "$FAKE_DEPLOYED"
run_check
check_equal 'an environment with no version at all: the providers are missing' '1' "$status"
check_equal 'an environment with no version at all: both providers are reported' '2' "$(grep -c '::error title=Provider missing' <<< "$output" || true)"

echo '--- check: values in SSM'

setup 'core 0.5.1' 'catalogue dev' 'account 0.3.1' 'web 0.3.1'
run_check
check_equal 'a value in SSM that is not a version stops the check' '1' "$status"
contains 'the message names the parameter and the value' 'The SSM parameter /lab/catalogue/version in production holds "dev"' "$output"
contains 'the message says that it is not a result of the check' 'This is not a result of the check.' "$output"
check_equal 'no summary table is written' '' "$(cat "$GITHUB_STEP_SUMMARY")"

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web v0.3.1'
run_check
check_equal 'the own value with a v in front is refused' '1' "$status"

setup 'core 0.5.1' 'catalogue 1.0.0-rc1' 'account 0.3.1' 'web 0.3.1'
run_check
check_equal 'a prerelease in SSM is refused' '1' "$status"

echo '--- check: this release against the environment'

setup 'catalogue 0.3.1' 'account 0.3.1'
run_check
check_equal 'the first deployment of a service passes' '0' "$status"
contains 'the summary says first deployment' 'ok: the first deployment' "$(cat "$GITHUB_STEP_SUMMARY")"
check_equal 'the previous version is empty for a first deployment' 'previous-version=' "$(grep previous "$GITHUB_OUTPUT")"

setup 'catalogue 0.3.1' 'account 0.3.1' 'web 0.4.0'
run_check
check_equal 'the same version again passes' '0' "$status"
contains 'the summary says a run again' 'the same version (a run again)' "$(cat "$GITHUB_STEP_SUMMARY")"

setup 'catalogue 0.3.1' 'account 0.3.1' 'web 0.4.1'
run_check
check_equal 'an older release is superseded and stops' '1' "$status"
contains 'the message says superseded' '::error title=Release superseded::production runs web 0.4.1. This release is web 0.4.0, which is older.' "$output"
contains 'the message says that the environment keeps its version' 'production keeps 0.4.1' "$output"

setup 'catalogue 0.3.1' 'account 0.3.1' 'web 0.4.1'
PF_MODE=redeploy run_check
check_equal 'a redeploy may go back to an older version' '0' "$status"
contains 'the summary says older on purpose' 'ok: older on purpose (a redeploy)' "$(cat "$GITHUB_STEP_SUMMARY")"

setup 'catalogue 0.3.1' 'account 0.3.1' 'web 0.9.0'
PF_VERSION=0.10.0 run_check
check_equal '0.10.0 is newer than 0.9.0 in the release check' '0' "$status"

echo '--- check: the tested set'

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
PF_TESTED_WITH="$(tested_json 0.4.0 0.3.1 0.3.1 0.5.1)" run_check
check_equal 'the same set in the environment passes' '0' "$status"
contains 'the summary has a row for the same version' '| tested together | core | 0.5.1 | 0.5.1 | ok: the same version |' "$(cat "$GITHUB_STEP_SUMMARY")"
lacks 'the own service is not compared with itself' '| tested together | web |' "$(cat "$GITHUB_STEP_SUMMARY")"

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
PF_TESTED_WITH="$(tested_json 0.4.0 0.3.1 0.3.1 0.5.2)" run_check
check_equal 'a neighbour that is older than tested stops the release' '1' "$status"
contains 'the message names the missing release' 'core 0.5.2 was in the set that the E2E suite tested with web 0.4.0 (release v0.4.0 of web), but production runs core 0.5.1.' "$output"
contains 'the message tells where to release it' 'Release core 0.5.2 to production first (repository lab-svc-core)' "$output"
contains 'the message names the escape in pipeline.json' 'add a range for core to pipeline.json' "$output"
contains 'the summary row says missing release' '| tested together | core | 0.5.2 | 0.5.1 | FAILED: missing release |' "$(cat "$GITHUB_STEP_SUMMARY")"
check_equal 'only the core row failed' '1' "$(grep -c '::error title=Missing release' <<< "$output" || true)"

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
write_pipeline '{"service":"web","requires":{"catalogue":">=0.3.0","account":">=0.3.0","core":">=0.5.0"}}'
PF_TESTED_WITH="$(tested_json 0.4.0 0.3.1 0.3.1 0.5.2)" run_check
check_equal 'an older neighbour inside the range of requires passes' '0' "$status"
contains 'the summary says that pipeline.json accepts it' 'ok: older, but pipeline.json accepts >=0.5.0' "$(cat "$GITHUB_STEP_SUMMARY")"

write_pipeline '{"service":"web","requires":{"catalogue":">=0.3.0","account":">=0.3.0"},"compatible":{"core":">=0.5.0 <1.0.0"}}'
PF_TESTED_WITH="$(tested_json 0.4.0 0.3.1 0.3.1 0.5.2)" run_check
check_equal 'an older neighbour inside the range of compatible passes' '0' "$status"

write_pipeline '{"service":"web","requires":{"catalogue":">=0.3.0","account":">=0.3.0"},"compatible":{"core":">=0.5.2"}}'
PF_TESTED_WITH="$(tested_json 0.4.0 0.3.1 0.3.1 0.5.2)" run_check
check_equal 'an older neighbour outside the range stops the release' '1' "$status"

write_pipeline '{"service":"web","requires":{"catalogue":">=0.3.0","account":">=0.3.0"}}'
setup 'core 0.5.3' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
PF_TESTED_WITH="$(tested_json 0.4.0 0.3.1 0.3.1 0.5.2)" run_check
check_equal 'a newer neighbour passes' '0' "$status"
contains 'a newer neighbour gives a notice' '::notice title=Newer neighbour::production runs core 0.5.3, which is newer than the 0.5.2' "$output"
contains 'the summary says newer than tested' 'ok: newer than tested' "$(cat "$GITHUB_STEP_SUMMARY")"

setup 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
PF_TESTED_WITH="$(tested_json 0.4.0 0.3.1 0.3.1 0.5.2)" run_check
check_equal 'a neighbour that is not deployed passes with a notice' '0' "$status"
contains 'the notice says that there is nothing to compare' '::notice title=Neighbour not deployed::production has no version of core' "$output"

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
PF_TESTED_WITH="$(tested_json 0.4.0 0.3.1 0.3.1 0.5.2)" PF_MODE=redeploy run_check
check_equal 'in a redeploy an older neighbour does not stop' '0' "$status"
contains 'in a redeploy an older neighbour is a warning row' 'warning: older than tested (a redeploy does not stop)' "$(cat "$GITHUB_STEP_SUMMARY")"

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
run_check
contains 'no record gives a notice' '::notice title=No tested set::No record of tested versions exists for this release' "$output"
check_equal 'no record still passes the other checks' '0' "$status"
PF_ENVIRONMENT='test' run_check
if [[ "$output" == *'No tested set'* ]]; then
  echo 'FAIL  in Test there is no record by design, so there is no notice'
  failures=$((failures + 1))
else
  echo 'ok    in Test there is no record by design, so there is no notice'
fi

PF_TESTED_WITH="$(tested_json 0.3.9 0.3.1 0.3.1 0.5.1)" run_check
check_equal 'a record of another release of the service is refused' '1' "$status"
contains 'the message names both versions' 'The record belongs to web 0.3.9, but this deployment is web 0.4.0.' "$output"

PF_TESTED_WITH='{"versions":"x"}' run_check
check_equal 'a record with no versions object is refused' '1' "$status"

PF_TESTED_WITH='{"release":"v0.4.0","versions":{}}' run_check
check_equal 'a record with an empty versions object does not say that the suite tested this release' '1' "$status"
contains 'the message says that the record has no version of the service' 'The record has no version of web' "$output"

PF_TESTED_WITH='{"release":"v0.4.0","versions":{"catalogue":"0.3.1","core":"0.5.1"}}' run_check
check_equal 'a record without the own service is refused' '1' "$status"

PF_VERSION='' PF_TESTED_WITH='{"release":"v0.4.0","versions":{"catalogue":"0.3.1","core":"0.5.1"}}' run_check
check_equal 'a dry run needs no own version in the record' '0' "$status"

echo '--- check: a service outside the four (flags, issue 32)'

# The service flags has no endpoint and no part in the E2E suite. Its record comes from tested_with_json, as in the job tested-set.
S='flags' V='0.1.0' record
flags_record="$output"
write_pipeline '{"service":"flags","requires":{}}'
setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.4.0' 'flags 0.0.9'
PF_VERSION=0.1.0 PF_TESTED_WITH="$flags_record" run_check
check_equal 'a flags release with its record passes' '0' "$status"
contains 'the summary has the row of this release' '| this release | flags | 0.1.0 | 0.0.9 | ok: newer than the environment |' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the summary compares a neighbour of the set' '| tested together | core | 0.5.1 | 0.5.1 | ok: the same version |' "$(cat "$GITHUB_STEP_SUMMARY")"
lacks 'the summary does not compare flags with itself' '| tested together | flags |' "$(cat "$GITHUB_STEP_SUMMARY")"
check_equal 'the output has the previous version of flags and the result' 'previous-version=0.0.9 min-rollback-version= result=pass' "$(tr '\n' ' ' < "$GITHUB_OUTPUT" | sed 's/ $//')"

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.4.0'
PF_VERSION=0.1.0 PF_TESTED_WITH="$flags_record" run_check
check_equal 'the first flags release passes' '0' "$status"

# A record from before this change has the four versions only. It still does not say that the suite tested this release.
PF_VERSION=0.1.0 PF_TESTED_WITH="$(tested_json 0.4.0 0.3.1 0.3.1 0.5.1)" run_check
check_equal 'a record with the four versions only is refused for flags' '1' "$status"
contains 'the message says that the record has no version of flags' 'The record has no version of flags, so it does not say that the suite tested this release.' "$output"

PF_VERSION=0.1.1 PF_TESTED_WITH="$flags_record" run_check
check_equal 'a record of another flags release is refused' '1' "$status"
contains 'the message names both versions of flags' 'The record belongs to flags 0.1.0, but this deployment is flags 0.1.1.' "$output"

S='flags' V='0.1.0' K='0.5.2' record
flags_older_record="$output"
PF_VERSION=0.1.0 PF_TESTED_WITH="$flags_older_record" run_check
check_equal 'an older neighbour stops a flags release' '1' "$status"
contains 'the message for an older neighbour is the same' '::error title=Missing release::core 0.5.2 was in the set that the E2E suite tested with flags 0.1.0 (release v0.4.0 of flags), but production runs core 0.5.1.' "$output"
contains 'the message tells where to release the neighbour' 'Release core 0.5.2 to production first (repository lab-svc-core)' "$output"

# A service may list flags as a provider. The message names the repository lab-flags.
write_pipeline '{"service":"catalogue","requires":{"core":">=0.5.0","flags":">=0.1.0"}}'
setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.4.0'
PF_VERSION=0.3.2 run_check
check_equal 'a provider flags that is not deployed stops the release' '1' "$status"
contains 'the call asks for the version of flags' '/lab/flags/version' "$(cat "$FAKE_CALLS")"
contains 'the message says that flags is not deployed' 'catalogue needs flags >=0.1.0, but production has no version of flags (the SSM parameter /lab/flags/version does not exist). Deploy flags to production first (repository lab-flags).' "$output"
setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.4.0' 'flags 0.0.9'
PF_VERSION=0.3.2 run_check
check_equal 'a provider flags that is too old stops the release' '1' "$status"
contains 'the message names the repository lab-flags' 'Put a version of flags that is inside the range into production first (repository lab-flags)' "$output"
setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.4.0' 'flags 0.1.0'
PF_VERSION=0.3.2 run_check
check_equal 'a provider flags inside the range passes' '0' "$status"
contains 'the summary has the row of the provider flags' '| provider | flags | >=0.1.0 | 0.1.0 | ok |' "$(cat "$GITHUB_STEP_SUMMARY")"

write_pipeline '{"service":"web","requires":{"catalogue":">=0.3.0","account":">=0.3.0"}}'

echo '--- check: the rollback floor in a redeploy'

# set_floor <service floor lines...>   The rollback floors that the fake SSM holds.
set_floor() {
  printf '%s\n' "$@" > "$FAKE_FLOORS"
}
# floor_calls   The number of reads of a floor parameter. A read of the versions does not count.
floor_calls() {
  grep -c 'get-parameter --name ' "$FAKE_CALLS" || true
}

write_pipeline '{"service":"core"}'

setup 'core 0.9.0'
PF_MODE=redeploy PF_VERSION=0.7.0 run_check
check_equal 'a redeploy with no floor recorded passes' '0' "$status"
contains 'the summary says that no floor is recorded' '| rollback floor | core | 0.7.0 | none | ok: no floor recorded |' "$(cat "$GITHUB_STEP_SUMMARY")"
check_equal 'the floor is read with one call' '1' "$(floor_calls)"
contains 'the call asks for the parameter of the floor' 'get-parameter --name /lab/core/min-rollback-version' "$(cat "$FAKE_CALLS")"
check_equal 'the output has an empty floor' 'min-rollback-version=' "$(grep min-rollback "$GITHUB_OUTPUT")"
lacks 'a missing parameter is not an error' '::error' "$output"

setup 'core 0.9.0'
set_floor 'core 0.8.0'
PF_MODE=redeploy PF_VERSION=0.8.0 run_check
check_equal 'a redeploy to the floor itself passes' '0' "$status"
contains 'the summary says that the version is not below the floor' '| rollback floor | core | 0.8.0 | 0.8.0 | ok: not below the floor |' "$(cat "$GITHUB_STEP_SUMMARY")"
check_equal 'the output has the floor' 'min-rollback-version=0.8.0' "$(grep min-rollback "$GITHUB_OUTPUT")"

setup 'core 0.9.0'
set_floor 'core 0.7.0'
PF_MODE=redeploy PF_VERSION=0.8.0 run_check
check_equal 'a redeploy above the floor passes' '0' "$status"
check_equal 'a redeploy above the floor says pass' 'result=pass' "$(grep result "$GITHUB_OUTPUT")"

setup 'core 0.9.0'
set_floor 'core 0.8.0'
PF_MODE=redeploy PF_VERSION=0.10.0 run_check
check_equal 'a redeploy of 0.10.0 above the floor 0.8.0 passes' '0' "$status"

setup 'core 0.9.0'
set_floor 'core 0.10.0'
PF_MODE=redeploy PF_VERSION=0.9.0 run_check
check_equal '0.9.0 is below the floor 0.10.0, as numbers' '1' "$status"

setup 'core 0.9.0'
set_floor 'core 0.8.0'
PF_MODE=redeploy PF_VERSION=0.7.0 run_check
check_equal 'a redeploy below the floor is refused' '1' "$status"
contains 'the log has the refusal with the exact words' "::error title=Rollback refused::${expected_refusal}" "$output"
check_equal 'the refusal is one error' '1' "$(grep -c '::error title=Rollback refused' <<< "$output" || true)"
contains 'the summary row says failed' '| rollback floor | core | 0.7.0 | 0.8.0 | FAILED: below the floor |' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the summary says that the check stopped' 'stopped, 1 check(s) failed' "$(cat "$GITHUB_STEP_SUMMARY")"
check_equal 'the result output says fail' 'result=fail' "$(grep result "$GITHUB_OUTPUT")"
check_equal 'the output has the floor also after a refusal' 'min-rollback-version=0.8.0' "$(grep min-rollback "$GITHUB_OUTPUT")"
contains 'the refusal names the service' 'core 0.7.0 cannot run' "$output"
contains 'the refusal names the environment' 'against the data in production' "$output"
contains 'the refusal names the floor' 'The oldest version that can run is core 0.8.0' "$output"
contains 'the refusal names the parameter' '(SSM parameter /lab/core/min-rollback-version)' "$output"
contains 'the refusal names the section Restore of the repository README' 'see "Restore" in the README of lab-svc-core.' "$output"
contains 'the refusal says what to do' 'Go back to 0.8.0 or newer, or fix forward with a new release.' "$output"

PF_ENVIRONMENT=staging PF_MODE=redeploy PF_VERSION=0.7.0 run_check
check_equal 'a redeploy below the floor is refused in Staging too' '1' "$status"
contains 'the refusal names the environment of the job' 'against the data in staging' "$output"

# A provider that fails and a floor that fails are two errors. The check does not stop at the first one.
write_pipeline '{"service":"core","requires":{"store":">=1.0.0"}}'
setup 'core 0.9.0' 'store 0.5.0'
set_floor 'core 0.8.0'
PF_MODE=redeploy PF_VERSION=0.7.0 run_check
check_equal 'a failed provider and a failed floor are two errors' '2' "$(grep -c '::error title=' <<< "$output" || true)"
write_pipeline '{"service":"core"}'

setup 'core 0.9.0'
set_floor 'webb 0.8.0'
PF_MODE=redeploy PF_VERSION=0.7.0 run_check
check_equal 'the floor of another service does not count' '0' "$status"

setup 'core 0.9.0'
set_floor 'core soon'
PF_MODE=redeploy PF_VERSION=0.7.0 run_check
check_equal 'a floor that is not a version stops the check' '1' "$status"
contains 'the message names the parameter and the value' 'The SSM parameter /lab/core/min-rollback-version in production holds "soon"' "$output"
contains 'the message says that it is not a result of the check' 'This is not a result of the check.' "$output"
check_equal 'a floor that is not a version writes no summary table' '' "$(cat "$GITHUB_STEP_SUMMARY")"
lacks 'a floor that is not a version is not a refusal' 'Rollback refused' "$output"

setup 'core 0.9.0'
set_floor 'core v0.8.0'
PF_MODE=redeploy PF_VERSION=0.9.0 run_check
check_equal 'a floor with a v in front stops the check' '1' "$status"

setup 'core 0.9.0'
echo 'An error occurred (AccessDeniedException) when calling the GetParameter operation: not authorized' > "$FAKE_FLOOR_ERROR"
PF_MODE=redeploy PF_VERSION=0.8.0 run_check
check_equal 'an AWS error on the floor is an error and not a result of the check' '1' "$status"
contains 'the message says that the floor could not be read' 'The rollback floor in production could not be read from SSM. This is not a result of the check.' "$output"
contains 'the message names the permission' 'ssm:GetParameter on /lab/*' "$output"
contains 'the log has the text of the AWS error' 'AccessDeniedException' "$output"
check_equal 'an AWS error on the floor writes no summary table' '' "$(cat "$GITHUB_STEP_SUMMARY")"
lacks 'an AWS error on the floor is not a refusal' 'Rollback refused' "$output"

setup 'core 0.9.0'
set_floor 'core 0.8.0'
PF_MODE=redeploy PF_VERSION='' run_check
check_equal 'a dry run is not compared with the floor' '0' "$status"
check_equal 'a dry run does not read the floor' '0' "$(floor_calls)"
lacks 'a dry run has no row for the floor' '| rollback floor |' "$(cat "$GITHUB_STEP_SUMMARY")"
check_equal 'a dry run has an empty floor in the output' 'min-rollback-version=' "$(grep min-rollback "$GITHUB_OUTPUT")"

setup 'core 0.6.0'
set_floor 'core 0.8.0'
PF_MODE=release PF_VERSION=0.7.0 run_check
check_equal 'a release does not compare with the floor in SSM' '0' "$status"
check_equal 'a release does not read the floor' '0' "$(floor_calls)"
lacks 'a release has no row for the floor without a floor in pipeline.json' '| rollback floor |' "$(cat "$GITHUB_STEP_SUMMARY")"

echo '--- check: the floor in pipeline.json'

write_pipeline '{"service":"core","minRollbackVersion":"0.8.0"}'

setup 'core 0.7.0'
PF_MODE=release PF_VERSION=0.8.0 run_check
check_equal 'a release at the declared floor passes' '0' "$status"
contains 'the summary row says that the floor is not above the release' '| rollback floor | core | 0.8.0 | 0.8.0 (pipeline.json) | ok: the floor is not above the release |' "$(cat "$GITHUB_STEP_SUMMARY")"

setup 'core 0.7.0'
PF_MODE=release PF_VERSION=0.9.0 run_check
check_equal 'a release above the declared floor passes' '0' "$status"

setup 'core 0.7.0'
PF_MODE=release PF_VERSION=0.7.5 run_check
check_equal 'a release below its own declared floor fails' '1' "$status"
contains 'the log has the error with its title' '::error title=Floor above release::' "$output"
contains 'the message names the file, the floor, the service and the release' 'pipeline.json declares minRollbackVersion 0.8.0 for core, but this release is core 0.7.5, which is older.' "$output"
contains 'the message says that a floor cannot be newer than its release' 'A floor cannot be newer than the release that declares it.' "$output"
contains 'the message says what to do' 'Lower minRollbackVersion to 0.7.5 or less' "$output"
contains 'the summary row says failed' '| rollback floor | core | 0.7.5 | 0.8.0 (pipeline.json) | FAILED: the floor is above the release |' "$(cat "$GITHUB_STEP_SUMMARY")"
check_equal 'a release does not read the floor from SSM, also with a floor in pipeline.json' '0' "$(floor_calls)"

setup 'core 0.9.0'
PF_MODE=redeploy PF_VERSION=0.7.5 run_check
check_equal 'a redeploy ignores the floor of pipeline.json: only SSM counts' '0' "$status"
lacks 'a redeploy has no row about pipeline.json' 'pipeline.json)' "$(cat "$GITHUB_STEP_SUMMARY")"

setup 'core 0.7.0'
PF_MODE=release PF_VERSION='' run_check
check_equal 'a dry run does not compare the floor of pipeline.json' '0' "$status"
lacks 'a dry run has no row for the floor of pipeline.json' '| rollback floor |' "$(cat "$GITHUB_STEP_SUMMARY")"

write_pipeline '{"service":"web","requires":{"catalogue":">=0.3.0","account":">=0.3.0"}}'

echo '--- fetch_floor'

fake_floor="$work/floor-bin"
mkdir -p "$fake_floor"
printf '#!/usr/bin/env bash
echo 0.8.0
' > "$fake_floor/aws"
chmod +x "$fake_floor/aws"
check_equal 'a floor is printed' '0.8.0' "$(PATH="$fake_floor:$PATH" fetch_floor core)"
printf '#!/usr/bin/env bash
echo "warning: a stray line on stderr" >&2
echo 0.8.0
' > "$fake_floor/aws"
check_equal 'a stray line on stderr does not change the floor' '0.8.0' "$(PATH="$fake_floor:$PATH" fetch_floor core 2> /dev/null)"
printf '#!/usr/bin/env bash
printf "0.8.0\\r\\n"
' > "$fake_floor/aws"
check_equal 'a CR at the end of the line goes away' '0.8.0' "$(PATH="$fake_floor:$PATH" fetch_floor core)"
printf '#!/usr/bin/env bash
printf "0.8.0\\n::warning::injected\\n"
' > "$fake_floor/aws"
check_equal 'a line break in the value cannot start a workflow command' '0.8.0?::warning::injected' "$(PATH="$fake_floor:$PATH" fetch_floor core)"
printf '#!/usr/bin/env bash
echo "An error occurred (ParameterNotFound) when calling the GetParameter operation: " >&2
exit 254
' > "$fake_floor/aws"
status=0
output="$(PATH="$fake_floor:$PATH" fetch_floor core 2>&1)" || status=$?
check_equal 'a parameter that does not exist gives code 0' '0' "$status"
check_equal 'a parameter that does not exist gives no text' '' "$output"
printf '#!/usr/bin/env bash
echo "An error occurred (ThrottlingException) when calling the GetParameter operation: Rate exceeded" >&2
exit 254
' > "$fake_floor/aws"
status=0
output="$(PATH="$fake_floor:$PATH" fetch_floor core 2>&1)" || status=$?
check_equal 'another AWS error gives code 1' '1' "$status"
contains 'another AWS error shows its text' 'ThrottlingException' "$output"
printf '#!/usr/bin/env bash
echo "Unable to locate credentials. You can configure credentials by running aws configure." >&2
exit 253
' > "$fake_floor/aws"
status=0
output="$(PATH="$fake_floor:$PATH" fetch_floor core 2>&1)" || status=$?
check_equal 'missing credentials give code 1' '1' "$status"

echo '--- fetch_deployed'

PATH_BEFORE="$PATH"
fake_none="$work/none-bin"
mkdir -p "$fake_none"
printf '#!/usr/bin/env bash
echo None
' > "$fake_none/aws"
chmod +x "$fake_none/aws"
check_equal 'the answer None of the AWS CLI means no version' '' "$(PATH="$fake_none:$PATH" fetch_deployed core web)"
printf '#!/usr/bin/env bash
printf "/lab/core/version\t0.5.1\n/lab/web/version\t0.4.0\n"
' > "$fake_none/aws"
check_equal 'two lines become service and version' $'core	0.5.1
web	0.4.0' "$(PATH="$fake_none:$PATH" fetch_deployed core web)"
PATH="$PATH_BEFORE"


echo '--- check: the dry run and the errors'

PF_TESTED_WITH=''
setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
PF_VERSION='' PF_REQUIRES_OVERRIDE='{"core":">=9.9.9"}' run_check
check_equal 'a requirement that cannot be met stops a dry run' '1' "$status"
contains 'the dry run names the requirement that failed' 'web needs core >=9.9.9, but production runs core 0.5.1, which is outside the range.' "$output"
lacks 'the dry run without a version has no row for the release' '| this release |' "$(cat "$GITHUB_STEP_SUMMARY")"
lacks 'the dry run does not compare the file requirements' 'catalogue' "$(cat "$GITHUB_STEP_SUMMARY")"

PF_REQUIRES_OVERRIDE='[1]' run_check
check_equal 'an override that is not an object is refused' '1' "$status"
PF_REQUIRES_OVERRIDE='{"core":"soon"}' run_check
check_equal 'an override with a bad range is refused' '1' "$status"
PF_REQUIRES_OVERRIDE='{"Core":">=1.0.0"}' run_check
check_equal 'an override with a bad name is refused' '1' "$status"

setup 'core 0.5.1'
echo 'An error occurred (AccessDeniedException) when calling the GetParameters operation: not authorized' > "$FAKE_ERROR"
run_check
check_equal 'an AWS error is an error and not a result of the check' '1' "$status"
contains 'the message says that this is not a result of the check' 'This is not a result of the check' "$output"
contains 'the log has the text of the AWS error' 'AccessDeniedException' "$output"
check_equal 'an AWS error writes no summary table' '' "$(cat "$GITHUB_STEP_SUMMARY")"

setup 'core 0.5.1'
PF_ENVIRONMENT=prod run_check
check_equal 'a bad environment is refused' '1' "$status"
check_equal 'a bad environment makes no AWS call' '0' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"

PF_MODE=force run_check
check_equal 'a bad mode is refused' '1' "$status"

PF_VERSION=latest run_check
check_equal 'a bad version is refused' '1' "$status"

PF_PIPELINE_FILE="$work/missing.json" run_check
check_equal 'a missing pipeline file stops the check' '1' "$status"
contains 'the error annotation names the file' '::error file=' "$output"
check_equal 'a missing pipeline file makes no AWS call' '0' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"

echo '--- the script as a process'

status=0
output="$(bash "$here/preflight.sh" 2>&1)" || status=$?
check_equal 'no command fails with code 2' '2' "$status"
contains 'the usage message' 'usage: preflight.sh' "$output"

setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
status=0
output="$(PF_TESTED_WITH='' bash "$here/preflight.sh" check 2>&1)" || status=$?
check_equal 'the script as a process passes a good case' '0' "$status"

status=0
output="$(PF_REQUIRES_OVERRIDE='{"core":">=9.9.9"}' PF_TESTED_WITH='' bash "$here/preflight.sh" check 2>&1)" || status=$?
check_equal 'the script as a process fails a bad case with code 1' '1' "$status"

finished=1
if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo 'all tests passed'
