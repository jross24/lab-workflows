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
check_equal 'provider: too old' 'too-old' "$(provider_verdict 0.4.0 '>=0.5.0')"
check_equal 'provider: missing' 'missing' "$(provider_verdict '' '>=0.5.0')"

check_equal 'neighbour: absent' 'absent' "$(neighbour_verdict 0.5.2 '' '')"
check_equal 'neighbour: same' 'same' "$(neighbour_verdict 0.5.2 0.5.2 '')"
check_equal 'neighbour: newer' 'newer' "$(neighbour_verdict 0.5.2 0.5.3 '')"
check_equal 'neighbour: older with no range' 'older' "$(neighbour_verdict 0.5.2 0.5.1 '')"
check_equal 'neighbour: older but inside the range' 'accepted' "$(neighbour_verdict 0.5.2 0.5.1 '>=0.5.0')"
check_equal 'neighbour: older and outside the range' 'older' "$(neighbour_verdict 0.5.2 0.4.0 '>=0.5.0')"

check_equal 'repository of core' 'lab-svc-core' "$(repository_of core)"
check_equal 'repository of catalogue' 'lab-svc-catalogue' "$(repository_of catalogue)"
check_equal 'repository of web' 'lab-web' "$(repository_of web)"

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

unset S V W C A K

# --- Part 3: the whole check against a fake AWS ---

bin="$work/bin"
mkdir -p "$bin"
# A fake of the AWS CLI. FAKE_DEPLOYED lists "service version" lines. It answers ssm get-parameters like the real command.
cat > "$bin/aws" << 'FAKE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == ssm && "$2" == get-parameters ]] || { echo "fake aws: unexpected call $*" >&2; exit 99; }
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
FAKE
chmod +x "$bin/aws"
export PATH="$bin:$PATH"
export FAKE_DEPLOYED="$work/deployed" FAKE_CALLS="$work/calls" FAKE_ERROR="$work/error"
export GITHUB_OUTPUT="$work/github-output" GITHUB_STEP_SUMMARY="$work/summary"

# setup <deployed lines...>
setup() {
  : > "$FAKE_CALLS"
  : > "$FAKE_ERROR"
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
check_equal 'the output has the previous version of the service and the result' 'previous-version=0.3.1 result=pass' "$(tr '\n' ' ' < "$GITHUB_OUTPUT" | sed 's/ $//')"
check_equal 'one SSM call reads all the versions' '1' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"
contains 'the call asks for the version parameters' '/lab/account/version /lab/catalogue/version /lab/web/version' "$(cat "$FAKE_CALLS")"

setup 'core 0.5.1' 'catalogue 0.2.0' 'account 0.3.1' 'web 0.3.1'
run_check
check_equal 'a provider that is too old stops the release' '1' "$status"
contains 'the message names the provider, the range and the version found' 'web needs catalogue >=0.3.0, but production runs catalogue 0.2.0.' "$output"
contains 'the message names the repository to release' 'repository lab-svc-catalogue' "$output"
contains 'the summary row says failed' '| provider | catalogue | >=0.3.0 | 0.2.0 | FAILED: too old |' "$(cat "$GITHUB_STEP_SUMMARY")"
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
PF_ENVIRONMENT=test run_check
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

echo '--- check: the dry run and the errors'

PF_TESTED_WITH=''
setup 'core 0.5.1' 'catalogue 0.3.1' 'account 0.3.1' 'web 0.3.1'
PF_VERSION='' PF_REQUIRES_OVERRIDE='{"core":">=9.9.9"}' run_check
check_equal 'a requirement that cannot be met stops a dry run' '1' "$status"
contains 'the dry run names the requirement that failed' 'web needs core >=9.9.9, but production runs core 0.5.1.' "$output"
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
