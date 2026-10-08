#!/usr/bin/env bash
# Decides if the job build makes the artefact of a release or takes the artefact that the release already holds.
#
# "Build once" must hold across the attempts of one run. After "Re-run all jobs" the GitHub release of the version
# exists, and the earlier environments may already run the zip of the first attempt. A second build can give other
# bytes. So when the release holds the zip and its SHA-256 file, this script downloads them and checks them.
# It never builds, and it never uploads or replaces a file of the release.
# When the release does not exist, or does not hold both files, the script says "build" and the job builds as before.
#
# Settings: REUSE_TAG (for example v1.2.3), GITHUB_REPOSITORY, GH_TOKEN, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY.
# Outputs: reused (true or false) and, when reused is true, digest (the SHA-256 of the zip).
# The zip and its SHA-256 file are in the current directory when reused is true.
# The script calls the gh command, the jq command and the sha256sum command.
set -euo pipefail

# release_has_artefact <tag> <release json>
# Returns 0 if the release json lists the zip and the SHA-256 file of the tag, and both are completely uploaded.
release_has_artefact() {
  jq -e --arg zip "cdk-out-$1.zip" --arg sum "cdk-out-$1.zip.sha256" \
    '[.assets[]? | select(.state == "uploaded") | .name] as $names
     | ($names | any(. == $zip)) and ($names | any(. == $sum))' <<< "$2" > /dev/null
}

# verify_artefact <tag>
# Checks the files cdk-out-<tag>.zip and cdk-out-<tag>.zip.sha256 in the current directory.
# The SHA-256 file must hold one line "<digest>  cdk-out-<tag>.zip", and the zip must have that digest.
# The line may also have the form "<digest> *cdk-out-<tag>.zip". That is the binary mark that sha256sum writes on Windows.
# Prints the digest. Returns 1 with an error message if a check fails.
verify_artefact() {
  local zip="cdk-out-$1.zip" sum="cdk-out-$1.zip.sha256" lines digest actual
  mapfile -t lines < "$sum"
  digest="${lines[0]%% *}"
  if [[ "${#lines[@]}" -ne 1 || ! "$digest" =~ ^[0-9a-f]{64}$ ]]     || [[ "${lines[0]}" != "${digest}  ${zip}" && "${lines[0]}" != "${digest} *${zip}" ]]; then
    echo "::error::The file $sum is not one line of the form \"<sha256>  $zip\"." >&2
    return 1
  fi
  actual="$(sha256sum "$zip" | cut -d ' ' -f 1)"
  if [[ "$actual" != "$digest" ]]; then
    echo "::error::The file $zip does not match $sum. Expected sha256 $digest, got $actual. The job does not build again, because an environment may already run the zip of the release. Look at the release by hand." >&2
    return 1
  fi
  echo "$digest"
}

reuse_artefact() {
  local tag="${REUSE_TAG:-}" repository="${GITHUB_REPOSITORY:-}"
  local output="${GITHUB_OUTPUT:-/dev/null}" summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
  local zip sum release errors digest

  if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "::error::The tag \"$tag\" does not have the form v1.2.3." >&2
    return 1
  fi
  zip="cdk-out-${tag}.zip"
  sum="cdk-out-${tag}.zip.sha256"

  # Only the answer "release not found" means that there is no release. Any other failure stops the job. If the job
  # built after a failed lookup, it could replace the files of a release that exists.
  errors="$(mktemp)"
  if ! release="$(gh release view "$tag" --repo "$repository" --json assets 2> "$errors")"; then
    if grep -qi 'release not found' "$errors"; then
      rm -f "$errors"
      echo "reused=false" >> "$output"
      {
        echo "### Artefact of ${tag}"
        echo
        echo "Path: build. The release ${tag} does not exist yet."
      } >> "$summary"
      echo "The release ${tag} does not exist yet. The job builds."
      return 0
    fi
    echo "::error::The lookup of the release ${tag} failed: $(cat "$errors")" >&2
    rm -f "$errors"
    return 1
  fi
  rm -f "$errors"

  if ! release_has_artefact "$tag" "$release"; then
    echo "reused=false" >> "$output"
    {
      echo "### Artefact of ${tag}"
      echo
      echo "Path: build. The release ${tag} does not hold both ${zip} and ${sum}."
    } >> "$summary"
    echo "The release ${tag} does not hold both ${zip} and ${sum}. The job builds."
    return 0
  fi

  gh release download "$tag" --repo "$repository" --pattern "$zip" --pattern "$sum" || return 1
  digest="$(verify_artefact "$tag")" || return 1
  {
    echo "reused=true"
    echo "digest=${digest}"
  } >> "$output"
  {
    echo "### Artefact of ${tag}"
    echo
    echo "Path: reuse. The release ${tag} holds the artefact. The job did not build and did not replace the files of the release."
    echo
    echo "Cloud assembly sha256: \`${digest}\`"
  } >> "$summary"
  echo "The release ${tag} holds the artefact. The job reuses it. sha256 ${digest}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  reuse_artefact
fi
