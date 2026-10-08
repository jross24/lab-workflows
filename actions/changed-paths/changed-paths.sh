#!/usr/bin/env bash
# Tells whether a pull request changes a file under some paths.
# Run: bash changed-paths.sh <base commit> <head commit> "<path> [<path>...]" [label]
#
# The script compares the head with the merge base of the two commits (git diff base...head).
# So a change that only the base branch has does not count as a change of the pull request.
# It writes changed=true or changed=false and count=<number> to GITHUB_OUTPUT.
# When it cannot decide, it says changed=true. A check that runs without need is better than a check that is skipped without reason.
set -euo pipefail

readonly MAX_LISTED=20

# changed_files <base> <head> <path>...: prints the changed files, one on each line.
# A renamed file counts under both names, so a file that moves out of the path is a change.
changed_files() {
  local base="$1" head="$2"
  shift 2
  git -c core.quotepath=off diff --name-only --no-renames "${base}...${head}" -- "$@"
}

main() {
  local base="${1:-}" head="${2:-}" paths_text="${3:-}" label="${4:-the check}"
  local out="${GITHUB_OUTPUT:-/dev/stdout}"

  if [[ -z "${paths_text//[[:space:]]/}" ]]; then
    echo 'usage: changed-paths.sh <base commit> <head commit> "<path> [<path>...]" [label]' >&2
    exit 2
  fi
  local paths=()
  read -r -a paths <<< "$paths_text"

  if [[ -z "$base" || -z "$head" ]]; then
    echo "::warning title=${label}::This run has no base commit or no head commit, so it cannot tell what changed. It runs ${label}."
    printf 'changed=true\ncount=unknown\n' >> "$out"
    return 0
  fi

  local files error_file
  error_file="$(mktemp)"
  if ! files="$(changed_files "$base" "$head" "${paths[@]}" 2> "$error_file")"; then
    echo "::warning title=${label}::git could not compare ${base} with ${head}, so this run cannot tell what changed. It runs ${label}."
    sed 's/^/  git: /' "$error_file" | head -n 3
    rm -f "$error_file"
    printf 'changed=true\ncount=unknown\n' >> "$out"
    return 0
  fi
  rm -f "$error_file"

  local count=0 line
  if [[ -n "$files" ]]; then
    count="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
  fi

  if [[ "$count" -eq 0 ]]; then
    local message="This pull request changes nothing under ${paths_text}. ${label} is skipped."
    echo "::notice title=${label} skipped::${message}"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      echo "${message}" >> "$GITHUB_STEP_SUMMARY"
    fi
    printf 'changed=false\ncount=0\n' >> "$out"
    return 0
  fi

  echo "This pull request changes ${count} file(s) under ${paths_text}. ${label} runs."
  # Each line starts with spaces. A file name cannot start a workflow command in the log.
  local listed=0
  while IFS= read -r line; do
    echo "  ${line}"
    listed=$((listed + 1))
    if [[ "$listed" -ge "$MAX_LISTED" ]]; then
      break
    fi
  done <<< "$files"
  if [[ "$count" -gt "$MAX_LISTED" ]]; then
    echo "  ... and $((count - MAX_LISTED)) more"
  fi
  printf 'changed=true\ncount=%s\n' "$count" >> "$out"
}

# Run main only when the file is run as a script. The tests source the file.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
