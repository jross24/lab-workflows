#!/usr/bin/env bash
# Tests for propose-rollback.sh. Run: bash actions/propose-rollback/test.sh
# The tests use a fake "gh" command and a fake "aws" command. They call no GitHub API and no AWS API.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=actions/propose-rollback/propose-rollback.sh
source "$here/propose-rollback.sh"

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

lacks() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "ok    $name"
  else
    echo "FAIL  $name: \"$needle\" is in the output"
    failures=$((failures + 1))
  fi
}

work="$(mktemp -d)"
finished=0
exec 3>&1
trap 'rm -rf "$work"; if [[ "$finished" -ne 1 ]]; then echo "FAIL  the test script stopped before the end" >&3; fi' EXIT

mkdir -p "$work/bin"
cat > "$work/bin/gh" << 'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_CALLS"
if [[ -f "$FAKE_FAILS" ]]; then
  echo 'HTTP 422: Workflow does not have workflow_dispatch trigger' >&2
  exit 1
fi
exit 0
FAKE
chmod +x "$work/bin/gh"
# A fake of the AWS CLI. It answers "ssm get-parameter" for the rollback floor, like the real command.
# FAKE_FLOORS lists "service floor" lines. A service with no line gives the error ParameterNotFound.
# A non-empty FAKE_AWS_ERROR holds the text of another AWS error, and the call fails with it.
cat > "$work/bin/aws" << 'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_AWS_CALLS"
if [[ "$1 $2" != 'ssm get-parameter' ]]; then
  echo "fake aws: unexpected call $*" >&2
  exit 99
fi
if [[ -s "$FAKE_AWS_ERROR" ]]; then
  cat "$FAKE_AWS_ERROR" >&2
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
FAKE
chmod +x "$work/bin/aws"
export PATH="$work/bin:$PATH"
export FAKE_CALLS="$work/calls" FAKE_FAILS="$work/fails"
export FAKE_AWS_CALLS="$work/aws-calls" FAKE_AWS_ERROR="$work/aws-error" FAKE_FLOORS="$work/floors"
export GITHUB_REPOSITORY='jross24/lab-web' GITHUB_STEP_SUMMARY="$work/summary"
export PR_SERVICE=web PR_VERSION=0.4.1 PR_PREVIOUS=0.4.0

reset() {
  : > "$FAKE_CALLS"
  : > "$FAKE_AWS_CALLS"
  : > "$FAKE_AWS_ERROR"
  : > "$FAKE_FLOORS"
  : > "$GITHUB_STEP_SUMMARY"
  rm -f "$FAKE_FAILS"
}

run_main() {
  status=0
  output="$(main 2>&1)" || status=$?
}

check_equal 'no earlier version' 'none' "$(decide 0.4.1 '')"
check_equal 'the earlier version is this version' 'same' "$(decide 0.4.1 0.4.1)"
check_equal 'an earlier version that is not a version' 'unknown' "$(decide 0.4.1 latest)"
check_equal 'an earlier version that is older' 'go-back' "$(decide 0.4.1 0.4.0)"
check_equal 'the rollback floor is above the earlier version' 'blocked' "$(decide 0.4.1 0.4.0 0.4.1)"
check_equal 'the rollback floor is the earlier version' 'go-back' "$(decide 0.4.1 0.4.0 0.4.0)"
check_equal 'the rollback floor is below the earlier version' 'go-back' "$(decide 0.4.1 0.4.0 0.3.0)"
check_equal 'no rollback floor' 'go-back' "$(decide 0.4.1 0.4.0 '')"
check_equal 'the third argument may be missing' 'go-back' "$(decide 0.4.1 0.4.0)"
check_equal 'a floor is compared as numbers, not as text' 'blocked' "$(decide 0.10.0 0.9.0 0.10.0)"
check_equal 'no earlier version wins over a floor' 'none' "$(decide 0.4.1 '' 0.4.0)"
check_equal 'an earlier version that is not a version wins over a floor' 'unknown' "$(decide 0.4.1 latest 0.4.0)"
check_equal 'the same version wins over a floor' 'same' "$(decide 0.4.1 0.4.1 0.4.1)"
check_equal 'a floor that is not a version does not block' 'go-back' "$(decide 0.4.1 0.4.0 soon)"
check_equal 'the command to redeploy' 'gh workflow run redeploy.yml --repo jross24/lab-web -f version=0.4.0 -f environment=production' \
  "$(redeploy_command jross24/lab-web redeploy.yml 0.4.0)"

