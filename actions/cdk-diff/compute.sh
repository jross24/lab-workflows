#!/usr/bin/env bash
# Synthesises the pull request and compares each stack with its deployed template.
#
# This script runs in the job "compute" of diff.yml. That job runs the code of the pull request,
# so it has NO AWS credentials and no write token. The deployed templates come from the job "fetch"
# as plain files in the directory "deployed".
#
# Environment: STAGE (can be empty), SYNTH_ARGS, PASS_VERSION, HEAD_SHA.
# Output: the directory "diff" with meta.json and, for each stack, <id>.diff.txt, <id>.new.json and <id>.old.json.
set -euo pipefail

tools="$(cd "$(dirname "$0")" && pwd)"
stage="${STAGE-}"

# The build uses the version that runs now. Without this, every pull request shows the version number as a change.
version=""
if [[ "${PASS_VERSION:-true}" == "true" && -f deployed/meta.json ]]; then
  version="$(jq -r '[.stacks[] | select(.version != null) | .version][0] // empty' deployed/meta.json)"
fi

synth=(npx cdk synth --quiet --output cdk.out)
if [[ -n "$version" ]]; then
  synth+=(-c "version=${version}")
fi
if [[ -n "${SYNTH_ARGS:-}" ]]; then
  # The caller writes the arguments in a workflow file, so a plain split by spaces is enough.
  read -r -a extra <<< "$SYNTH_ARGS"
  synth+=("${extra[@]}")
fi
echo "::group::cdk synth"
"${synth[@]}"
echo "::endgroup::"

mkdir -p diff
stacks="$(node "$tools/cli.mjs" stacks cdk.out "$stage" | jq -r '.[] | [.displayName, .stackName, .templateFile] | @tsv')"
if [[ -z "$stacks" ]]; then
  echo "::error::The cloud assembly has no stack in the stage \"${stage}\". Check the input \"stage\" of the diff workflow."
  exit 1
fi

# A stack that is not deployed yet is compared with an empty template, so every resource shows as new.
echo '{"Resources":{}}' > empty-template.json

stacks_meta='[]'
index=0
while IFS=$'\t' read -r display name template; do
  index=$((index + 1))
  id="stack-${index}"
  old="deployed/${name}.json"
  deployed=true
  if [[ ! -f "$old" ]]; then
    deployed=false
    old="empty-template.json"
  fi

  echo "::group::cdk diff ${display} (${name})"
  # --exclusively: a stack can depend on another stack of the app. The CLI then selects both, and it refuses to compare
  # more than one stack with a fixed template.
  # The command exits with 0 when it finds differences. A non-zero exit code means that the command failed.
  if ! AWS_EC2_METADATA_DISABLED=true npx cdk diff --app cdk.out --template "$old" "$display" --exclusively --no-color > "diff/${id}.diff.txt" 2>&1; then
    cat "diff/${id}.diff.txt"
    echo "::error::cdk diff failed for ${display}."
    exit 1
  fi
  cat "diff/${id}.diff.txt"
  echo "::endgroup::"

  cp "$template" "diff/${id}.new.json"
  if [[ "$deployed" == "true" ]]; then
    cp "$old" "diff/${id}.old.json"
  fi
  # The job fetch wrote the status of the deployed stack. An older fetch job wrote none, and then the value is null.
  status=""
  if [[ -f deployed/meta.json ]]; then
    status="$(jq -r --arg name "$name" '[.stacks[] | select(.name == $name) | (.status // empty)][0] // empty' deployed/meta.json)"
  fi
  stacks_meta="$(jq -c --arg id "$id" --arg name "$name" --argjson deployed "$deployed" --arg status "$status" \
    '. + [{id: $id, name: $name, deployed: $deployed, status: (if ($status | length) > 0 then $status else null end)}]' <<< "$stacks_meta")"
done <<< "$stacks"

jq -n --arg commit "${HEAD_SHA:-unknown}" --arg version "$version" --argjson stacks "$stacks_meta" \
  '{commit: $commit, version: (if ($version | length) > 0 then $version else null end), stacks: $stacks}' > diff/meta.json
rm -f empty-template.json
