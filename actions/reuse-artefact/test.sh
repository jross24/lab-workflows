#!/usr/bin/env bash
# Tests for reuse.sh. Run: bash actions/reuse-artefact/test.sh   (it needs jq and sha256sum)
#
# The tests use a fake "gh" command that answers from files. They call no GitHub API.
# The fake fails on every call that changes a release, so a test proves that the script never replaces a file.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# On Windows, jq.exe ends each line with CR LF. The runner of GitHub does not. This function strips the CR,
# so the tests give the same result in both places. "export -f" lets the scripts that the tests start use it too.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  jq() { command jq "$@" | tr -d '\r'; }
  export -f jq
fi
# shellcheck source=actions/reuse-artefact/reuse.sh
source "$here/reuse.sh"

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

# A fake of the gh command. The directory $FAKE_GH holds its answers:
#   release.json      the answer of "gh release view". Without it the release does not exist.
#   view-error        if the file exists, "gh release view" fails with a server error.
#   assets/<name>     the files that "gh release download" can give.
# Every call is written to $FAKE_GH/calls. Any call other than view and download fails.
mkdir -p "$work/bin"
cat > "$work/bin/gh" << 'FAKE'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_GH/calls"
if [[ "$1 $2" == "release view" ]]; then
  if [[ -f "$FAKE_GH/view-error" ]]; then echo 'HTTP 502: Bad Gateway' >&2; exit 1; fi
  if [[ ! -f "$FAKE_GH/release.json" ]]; then echo 'release not found' >&2; exit 1; fi
  cat "$FAKE_GH/release.json"
  exit 0
fi
if [[ "$1 $2" == "release download" ]]; then
  shift 3
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --pattern ]]; then
      [[ -f "$FAKE_GH/assets/$2" ]] || { echo "no assets match the file pattern $2" >&2; exit 1; }
      cp "$FAKE_GH/assets/$2" .
      shift
    fi
    shift
  done
  exit 0
fi
echo "fake gh: unexpected call $*" >&2
exit 99
FAKE
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"
export FAKE_GH="$work/fake"

TAG='v1.2.3'
ZIP="cdk-out-${TAG}.zip"
SUM="cdk-out-${TAG}.zip.sha256"

# release_json <asset name:state>...   Prints the JSON that "gh release view --json assets" prints.
release_json() {
  local first=1 spec
  printf '{"assets":['
  for spec in "$@"; do
    [[ "$first" == 1 ]] || printf ','
    first=0
    printf '{"name":"%s","state":"%s","size":10}' "${spec%%:*}" "${spec##*:}"
  done
  printf ']}\n'
}

# yes_no <command>...   Prints yes if the command succeeds, and no if it fails.
yes_no() {
  if "$@" > /dev/null 2>&1; then echo yes; else echo no; fi
}

# --- release_has_artefact ---
check_equal 'the zip and its SHA-256 file make an artefact' 'yes' \
  "$(yes_no release_has_artefact "$TAG" "$(release_json "$ZIP:uploaded" "$SUM:uploaded")")"
check_equal 'other files on the release do not matter' 'yes' \
  "$(yes_no release_has_artefact "$TAG" "$(release_json contract.json:uploaded "$ZIP:uploaded" "$SUM:uploaded" tested-with.json:uploaded)")"
check_equal 'a release with no assets has no artefact' 'no' \
  "$(yes_no release_has_artefact "$TAG" "$(release_json)")"
check_equal 'the zip alone is not an artefact' 'no' \
  "$(yes_no release_has_artefact "$TAG" "$(release_json "$ZIP:uploaded")")"
check_equal 'the SHA-256 file alone is not an artefact' 'no' \
  "$(yes_no release_has_artefact "$TAG" "$(release_json "$SUM:uploaded")")"
check_equal 'the files of another version are not an artefact' 'no' \
  "$(yes_no release_has_artefact "$TAG" "$(release_json cdk-out-v1.2.4.zip:uploaded cdk-out-v1.2.4.zip.sha256:uploaded)")"
check_equal 'an upload that did not finish is not an artefact' 'no' \
  "$(yes_no release_has_artefact "$TAG" "$(release_json "$ZIP:starter" "$SUM:uploaded")")"
check_equal 'the dots of the tag are not wildcards' 'no' \
  "$(yes_no release_has_artefact "$TAG" "$(release_json cdk-out-v1x2x3.zip:uploaded cdk-out-v1x2x3.zip.sha256:uploaded)")"

# --- verify_artefact ---
# make_assets <dir>   Puts a good zip and its SHA-256 file in the directory.
make_assets() {
  mkdir -p "$1"
  printf 'the bytes of the first build\n' > "$1/$ZIP"
  (cd "$1" && sha256sum "$ZIP" > "$SUM")
}
good_digest="$(printf 'the bytes of the first build\n' | sha256sum | cut -d ' ' -f 1)"

make_assets "$work/v1"
check_equal 'a matching zip passes and gives the digest' "$good_digest" "$(cd "$work/v1" && verify_artefact "$TAG")"

make_assets "$work/v2"
printf 'the bytes of another build\n' > "$work/v2/$ZIP"
check_equal 'a changed zip fails' 'failed' "$(cd "$work/v2" && verify_artefact "$TAG" 2>/dev/null || echo failed)"

make_assets "$work/v3"
printf '%s  other.zip\n' "$good_digest" > "$work/v3/$SUM"
check_equal 'a SHA-256 file for another file name fails' 'failed' "$(cd "$work/v3" && verify_artefact "$TAG" 2>/dev/null || echo failed)"

