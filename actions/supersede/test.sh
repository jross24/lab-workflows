#!/usr/bin/env bash
# Tests for supersede.sh. Run: bash actions/supersede/test.sh   (it needs jq)
#
# The tests use a fake "gh" command that answers from files. They call no GitHub API.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# On Windows, jq.exe ends each line with CR LF. The runner of GitHub does not. This function strips the CR,
# so the tests give the same result in both places. "export -f" lets the scripts that the tests start use it too.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  jq() { command jq "$@" | tr -d '\r'; }
  export -f jq
fi
# shellcheck source=actions/supersede/supersede.sh
source "$here/supersede.sh"

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

work="$(mktemp -d)"
finished=0
exec 3>&1
trap 'rm -rf "$work"; if [[ "$finished" -ne 1 ]]; then echo "FAIL  the test script stopped before the end" >&3; fi' EXIT

# A fake of the gh command. Each API path maps to a file in $FAKE_GH. The file name is the path with / ? & = replaced by _.
# "gh api <path> --jq <filter>" applies the filter with jq. "gh run cancel" writes the id to the file "cancelled".
mkdir -p "$work/bin"
cat > "$work/bin/gh" << 'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == run && "$2" == cancel ]]; then
  if [[ -f "$FAKE_GH/cancel-fails" ]]; then echo 'HTTP 403: Resource not accessible by integration' >&2; exit 1; fi
  echo "$3" >> "$FAKE_GH/cancelled"
  exit 0
fi
[[ "$1" == api ]] || { echo "fake gh: unexpected call $*" >&2; exit 99; }
path="$2"
shift 2
file="$FAKE_GH/$(tr '/?&=' '____' <<< "$path")"
if [[ -f "$file.error" ]]; then echo 'HTTP 500' >&2; exit 1; fi
[[ -f "$file" ]] || { echo "fake gh: no fixture for $path" >&2; exit 98; }
if [[ "${1:-}" == --jq ]]; then
  jq -r "$2" "$file"
else
  cat "$file"
fi
FAKE
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"
export FAKE_GH="$work/gh"
export GITHUB_REPOSITORY='jross24/lab-web' GITHUB_RUN_ID=300 SUPERSEDE_TAG='v0.4.1'
export GITHUB_STEP_SUMMARY="$work/summary"

fixture() { # fixture <api path> <json>
  mkdir -p "$FAKE_GH"
  printf '%s\n' "$2" > "$FAKE_GH/$(tr '/?&=' '____' <<< "$1")"
}

reset() {
  rm -rf "$FAKE_GH"
  mkdir -p "$FAKE_GH"
  : > "$GITHUB_STEP_SUMMARY"
  # My run is 300 of workflow 7.
  fixture 'repos/jross24/lab-web/actions/runs/300' '{"id":300,"workflow_id":7,"status":"in_progress"}'
}

cancelled() {
  if [[ -f "$FAKE_GH/cancelled" ]]; then tr '\n' ' ' < "$FAKE_GH/cancelled" | sed 's/ $//'; fi
}

waiting_runs='repos/jross24/lab-web/actions/runs?status=waiting&per_page=100'

run_supersede() {
  status=0
  output="$(supersede 2>&1)" || status=$?
}

echo '--- the filters'

runs='{"workflow_runs":[
  {"id":100,"workflow_id":7,"status":"waiting"},
  {"id":250,"workflow_id":7,"status":"waiting"},
  {"id":299,"workflow_id":9,"status":"waiting"},
  {"id":310,"workflow_id":7,"status":"waiting"},
  {"id":200,"workflow_id":7,"status":"in_progress"}]}'
check_equal 'only older waiting runs of the same workflow are listed' '100 250' "$(older_waiting_runs 300 7 "$runs" | tr '\n' ' ' | sed 's/ $//')"
check_equal 'my own run is not listed' '' "$(older_waiting_runs 100 7 '{"workflow_runs":[{"id":100,"workflow_id":7,"status":"waiting"}]}')"
check_equal 'a job that waits and ends with the suffix counts' 'yes' "$(waits_in_job deploy-production '{"jobs":[{"name":"release / deploy-production","status":"waiting"}]}' && echo yes)"
check_equal 'a job with the suffix that is not waiting does not count' 'no' "$(waits_in_job deploy-production '{"jobs":[{"name":"release / deploy-production","status":"in_progress"}]}' || echo no)"
check_equal 'a waiting job with another name does not count' 'no' "$(waits_in_job deploy-production '{"jobs":[{"name":"release / deploy-staging","status":"waiting"}]}' || echo no)"

echo '--- supersede'

