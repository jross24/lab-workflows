#!/usr/bin/env bash
# Runs after a failed smoke check in Production. The job is red already. This script says what to do next.
#
# The canary and its alarms watched the first minutes of the release. The smoke check is the last line.
# When it fails, the new version already carries all the traffic. This script does not change Production.
# It starts the redeploy workflow for the version that ran before. That run waits for the production
# reviewer like every run that deploys to Production. So a person decides, and a false alarm costs one click.
#
# A rollback restores code, not data. The new release may have changed the data in a way that the earlier version cannot read.
# The migration step of the service records the oldest version that can run in the SSM parameter
# /lab/<service>/min-rollback-version (the rollback floor). Before the script starts the redeploy, it reads that parameter.
# If the earlier version is below the floor, the script does not start the redeploy. It says "fix forward".
# If the script cannot read the floor (no parameter, no access, a value that is not a version), it goes on as before and says so.
# The redeploy workflow checks the floor again before it deploys. So a redeploy that a person starts by hand is refused too.
#
# Settings: GH_TOKEN, GITHUB_REPOSITORY, PR_SERVICE, PR_VERSION, PR_PREVIOUS (the version before the deployment, may be empty),
# PR_WORKFLOW (the file of the redeploy workflow in the service repository, default redeploy.yml).
# The job needs AWS credentials for the read of the floor. The deploy job has them.
# The script never fails. Its output is for people.
set -euo pipefail

# The functions valid_version, floor_verdict, fetch_floor and rollback_refusal come from the script of the action preflight.
# That script runs nothing when another script sources it.
# shellcheck source=actions/preflight/preflight.sh
source "$(dirname "${BASH_SOURCE[0]}")/../preflight/preflight.sh"

readonly ENVIRONMENT=production

# decide <version> <previous> [floor]
# Prints one word: none (no earlier version), unknown (the earlier version is not a version), same (the earlier version
# is this one), blocked (the earlier version is below the rollback floor), or go-back.
# The floor may be empty. A floor that is not a version blocks nothing: the caller says that it could not use it.
decide() {
  local version="$1" previous="$2" floor="${3:-}"
  if [[ -z "$previous" ]]; then
    echo none
  elif ! valid_version "$previous"; then
    echo unknown
  elif [[ "$previous" == "$version" ]]; then
    echo same
  elif valid_version "$floor" && [[ "$(floor_verdict "$previous" "$floor")" == below ]]; then
    echo blocked
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
  local workflow="${PR_WORKFLOW:-redeploy.yml}" what text summary reason output floor='' floor_unknown=''

  what="$(decide "$version" "$previous")"
  echo "::error title=Smoke check failed in production::The smoke check failed after $service $version was deployed to production. The canary has finished, so the new version carries all the traffic."

  # The floor matters only if there is a version to go back to. Read it now: the release may have raised it.
  if [[ "$what" == go-back ]]; then
    if output="$(fetch_floor "$service" 2>&1)"; then
      floor="$output"
      if [[ -z "$floor" ]]; then
        echo "::notice title=No rollback floor::No rollback floor is recorded for $service in $ENVIRONMENT (the SSM parameter /lab/$service/min-rollback-version does not exist), so the redeploy of $service $previous is not checked against one."
      elif ! valid_version "$floor"; then
        floor_unknown="the SSM parameter /lab/$service/min-rollback-version holds \"$floor\", which is not a version of the form 1.2.3"
        floor=''
      fi
    else
      floor_unknown="$(head -n 1 <<< "$output")"
      floor_unknown="${floor_unknown:-no message}"
    fi
    if [[ -n "$floor_unknown" ]]; then
      echo "::notice title=Rollback floor not read::The rollback floor of $service in $ENVIRONMENT could not be read ($floor_unknown), so the redeploy of $service $previous is not checked against it. Check the SSM parameter /lab/$service/min-rollback-version before you approve the redeploy."
    fi
    what="$(decide "$version" "$previous" "$floor")"
  fi

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
    blocked)
      reason="$(rollback_refusal "$service" "$previous" "$ENVIRONMENT" "$floor")"
      echo "::warning title=Rollback refused::$reason"
      text="I did not start the redeploy of $service $previous. $reason Production runs $service $version now. The way back is closed, so fix forward: fix the fault and release a new version."
      ;;
    go-back)
      text="To go back to $service $previous, run: \`$(redeploy_command "$repository" "$workflow" "$previous")\`. The redeploy waits for the production reviewer."
      if reason="$(gh workflow run "$workflow" --repo "$repository" -f "version=$previous" -f environment=production 2>&1)"; then
        text="I started the redeploy of $service $previous to production. The run waits for the production reviewer. Approve it to go back. Cancel it if the smoke check was a false alarm. If the drill variable E2E_FAULT_DRILL is set, remove it first, or the smoke check of the redeploy fails too. $text"
      else
        reason="$(head -n 1 <<< "$reason")"
        echo "::warning::The redeploy could not be started from this job (${reason:-no message}). Start it by hand with the command in the summary."
      fi
      if [[ -n "$floor_unknown" ]]; then
        text+=" I could not check the rollback floor. A version below the floor cannot read the data. Check the SSM parameter /lab/$service/min-rollback-version before you approve the redeploy."
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
