#!/usr/bin/env bash
# Tests for scan.sh. Run: bash actions/secret-scan/test.sh
#
# Part 1 tests the pure functions.
# Part 2 runs the script against real git repositories in a temporary directory, with the real gitleaks.
# If gitleaks is not on the PATH, Part 2 is skipped. Set REQUIRE_GITLEAKS=1 to make that a failure (CI does this).
# The fake secrets are built from two parts at run time. This file holds no complete fake secret.
# The tests never use the network.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=actions/secret-scan/scan.sh
source "$here/scan.sh"

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
    while IFS= read -r line; do
      echo "        $line"
    done <<< "$haystack"
    failures=$((failures + 1))
  fi
}

# lacks <name> <text that must NOT be in the output> <output>
lacks() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "ok    $name"
  else
    echo "FAIL  $name: \"$needle\" is in the output"
    failures=$((failures + 1))
  fi
}

# --- Part 1: the pure functions ---

sha1='0123456789abcdef0123456789abcdef01234567'
check 'a 40 character commit id is valid' 'ok' "$(validate_commit_id "$sha1" 2> /dev/null && echo ok)"
check 'a 64 character commit id is valid' 'ok' "$(validate_commit_id "${sha1}${sha1:0:24}" 2> /dev/null && echo ok)"
check 'a short commit id is not valid' 'failed' "$(validate_commit_id 0123abc 2> /dev/null || echo failed)"
check 'an empty commit id is not valid' 'failed' "$(validate_commit_id '' 2> /dev/null || echo failed)"
check 'a branch name is not a valid commit id' 'failed' "$(validate_commit_id main 2> /dev/null || echo failed)"
check 'an option is not a valid commit id' 'failed' "$(validate_commit_id '--output=/tmp/x' 2> /dev/null || echo failed)"

tab=$'\t'
report="generic-api-key${tab}config.txt${tab}2${tab}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
generic-api-key${tab}config.txt${tab}2${tab}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
github-pat${tab}src/a b.ts${tab}10${tab}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
summary="$(summarize_report <<< "$report")"
check 'the summary has one line for each finding' '2' "$(printf '%s\n' "$summary" | wc -l | tr -d ' ')"
contains 'the summary shows rule, file, line and short commit' 'generic-api-key  config.txt:2  commit aaaaaaa' "$summary"
contains 'the summary keeps a file name with a space' 'github-pat  src/a b.ts:10  commit bbbbbbb' "$summary"
check 'the summary of an empty report is empty' '' "$(summarize_report <<< '')"
check 'every line of the summary starts with spaces' '0' "$(printf '%s\n' "$summary" | grep -c '^[^ ]' || true)"
hostile="rule${tab}::error::hostile${tab}1${tab}cccccccccccccccccccccccccccccccccccccccc"
check 'a file name cannot start a workflow command' '0' "$(summarize_report <<< "$hostile" | grep -c '^::' || true)"

# --- Part 2: the script as a process, with the real gitleaks ---

