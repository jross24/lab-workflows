#!/usr/bin/env bash
# Tests for lock.sh. Run: bash actions/lock/test.sh
#
# Part 1 tests the pure functions.
# Part 2 tests acquire and release in this shell, against a fake "aws" command and a fake clock.
# Part 3 runs the real script as a process, for the argument checks and the exit codes.
# The tests never call AWS and never wait.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=actions/lock/lock.sh
source "$here/lock.sh"

failures=0

check() {
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
    echo "$haystack" | sed 's/^/        /'
    failures=$((failures + 1))
  fi
}

# --- Part 1: the pure functions ---

check 'holder id has repository, run id and attempt' 'jross24/lab-web#123#1' "$(holder_id 'jross24/lab-web' 123 1)"
check 'holder id of a re-run has the new attempt' 'jross24/lab-web#123#2' "$(holder_id 'jross24/lab-web' 123 2)"
check 'holder id rejects a repository with no owner' 'failed' "$(holder_id 'lab-web' 123 1 2> /dev/null || echo failed)"
check 'holder id rejects a quote in the repository' 'failed' "$(holder_id 'jross24/lab"web' 123 1 2> /dev/null || echo failed)"
check 'holder id rejects an empty run id' 'failed' "$(holder_id 'jross24/lab-web' '' 1 2> /dev/null || echo failed)"
check 'holder id rejects a run id that is not a number' 'failed' "$(holder_id 'jross24/lab-web' 12a 1 2> /dev/null || echo failed)"
check 'holder id rejects attempt 0' 'failed' "$(holder_id 'jross24/lab-web' 123 0 2> /dev/null || echo failed)"

check 'run prefix drops the attempt' 'jross24/lab-web#123#' "$(run_prefix 'jross24/lab-web#123#2')"
check 'run prefix keeps a longer run id apart' 'jross24/lab-web#1234#' "$(run_prefix 'jross24/lab-web#1234#1')"

check 'run url of a holder' 'https://github.com/jross24/lab-svc-core/actions/runs/77' "$(holder_run_url 'jross24/lab-svc-core#77#3')"

check 'expiry is now plus the minutes' '1001800' "$(expiry_epoch 1000000 30)"
check 'expiry of one minute' '1000060' "$(expiry_epoch 1000000 1)"
check 'expiry rejects 0 minutes' 'failed' "$(expiry_epoch 1000000 0 2> /dev/null || echo failed)"
check 'expiry rejects minutes that are not a number' 'failed' "$(expiry_epoch 1000000 soon 2> /dev/null || echo failed)"
check 'expiry rejects an empty time' 'failed' "$(expiry_epoch '' 30 2> /dev/null || echo failed)"

check 'seconds between two times' '100' "$(seconds_between 1000100 1000000)"
check 'seconds between is 0 when the time has passed' '0' "$(seconds_between 1000000 1000100)"
check 'seconds between the same time' '0' "$(seconds_between 5 5)"

check 'duration under a minute' '45 s' "$(format_duration 45)"
check 'duration of a minute and more' '1 min 30 s' "$(format_duration 90)"
check 'duration of an hour' '60 min 0 s' "$(format_duration 3600)"

check 'integer check accepts the minimum' 'ok' "$(require_int x 0 0 2> /dev/null && echo ok)"
check 'integer check rejects below the minimum' 'failed' "$(require_int x 0 1 2> /dev/null || echo failed)"
check 'integer check rejects a negative number' 'failed' "$(require_int x -5 0 2> /dev/null || echo failed)"
check 'integer check rejects text' 'failed' "$(require_int x '1 2' 0 2> /dev/null || echo failed)"

check 'name check accepts a normal name' 'ok' "$(validate_name table lab-test-lock 2> /dev/null && echo ok)"
check 'name check rejects a quote' 'failed' "$(validate_name table 'a"b' 2> /dev/null || echo failed)"
check 'name check rejects a space' 'failed' "$(validate_name table 'a b' 2> /dev/null || echo failed)"
check 'name check rejects an empty name' 'failed' "$(validate_name table '' 2> /dev/null || echo failed)"

