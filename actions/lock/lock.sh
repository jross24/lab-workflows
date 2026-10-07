#!/usr/bin/env bash
# The lock of the shared Test environment.
#
# The lock is one item in a DynamoDB table. The actions lock-acquire and lock-release call this script.
# The README of this repository explains why the lock exists and what it does not solve.
#
# Usage: lock.sh acquire | release
# Settings come from environment variables. The actions set them from their inputs:
#   LOCK_TABLE, LOCK_ID, LOCK_TIMEOUT_MINUTES, LOCK_MAX_WAIT_MINUTES, LOCK_POLL_SECONDS
# GitHub sets the run variables: GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.
set -euo pipefail

readonly DEFAULT_TABLE='lab-test-lock'
readonly DEFAULT_LOCK_ID='test-environment'

# The lock ends by itself after this time. The README has the time budget behind this number.
readonly DEFAULT_TIMEOUT_MINUTES=40

# The exit code of try_put when the lock belongs to another run.
readonly HELD=10

# ---------------------------------------------------------------------------
# Pure functions. They call no AWS API and read no clock. test.sh tests them.
# ---------------------------------------------------------------------------

# require_int <name> <value> <minimum>
# Bash reads a number with a leading zero as octal. So 08 is an error and 010 is 8.
# The prefix 10# makes the comparison decimal. The limit of 12 digits keeps the arithmetic safe.
# Every function below that does arithmetic with a checked value uses the prefix 10# too.
require_int() {
  local name="$1" value="${2:-}" minimum="$3"
  if [[ ! "$value" =~ ^[0-9]{1,12}$ ]] || ((10#$value < minimum)); then
    echo "lock: $name must be a whole number of at least $minimum, but it is \"$value\"" >&2
    return 1
  fi
}

# validate_name <what> <value>
# A name goes into a JSON text. This check keeps out quotes and every other special character.
validate_name() {
  if [[ ! "${2:-}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "lock: $1 must use only letters, digits, dot, underscore and hyphen, but it is \"${2:-}\"" >&2
    return 1
  fi
}

# holder_id <repository> <run id> <run attempt>
# The holder names the run that owns the lock, for example jross24/lab-web#123#1.
holder_id() {
  local repository="${1:-}" run_id="${2:-}" attempt="${3:-}"
  if [[ ! "$repository" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
    echo "lock: GITHUB_REPOSITORY must have the form owner/name, but it is \"$repository\"" >&2
    return 1
  fi
  require_int 'GITHUB_RUN_ID' "$run_id" 1 || return 1
  require_int 'GITHUB_RUN_ATTEMPT' "$attempt" 1 || return 1
  echo "${repository}#${run_id}#${attempt}"
}

# run_prefix <holder>
# The holder without the attempt: jross24/lab-web#123#
# A re-run of a run has a new attempt number. So all attempts of one run share this prefix.
run_prefix() {
  local holder="$1"
  echo "${holder%#*}#"
}

# holder_run_url <holder>
# The address of the run of a holder. The log prints it, so a person can look at the run.
holder_run_url() {
  local holder="$1" repository run_id
  repository="${holder%%#*}"
  run_id="${holder#*#}"
  run_id="${run_id%%#*}"
  echo "https://github.com/${repository}/actions/runs/${run_id}"
}

# expiry_epoch <now> <minutes>
# The time at which a lock that starts now ends. The unit of the time is epoch seconds.
expiry_epoch() {
  require_int 'now' "${1:-}" 0 || return 1
  require_int 'minutes' "${2:-}" 1 || return 1
  echo $((10#$1 + 10#$2 * 60))
}

# seconds_between <later> <earlier>
# The number of seconds from the earlier time to the later time. Zero when the later time is not later.
seconds_between() {
  local difference=$((10#$1 - 10#$2))
  echo $((difference > 0 ? difference : 0))
}

# format_duration <seconds>
format_duration() {
  local seconds="$1"
  if ((seconds < 60)); then
    echo "${seconds} s"
  else
    echo "$((seconds / 60)) min $((seconds % 60)) s"
  fi
}

# format_time <epoch seconds>
format_time() {
  date -u -d "@$1" '+%Y-%m-%d %H:%M:%S UTC' 2> /dev/null ||
    date -u -r "$1" '+%Y-%m-%d %H:%M:%S UTC' 2> /dev/null ||
    echo "epoch $1"
}

# The JSON texts of the AWS CLI calls. The inputs are checked, so they need no escaping.
key_json() {
  printf '{"lockId":{"S":"%s"}}' "$1"
}

# item_json <lock id> <holder> <acquired at> <expires at>
item_json() {
  printf '{"lockId":{"S":"%s"},"holder":{"S":"%s"},"acquiredAt":{"N":"%s"},"expiresAt":{"N":"%s"}}' "$1" "$2" "$3" "$4"
}

# The lock is free when there is no item, when the item has expired, or when an earlier attempt of the
# same run owns it. The code does not wait for the TTL deletion of DynamoDB, because that is slow.
readonly ACQUIRE_CONDITION='attribute_not_exists(#id) OR #exp < :now OR begins_with(#holder, :run)'
readonly ACQUIRE_NAMES='{"#id":"lockId","#exp":"expiresAt","#holder":"holder"}'

# acquire_values_json <now> <run prefix>
acquire_values_json() {
  printf '{":now":{"N":"%s"},":run":{"S":"%s"}}' "$1" "$2"
}

# Only the holder can delete the lock.
readonly RELEASE_CONDITION='#holder = :me'
readonly RELEASE_NAMES='{"#holder":"holder"}'

# release_values_json <holder>
release_values_json() {
  printf '{":me":{"S":"%s"}}' "$1"
}

# ---------------------------------------------------------------------------
# The clock and the pause. A test replaces them.
# ---------------------------------------------------------------------------

now_epoch() {
  date +%s
}

pause() {
  sleep "$1"
}

# ---------------------------------------------------------------------------
# The AWS calls. A test replaces the command "aws".
# ---------------------------------------------------------------------------

# try_put <table> <lock id> <holder> <now> <expires at>
# Prints the old holder when the call replaced an item. Prints nothing when there was no item.
# Returns 0 when the call wrote the lock, HELD when the lock belongs to another run, 1 for any other error.
# This function does not rely on "set -e", because its caller can call it in a condition.
try_put() {
  local table="$1" lock_id="$2" holder="$3" now="$4" expires="$5"
  local output error_file status=0
  error_file="$(mktemp)"
  output="$(aws dynamodb put-item \
    --table-name "$table" \
    --item "$(item_json "$lock_id" "$holder" "$now" "$expires")" \
    --condition-expression "$ACQUIRE_CONDITION" \
    --expression-attribute-names "$ACQUIRE_NAMES" \
    --expression-attribute-values "$(acquire_values_json "$now" "$(run_prefix "$holder")")" \
    --return-values ALL_OLD \
    --query 'Attributes.holder.S' --output text 2> "$error_file")" || status=$?

  if [[ "$status" -eq 0 ]]; then
    rm -f "$error_file"
    [[ "$output" == 'None' ]] || echo "$output"
    return 0
  fi
  if grep -q 'ConditionalCheckFailedException' "$error_file"; then
    rm -f "$error_file"
    return "$HELD"
  fi
  cat "$error_file" >&2
  rm -f "$error_file"
  return 1
}

# get_lock <table> <lock id>
# Prints "holder acquired-at expires-at" separated by tabs. Prints nothing when there is no item.
get_lock() {
  local output
  output="$(aws dynamodb get-item \
    --table-name "$1" \
    --key "$(key_json "$2")" \
    --consistent-read \
    --query 'Item.[holder.S, acquiredAt.N, expiresAt.N]' --output text)" || return 1
  [[ "$output" == 'None' ]] || echo "$output"
}

# try_delete <table> <lock id> <holder>
# Returns 0 when the call deleted the lock, HELD when the lock is gone or belongs to another run, 1 for any other error.
try_delete() {
  local table="$1" lock_id="$2" holder="$3"
  local error_file status=0
  error_file="$(mktemp)"
  aws dynamodb delete-item \
    --table-name "$table" \
    --key "$(key_json "$lock_id")" \
    --condition-expression "$RELEASE_CONDITION" \
    --expression-attribute-names "$RELEASE_NAMES" \
    --expression-attribute-values "$(release_values_json "$holder")" 2> "$error_file" > /dev/null || status=$?

  if [[ "$status" -eq 0 ]]; then
    rm -f "$error_file"
    return 0
  fi
  if grep -q 'ConditionalCheckFailedException' "$error_file"; then
    rm -f "$error_file"
    return "$HELD"
  fi
  cat "$error_file" >&2
  rm -f "$error_file"
  return 1
}

# ---------------------------------------------------------------------------
# The two commands
# ---------------------------------------------------------------------------

# Waits until the lock is free, then takes it. Fails when the wait is over.
acquire() {
  local table lock_id timeout_minutes max_wait_minutes poll_seconds holder
  table="${LOCK_TABLE:-$DEFAULT_TABLE}"
  lock_id="${LOCK_ID:-$DEFAULT_LOCK_ID}"
  timeout_minutes="${LOCK_TIMEOUT_MINUTES:-$DEFAULT_TIMEOUT_MINUTES}"
  max_wait_minutes="${LOCK_MAX_WAIT_MINUTES:-20}"
  poll_seconds="${LOCK_POLL_SECONDS:-15}"

  validate_name 'LOCK_TABLE' "$table" || return 1
  validate_name 'LOCK_ID' "$lock_id" || return 1
  require_int 'LOCK_TIMEOUT_MINUTES' "$timeout_minutes" 1 || return 1
  require_int 'LOCK_MAX_WAIT_MINUTES' "$max_wait_minutes" 0 || return 1
  require_int 'LOCK_POLL_SECONDS' "$poll_seconds" 1 || return 1
  holder="$(holder_id "${GITHUB_REPOSITORY:-}" "${GITHUB_RUN_ID:-}" "${GITHUB_RUN_ATTEMPT:-}")" || return 1

  # The values are checked. Make them plain decimal numbers, so 08 is 8 in all the arithmetic below.
  timeout_minutes=$((10#$timeout_minutes))
  max_wait_minutes=$((10#$max_wait_minutes))
  poll_seconds=$((10#$poll_seconds))

  local started deadline now expires status previous remaining
  started="$(now_epoch)"
  deadline=$((started + max_wait_minutes * 60))

  while true; do
    now="$(now_epoch)"
    expires="$(expiry_epoch "$now" "$timeout_minutes")"

    status=0
    previous="$(try_put "$table" "$lock_id" "$holder" "$now" "$expires")" || status=$?

    if [[ "$status" -eq 0 ]]; then
      if [[ -z "$previous" ]]; then
        echo "::notice::The lock of $lock_id is yours ($holder)."
      elif [[ "$previous" == "$holder" ]]; then
        echo "::notice::This run already had the lock of $lock_id ($holder). The expiry starts again."
      else
        echo "::notice::The lock of $lock_id is yours ($holder). It took over from $previous, which had finished or had expired."
      fi
      echo "The lock ends at $(format_time "$expires") ($timeout_minutes min from now). A release that takes longer loses it."
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        echo "holder=${holder}" >> "$GITHUB_OUTPUT"
      fi
      return 0
    fi

    if [[ "$status" -ne "$HELD" ]]; then
      echo "::error::The lock table $table could not be written. This is not a lock conflict. Check the permissions of the role and the table name."
      return 1
    fi

    describe_holder "$table" "$lock_id" "$now"

    remaining=$((deadline - now))
    if ((remaining <= 0)); then
      echo "::error::The Test environment stayed locked for $max_wait_minutes min. Run this release again when the other release has finished."
      return 1
    fi
    echo "Waiting for the lock. $(format_duration "$remaining") of the wait are left."
    pause "$((poll_seconds < remaining ? poll_seconds : remaining))"
  done
}

# Prints who holds the lock. A failure to read it does not stop the wait.
describe_holder() {
  local table="$1" lock_id="$2" now="$3"
  local item holder acquired expires
  item="$(get_lock "$table" "$lock_id")" || item=''
  if [[ -z "$item" ]]; then
    echo "The lock of $lock_id is held, but the holder could not be read. It may have just ended."
    return 0
  fi
  IFS=$'\t' read -r holder acquired expires <<< "$item"
  echo "The lock of $lock_id is held by $holder. $(holder_run_url "$holder")"
  if [[ "$acquired" =~ ^[0-9]+$ && "$expires" =~ ^[0-9]+$ ]]; then
    echo "It started $(format_duration "$(seconds_between "$now" "$acquired")") ago and ends in $(format_duration "$(seconds_between "$expires" "$now")")."
  fi
}

# Deletes the lock when this run holds it. It never fails. A release that fails in the cleanup must not
# fail the release of the application. The expiry removes a lock that stays.
release() {
  local table lock_id holder status=0 item
  table="${LOCK_TABLE:-$DEFAULT_TABLE}"
  lock_id="${LOCK_ID:-$DEFAULT_LOCK_ID}"

  validate_name 'LOCK_TABLE' "$table" || return 1
  validate_name 'LOCK_ID' "$lock_id" || return 1
  holder="$(holder_id "${GITHUB_REPOSITORY:-}" "${GITHUB_RUN_ID:-}" "${GITHUB_RUN_ATTEMPT:-}")" || return 1

  try_delete "$table" "$lock_id" "$holder" || status=$?

  case "$status" in
    0)
      echo "::notice::The lock of $lock_id is released ($holder)."
      ;;
    "$HELD")
      item="$(get_lock "$table" "$lock_id")" || item=''
      if [[ -z "$item" ]]; then
        echo "::warning::The lock of $lock_id is already gone. It probably expired. Nothing to release."
      else
        echo "::warning::The lock of $lock_id belongs to $(cut -f 1 <<< "$item"), not to $holder. This run does not release it."
      fi
      ;;
    *)
      echo "::warning::The lock of $lock_id could not be released. It ends by itself at its expiry time."
      ;;
  esac
  return 0
}

main() {
  case "${1:-}" in
    acquire) acquire ;;
    release) release ;;
    *)
      echo "usage: lock.sh acquire | release" >&2
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
