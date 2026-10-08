#!/usr/bin/env bash
# Tests for changed-paths.sh. Run: bash actions/changed-paths/test.sh
#
# The tests use real git repositories in a temporary directory. They never use the network.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=actions/changed-paths/changed-paths.sh
source "$here/changed-paths.sh"

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

work="$(mktemp -d)"
repo="$work/repo"
mkdir -p "$repo"
trap 'rm -rf "$work"' EXIT

git_in_repo() {
  git -C "$repo" -c core.autocrlf=false -c user.name=test -c user.email=test@example.invalid "$@"
}

# commit_file <path> <content>: writes a file and commits it
commit_file() {
  mkdir -p "$repo/$(dirname "$1")"
  printf '%s\n' "$2" > "$repo/$1"
  git_in_repo add -A
  git_in_repo commit --quiet -m "change $1"
}

git_in_repo init --quiet --initial-branch=main
commit_file README.md 'first'
commit_file .github/workflows/pr.yml 'name: pr'
base="$(git_in_repo rev-parse HEAD)"

# run <base> <head> <paths>: runs the script in the repository and prints the outputs on one line
run() {
  local out="$work/github_output" code=0
  : > "$out"
  (cd "$repo" && GITHUB_OUTPUT="$out" bash "$here/changed-paths.sh" "$1" "$2" "$3" 'the check') > "$work/stdout" 2>&1 || code=$?
  echo "exit=$code $(tr '\n' ' ' < "$out")"
}

# a branch that changes a workflow file
git_in_repo checkout --quiet -b workflow-change "$base"
commit_file .github/workflows/pr.yml 'name: pr changed'
head_workflow="$(git_in_repo rev-parse HEAD)"
check 'a changed workflow file' 'exit=0 changed=true count=1 ' "$(run "$base" "$head_workflow" '.github/')"
contains 'it lists the changed file' '.github/workflows/pr.yml' "$(cat "$work/stdout")"

# a branch that changes a file outside .github
git_in_repo checkout --quiet -b source-change "$base"
commit_file src/app.ts 'export {}'
head_source="$(git_in_repo rev-parse HEAD)"
check 'a change outside the path' 'exit=0 changed=false count=0 ' "$(run "$base" "$head_source" '.github/')"
contains 'it prints a visible notice when it skips' '::notice' "$(cat "$work/stdout")"
contains 'the notice names the check' 'the check' "$(cat "$work/stdout")"

# a branch that changes both
git_in_repo checkout --quiet -b both-change "$base"
commit_file src/app.ts 'export {}'
commit_file .github/dependabot.yml 'version: 2'
head_both="$(git_in_repo rev-parse HEAD)"
check 'a change in both places' 'exit=0 changed=true count=1 ' "$(run "$base" "$head_both" '.github/')"

# several commits: the change is in the first commit and the last commit does not touch the path
git_in_repo checkout --quiet -b early-change "$base"
commit_file .github/workflows/new.yml 'name: new'
commit_file src/other.ts 'export {}'
head_early="$(git_in_repo rev-parse HEAD)"
check 'a change in an earlier commit of the branch' 'exit=0 changed=true count=1 ' "$(run "$base" "$head_early" '.github/')"

# a deleted file and a renamed file
git_in_repo checkout --quiet -b delete-change "$base"
git_in_repo rm --quiet .github/workflows/pr.yml
git_in_repo commit --quiet -m 'delete the workflow'
head_delete="$(git_in_repo rev-parse HEAD)"
check 'a deleted workflow file' 'exit=0 changed=true count=1 ' "$(run "$base" "$head_delete" '.github/')"

git_in_repo checkout --quiet -b rename-change "$base"
mkdir -p "$repo/ci"
git_in_repo mv .github/workflows/pr.yml ci/pr.yml
git_in_repo commit --quiet -m 'move the workflow out of .github'
head_rename="$(git_in_repo rev-parse HEAD)"
check 'a file moved out of the path counts as a change' 'exit=0 changed=true count=1 ' "$(run "$base" "$head_rename" '.github/')"

# the base branch moves on: the new change on the base is not a change of the pull request
git_in_repo checkout --quiet main
commit_file .github/workflows/other.yml 'name: other'
new_base="$(git_in_repo rev-parse HEAD)"
check 'a change that only the base has is not counted' 'exit=0 changed=false count=0 ' "$(run "$new_base" "$head_source" '.github/')"

# more than one path
check 'two paths: the second one matches' 'exit=0 changed=true count=1 ' "$(run "$base" "$head_source" 'docs/ src/')"
check 'two paths: none matches' 'exit=0 changed=false count=0 ' "$(run "$base" "$head_source" 'docs/ infra/')"

# when the script cannot decide, it says "changed" so the check still runs
check 'an empty base runs the check' 'exit=0 changed=true count=unknown ' "$(run '' "$head_source" '.github/')"
contains 'an empty base gives a warning' '::warning' "$(cat "$work/stdout")"
check 'an empty head runs the check' 'exit=0 changed=true count=unknown ' "$(run "$base" '' '.github/')"
check 'a base that does not exist runs the check' 'exit=0 changed=true count=unknown ' "$(run 0000000000000000000000000000000000000001 "$head_source" '.github/')"
contains 'a bad base gives a warning' '::warning' "$(cat "$work/stdout")"
check 'an empty path list is an error' 'exit=2 ' "$(run "$base" "$head_source" '')"

# the list of files is short when many files change
git_in_repo checkout --quiet -b many-changes "$base"
for i in $(seq 1 30); do
  mkdir -p "$repo/.github/workflows"
  printf 'name: w%s\n' "$i" > "$repo/.github/workflows/w$i.yml"
done
git_in_repo add -A
git_in_repo commit --quiet -m 'many workflows'
head_many="$(git_in_repo rev-parse HEAD)"
check 'many files are counted' 'exit=0 changed=true count=30 ' "$(run "$base" "$head_many" '.github/')"
check 'the list shows at most 20 files' '20' "$(grep -c 'workflows/w' "$work/stdout")"
contains 'the list says how many more files there are' '10 more' "$(cat "$work/stdout")"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo 'all tests passed'
