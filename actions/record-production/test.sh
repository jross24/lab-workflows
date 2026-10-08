#!/usr/bin/env bash
# Tests for record.sh. Run: bash actions/record-production/test.sh   (it needs jq)
#
# The tests use a fake "gh" command. They call no GitHub API.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# On Windows, jq.exe ends each line with CR LF. The runner of GitHub does not. This function strips the CR,
# so the tests give the same result in both places. "export -f" lets the scripts that the tests start use it too.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  jq() { command jq "$@" | tr -d '\r'; }
  export -f jq
fi
# shellcheck source=actions/record-production/record.sh
source "$here/record.sh"

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

# A fake of the gh command.
#   gh release upload <tag> <file> --repo <repo> --clobber   writes the arguments to "calls" and copies the file to "uploaded".
#   gh api repos/<repo>/commits/<tag> --jq .sha              prints the content of the file "commit", or fails if there is none.
# The file "upload-fails" makes the upload fail.
mkdir -p "$work/bin"
cat > "$work/bin/gh" << 'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == release && "$2" == upload ]]; then
  if [[ -f "$FAKE_GH/upload-fails" ]]; then echo 'HTTP 403: Resource not accessible by integration' >&2; exit 1; fi
  echo "$*" >> "$FAKE_GH/calls"
  cp "$4" "$FAKE_GH/uploaded"
  exit 0
fi
if [[ "$1" == api && "$2" == repos/*/commits/* ]]; then
  [[ -f "$FAKE_GH/commit" ]] || { echo 'HTTP 404: Not Found' >&2; exit 1; }
  cat "$FAKE_GH/commit"
  exit 0
fi
echo "fake gh: unexpected call $*" >&2
exit 99
FAKE
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"
export FAKE_GH="$work/gh"
export GITHUB_STEP_SUMMARY="$work/summary"

sha='8eab7224f779e0cc2718d50b19c8a2a56ea39810'
reset() {
  rm -rf "$FAKE_GH" "$work/cwd"
  mkdir -p "$FAKE_GH" "$work/cwd"
  : > "$GITHUB_STEP_SUMMARY"
  export GITHUB_REPOSITORY='jross24/lab-svc-core'
  export RP_SERVICE='core' RP_VERSION='0.8.0' RP_TAG='v0.8.0' RP_COMMIT="$sha"
  export RP_RUN_URL='https://github.com/jross24/lab-svc-core/actions/runs/123'
  export RP_NOW='2026-10-08T12:00:00Z'
  unset RP_FILE
}

run_record() {
  status=0
  output="$(cd "$work/cwd" && record 2>&1)" || status=$?
}

calls() { if [[ -f "$FAKE_GH/calls" ]]; then cat "$FAKE_GH/calls"; fi; }

echo '--- the marker'

expected="{\"service\":\"core\",\"version\":\"0.8.0\",\"tag\":\"v0.8.0\",\"environment\":\"production\",\"commit\":\"$sha\",\"run\":\"https://github.com/jross24/lab-svc-core/actions/runs/123\",\"at\":\"2026-10-08T12:00:00Z\"}"
check_equal 'the marker has the seven fields, in this order' "$expected" \
  "$(marker_json core 0.8.0 v0.8.0 "$sha" https://github.com/jross24/lab-svc-core/actions/runs/123 2026-10-08T12:00:00Z)"
check_equal 'a quote and a backslash in a value stay valid JSON' 'a"b\c' \
  "$(marker_json 'a"b\c' 1.0.0 v1.0.0 x y z | jq -r .service)"
check_equal 'the environment is always production' 'production' "$(marker_json core 0.8.0 v0.8.0 x y z | jq -r .environment)"

echo '--- record'

reset
run_record
check_equal 'a good call succeeds' '0' "$status"
check_equal 'it uploads the file to the release of the tag, and replaces an older file' \
  'release upload v0.8.0 deployed-production.json --repo jross24/lab-svc-core --clobber' "$(calls)"
check_equal 'the uploaded file is the marker' "$expected" "$(jq -c . "$FAKE_GH/uploaded")"
check_equal 'the file is written in the working directory' "$expected" "$(jq -c . "$work/cwd/deployed-production.json")"
contains 'the log says what happened' '::notice title=Production marker::Recorded core 0.8.0 in Production. The release v0.8.0 has the asset deployed-production.json now.' "$output"
contains 'the summary names the release' 'v0.8.0' "$(cat "$GITHUB_STEP_SUMMARY")"

reset
export RP_FILE='other.json'
run_record
check_equal 'RP_FILE sets the name of the asset' 'release upload v0.8.0 other.json --repo jross24/lab-svc-core --clobber' "$(calls)"

reset
unset RP_NOW
run_record
check_equal 'without RP_NOW the time is the time now, in UTC' 'yes' \
  "$(jq -r .at "$work/cwd/deployed-production.json" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' && echo yes)"

echo '--- the commit'

reset
export RP_COMMIT=''
printf '%s\n' "$sha" > "$FAKE_GH/commit"
run_record
check_equal 'an empty commit is read from the tag' "$sha" "$(jq -r .commit "$FAKE_GH/uploaded")"

reset
export RP_COMMIT=''
run_record
check_equal 'a commit that cannot be read does not stop the marker' '0' "$status"
check_equal 'the marker then has an empty commit' '' "$(jq -r .commit "$FAKE_GH/uploaded")"
contains 'the log has a warning' '::warning title=Commit not found::' "$output"

echo '--- wrong input'

reset
export RP_VERSION='0.8'
run_record
check_equal 'a version that is not x.y.z fails' '1' "$status"
contains 'the message names the version' '::error title=Wrong input::The version "0.8" does not have the form 1.2.3.' "$output"
check_equal 'nothing is uploaded' '' "$(calls)"

reset
export RP_TAG='v0.9.0'
run_record
check_equal 'a tag that is not v<version> fails' '1' "$status"
contains 'the message names the tag' 'The tag "v0.9.0" is not v0.8.0.' "$output"
check_equal 'nothing is uploaded after a wrong tag' '' "$(calls)"

reset
export RP_SERVICE='Core;rm'
run_record
check_equal 'a service name with wrong characters fails' '1' "$status"

reset
unset RP_SERVICE
run_record
check_equal 'a missing service fails' '1' "$status"
contains 'the message names the setting' 'RP_SERVICE' "$output"

reset
export GITHUB_REPOSITORY='nowhere'
run_record
check_equal 'a repository that is not owner/name fails' '1' "$status"

echo '--- the upload fails'

reset
: > "$FAKE_GH/upload-fails"
run_record
check_equal 'a failed upload fails the step' '1' "$status"
contains 'the message says that Production has no marker' '::error title=Marker not recorded::' "$output"
contains 'the message says what to do' 'Run the job again.' "$output"

finished=1
if [[ "$failures" -ne 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo 'all tests passed'