reset
run_main
check_equal 'a failed smoke check starts the redeploy of the earlier version' '0' "$status"
check_equal 'the redeploy call has the version and the environment' 'workflow run redeploy.yml --repo jross24/lab-web -f version=0.4.0 -f environment=production' "$(cat "$FAKE_CALLS")"
contains 'the log has an error that names the service and the version' '::error title=Smoke check failed in production::The smoke check failed after web 0.4.1 was deployed to production.' "$output"
contains 'the summary says that the redeploy was started' 'I started the redeploy of web 0.4.0 to production.' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the summary says what to do with a false alarm' 'Cancel it if the smoke check was a false alarm.' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the summary gives the command for a person' 'gh workflow run redeploy.yml --repo jross24/lab-web -f version=0.4.0 -f environment=production' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the summary says that Production is not changed by this job' 'The job does not change Production by itself.' "$(cat "$GITHUB_STEP_SUMMARY")"

reset
: > "$FAKE_FAILS"
run_main
check_equal 'a redeploy that cannot start is a warning and the script still succeeds' '0' "$status"
contains 'the log has the warning' '::warning::The redeploy could not be started from this job' "$output"
contains 'the warning has the reason from GitHub' 'HTTP 422: Workflow does not have workflow_dispatch trigger' "$output"
contains 'the summary still gives the command' 'gh workflow run redeploy.yml' "$(cat "$GITHUB_STEP_SUMMARY")"
lacks 'the summary does not claim that the redeploy started' 'I started' "$(cat "$GITHUB_STEP_SUMMARY")"

reset
PR_PREVIOUS='' run_main
check_equal 'no earlier version means no redeploy call' '0 0' "$status $(wc -l < "$FAKE_CALLS" | tr -d ' ')"
contains 'the summary says there is nothing to go back to' 'there is nothing to go back to' "$(cat "$GITHUB_STEP_SUMMARY")"

reset
PR_PREVIOUS=latest run_main
check_equal 'an earlier version that is not a version means no redeploy call' '0 0' "$status $(wc -l < "$FAKE_CALLS" | tr -d ' ')"
contains 'the summary asks for a decision by hand' 'could not be read, so I did not start a redeploy' "$(cat "$GITHUB_STEP_SUMMARY")"

reset
PR_PREVIOUS=0.4.1 run_main
check_equal 'the same version as before means no redeploy call' '0 0' "$status $(wc -l < "$FAKE_CALLS" | tr -d ' ')"
contains 'the summary says there is no older version' 'There is no older version to go back to.' "$(cat "$GITHUB_STEP_SUMMARY")"

reset
PR_WORKFLOW=back.yml run_main
contains 'the workflow file can be changed' 'workflow run back.yml' "$(cat "$FAKE_CALLS")"

# --- the rollback floor ---

expected_refusal='Rollback refused: web 0.4.0 cannot run against the data in production. A migration changed the data in a way that an older version cannot read. The oldest version that can run is web 0.4.1 (SSM parameter /lab/web/min-rollback-version). Do not roll back to 0.4.0. Go back to 0.4.1 or newer, or fix forward with a new release. If the data itself is wrong, restore it first: see "Restore" in the README of lab-web.'

reset
echo 'web 0.4.1' > "$FAKE_FLOORS"
run_main
check_equal 'an earlier version below the floor: the script still succeeds' '0' "$status"
check_equal 'an earlier version below the floor: no redeploy is started' '0' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"
contains 'the floor is read with get-parameter' 'ssm get-parameter --name /lab/web/min-rollback-version' "$(cat "$FAKE_AWS_CALLS")"
check_equal 'the floor is read once' '1' "$(wc -l < "$FAKE_AWS_CALLS" | tr -d ' ')"
contains 'the summary has the refusal with the exact words' "$expected_refusal" "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the summary says fix forward' 'fix forward' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the summary says that no redeploy was started' 'I did not start the redeploy of web 0.4.0.' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the summary says which version Production runs' 'Production runs web 0.4.1 now.' "$(cat "$GITHUB_STEP_SUMMARY")"
lacks 'the summary does not claim that a redeploy started' 'I started' "$(cat "$GITHUB_STEP_SUMMARY")"
lacks 'the summary does not give the command to roll back' 'gh workflow run' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the log has the warning with the refusal' "::warning title=Rollback refused::${expected_refusal}" "$output"
contains 'the log still has the error of the smoke check' '::error title=Smoke check failed in production::' "$output"
contains 'the summary still says that the job does not change Production' 'The job does not change Production by itself.' "$(cat "$GITHUB_STEP_SUMMARY")"

