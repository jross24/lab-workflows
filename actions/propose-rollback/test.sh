#!/usr/bin/env bash
# Tests for propose-rollback.sh. Run: bash actions/propose-rollback/test.sh
# The tests use a fake "gh" command. They call no GitHub API.
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
export PATH="$work/bin:$PATH"
export FAKE_CALLS="$work/calls" FAKE_FAILS="$work/fails"
export GITHUB_REPOSITORY='jross24/lab-web' GITHUB_STEP_SUMMARY="$work/summary"
export PR_SERVICE=web PR_VERSION=0.4.1 PR_PREVIOUS=0.4.0

reset() {
  : > "$FAKE_CALLS"
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

finished=1
if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo 'all tests passed'
