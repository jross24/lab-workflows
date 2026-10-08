#!/usr/bin/env bash
# Writes the production marker and attaches it to the GitHub release of the version.
#
# The job record-production of release.yml and the job record of redeploy.yml call this script, after a deployment
# to Production has succeeded. The marker is the file deployed-production.json. It says "this release runs in
# Production now". The contract check lists the releases and picks the one with the newest marker, so the marker
# must be uploaded again (and not kept) each time. The README section "Contract tests" explains why.
#
# Settings: GH_TOKEN, GITHUB_REPOSITORY,
#   RP_SERVICE   the name of the service, for example core
#   RP_VERSION   the version that runs in Production now, for example 0.8.0
#   RP_TAG       the tag of the release, v<version>
#   RP_RUN_URL   the URL of the run that deployed
#   RP_COMMIT    the commit of the release. It is optional. If it is empty, the script reads the commit of the tag.
#   RP_FILE      the name of the file and of the asset. The default is deployed-production.json.
#   RP_NOW       the time of the marker. It is for the tests. The default is the time now, in UTC.
# The script calls the gh command and the jq command.
set -euo pipefail

readonly DEFAULT_FILE='deployed-production.json'
readonly VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+$'
readonly NAME_PATTERN='^[a-z][a-z0-9-]{0,30}$'

# marker_json <service> <version> <tag> <commit> <run url> <time>   Prints the marker as one line of JSON.
# jq does the escaping, so no value can break the JSON.
marker_json() {
  jq -cn --arg service "$1" --arg version "$2" --arg tag "$3" --arg commit "$4" --arg run "$5" --arg at "$6" \
    '{service: $service, version: $version, tag: $tag, environment: "production", commit: $commit, run: $run, at: $at}'
}

wrong_input() {
  echo "::error title=Wrong input::$1"
  return 1
}

record() {
  local service="${RP_SERVICE:-}" version="${RP_VERSION:-}" tag="${RP_TAG:-}" commit="${RP_COMMIT:-}" run_url="${RP_RUN_URL:-}"
  local file="${RP_FILE:-$DEFAULT_FILE}" now="${RP_NOW:-}" repository="${GITHUB_REPOSITORY:-}"

  [[ -n "$service" ]] || { wrong_input 'RP_SERVICE is empty.'; return 1; }
  [[ "$service" =~ $NAME_PATTERN ]] || { wrong_input "The service \"$service\" is not a name with lower case letters, digits and hyphens."; return 1; }
  [[ "$version" =~ $VERSION_PATTERN ]] || { wrong_input "The version \"$version\" does not have the form 1.2.3."; return 1; }
  [[ "$tag" == "v$version" ]] || { wrong_input "The tag \"$tag\" is not v$version."; return 1; }
  [[ "$repository" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { wrong_input 'GITHUB_REPOSITORY is not of the form owner/name.'; return 1; }
  [[ -n "$now" ]] || now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # A redeploy runs from the default branch, so its own commit is not the commit of the version. It passes no commit.
  # The tag is a lightweight tag on the released commit. The commit is information only, so a failure here is a warning.
  if [[ -z "$commit" ]]; then
    if ! commit="$(gh api "repos/${repository}/commits/${tag}" --jq '.sha')"; then
      commit=''
      echo "::warning title=Commit not found::The commit of the tag ${tag} could not be read. The marker has an empty commit. The marker still works: the check reads its name and its time."
    fi
  fi

  marker_json "$service" "$version" "$tag" "$commit" "$run_url" "$now" > "$file"

  # --clobber replaces the asset of an earlier deployment. The new upload has a new time, and the time is what counts.
  if ! gh release upload "$tag" "$file" --repo "$repository" --clobber; then
    echo "::error title=Marker not recorded::The marker could not be uploaded to the release ${tag}. Production runs ${service} ${version}, but the contract check does not know it. Run the job again."
    return 1
  fi

  echo "::notice title=Production marker::Recorded ${service} ${version} in Production. The release ${tag} has the asset ${file} now."
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Production marker"
      echo
      echo "\`${service}\` \`${version}\` runs in Production. The release \`${tag}\` has the asset \`${file}\` now."
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  record
fi
