#!/usr/bin/env bash
# Works out the next semantic version from the commits since the last v* tag.
set -euo pipefail

readonly VERSION_TAG='^v[0-9]+\.[0-9]+\.[0-9]+$'

# next_version <last version, or empty> <commit titles, one per line>
# A line that contains BREAKING CHANGE counts as a breaking commit.
next_version() {
  local last="$1" lines="$2"

  if [[ -z "$last" ]]; then
    echo '0.1.0'
    return
  fi
  if [[ ! "$last" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "next-version: \"$last\" is not a version of the form 1.2.3" >&2
    return 1
  fi
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"

  local breaking='^[A-Za-z]+(\([^)]*\))?!:'
  local feature='^feat(\([^)]*\))?:'
  local level='patch' line
  while IFS= read -r line; do
    if [[ "$line" =~ $breaking || "$line" == *'BREAKING CHANGE'* ]]; then
      level='major'
      break
    fi
    if [[ "$line" =~ $feature ]]; then
      level='minor'
    fi
  done <<< "$lines"

  case "$level" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "${major}.$((minor + 1)).0" ;;
    *) echo "${major}.${minor}.$((patch + 1))" ;;
  esac
}

# Prints the highest version tag from a list of tags on stdin, or nothing.
highest_tag() {
  { grep -E "$VERSION_TAG" || true; } | sort --version-sort | tail -n 1
}

main() {
  local output="${GITHUB_OUTPUT:-/dev/stdout}"

  # A second run for the same commit must give the same version, not a new one.
  local existing
  existing="$(git tag --points-at HEAD | highest_tag)"
  if [[ -n "$existing" ]]; then
    {
      echo "version=${existing#v}"
      echo "tag=${existing}"
      echo 'exists=true'
    } >> "$output"
    return
  fi

  local last range titles breaking version
  last="$(git tag --merged HEAD | highest_tag)"
  range='HEAD'
  if [[ -n "$last" ]]; then
    range="${last}..HEAD"
  fi
  titles="$(git log --format=%s "$range")"
  breaking="$(git log --format=%b "$range" | { grep 'BREAKING CHANGE' || true; })"
  version="$(next_version "${last#v}" "${titles}"$'\n'"${breaking}")"

  {
    echo "version=${version}"
    echo "tag=v${version}"
    echo 'exists=false'
  } >> "$output"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