reset
fixture "$waiting_runs" '{"workflow_runs":[{"id":250,"workflow_id":7,"status":"waiting"}]}'
fixture 'repos/jross24/lab-web/actions/runs/250/jobs' '{"jobs":[{"name":"release / version","status":"completed"},{"name":"release / deploy-production","status":"waiting"}]}'
fixture 'repos/jross24/lab-web/actions/runs/250' '{"id":250,"workflow_id":7,"status":"waiting"}'
run_supersede
check_equal 'an older run that waits in the production job is cancelled' '0 250' "$status $(cancelled)"
contains 'the log names the cancelled run and the new release' 'Cancelled run https://github.com/jross24/lab-web/actions/runs/250. It waited for the production reviewer, and v0.4.1 contains its changes.' "$output"
contains 'the summary lists the cancelled run' '/actions/runs/250' "$(cat "$GITHUB_STEP_SUMMARY")"
contains 'the log counts the cancelled runs' '1 older run(s) cancelled.' "$output"

reset
fixture "$waiting_runs" '{"workflow_runs":[]}'
run_supersede
check_equal 'no waiting run means nothing to cancel' '0 ' "$status $(cancelled)"
contains 'the log says so' 'No older run of this workflow waits for the production reviewer.' "$output"

reset
fixture "$waiting_runs" '{"workflow_runs":[{"id":310,"workflow_id":7,"status":"waiting"},{"id":250,"workflow_id":9,"status":"waiting"}]}'
run_supersede
check_equal 'a newer run and a run of another workflow stay' '0 ' "$status $(cancelled)"

reset
fixture "$waiting_runs" '{"workflow_runs":[{"id":250,"workflow_id":7,"status":"waiting"}]}'
fixture 'repos/jross24/lab-web/actions/runs/250/jobs' '{"jobs":[{"name":"release / deploy-staging","status":"waiting"}]}'
run_supersede
check_equal 'a run that waits in another job stays' '0 ' "$status $(cancelled)"
contains 'the log says why it stays' 'Run 250 waits, but not in a job that ends with deploy-production. It stays.' "$output"

reset
fixture "$waiting_runs" '{"workflow_runs":[{"id":250,"workflow_id":7,"status":"waiting"}]}'
fixture 'repos/jross24/lab-web/actions/runs/250/jobs' '{"jobs":[{"name":"release / deploy-production","status":"waiting"}]}'
fixture 'repos/jross24/lab-web/actions/runs/250' '{"id":250,"workflow_id":7,"status":"in_progress"}'
run_supersede
check_equal 'a run that was approved in the meantime is not cancelled' '0 ' "$status $(cancelled)"
contains 'the log says that the status changed' 'has the status "in_progress" now. It stays.' "$output"

reset
fixture "$waiting_runs" '{"workflow_runs":[{"id":100,"workflow_id":7,"status":"waiting"},{"id":250,"workflow_id":7,"status":"waiting"}]}'
for id in 100 250; do
  fixture "repos/jross24/lab-web/actions/runs/$id/jobs" '{"jobs":[{"name":"release / deploy-production","status":"waiting"}]}'
  fixture "repos/jross24/lab-web/actions/runs/$id" "{\"id\":$id,\"workflow_id\":7,\"status\":\"waiting\"}"
done
run_supersede
check_equal 'two older runs are both cancelled' '0 100 250' "$status $(cancelled)"

reset
fixture "$waiting_runs" '{"workflow_runs":[{"id":250,"workflow_id":7,"status":"waiting"}]}'
fixture 'repos/jross24/lab-web/actions/runs/250/jobs' '{"jobs":[{"name":"release / deploy-production","status":"waiting"}]}'
fixture 'repos/jross24/lab-web/actions/runs/250' '{"id":250,"workflow_id":7,"status":"waiting"}'
: > "$FAKE_GH/cancel-fails"
run_supersede
check_equal 'a cancel that fails is a warning and not an error' '0 ' "$status $(cancelled)"
contains 'the warning names the run' '::warning::supersede: run 250 could not be cancelled.' "$output"

reset
: > "$FAKE_GH/repos_jross24_lab-web_actions_runs?status=waiting.error"
mv "$FAKE_GH/repos_jross24_lab-web_actions_runs?status=waiting.error" "$FAKE_GH/$(tr '/?&=' '____' <<< "$waiting_runs").error"
run_supersede
check_equal 'a list that cannot be read is a warning and not an error' '0 ' "$status $(cancelled)"
contains 'the warning says that the guard keeps the order' 'The guard in the deploy job keeps the order.' "$output"

reset
rm "$FAKE_GH/repos_jross24_lab-web_actions_runs_300"
run_supersede
check_equal 'a run that cannot be read is a warning and not an error' '0' "$status"

GITHUB_RUN_ID=abc run_supersede
check_equal 'a bad run id is a warning and not an error' '0' "$status"
contains 'the warning says that nothing was cancelled' 'Nothing was cancelled.' "$output"

finished=1
if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo 'all tests passed'
