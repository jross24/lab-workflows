// The logic behind the temporary environment of a pull request. The README of this repository explains the design.
// These functions are pure: they read no file, call no API and read no clock (the caller gives the time).
// lib.test.mjs tests them. They run in trusted jobs only, and they treat every input from a pull request as data.
import { redact } from '../cdk-diff/lib.mjs';

export const PREVIEW_LABEL = 'preview';
export const PREVIEW_COMMENT_MARKER = '<!-- lab-preview -->';

// The tags that the deploy step puts on the stack. The sweeper finds the previews with them.
export const TAG_REPO = 'lab-preview-repo';
export const TAG_PR = 'lab-preview-pr';

const REPOSITORY = /^[a-z][a-z0-9-]{0,60}$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;

// The names of one preview. The namespace pr-<number> is reserved for the pipeline: a developer picks another name.
// The stack name is the name of the repository plus the namespace. This is the rule of the catalogue service:
// lab-svc-catalogue-<namespace>. The repository name keeps two repositories apart, and the number keeps two pull
// requests of one repository apart.
export function namesFor({ repository, pr, sha }) {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) {
    throw new Error(`The repository name must look like lab-svc-catalogue. Got ${JSON.stringify(repository)}.`);
  }
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) {
    throw new Error(`The pull request number must be a positive whole number. Got ${JSON.stringify(pr)}.`);
  }
  if (typeof sha !== 'string' || !COMMIT.test(sha)) {
    throw new Error(`The commit must be a hexadecimal SHA. Got ${JSON.stringify(sha)}.`);
  }
  const namespace = `pr-${pr}`;
  // The version is also a metric dimension. A version of its own keeps the alarms of two previews apart.
  return { namespace, stack: `${repository}-${namespace}`, version: `0.0.0-pr${pr}.${sha.slice(0, 7).toLowerCase()}` };
}

// What does this pull request event mean for the preview?
//   deploy   build and deploy the preview
//   destroy  remove the preview
//   none     do nothing
// A pull request from a fork or from Dependabot gets no OIDC token, so it never has a preview.
export function decidePreview({ eventName, action, labelName, labels, headRepo, baseRepo, actor, accountId }) {
  const none = (reason) => ({ action: 'none', reason });
  if (eventName !== 'pull_request') return none(`The event is ${eventName}, not pull_request.`);
  if (!headRepo || headRepo !== baseRepo) {
    return none('This pull request comes from a fork. GitHub gives a fork no OIDC token, so it gets no preview.');
  }
  if (typeof actor === 'string' && actor.startsWith('dependabot')) {
    return none('This pull request comes from Dependabot. GitHub gives its jobs no OIDC token, so it gets no preview.');
  }
  if (!accountId) return none('This repository has no secret that names the account of the previews.');

  const hasLabel = Array.isArray(labels) && labels.includes(PREVIEW_LABEL);
  switch (action) {
    case 'closed':
      // A pull request that never had the label has no preview. Skip the AWS login for it.
      return hasLabel ? { action: 'destroy', reason: 'The pull request is closed.' } : none(`The pull request has no label ${PREVIEW_LABEL}.`);
    case 'unlabeled':
      return labelName === PREVIEW_LABEL
        ? { action: 'destroy', reason: `The label ${PREVIEW_LABEL} was removed.` }
        : none(`The removed label is not ${PREVIEW_LABEL}.`);
    case 'labeled':
      if (labelName !== PREVIEW_LABEL) return none(`The added label is not ${PREVIEW_LABEL}.`);
      return { action: 'deploy', reason: `The label ${PREVIEW_LABEL} was added.` };
    case 'opened':
    case 'reopened':
    case 'synchronize':
      return hasLabel ? { action: 'deploy', reason: `The pull request has the label ${PREVIEW_LABEL}.` } : none(`The pull request has no label ${PREVIEW_LABEL}.`);
    default:
      return none(`The pull request action ${action} does not change a preview.`);
  }
}

