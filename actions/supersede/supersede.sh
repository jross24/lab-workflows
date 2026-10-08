#!/usr/bin/env bash
# Cancels the older runs of the same workflow that wait for the production reviewer.
#
# The job supersede of release.yml calls this script, after the staging job of a release has passed.
# The new release contains the changes of an older release that still waits. So the old approval has no use.
# The script cancels a run only when the run waits (nobody approved it, so it does not deploy), when the run is older
# than this one, when it is a run of the same workflow, and when its job for production is the job that waits.
# It never fails the release. If it cannot cancel, the guard in the deploy job still keeps the order.
#
# Settings: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, SUPERSEDE_TAG (for the messages),
# SUPERSEDE_JOB_SUFFIX (the end of the name of the job that waits, default deploy-production).
# The script calls the gh command and the jq command.
set -euo pipefail

readonly DEFAULT_JOB_SUFFIX='deploy-production'

# older_waiting_runs <my run id> <workflow id> <runs json>
# Prints the id of each run that waits, belongs to the workflow, and is older than my run.
older_waiting_runs() {
  jq -r --argjson me "$1" --argjson workflow "$2" \
    '.workflow_runs[] | select(.workflow_id == $workflow and .id < $me and .status == "waiting") | .id' <<< "$3"
}

# waits_in_job <suffix> <jobs json>   Returns 0 if a job with this name suffix has the status waiting.
waits_in_job() {
  jq -e --arg suffix "$1" '[.jobs[] | select(.status == "waiting" and (.name | endswith($suffix)))] | length > 0' <<< "$2" > /dev/null
}

supersede() {
  local repository="${GITHUB_REPOSITORY:-}" run_id="${GITHUB_RUN_ID:-}" tag="${SUPERSEDE_TAG:-this release}"
  local suffix="${SUPERSEDE_JOB_SUFFIX:-$DEFAULT_JOB_SUFFIX}" workflow_id runs jobs older id status cancelled=0 text

  if [[ ! "$repository" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ || ! "$run_id" =~ ^[0-9]+$ ]]; then
    echo "::warning::supersede: GITHUB_REPOSITORY or GITHUB_RUN_ID is wrong. Nothing was cancelled."
    return 0
  fi

  if ! workflow_id="$(gh api "repos/${repository}/actions/runs/${run_id}" --jq '.workflow_id')"; then
    echo "::warning::supersede: the workflow of this run could not be read. Nothing was cancelled. The guard in the deploy job keeps the order."
    return 0
  fi
  if ! runs="$(gh api "repos/${repository}/actions/runs?status=waiting&per_page=100")"; then
    echo "::warning::supersede: the list of waiting runs could not be read. Nothing was cancelled. The guard in the deploy job keeps the order."
    return 0
  fi

  older="$(older_waiting_runs "$run_id" "$workflow_id" "$runs")"
  if [[ -z "$older" ]]; then
    echo "No older run of this workflow waits for the production reviewer."
    return 0
  fi

  for id in $older; do
    if ! jobs="$(gh api "repos/${repository}/actions/runs/${id}/jobs")" || ! waits_in_job "$suffix" "$jobs"; then
      echo "Run $id waits, but not in a job that ends with $suffix. It stays."
      continue
    fi
    # The reviewer can approve while this script runs. Look at the status again, right before the cancel.
    status="$(gh api "repos/${repository}/actions/runs/${id}" --jq '.status' || true)"
    if [[ "$status" != waiting ]]; then
      echo "Run $id has the status \"$status\" now. It stays."
      continue
    fi
    if gh run cancel "$id" --repo "$repository"; then
      cancelled=$((cancelled + 1))
      text="Cancelled run https://github.com/${repository}/actions/runs/${id}. It waited for the production reviewer, and ${tag} contains its changes."
      echo "::notice title=Older release superseded::${text}"
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        echo "- $text" >> "$GITHUB_STEP_SUMMARY"
      fi
    else
      echo "::warning::supersede: run $id could not be cancelled. It stays, and the release of ${tag} waits behind it."
    fi
  done
  echo "$cancelled older run(s) cancelled."
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  supersede
fi