make_assets "$work/v4"
printf 'not a checksum\n' > "$work/v4/$SUM"
check_equal 'a SHA-256 file with a bad line fails' 'failed' "$(cd "$work/v4" && verify_artefact "$TAG" 2>/dev/null || echo failed)"

make_assets "$work/v5"
printf '%s  %s\n%s  other.zip\n' "$good_digest" "$ZIP" "$good_digest" > "$work/v5/$SUM"
check_equal 'a SHA-256 file with two lines fails' 'failed' "$(cd "$work/v5" && verify_artefact "$TAG" 2>/dev/null || echo failed)"

make_assets "$work/v6"
printf '%s *%s
' "$good_digest" "$ZIP" > "$work/v6/$SUM"
check_equal 'the binary mark of sha256sum on Windows passes' "$good_digest" "$(cd "$work/v6" && verify_artefact "$TAG")"

make_assets "$work/v7"
printf '%s  %s
' "$good_digest" "$ZIP" > "$work/v7/$SUM"
check_equal 'the text form of sha256sum on Linux passes' "$good_digest" "$(cd "$work/v7" && verify_artefact "$TAG")"

# --- the whole script ---
# run_reuse <tag>   Runs reuse_artefact in a new empty directory, $run_dir. Prints the output and the exit code.
run_dir="$work/run"
run_reuse() {
  rm -rf "$run_dir"
  mkdir -p "$run_dir"
  : > "$run_dir/output"
  : > "$run_dir/summary"
  : > "$FAKE_GH/calls"
  local rc=0 text
  text="$(cd "$run_dir" && GITHUB_OUTPUT="$run_dir/output" GITHUB_STEP_SUMMARY="$run_dir/summary" \
    GITHUB_REPOSITORY=jross24/lab-svc-account REUSE_TAG="$1" reuse_artefact 2>&1)" || rc=$?
  printf '%s\nexit=%s' "$text" "$rc"
}
reset_fake() {
  rm -rf "$FAKE_GH"
  mkdir -p "$FAKE_GH/assets"
}

# The release does not exist: the first attempt. The job builds.
reset_fake
out="$(run_reuse "$TAG")"
contains 'no release: the script exits 0' 'exit=0' "$out"
check_equal 'no release: the output says build' 'reused=false' "$(cat "$run_dir/output")"
contains 'no release: the summary names the path and the reason' 'Path: build. The release v1.2.3 does not exist yet.' "$(cat "$run_dir/summary")"
check_equal 'no release: only one call, the lookup' '1' "$(wc -l < "$FAKE_GH/calls" | tr -d ' ')"

# The release exists and has no artefact (a partial first attempt): the job builds.
reset_fake
release_json contract.json:uploaded "$ZIP:uploaded" > "$FAKE_GH/release.json"
out="$(run_reuse "$TAG")"
contains 'partial release: the script exits 0' 'exit=0' "$out"
check_equal 'partial release: the output says build' 'reused=false' "$(cat "$run_dir/output")"
contains 'partial release: the summary names the reason' 'does not hold both' "$(cat "$run_dir/summary")"

# The release holds the artefact: the job reuses it and replaces nothing.
reset_fake
release_json "$ZIP:uploaded" "$SUM:uploaded" > "$FAKE_GH/release.json"
make_assets "$FAKE_GH/assets"
out="$(run_reuse "$TAG")"
contains 'artefact on the release: the script exits 0' 'exit=0' "$out"
check_equal 'artefact on the release: the output says reuse and gives the digest' $'reused=true\ndigest='"$good_digest" "$(cat "$run_dir/output")"
check_equal 'artefact on the release: the zip is in the directory' "$good_digest" "$(sha256sum "$run_dir/$ZIP" | cut -d ' ' -f 1)"
contains 'artefact on the release: the summary names the path' 'Path: reuse.' "$(cat "$run_dir/summary")"
contains 'artefact on the release: the summary gives the digest' "$good_digest" "$(cat "$run_dir/summary")"
check_equal 'artefact on the release: no call changed the release' '0' "$(grep -c -E '^release (upload|create|delete|edit)' "$FAKE_GH/calls" || true)"

# The zip of the release does not match its SHA-256 file: the job fails and does not build.
reset_fake
release_json "$ZIP:uploaded" "$SUM:uploaded" > "$FAKE_GH/release.json"
make_assets "$FAKE_GH/assets"
printf 'damaged\n' > "$FAKE_GH/assets/$ZIP"
out="$(run_reuse "$TAG")"
contains 'damaged zip: the script fails' 'exit=1' "$out"
contains 'damaged zip: the message says why' 'does not match' "$out"
check_equal 'damaged zip: the output does not say reuse or build' '' "$(cat "$run_dir/output")"

# GitHub fails for another reason than "not found": the job fails. It must not build, because it cannot know.
reset_fake
touch "$FAKE_GH/view-error"
out="$(run_reuse "$TAG")"
contains 'API error: the script fails' 'exit=1' "$out"
contains 'API error: the message names the cause' 'HTTP 502' "$out"
check_equal 'API error: the output does not say build' '' "$(cat "$run_dir/output")"

# A bad tag fails before any call.
reset_fake
out="$(run_reuse 'main')"
contains 'bad tag: the script fails' 'exit=1' "$out"
check_equal 'bad tag: no call was made' '0' "$(wc -l < "$FAKE_GH/calls" | tr -d ' ')"

finished=1
if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed."
  exit 1
fi
echo "All tests passed."
