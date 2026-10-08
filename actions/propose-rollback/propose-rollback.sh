#!/usr/bin/env bash
# Runs after a failed smoke check in Production. The job is red already. This script says what to do next.
#
# The canary and its alarms watched the first minutes of the release. The smoke check is the last line.
# When it fails, the new version already carries all the traffic. This script does not change Production.
# It starts the redeploy workflow for the version that ran before. That run waits for the production
# reviewer like every run that deploys to Production. So a person decides, and a false alarm costs one click.
#
# Settings: GH_TOKEN, GITHUB_REPOSITORY, PR_SERVICE, PR_VERSION, PR_PREVIOUS (the version before the deployment, may be empty),
# PR_WORKFLOW (the file of the redeploy workflow in the service repository, default redeploy.yml).
# The script never fails. Its output is for people.
set -euo pipefail

readonly VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+$'

# decide <version> <previous>
# Prints one word: none (no earlier version), unknown (the earlier version is not a version), same (the earlier version
# is this one), or go-back.
decide() {
  local version="$1" previous="$2"
  if [[ -z "$previous" ]]; then
    echo none
  elif [[ ! "$previous" =~ $VERSION_PATTERN ]]; then
    echo unknown
  elif [[ "$previous" == "$version" ]]; then
    echo same
  else
    echo go-back
  fi
}

# redeploy_command <repository> <workflow> <version>
redeploy_command() {
  echo "gh workflow run $2 --repo $1 -f version=$3 -f environment=production"
}

main() {
  local repository="${GITHUB_REPOSITORY:-}" service="${PR_SERVICE:-}" version="${PR_VERSION:-}" previous="${PR_PREVIOUS:-}"
  local workflow="${PR_WORKFLOW:-redeploy.yml}" what text summary reason

  what="$(decide "$version" "$previous")"
  echo "::error title=Smoke check failed in production::The smoke check failed after $service $version was deployed to production. The canary has finished, so the new version carries all the traffic."

  case "$what" in
    none)
      text="Production had no version of $service before this release, so there is nothing to go back to. Fix the fault and release again."
      ;;
    unknown)
      text="The version that Production ran before this job could not be read, so I did not start a redeploy. Look at the releases of $service, pick the version to go back to, and start the redeploy by hand."
      ;;
    same)
      text="Production ran $service $version before this job. There is no older version to go back to. Fix the fault and release again."
      ;;
    go-back)
      text="To go back to $service $previous, run: \`$(redeploy_command "$repository" "$workflow" "$previous")\`. The redeploy waits for the production reviewer."
      if reason="$(gh workflow run "$workflow" --repo "$repository" -f "version=$previous" -f environment=production 2>&1)"; then
        text="I started the redeploy of $service $previous to production. The run waits for the production reviewer. Approve it to go back. Cancel it if the smoke check was a false alarm. If the drill variable E2E_FAULT_DRILL is set, remove it first, or the smoke check of the redeploy fails too. $text"
      else
        reason="$(head -n 1 <<< "$reason")"
        echo "::warning::The redeploy could not be started from this job (${reason:-no message}). Start it by hand with the command in the summary."
      fi
      ;;
  esac

  summary="### Smoke check failed in production"$'\n\n'
  summary+="Release \`$version\` of \`$service\` passed Test and Staging, and the canary in production finished. The smoke check then failed."$'\n\n'
  summary+="The job does not change Production by itself. A smoke check can fail for a reason that is not a fault of the release, for example a network error. A person decides."$'\n\n'
  summary+="$text"$'\n'
  printf '%s\n' "$summary"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$summary" >> "$GITHUB_STEP_SUMMARY"
  fi
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