check 'key json' '{"lockId":{"S":"test-environment"}}' "$(key_json test-environment)"
check 'item json' '{"lockId":{"S":"test-environment"},"holder":{"S":"jross24/lab-web#1#1"},"acquiredAt":{"N":"10"},"expiresAt":{"N":"1810"}}' \
  "$(item_json test-environment 'jross24/lab-web#1#1' 10 1810)"
check 'acquire values json' '{":now":{"N":"10"},":run":{"S":"jross24/lab-web#1#"}}' "$(acquire_values_json 10 'jross24/lab-web#1#')"
check 'release values json' '{":me":{"S":"jross24/lab-web#1#1"}}' "$(release_values_json 'jross24/lab-web#1#1')"
check 'the acquire condition does not wait for the TTL deletion' \
  'attribute_not_exists(#id) OR #exp < :now OR begins_with(#holder, :run)' "$ACQUIRE_CONDITION"
check 'the release condition names the holder' '#holder = :me' "$RELEASE_CONDITION"

# --- Part 2: acquire and release in this shell ---

work="$(mktemp -d)"
finished=0
# A test script that stops early must not look like a pass. File descriptor 3 is the real output.
# A test can redirect the output of a command, and the trap must still reach the log.
exec 3>&1
trap 'rm -rf "$work"; if [[ "$finished" -ne 1 ]]; then echo "FAIL  the test script stopped before the end" >&3; fi' EXIT
state="$work/state"
bin="$work/bin"
mkdir -p "$bin"

# A fake of the AWS CLI. It keeps one DynamoDB item in the files of $FAKE_STATE.
# It applies the rule of the condition itself. The tests check the text of the condition separately.
cat > "$bin/aws" << 'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state="$FAKE_STATE"
value_of() { if [[ -f "$state/$1" ]]; then cat "$state/$1"; fi; }
json_value() { sed -n "s/.*\"$2\":{\"$3\":\"\([^\"]*\)\"}.*/\1/p" <<< "$1"; }

[[ "$1" == dynamodb ]] || { echo "fake aws: unexpected service $1" >&2; exit 99; }
command="$2"
shift 2
item=''
values=''
condition=''
while (($#)); do
  case "$1" in
    --item) item="$2"; shift 2 ;;
    --expression-attribute-values) values="$2"; shift 2 ;;
    --condition-expression) condition="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "$command $condition" >> "$state/calls"

if [[ -s "$state/error" ]]; then
  cat "$state/error" >&2
  exit 254
fi

holder="$(value_of holder)"
acquired="$(value_of acquired)"
expires="$(value_of expires)"
refused='An error occurred (ConditionalCheckFailedException) when calling the operation: The conditional request failed'

case "$command" in
  put-item)
    now="$(json_value "$values" ':now' N)"
    run="$(json_value "$values" ':run' S)"
    if [[ -z "$holder" || "$expires" -lt "$now" || "$holder" == "$run"* ]]; then
      printf '%s' "$(json_value "$item" holder S)" > "$state/holder"
      printf '%s' "$(json_value "$item" acquiredAt N)" > "$state/acquired"
      printf '%s' "$(json_value "$item" expiresAt N)" > "$state/expires"
      echo "${holder:-None}"
    else
      echo "$refused" >&2
      exit 254
    fi
    ;;
  get-item)
    if [[ -z "$holder" ]]; then echo None; else printf '%s\t%s\t%s\n' "$holder" "$acquired" "$expires"; fi
    ;;
  delete-item)
    me="$(json_value "$values" ':me' S)"
    if [[ -n "$holder" && "$holder" == "$me" ]]; then
      rm -f "$state/holder" "$state/acquired" "$state/expires"
    else
      echo "$refused" >&2
      exit 254
    fi
    ;;
  *)
    echo "fake aws: unexpected command $command" >&2
    exit 99
    ;;