if ! command -v gitleaks > /dev/null; then
  if [[ "${REQUIRE_GITLEAKS:-}" == '1' ]]; then
    echo 'FAIL  gitleaks is not on the PATH, and REQUIRE_GITLEAKS is 1'
    failures=$((failures + 1))
  else
    echo 'skip  gitleaks is not on the PATH. Part 2 is skipped.'
  fi
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  repo="$work/repo"
  mkdir -p "$repo"

  # The fake secrets. They are random text and they are not credentials.
  # Each is built from two parts, so no scanner finds a complete value in this file.
  generic_secret="q8Zr3KpL0xVd""7NwT2mYb5HcJ9sFe4GuA"
  pat_secret="ghp""_Ab3Dk9Xm2Qw7Lp5Ts8Vn4Rj6Hc1Yf0Zg3UoK"
  author_email='author-test@example.invalid'

  git_in_repo() {
    git -C "$repo" -c core.autocrlf=false -c user.name=tester -c "user.email=$author_email" "$@"
  }

  commit_file() {
    mkdir -p "$repo/$(dirname "$1")"
    printf '%s\n' "$2" > "$repo/$1"
    git_in_repo add -A
    git_in_repo commit --quiet -m "change $1"
  }

  # scan <base> <head>: runs the script in the repository, prints "exit=<code>" and the output
  scan() {
    local code=0 output
    output="$(cd "$repo" && bash "$here/scan.sh" "$1" "$2" 2>&1)" || code=$?
    echo "exit=$code"
    echo "$output"
  }

  git_in_repo init --quiet --initial-branch=main
  commit_file README.md 'a clean repository'
  base="$(git_in_repo rev-parse HEAD)"

  # a clean pull request
  git_in_repo checkout --quiet -b clean "$base"
  commit_file src/app.ts 'export const answer = 42;'
  head_clean="$(git_in_repo rev-parse HEAD)"
  out="$(scan "$base" "$head_clean")"
  contains 'a clean pull request exits 0' 'exit=0' "$out"
  contains 'a clean pull request says that no secret was found' 'no secret found' "$out"

  # a pull request that adds a generic key
  git_in_repo checkout --quiet -b leak "$base"
  commit_file config.txt "api_key = \"$generic_secret\""
  head_leak="$(git_in_repo rev-parse HEAD)"
  out="$(scan "$base" "$head_leak")"
  contains 'a leaked key exits 1' 'exit=1' "$out"
  contains 'the report names the rule' 'generic-api-key' "$out"
  contains 'the report names the file and the line' 'config.txt:1' "$out"
  contains 'the report names the commit' "commit ${head_leak:0:7}" "$out"
  lacks 'the output has no part of the secret (first half)' "q8Zr3KpL0xVd" "$out"
  lacks 'the output has no part of the secret (second half)' "7NwT2mYb5HcJ9sFe4GuA" "$out"
  lacks 'the output has no author email' "$author_email" "$out"

  # a provider token
  git_in_repo checkout --quiet -b token "$base"
  commit_file token.txt "token: $pat_secret"
  head_token="$(git_in_repo rev-parse HEAD)"
  out="$(scan "$base" "$head_token")"
  contains 'a provider token exits 1' 'exit=1' "$out"
  contains 'a provider token is named by its rule' 'github-pat' "$out"
  lacks 'the output has no part of the token' "Ab3Dk9Xm2Qw7" "$out"

  # only the commits of the pull request are scanned
  git_in_repo checkout --quiet main
  commit_file old-config.txt "api_key = \"$generic_secret\""
  old_base="$(git_in_repo rev-parse HEAD)"
  git_in_repo checkout --quiet -b after-old "$old_base"
  commit_file src/more.ts 'export const more = 1;'
  head_after_old="$(git_in_repo rev-parse HEAD)"
  out="$(scan "$old_base" "$head_after_old")"
  contains 'a secret in a commit before the base is not reported' 'exit=0' "$out"
  git_in_repo checkout --quiet -B main "$base"

  # a secret that the pull request adds and removes again is still in the history
  git_in_repo checkout --quiet -b added-removed "$base"
  commit_file temp.txt "api_key = \"$generic_secret\""
  git_in_repo rm --quiet temp.txt
  git_in_repo commit --quiet -m 'remove the key'
  head_removed="$(git_in_repo rev-parse HEAD)"
  out="$(scan "$base" "$head_removed")"
  contains 'a secret that a later commit removes is still found' 'exit=1' "$out"

  # a pull request cannot weaken the scan
  git_in_repo checkout --quiet -b ignore-file "$base"
  commit_file config.txt "api_key = \"$generic_secret\""
  leak_commit="$(git_in_repo rev-parse HEAD)"
  commit_file .gitleaksignore "${leak_commit}:config.txt:generic-api-key:1"
  head_ignore="$(git_in_repo rev-parse HEAD)"
  out="$(scan "$base" "$head_ignore")"
  contains 'a .gitleaksignore file in the pull request does not hide the secret' 'exit=1' "$out"

  git_in_repo checkout --quiet -b toml-file "$base"
  commit_file config.txt "api_key = \"$generic_secret\""
  commit_file .gitleaks.toml $'[extend]\nuseDefault = true\n[[allowlists]]\nregexes = [\'\'\'.*\'\'\']'
  head_toml="$(git_in_repo rev-parse HEAD)"
  out="$(scan "$base" "$head_toml")"
  contains 'a .gitleaks.toml file in the pull request does not hide the secret' 'exit=1' "$out"

  git_in_repo checkout --quiet -b inline-allow "$base"
  commit_file config.txt "api_key = \"$generic_secret\" # gitleaks:allow"
  head_allow=$(git_in_repo rev-parse HEAD)
  out="$(scan "$base" "$head_allow")"
  contains 'a gitleaks:allow comment does not hide the secret' 'exit=1' "$out"

  # a secret that only a merge commit adds (a conflict that the author resolved)
  git_in_repo checkout --quiet -b feature "$base"
  commit_file shared.txt 'feature line'
  git_in_repo checkout --quiet -b main-moves "$base"
  commit_file shared.txt 'main line'
  main_tip="$(git_in_repo rev-parse HEAD)"
  git_in_repo checkout --quiet feature
  git_in_repo merge --quiet main-moves > /dev/null 2>&1 || true
  printf 'merged\napi_key = "%s"\n' "$generic_secret" > "$repo/shared.txt"
  git_in_repo add -A
  git_in_repo commit --quiet -m 'merge main and resolve the conflict'
  head_merge="$(git_in_repo rev-parse HEAD)"
  out="$(scan "$main_tip" "$head_merge")"
  contains 'a secret that only a merge commit adds is found' 'exit=1' "$out"

  # the arguments
  out="$(cd "$repo"; bash "$here/scan.sh" 2>&1)" || true
  contains 'no arguments show the usage' 'usage' "$out"
  out="$(scan 'main' "$head_clean")"
  contains 'a branch name instead of a commit id is refused' 'exit=2' "$out"
  out="$(scan "$base" '--output=/tmp/x')"
  contains 'an option instead of a commit id is refused' 'exit=2' "$out"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo 'all tests passed'
