#!/usr/bin/env bash
# Scans the commits of a pull request for secrets with gitleaks.
# Run in a git repository: bash scan.sh <base commit> <head commit>
# gitleaks must be on the PATH. The action actions/install-tool installs the pinned version.
#
# The scan has four properties:
# - It reads only the commits after the base commit, up to the head commit. Older history is not scanned.
# - It never prints a secret. gitleaks redacts the value, and the report holds no value, no line text and no author.
# - The rules come from gitleaks.toml in this directory. A config file or an ignore file in the scanned
#   repository has no effect, and a gitleaks:allow comment has no effect. A pull request cannot weaken the scan.
# - It scans merge commits too (-m), so a secret that an author adds while resolving a merge conflict is found.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# gitleaks exits with this code when it finds a secret. Any other code that is not 0 means that gitleaks failed.
readonly LEAK_EXIT_CODE=99

# validate_commit_id <id>: accepts only a full commit id (40 or 64 hex characters).
# The id goes into the options of "git log", so it must not be a branch name or an option.
validate_commit_id() {
  if [[ ! "$1" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    echo "secret-scan: \"$1\" is not a full commit id" >&2
    return 1
  fi
}

# summarize_report: reads the report (rule, file, line, commit; separated by tabs) on stdin.
# It prints one line for each finding, with no repeats. Every line starts with spaces, so a file name
# in a pull request cannot start a workflow command in the log.
summarize_report() {
  local rule file line commit
  while IFS=$'\t' read -r rule file line commit; do
    [[ -z "$rule" ]] && continue
    printf '  %s  %s:%s  commit %s\n' "$rule" "$file" "$line" "${commit:0:7}"
  done | sort -u
}

main() {
  if [[ $# -ne 2 ]]; then
    echo 'usage: scan.sh <base commit> <head commit>' >&2
    exit 2
  fi
  local base="$1" head="$2"
  validate_commit_id "$base" || exit 2
  validate_commit_id "$head" || exit 2

  if ! command -v gitleaks > /dev/null; then
    echo 'secret-scan: gitleaks is not on the PATH. Install it with actions/install-tool first.' >&2
    exit 2
  fi

  local git_dir work report code=0
  # The source is the .git directory. gitleaks reads a .gitleaksignore file from the source tree,
  # and the .git directory has none. The ignore path points to an empty directory for the same reason.
  git_dir="$(git rev-parse --absolute-git-dir)"
  work="$(mktemp -d)"
  report="$work/report.tsv"
  mkdir "$work/no-ignore"

  echo "secret-scan: scanning the commits after ${base:0:7} up to ${head:0:7}"
  gitleaks git \
    --no-banner --no-color --redact \
    --config "$here/gitleaks.toml" \
    --gitleaks-ignore-path "$work/no-ignore" \
    --ignore-gitleaks-allow \
    --exit-code "$LEAK_EXIT_CODE" \
    --report-format template --report-template "$here/report.tmpl" --report-path "$report" \
    --log-opts "-m ${base}..${head}" \
    "$git_dir" || code=$?

  if [[ "$code" -eq 0 ]]; then
    rm -rf "$work"
    echo 'secret-scan: no secret found in the commits of this pull request.'
    return 0
  fi
  if [[ "$code" -ne "$LEAK_EXIT_CODE" ]]; then
    rm -rf "$work"
    echo "secret-scan: gitleaks failed with exit code ${code}. This is not a finding. Read the lines above." >&2
    exit 2
  fi

  local findings
  findings="$(summarize_report < "$report")"
  rm -rf "$work"
  echo
  echo 'secret-scan: possible secrets in this pull request. The values are not printed.'
  echo "$findings"
  echo
  echo 'Treat each secret as public now: a public repository shows every commit, also in a branch that you delete.'
  echo '1. Revoke or rotate the secret at its source.'
  echo '2. Remove it from the commits of this pull request.'
  echo '3. If the finding is a false positive, ask for an allow rule in actions/secret-scan/gitleaks.toml of lab-workflows.'
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo '### Secret scan: possible secrets found'
      echo
      echo 'The values are not printed. Revoke the secret, then remove it from the commits.'
      echo
      echo '```'
      echo "$findings"
      echo '```'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
}

# Run main only when the file is run as a script. The tests source the file.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