esac
FAKE
chmod +x "$bin/aws"
export PATH="$bin:$PATH"
export FAKE_STATE="$state"

# The fake clock. A pause moves the clock and does not wait.
# A test can set RELEASE_AFTER=n. Then the other run releases the lock during pause number n.
now_epoch() {
  echo "$NOW"
}
pause() {
  NOW=$((NOW + $1))
  PAUSED=$((PAUSED + $1))
  PAUSES=$((PAUSES + 1))
  # A wait loop that never ends must fail the test and not run for ever. A real test pauses 8 times at most.
  if ((PAUSES > 50)); then
    echo 'FAIL  the wait loop does not end' >&3
    exit 1
  fi
  if ((PAUSES == RELEASE_AFTER)); then
    rm -f "$state/holder" "$state/acquired" "$state/expires"
  fi
}

reset() {
  rm -rf "$state"
  mkdir -p "$state"
  : > "$state/calls"
  NOW=1000000
  PAUSED=0
  PAUSES=0
  RELEASE_AFTER=0
  export GITHUB_REPOSITORY='jross24/lab-web' GITHUB_RUN_ID=123 GITHUB_RUN_ATTEMPT=1
  export LOCK_TIMEOUT_MINUTES=30 LOCK_MAX_WAIT_MINUTES=20 LOCK_POLL_SECONDS=15
  export GITHUB_OUTPUT="$work/github-output"
  : > "$GITHUB_OUTPUT"
}

# set_lock <holder> <acquired at> <expires at>
set_lock() {
  printf '%s' "$1" > "$state/holder"
  printf '%s' "$2" > "$state/acquired"
  printf '%s' "$3" > "$state/expires"
}

stored_holder() {
  if [[ -f "$state/holder" ]]; then cat "$state/holder"; fi
}

stored_expires() {
  if [[ -f "$state/expires" ]]; then cat "$state/expires"; fi
}

calls_of() {
  grep -c "^$1 " "$state/calls" || true
}

# run_command <function> : runs it in this shell, so the clock changes stay. Sets $status and $output.
run_command() {
  status=0
  "$1" > "$work/output" 2>&1 || status=$?
  output="$(cat "$work/output")"
}

echo '--- acquire'

reset
run_command acquire
check 'a free lock is taken at once' '0' "$status"
check 'the holder is stored' 'jross24/lab-web#123#1' "$(stored_holder)"
check 'the expiry is 30 minutes from now' '1001800' "$(stored_expires)"
check 'one write and no wait' '1 0' "$(calls_of put-item) $PAUSED"
check 'the holder is an output of the action' 'holder=jross24/lab-web#123#1' "$(cat "$GITHUB_OUTPUT")"
contains 'the log says that the lock is yours' 'is yours (jross24/lab-web#123#1)' "$output"
contains 'the log says when the lock ends' 'The lock ends at' "$output"
contains 'the call used the condition without the TTL' "put-item $ACQUIRE_CONDITION" "$(cat "$state/calls")"

reset
LOCK_TIMEOUT_MINUTES=5 run_command acquire
check 'the timeout input sets the expiry' '1000300' "$(stored_expires)"

reset
set_lock 'jross24/lab-svc-core#77#1' 999900 1000100
run_command acquire
check 'it waits for a lock that expires, then takes it' '0' "$status"
check 'the new holder is stored' 'jross24/lab-web#123#1' "$(stored_holder)"
check 'it waited about 100 seconds, in steps of 15' '105 7' "$PAUSED $PAUSES"
contains 'the log names the holder' 'is held by jross24/lab-svc-core#77#1' "$output"
contains 'the log gives the run of the holder' 'https://github.com/jross24/lab-svc-core/actions/runs/77' "$output"
contains 'the log gives the time left' 'ends in 1 min 40 s' "$output"
contains 'the log says the lock took over from an expired holder' 'took over from jross24/lab-svc-core#77#1' "$output"