// The code of a pull request makes the assembly. The deploy and the destroy use the names in it.
// Code that does not know the namespace gives the name of the baseline stack, and a destroy would remove the baseline.
// So the assembly must hold exactly the stack that this pull request owns.
export function assertStackNames(found, expected) {
  if (found.length !== 1 || found[0] !== expected) {
    throw new Error(
      `The cloud assembly must hold exactly one stack, ${expected}. It holds ${found.length === 0 ? 'no stack' : found.join(', ')}. ` +
        'The code of this pull request may not know the namespace context value.',
    );
  }
}

export function renderPreviewComment({ state, stack, url, commit, runUrl, accountIds = [] }) {
  const short = String(commit).slice(0, 7);
  const lines = [PREVIEW_COMMENT_MARKER, '### Preview environment', ''];
  if (state === 'deployed') {
    lines.push(
      `**Preview is ready:** ${url}`,
      '',
      `Commit \`${short}\`, stack \`${stack}\` in the developer account. It reads core from the baseline copy of the account.`,
      'A push to this pull request deploys the new commit here. The preview is removed when this pull request closes or when the label is removed.',
    );
  } else if (state === 'destroyed') {
    lines.push(`The preview was removed. Stack \`${stack}\` is gone from the developer account.`);
  } else {
    lines.push(`**The preview failed** for commit \`${short}\`. See [the run](${runUrl}) for the reason.`);
  }
  return redact(lines.join('\n'), accountIds);
}

// ---------------------------------------------------------------------------------------------------------------------
// The sweeper
// ---------------------------------------------------------------------------------------------------------------------

const KEEP_STATUSES = new Set(['DELETE_IN_PROGRESS', 'DELETE_COMPLETE']);

// Reads the previews from the output of `aws cloudformation describe-stacks`. A stack is a preview only if its tags
// say so AND its name fits the tags. A person could tag the baseline stack; the sweeper must never delete it.
export function parsePreviewStacks(stacks, owner) {
  const previews = [];
  const skipped = [];
  for (const stack of stacks) {
    const tags = Object.fromEntries((stack.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
    if (!(TAG_REPO in tags) && !(TAG_PR in tags)) continue;
    if (KEEP_STATUSES.has(stack.StackStatus)) continue;

    const skip = (reason) => skipped.push({ stack: stack.StackName, reason });
    const repo = tags[TAG_REPO];
    const prText = tags[TAG_PR];
    const match = new RegExp(`^${owner}/(lab-[a-z0-9-]+)$`).exec(repo ?? '');
    if (!match) {
      skip(`The tag ${TAG_REPO} is not a ${owner}/lab-* repository.`);
      continue;
    }
    if (!/^[1-9][0-9]*$/.test(prText ?? '')) {
      skip(`The tag ${TAG_PR} is not a pull request number.`);
      continue;
    }
    const pr = Number(prText);
    if (stack.StackName !== `${match[1]}-pr-${pr}`) {
      skip(`The stack name does not fit the tags. Expected ${match[1]}-pr-${pr}.`);
      continue;
    }
    previews.push({ stack: stack.StackName, repo, pr, createdAt: stack.CreationTime, status: stack.StackStatus });
  }
  return { previews, skipped };
}

// prState is open, closed, merged or unknown. A preview of a closed pull request goes. So does a preview that is
// older than the limit, because a forgotten open pull request must not cost money for ever.
export function shouldSweep({ preview, prState, now, maxAgeDays }) {
  if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error(`maxAgeDays must be a positive number. Got ${JSON.stringify(maxAgeDays)}.`);
  }
  if (prState === 'closed' || prState === 'merged') {
    return { sweep: true, reason: `The pull request is ${prState}.` };
  }
  const created = Date.parse(preview.createdAt);
  if (Number.isNaN(created)) return { sweep: false, reason: 'The creation time of the stack cannot be read.' };
  const ageDays = (now - created) / 86_400_000;
  if (ageDays > maxAgeDays) {
    return { sweep: true, reason: `The preview is older than ${maxAgeDays} days.` };
  }
  return { sweep: false, reason: `The pull request is ${prState} and the preview is younger than ${maxAgeDays} days.` };
}
