#!/usr/bin/env bash
# Tests for next-version.sh. Run: bash actions/next-version/test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=actions/next-version/next-version.sh
source "$here/next-version.sh"

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

# --- the bump logic ---
check 'first release is 0.1.0' '0.1.0' "$(next_version '' 'feat!: anything')"
check 'a fix is a patch' '1.2.4' "$(next_version '1.2.3' 'fix: handle an empty list')"
check 'a title with no prefix is a patch' '1.2.4' "$(next_version '1.2.3' 'update the readme')"
check 'no commits is a patch' '1.2.4' "$(next_version '1.2.3' '')"
check 'feat is a minor' '1.3.0' "$(next_version '1.2.3' 'feat: add the items route')"
check 'feat with a scope is a minor' '1.3.0' "$(next_version '1.2.3' 'feat(api): add the items route')"
check 'feat among fixes is a minor' '1.3.0' "$(next_version '1.2.3' $'fix: one\nfeat: two\nchore: three')"
check 'a word that starts with feat is a patch' '1.2.4' "$(next_version '1.2.3' 'feature flags: tidy up')"
check 'feat in the middle of a title is a patch' '1.2.4' "$(next_version '1.2.3' 'revert feat: add the items route')"
check 'feat! is a major' '2.0.0' "$(next_version '1.2.3' 'feat!: change the response shape')"
check 'fix! is a major' '2.0.0' "$(next_version '1.2.3' 'fix!: remove a field')"
check 'a scope and ! is a major' '2.0.0' "$(next_version '1.2.3' 'feat(api)!: change the response shape')"
check 'BREAKING CHANGE is a major' '2.0.0' "$(next_version '1.2.3' $'fix: one\nBREAKING CHANGE: the id is now a string')"
check 'major wins over minor' '2.0.0' "$(next_version '1.2.3' $'feat: one\nfix!: two\nfeat: three')"
check 'a major from 0.x goes to 1.0.0' '1.0.0' "$(next_version '0.4.2' 'feat!: first stable shape')"
check 'numbers above 9 work' '10.10.0' "$(next_version '10.9.9' 'feat: one')"
check 'an invalid last version fails' 'failed' "$(next_version '1.2' 'fix: one' 2>/dev/null || echo failed)"

# --- the highest tag ---
check 'the highest tag by version, not by text' 'v0.10.0' "$(printf 'v0.9.0\nv0.10.0\nv0.2.0\n' | highest_tag)"
check 'tags that are not versions are ignored' 'v1.0.0' "$(printf 'v1.0.0\nv2\nvnext\nv1.0.0-rc.1\n' | highest_tag)"
check 'no tag gives nothing' '' "$(printf '' | highest_tag)"

# --- the whole script against a real git repository ---
repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT

run_in_repo() {
  local output="$repo/output"
  : > "$output"
  (cd "$repo" && GITHUB_OUTPUT="$output" bash "$here/next-version.sh")
  tr '\n' ' ' < "$output"
}

commit() {
  git -C "$repo" -c user.name=test -c user.email=test@example.invalid commit --quiet --allow-empty "$@"
}

git -C "$repo" init --quiet
commit -m 'feat: first commit'
check 'a repository with no tag' 'version=0.1.0 tag=v0.1.0 exists=false ' "$(run_in_repo)"

git -C "$repo" tag v0.1.0
check 'a commit that has a tag keeps its version' 'version=0.1.0 tag=v0.1.0 exists=true ' "$(run_in_repo)"

commit -m 'fix: one'
check 'a fix after the tag' 'version=0.1.1 tag=v0.1.1 exists=false ' "$(run_in_repo)"

commit -m 'feat: two'
check 'a feat after the tag' 'version=0.2.0 tag=v0.2.0 exists=false ' "$(run_in_repo)"

git -C "$repo" tag v0.2.0
commit -m 'fix: three' -m 'BREAKING CHANGE: the id is now a string'
check 'BREAKING CHANGE in the body' 'version=1.0.0 tag=v1.0.0 exists=false ' "$(run_in_repo)"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo 'all tests passed'