reset
set_lock 'jross24/lab-svc-core#77#1' 1000000 9999999
LOCK_MAX_WAIT_MINUTES=1 run_command acquire
check 'it fails when the wait is over' '1' "$status"
check 'it waited exactly the wait that it was given' '60' "$PAUSED"
check 'it tried at 0, 15, 30, 45 and 60 seconds' '5' "$(calls_of put-item)"
check 'the other holder still has the lock' 'jross24/lab-svc-core#77#1' "$(stored_holder)"
contains 'the error says that the environment stayed locked' 'stayed locked for 1 min' "$output"
check 'a failed acquire has no holder output' '' "$(cat "$GITHUB_OUTPUT")"

reset
set_lock 'jross24/lab-svc-core#77#1' 1000000 9999999
LOCK_MAX_WAIT_MINUTES=0 run_command acquire
check 'a wait of 0 minutes fails at once when the lock is held' '1 0' "$status $PAUSED"

reset
set_lock 'jross24/lab-svc-core#77#1' 1000000 9999999
RELEASE_AFTER=1
run_command acquire
check 'it takes the lock when the other run releases it' '0 jross24/lab-web#123#1' "$status $(stored_holder)"
check 'it waited for one step only' '15' "$PAUSED"

reset
set_lock 'jross24/lab-web#123#1' 999000 1000500
run_command acquire
check 'the same holder gets the lock again' '0 jross24/lab-web#123#1' "$status $(stored_holder)"
check 'the expiry starts again' '1001800' "$(stored_expires)"
check 'it did not wait' '0' "$PAUSED"
contains 'the log says that the run already had the lock' 'already had the lock' "$output"

reset
GITHUB_RUN_ATTEMPT=2
set_lock 'jross24/lab-web#123#1' 999000 9999999
run_command acquire
check 'a re-run takes the lock of its own earlier attempt' '0 jross24/lab-web#123#2' "$status $(stored_holder)"
contains 'the log names the earlier attempt' 'took over from jross24/lab-web#123#1' "$output"

reset
set_lock 'jross24/lab-web#1234#1' 1000000 9999999
LOCK_MAX_WAIT_MINUTES=0 run_command acquire
check 'run 1234 does not count as run 123' '1 jross24/lab-web#1234#1' "$status $(stored_holder)"

reset
set_lock 'jross24/lab-svc-core#77#1' 1000000 9999999
GITHUB_REPOSITORY='jross24/lab-svc-core' GITHUB_RUN_ID=78 LOCK_MAX_WAIT_MINUTES=0 run_command acquire
check 'a different run of the same repository does not take the lock' '1 jross24/lab-svc-core#77#1' "$status $(stored_holder)"

reset
set_lock 'jross24/lab-svc-core#77#1' 990000 999999
run_command acquire
check 'a lock that has expired is taken at once, with no TTL deletion' '0 jross24/lab-web#123#1 0' "$status $(stored_holder) $PAUSED"

reset
set_lock 'jross24/lab-svc-core#77#1' 990000 1000000
run_command acquire
check 'a lock that expires exactly now is still held at that second' '0 15' "$status $PAUSED"

reset
echo 'An error occurred (AccessDeniedException) when calling the PutItem operation: not authorized' > "$state/error"
run_command acquire
check 'an AWS error is not a lock conflict: it fails at once' '1 1 0' "$status $(calls_of put-item) $PAUSED"
contains 'the error says that it is not a conflict' 'This is not a lock conflict' "$output"
contains 'the log has the text of the AWS error' 'AccessDeniedException' "$output"

echo '--- release'

reset
set_lock 'jross24/lab-web#123#1' 1000000 1001800
run_command release
check 'the holder deletes the lock' '0 ' "$status $(stored_holder)"
contains 'the log says that the lock is released' 'is released' "$output"