reset
echo 'web 0.4.0' > "$FAKE_FLOORS"
run_main
check_equal 'an earlier version equal to the floor: the redeploy is started' 'workflow run redeploy.yml --repo jross24/lab-web -f version=0.4.0 -f environment=production' "$(cat "$FAKE_CALLS")"
contains 'an earlier version equal to the floor: the summary says that the redeploy started' 'I started the redeploy of web 0.4.0 to production.' "$(cat "$GITHUB_STEP_SUMMARY")"
lacks 'an earlier version equal to the floor: no notice about the floor' '::notice' "$output"

reset
echo 'web 0.3.0' > "$FAKE_FLOORS"
run_main
check_equal 'an earlier version above the floor: the redeploy is started' '1' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"

reset
echo 'core 0.9.0' > "$FAKE_FLOORS"
run_main
check_equal 'the floor of another service does not count: the redeploy is started' '1' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"

reset
run_main
check_equal 'no floor recorded: the redeploy is started as before' '1' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"
check_equal 'no floor recorded: the script succeeds' '0' "$status"
contains 'no floor recorded: a notice says so' '::notice title=No rollback floor::No rollback floor is recorded for web in production' "$output"
contains 'no floor recorded: the notice names the parameter' '/lab/web/min-rollback-version' "$output"
contains 'no floor recorded: the summary still says that the redeploy started' 'I started the redeploy of web 0.4.0 to production.' "$(cat "$GITHUB_STEP_SUMMARY")"

reset
echo 'An error occurred (AccessDeniedException) when calling the GetParameter operation: not authorized' > "$FAKE_AWS_ERROR"
echo 'web 0.4.1' > "$FAKE_FLOORS"
run_main
check_equal 'a floor that cannot be read: the script succeeds' '0' "$status"
check_equal 'a floor that cannot be read: the redeploy is started as before' '1' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"
contains 'a floor that cannot be read: a notice says so' '::notice title=Rollback floor not read::The rollback floor of web in production could not be read' "$output"
contains 'a floor that cannot be read: the notice has the reason' 'AccessDeniedException' "$output"
contains 'a floor that cannot be read: the summary asks for a check by hand' 'I could not check the rollback floor.' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'a floor that cannot be read: the summary names the parameter' '/lab/web/min-rollback-version' "$(cat "$GITHUB_STEP_SUMMARY")"

reset
echo 'web soon' > "$FAKE_FLOORS"
run_main
check_equal 'a floor that is not a version: the script succeeds' '0' "$status"
check_equal 'a floor that is not a version: the redeploy is started as before' '1' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"
contains 'a floor that is not a version: a notice says so' '::notice title=Rollback floor not read::The rollback floor of web in production could not be read' "$output"
contains 'a floor that is not a version: the notice names the value' 'holds "soon"' "$output"
contains 'a floor that is not a version: the summary asks for a check by hand' 'I could not check the rollback floor.' "$(cat "$GITHUB_STEP_SUMMARY")"

reset
echo 'web 0.4.1' > "$FAKE_FLOORS"
PR_PREVIOUS='' run_main
check_equal 'no earlier version: the floor is not read' '0' "$(wc -l < "$FAKE_AWS_CALLS" | tr -d ' ')"
PR_PREVIOUS=latest run_main
check_equal 'an earlier version that is not a version: the floor is not read' '0' "$(wc -l < "$FAKE_AWS_CALLS" | tr -d ' ')"
PR_PREVIOUS=0.4.1 run_main
check_equal 'the same version as before: the floor is not read' '0' "$(wc -l < "$FAKE_AWS_CALLS" | tr -d ' ')"

reset
echo 'web 0.4.1' > "$FAKE_FLOORS"
PR_PREVIOUS=0.4.0 PR_VERSION=0.4.2 run_main
contains 'the refusal names the earlier version and not the failed one' 'Rollback refused: web 0.4.0 cannot run' "$output"

# The script as a process, like the action runs it. It sources the script of the action preflight, which is a sibling folder.
reset
echo 'web 0.4.1' > "$FAKE_FLOORS"
status=0
output="$(bash "$here/propose-rollback.sh" 2>&1)" || status=$?
check_equal 'the script as a process succeeds when the earlier version is below the floor' '0' "$status"
contains 'the script as a process prints the refusal' '::warning title=Rollback refused::Rollback refused: web 0.4.0 cannot run' "$output"
check_equal 'the script as a process starts no redeploy below the floor' '0' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"
reset
status=0
output="$(bash "$here/propose-rollback.sh" 2>&1)" || status=$?
check_equal 'the script as a process starts the redeploy when there is no floor' '1' "$(wc -l < "$FAKE_CALLS" | tr -d ' ')"
check_equal 'the script as a process succeeds when there is no floor' '0' "$status"

finished=1
if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo 'all tests passed'
