// The logic behind the cdk diff comment of a pull request. The README of this repository explains the design.
// These functions are pure: they read no file, call no API and read no clock. lib.test.mjs tests them.
// The code runs in trusted jobs only. It treats the diff text as data, because a pull request produces it.

export const APPROVAL_LABEL = 'destructive-change-approved';
export const COMMENT_MARKER_PREFIX = '<!-- lab-cdk-diff:';
export const PLACEHOLDER = '[account-id]';

// The resource types for which a delete or a replacement can lose data. The list is short on purpose.
// A type that is not here never blocks a pull request. Add a type when the lab starts to use it.
// Log groups are here because a deleted log group deletes the history of the service.
export const STATEFUL_TYPES = [
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
  'AWS::S3::Bucket',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::EFS::FileSystem',
  'AWS::Cognito::UserPool',
  'AWS::KMS::Key',
  'AWS::Logs::LogGroup',
];

// ---------------------------------------------------------------------------------------------------------------------
// Account IDs
// ---------------------------------------------------------------------------------------------------------------------

// Twelve digits with no letter or digit next to them. This matches an account ID in an ARN, in a role name
// and in a bucket name. It does not match a hash, a timestamp or a longer number.
const ACCOUNT_ID_PATTERN = /(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/g;

// Comments are not masked like logs. This function runs on the whole text before a person can read it.
// Layer 1 replaces the IDs that the job knows, wherever they appear. Layer 2 replaces any other 12 digit number.
export function redact(text, knownIds = []) {
  let out = String(text);
  for (const id of knownIds) {
    if (typeof id === 'string' && id.length > 0) out = out.split(id).join(PLACEHOLDER);
  }
  return out.replace(ACCOUNT_ID_PATTERN, PLACEHOLDER);
}

// ---------------------------------------------------------------------------------------------------------------------
// The text of `cdk diff`
// ---------------------------------------------------------------------------------------------------------------------

// The CLI prints notices and warnings before the diff, and a summary after it. Keep the stack sections only.
export function cleanDiffOutput(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const first = lines.findIndex((line) => line.startsWith('Stack '));
  if (first === -1) return '';
  const kept = lines.slice(first).filter((line) => !line.startsWith('✨'));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// A resource line of the diff: [+] AWS::DynamoDB::Table Orders Orders destroy
// Property lines start with a box character, and output lines have no resource type, so they do not match.
const RESOURCE_LINE = /^\[([+~-])\] ([A-Za-z0-9]+(?:::[A-Za-z0-9]+)+) (\S+) (\S+)(?: (.+))?$/;

export function parseDiff(text) {
  const changes = [];
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const match = RESOURCE_LINE.exec(line);
    if (!match) continue;
    const [, kind, type, path, logicalId, rest = ''] = match;
    let action = '';
    if (/destroy/.test(rest)) action = 'destroy';
    else if (/orphan/.test(rest)) action = 'orphan';
    else if (/replace/.test(rest)) action = 'replace';
    changes.push({ kind, type, path, logicalId, action });
  }
  return changes;
}

export function summarize(changes) {
  const summary = { add: 0, change: 0, replace: 0, delete: 0 };
  for (const change of changes) {
    if (change.kind === '+') summary.add += 1;
    else if (change.kind === '-') summary.delete += 1;
    else if (change.action === 'replace') summary.replace += 1;
    else summary.change += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------------------------------
// The guard for stateful resources
// ---------------------------------------------------------------------------------------------------------------------

// A resource that the new template does not have is deleted by the deployment. With DeletionPolicy Retain
// CloudFormation only stops to manage it ("orphan"). This check reads the templates and not the text of the CLI,
// so a change of the text format cannot hide a delete.
export function findRemovedStateful(oldTemplate, newTemplate) {
  const oldResources = oldTemplate?.Resources;
  const newResources = newTemplate?.Resources;
  if (!oldResources || !newResources) return [];
  const removed = [];
  for (const [logicalId, resource] of Object.entries(oldResources)) {
    if (!STATEFUL_TYPES.includes(resource?.Type) || logicalId in newResources) continue;
    const policy = String(resource.DeletionPolicy ?? '');
    removed.push({ type: resource.Type, logicalId, action: policy.startsWith('Retain') ? 'orphan' : 'destroy' });
  }
  return removed;
}

// Combines the two sources: the text of the diff (it knows the replacements) and the templates (they know the deletes).
export function assess({ diff, oldTemplate, newTemplate }) {
  const changes = parseDiff(diff);
  const fromText = changes
    .filter((change) => STATEFUL_TYPES.includes(change.type) && (change.kind === '-' || change.action === 'replace'))
    .map((change) => ({
      type: change.type,
      logicalId: change.logicalId,
      action: change.action || (change.kind === '-' ? 'destroy' : 'replace'),
    }));
  const stateful = [...fromText];
  for (const removed of findRemovedStateful(oldTemplate, newTemplate)) {
    if (!stateful.some((found) => found.type === removed.type && found.logicalId === removed.logicalId)) {
      stateful.push(removed);
    }
  }
  return { changes, summary: summarize(changes), stateful };
}

// The label must have this exact spelling. Anyone with triage rights can add it, and it is visible on the pull request.
export function guardVerdict(stateful, labels) {
  if (stateful.length === 0) return { blocked: false, approved: false };
  const approved = labels.includes(APPROVAL_LABEL);
  return { blocked: !approved, approved };
}

// ---------------------------------------------------------------------------------------------------------------------
// Should the diff run at all?
// ---------------------------------------------------------------------------------------------------------------------

// A pull request from a fork gets no OIDC token and no secret from GitHub. A Dependabot pull request gets none either.
// The workflow then skips the diff with a notice. It does not fail.
export function decideRun({ eventName, headRepo, baseRepo, actor, accountId }) {
  if (eventName !== 'pull_request') {
    return { run: false, reason: `The event is ${eventName}, not pull_request. The diff runs for pull requests only.` };
  }
  if (!headRepo || headRepo !== baseRepo) {
    return {
      run: false,
      reason:
        'This pull request comes from a fork. GitHub gives the jobs of a fork no OIDC token and no secret, ' +
        'so the job cannot read the deployed stack. The diff is skipped. A maintainer can push the branch to this repository to get the diff.',
    };
  }
  if (typeof actor === 'string' && actor.startsWith('dependabot')) {
    return {
      run: false,
      reason: 'This pull request comes from Dependabot. GitHub gives its jobs no OIDC token, so the diff is skipped.',
    };
  }
  if (!accountId) {
    return {
      run: false,
      reason: 'This repository has no secret that names the account of the diff, so the diff is skipped. The README of lab-workflows explains the secret.',
    };
  }
  return { run: true, reason: '' };
}

// ---------------------------------------------------------------------------------------------------------------------
// The comment
// ---------------------------------------------------------------------------------------------------------------------

export function markerFor(key) {
  return `${COMMENT_MARKER_PREFIX}${key} -->`;
}

// A fence longer than any run of backticks in the text. The text cannot close the block and write its own markdown.
export function fenceFor(text) {
  const runs = String(text).match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const omitted = text.length - 2 * half;
  return `${text.slice(0, half)}\n[... ${omitted} characters omitted ...]\n${text.slice(text.length - half)}`;
}

// GitHub allows 65536 characters in a comment. The diff gets at most this many.
const MAX_DIFF_CHARACTERS = 55000;

function summaryLine(summary) {
  return `${summary.add} to add, ${summary.change} to change, ${summary.replace} to replace, ${summary.delete} to delete`;
}

// The template can differ with no resource added, changed, replaced or deleted: the description, a parameter
// or an output has no resource line. The four counts are then zero, so the line says what the counts cannot.
const OTHER_DIFFERENCE = 'but something else differs (for example a parameter, an output or the description)';

// CloudFormation names a status like UPDATE_IN_PROGRESS. The meta file comes from a job that ran the code of the
// pull request, so the comment shows a value only if it has this shape. Any other value is dropped.
const STATUS_FORMAT = /^[A-Z][A-Z_]*$/;

// A status that ends in _COMPLETE is stable. Every other status (IN_PROGRESS, FAILED) means that the deployed template
// can be the one of a release that is still on its way.
export function unstableStacks(stackStatuses) {
  return (Array.isArray(stackStatuses) ? stackStatuses : []).filter(
    (item) =>
      typeof item?.name === 'string' &&
      typeof item.status === 'string' &&
      STATUS_FORMAT.test(item.status) &&
      !item.status.endsWith('_COMPLETE'),
  );
}

function statusSection(stackStatuses) {
  const unstable = unstableStacks(stackStatuses);
  if (unstable.length === 0) return '';
  const lines = unstable.flatMap((item) => [`> **The stack \`${item.name}\` has the status \`${item.status}\`.**`, '>']);
  return ['> [!WARNING]', ...lines, '> The comparison may be against a release that still runs.'].join('\n');
}

function guardSection({ stateful, verdict, label }) {
  if (stateful.length === 0) return '';
  const rows = stateful.map((item) => `> | \`${item.logicalId}\` | \`${item.type}\` | ${item.action} |`);
  const table = ['> | Resource | Type | Change |', '> | --- | --- | --- |', ...rows].join('\n');
  if (verdict.approved) {
    return [
      '> [!NOTE]',
      `> **Approved by the label \`${label}\`.** This change deletes or replaces a stateful resource.`,
      '>',
      table,
    ].join('\n');
  }
  return [
    '> [!CAUTION]',
    '> **Blocked: this change deletes or replaces a stateful resource.** A deletion or a replacement can lose data.',
    '>',
    table,
    '>',
    `> If you are sure, add the label \`${label}\` to this pull request. Then re-run the failed job.`,
  ].join('\n');
}

// Builds the markdown of the one comment. The caller posts it. The whole text goes through redact().
export function renderComment({
  key,
  title,
  stackNames,
  commit,
  version,
  summary,
  diff,
  stateful,
  verdict,
  label,
  accountIds,
  missingStacks = [],
  stackStatuses = [],
}) {
  // A diff of outputs or parameters only has no resource line, but it is still a change.
  const hasChangeLines = /^\[[+~-]\] /m.test(diff);
  const noCounts = summary.add + summary.change + summary.replace + summary.delete === 0;
  const none = noCounts && !hasChangeLines && stateful.length === 0;
  // The guard counts a stateful resource that the templates show and the text does not. That case is a resource change.
  const onlyOther = noCounts && !none && stateful.length === 0;
  const parts = [markerFor(key), `### ${title}`, ''];

  parts.push(
    none
      ? '**No change.** The templates of this pull request equal the deployed templates.'
      : `**${summaryLine(summary)}${onlyOther ? `, ${OTHER_DIFFERENCE}` : ''}.**`,
  );
  parts.push('');
  const names = stackNames.map((name) => `\`${name}\``).join(', ');
  const facts = [`Stack: ${names}.`, `Commit: \`${String(commit).slice(0, 7)}\`.`];
  if (version) {
    facts.push(`The build uses the version that runs now (\`${version}\`), so the version number is not a change.`);
  }
  parts.push(facts.join(' '));

  if (missingStacks.length > 0) {
    parts.push('');
    parts.push(
      `${missingStacks.map((name) => `\`${name}\``).join(', ')} is not deployed yet in this account. The diff shows every resource as new.`,
    );
  }

  const status = statusSection(stackStatuses);
  if (status) parts.push('', status);

  const guard = guardSection({ stateful, verdict, label });
  if (guard) parts.push('', guard);

  if (!none && diff.trim().length > 0) {
    const shown = truncateMiddle(diff, MAX_DIFF_CHARACTERS);
    const fence = fenceFor(shown);
    parts.push('', '<details>', '<summary>Show the diff</summary>', '', `${fence}text`, shown, fence, '', '</details>');
  }

  parts.push('', '<sub>This comment changes in place on each push. Account numbers are replaced before it is posted.</sub>');
  return redact(parts.join('\n'), accountIds);
}