reset
run_command release
check 'a lock that is gone is not an error' '0' "$status"
contains 'the log warns that the lock is gone' '::warning::The lock of test-environment is already gone' "$output"

reset
set_lock 'jross24/lab-svc-core#77#1' 1000000 1001800
run_command release
check 'a lock of another run is not deleted and is not an error' '0 jross24/lab-svc-core#77#1' "$status $(stored_holder)"
contains 'the log warns about the other holder' '::warning::The lock of test-environment belongs to jross24/lab-svc-core#77#1' "$output"

reset
set_lock 'jross24/lab-web#123#1' 1000000 1001800
GITHUB_RUN_ATTEMPT=2 run_command release
check 'attempt 2 does not delete the lock of attempt 1' '0 jross24/lab-web#123#1' "$status $(stored_holder)"

reset
set_lock 'jross24/lab-web#123#1' 1000000 1001800
echo 'An error occurred (ThrottlingException) when calling the DeleteItem operation: slow down' > "$state/error"
run_command release
check 'an AWS error never fails the release' '0' "$status"
contains 'the log warns that the lock could not be released' '::warning::The lock of test-environment could not be released' "$output"

# --- Part 3: the real script as a process ---

echo '--- the script as a process'

run_script() {
  status=0
  output="$(env GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}" GITHUB_RUN_ID="${GITHUB_RUN_ID:-}" GITHUB_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}" \
    LOCK_TIMEOUT_MINUTES="${LOCK_TIMEOUT_MINUTES:-}" LOCK_MAX_WAIT_MINUTES="${LOCK_MAX_WAIT_MINUTES:-}" \
    LOCK_POLL_SECONDS="${LOCK_POLL_SECONDS:-}" LOCK_ID="${LOCK_ID:-}" LOCK_TABLE="${LOCK_TABLE:-}" \
    bash "$here/lock.sh" "$@" 2>&1)" || status=$?
}

reset
run_script acquire
check 'the script takes a free lock' '0 jross24/lab-web#123#1' "$status $(stored_holder)"

reset
run_script release
check 'the script releases a lock that is not held, with success' '0' "$status"

reset
set_lock 'jross24/lab-svc-core#77#1' 1000000 99999999999
LOCK_MAX_WAIT_MINUTES=0 run_script acquire
check 'the script fails when it cannot wait' '1' "$status"

reset
GITHUB_RUN_ID='' run_script acquire
check 'a missing run id fails' '1' "$status"
contains 'the message names GITHUB_RUN_ID' 'GITHUB_RUN_ID' "$output"
check 'a missing run id makes no AWS call' '0' "$(wc -l < "$state/calls" | tr -d ' ')"

reset
LOCK_TIMEOUT_MINUTES=abc run_script acquire
check 'a timeout that is not a number fails' '1' "$status"
contains 'the message names LOCK_TIMEOUT_MINUTES' 'LOCK_TIMEOUT_MINUTES' "$output"

reset
LOCK_TIMEOUT_MINUTES=0 run_script acquire
check 'a timeout of 0 fails' '1' "$status"

reset
LOCK_POLL_SECONDS=0 run_script acquire
check 'a poll of 0 seconds fails' '1' "$status"

reset
LOCK_ID='a"b' run_script acquire
check 'a lock id with a quote fails' '1' "$status"
check 'a lock id with a quote makes no AWS call' '0' "$(wc -l < "$state/calls" | tr -d ' ')"

reset
LOCK_TABLE='bad table' run_script release
check 'a table name with a space fails, also for release' '1' "$status"

reset
run_script nonsense
check 'an unknown command fails with code 2' '2' "$status"
contains 'the usage message' 'usage: lock.sh acquire | release' "$output"

reset
run_script
check 'no command fails with code 2' '2' "$status"

finished=1
if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo 'all tests passed'
