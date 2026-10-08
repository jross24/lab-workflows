// The rules for the shared files of the service repositories. This file has no I/O.
//
// lab-workflows holds the one true copy of some files in the directory `shared/`. A service repository holds a copy of
// each file at the same relative path (shared/lib/logger.ts is lib/logger.ts in the service). The file `shared.lock.json`
// in the root of the service names the commit of lab-workflows that the copies come from.
//
//   sync   (sync.mjs)   copies the files of one commit into a service and writes the pin.
//   check  (cli.mjs)    in the pull request: every shared file of the service is byte-equal to the file at the PINNED commit.
//   report (cli.mjs)    each week: which services have a pin that is behind the latest commit that changed shared/.
//
// The check compares with the pinned commit and not with main. So a change of lab-workflows never fails a pull request of a service.

export const SOURCE_REPOSITORY = 'jross24/lab-workflows';
export const LOCK_FILE = 'shared.lock.json';
export const SHARED_DIR = 'shared';
export const SYNC_SCRIPT = 'actions/shared-files/sync.mjs';

const COMMIT = /^[0-9a-f]{40}$/;
const SHORT = 7;

export function isCommit(value) {
  return typeof value === 'string' && COMMIT.test(value);
}

// A path in a service: relative, with "/" as the separator and plain parts. A path that fails this test could leave the repository.
export function isSafePath(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

// ---------------------------------------------------------------------------------------------------------------------
// the lock file
// ---------------------------------------------------------------------------------------------------------------------

export function renderLock(commit) {
  if (!isCommit(commit)) throw new Error(`The commit must be 40 lowercase hex characters. Got ${JSON.stringify(commit)}.`);
  return `${JSON.stringify({ repository: SOURCE_REPOSITORY, commit }, null, 2)}\n`;
}

export function parseLock(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${LOCK_FILE} is not valid JSON: ${error.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${LOCK_FILE} must hold a JSON object.`);
  const unknown = Object.keys(data).filter((key) => key !== 'repository' && key !== 'commit');
  if (unknown.length > 0) throw new Error(`${LOCK_FILE} has a field that the check does not know: ${unknown.join(', ')}.`);
  if (data.repository !== SOURCE_REPOSITORY) {
    throw new Error(`${LOCK_FILE}: the field repository must be ${SOURCE_REPOSITORY}. Got ${JSON.stringify(data.repository)}.`);
  }
  if (!isCommit(data.commit)) {
    throw new Error(`${LOCK_FILE}: the field commit must be 40 lowercase hex characters. Got ${JSON.stringify(data.commit)}.`);
  }
  return { repository: data.repository, commit: data.commit };
}

// lockText is the text of the file, or null when the file does not exist.
// required says that this repository must have a pin. requiredReason says why, for the message.
// It returns { present, commit, failure, notice }. A failure fails the job. A notice only prints.
export function decidePin({ lockText, required, requiredReason = '' }) {
  if (lockText === null || lockText === undefined) {
    if (required) {
      return {
        present: false,
        commit: null,
        failure: `${LOCK_FILE} is missing. A repository ${requiredReason ? `with ${requiredReason} ` : ''}must pin its shared files. Run in a clone of lab-workflows: ${syncCommandFor('<path to this repository>')}`,
        notice: null,
      };
    }
    return {
      present: false,
      commit: null,
      failure: null,
      notice: `${LOCK_FILE} is missing, so this repository does not check its shared files. To adopt the shared files, run in a clone of lab-workflows: ${syncCommandFor('<path to this repository>')}`,
    };
  }
  try {
    return { present: true, commit: parseLock(lockText).commit, failure: null, notice: null };
  } catch (error) {
    return { present: false, commit: null, failure: error.message, notice: null };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the compare
// ---------------------------------------------------------------------------------------------------------------------

function sorted(values) {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// expected: Map path -> Buffer (the files at the pinned commit). actual: Map path -> Buffer | null (the files of the service).
// A path with no entry, or with null, is missing. The service may hold more files than the pin. They are not compared.
export function compareFiles(expected, actual) {
  const result = { same: [], different: [], missing: [] };
  for (const path of sorted(expected.keys())) {
    const found = actual.get(path);
    if (found === undefined || found === null) result.missing.push(path);
    else if (Buffer.compare(expected.get(path), found) === 0) result.same.push(path);
    else result.different.push(path);
  }
  return result;
}

export function syncCommandFor(target, commit) {
  return `node ${SYNC_SCRIPT} ${target}${commit ? ` ${commit}` : ''}`;
}

// The messages of a failed check. annotations: one for each file, for the workflow command ::error file=.... lines: the explanation.
export function describeProblems({ different = [], missing = [] }, commit, target = '<path to this repository>') {
  const short = commit.slice(0, SHORT);
  const annotations = [
    ...different.map((file) => ({
      file,
      message: `${file} differs from the file at lab-workflows ${short}. Do not edit a shared file in this repository.`,
    })),
    ...missing.map((file) => ({
      file,
      message: `${file} is missing. It is a shared file at lab-workflows ${short}.`,
    })),
  ];
  const lines = [
    ...different.map((file) => `differs: ${file}`),
    ...missing.map((file) => `missing: ${file}`),
    '',
    `The pin ${LOCK_FILE} names lab-workflows ${commit}. Each shared file must be byte-equal to the file at that commit.`,
    `To change a shared file, change ${SHARED_DIR}/${(different[0] ?? missing[0] ?? '<path>')} in lab-workflows and merge it. Then run in a clone of lab-workflows:`,
    `  ${syncCommandFor(target)}`,
    `To undo a hand edit and keep the pin, run in a clone of lab-workflows:`,
    `  ${syncCommandFor(target, commit)}`,
  ];
  return { annotations, lines };
}

// ---------------------------------------------------------------------------------------------------------------------
// the sync
// ---------------------------------------------------------------------------------------------------------------------

// wanted: Map path -> Buffer (the files at the commit to sync).
// current: Map path -> Buffer | null (what the service holds now, for the wanted paths and for the previous paths).
// previousPaths: the paths that the previous pin owned. A path that the new commit no longer has is removed, but only if
// the previous pin owned it, so the sync never removes a file of the service itself.
export function planSync({ wanted, current, previousPaths = [] }) {
  for (const path of [...wanted.keys(), ...previousPaths]) {
    if (!isSafePath(path)) throw new Error(`Unsafe path in the list of shared files: ${JSON.stringify(path)}.`);
  }
  const write = [];
  const unchanged = [];
  for (const path of sorted(wanted.keys())) {
    const found = current.get(path);
    if (found !== undefined && found !== null && Buffer.compare(found, wanted.get(path)) === 0) unchanged.push(path);
    else write.push(path);
  }
  const remove = sorted(previousPaths).filter((path) => !wanted.has(path) && current.get(path) !== undefined && current.get(path) !== null);
  return { write, unchanged, remove };
}

// ---------------------------------------------------------------------------------------------------------------------
// the weekly report
// ---------------------------------------------------------------------------------------------------------------------

// relation is the status that GitHub gives when it compares the pinned commit (base) with the latest commit that changed
// shared/ (head): identical, ahead (the latest commit is newer than the pin), behind (the pin is newer), or diverged.
// The pin is current when it holds the latest change of shared/, so when the latest commit is the pin or an ancestor of it.
export function classifyPin({ repository, pinned, latest, relation }) {
  if (pinned === null || pinned === undefined) return { repository, status: 'no-pin', pinned: null, latest };
  switch (relation) {
    case 'identical':
    case 'behind':
      return { repository, status: 'current', pinned, latest };
    case 'ahead':
    case 'diverged':
      return { repository, status: 'behind', pinned, latest };
    default:
      throw new Error(`${repository}: GitHub answered with the relation ${JSON.stringify(relation)}, which the check does not know.`);
  }
}

// The key of an item in the tracking issue. It changes when shared/ changes again, so the next change makes a new comment.
export function keyOf({ repository, status, latest }) {
  return status === 'no-pin' ? `${repository}@no-pin` : `${repository}@${latest.slice(0, SHORT)}`;
}

function pinCell(item) {
  return item.pinned ? `\`${item.pinned.slice(0, SHORT)}\`` : 'no pin';
}

function table(items, latest) {
  const head = '| Service | Pin | Status |\n| --- | --- | --- |';
  const rows = items.map((item) => `| ${item.repository} | ${pinCell(item)} | ${item.status === 'no-pin' ? `no pin file; the latest change of shared/ is \`${latest.slice(0, SHORT)}\`` : `behind \`${latest.slice(0, SHORT)}\``} |`);
  return [head, ...rows].join('\n');
}

function footer({ runUrl }) {
  const lines = [
    '**What to do.** For each service, open a clone of lab-workflows at the latest `main`, and run:',
    '',
    `\`${syncCommandFor('<path to the service>')}\``,
    '',
    `Then commit the changed files and \`${LOCK_FILE}\` in one pull request of the service. Use the title \`fix:\` or \`chore:\`.`,
    '',
    'The check runs each week. It changes nothing. It adds a comment here when `shared/` changes again and a service is still behind. It does not repeat a row that this issue already holds.',
  ];
  if (runUrl) lines.push('', `Run: ${runUrl}`);
  return lines.join('\n');
}

export function renderBody(items, context) {
  const n = items.length;
  return [
    `${n} ${n === 1 ? 'service is' : 'services are'} behind the latest change of \`shared/\` in lab-workflows (commit \`${context.latest.slice(0, SHORT)}\`).`,
    '',
    table(items, context.latest),
    '',
    footer(context),
  ].join('\n');
}

export function renderComment(fresh, all, context) {
  return [
    `${fresh.length} new ${fresh.length === 1 ? 'row' : 'rows'}. The latest change of \`shared/\` is \`${context.latest.slice(0, SHORT)}\`.`,
    '',
    table(fresh, context.latest),
    '',
    `All services that are behind (${all.length}):`,
    '',
    table(all, context.latest),
    ...(context.runUrl ? ['', `Run: ${context.runUrl}`] : []),
  ].join('\n');
}
