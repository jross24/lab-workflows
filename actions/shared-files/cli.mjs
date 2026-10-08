#!/usr/bin/env node
// The commands that pr.yml (the job `shared`) and shared-files.yml call. They need no package, only Node 22.
//
//   node cli.mjs pin [--dir <folder>] [--require-if <path>]
//       Reads shared.lock.json in the folder (default: the current folder). It writes the outputs `present` and `commit`
//       to the file GITHUB_OUTPUT. Without a pin file it prints a notice and passes, unless the folder has the file
//       that --require-if names. Then it fails. A pin file that it cannot read always fails.
//
//   node cli.mjs check <shared folder> <service folder>
//       Fails when a file of the shared folder (lab-workflows at the pinned commit) is missing from the service or
//       is not byte-equal to the copy in the service.
//
//   node cli.mjs report
//       The weekly report. It lists the services whose pin is behind the latest commit that changed shared/, and keeps
//       ONE open issue (see ../tracking-issue). Environment variables:
//         REPOSITORIES  names, separated by spaces. Default: the four services.
//         OWNER         the owner of the bare names. Default: jross24.
//         ISSUE_REPO    owner/name of the repository for the issue. Default: GITHUB_REPOSITORY.
//         DRY_RUN       "true" writes nothing and prints what it would write.
//         RUN_URL       the link to the run, for the text of the issue.
//         GH_TOKEN      the token for `gh`. The default token of the workflow is enough: the repositories are public.
//
// lib.mjs holds the rules. This file reads files, calls gh and sets the exit code.
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncIssue } from '../tracking-issue/sync.mjs';
import {
  LOCK_FILE,
  SHARED_DIR,
  SOURCE_REPOSITORY,
  classifyPin,
  compareFiles,
  decidePin,
  describeProblems,
  isSafePath,
  keyOf,
  parseLock,
  renderBody,
  renderComment,
} from './lib.mjs';

const NAME = 'shared-files';
const TITLE = 'shared files: a service pin is behind lab-workflows';
const DEFAULT_REPOSITORIES = 'lab-svc-core lab-svc-catalogue lab-svc-account lab-web';
const REPOSITORY = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/;

// The text of a workflow command may not hold %, CR or LF as they are. A property may not hold : or , either.
function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// ---------------------------------------------------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------------------------------------------------

// Every file below a folder, as Map relative path -> Buffer, in sorted order. A symbolic link is not followed. It is left out.
export function readTree(dir) {
  const files = new Map();
  const walk = (relative) => {
    let entries;
    try {
      entries = readdirSync(join(dir, relative), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(path, readFileSync(join(dir, path)));
    }
  };
  walk('');
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function readFileOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function fileExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// pin
// ---------------------------------------------------------------------------------------------------------------------

export function runPin({ dir, requireIf, log = console.log }) {
  if (requireIf !== null && !isSafePath(requireIf)) throw new Error('--require-if must be a path inside the folder.');
  const required = requireIf !== null && fileExists(join(dir, requireIf));
  const decision = decidePin({ lockText: readFileOrNull(join(dir, LOCK_FILE)), required, requiredReason: requireIf ?? '' });
  const outputs = { present: decision.present ? 'true' : 'false', commit: decision.commit ?? '' };
  if (decision.notice) log(`::notice title=Shared files::${escapeData(decision.notice)}`);
  if (decision.failure) {
    log(`::error file=${escapeProperty(LOCK_FILE)},title=Shared files::${escapeData(decision.failure)}`);
    return { exitCode: 1, outputs };
  }
  return { exitCode: 0, outputs };
}

// ---------------------------------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------------------------------

export function runCheck({ sharedDir, targetDir, log = console.log }) {
  const fail = (message, summary = message) => {
    log(`::error title=Shared files::${escapeData(message)}`);
    return { exitCode: 1, summary: `### Shared files\n\n${summary}` };
  };

  let commit;
  try {
    const text = readFileOrNull(join(targetDir, LOCK_FILE));
    if (text === null) return fail(`${LOCK_FILE} is missing.`);
    commit = parseLock(text).commit;
  } catch (error) {
    return fail(error.message);
  }

  const expected = readTree(sharedDir);
  if (expected.size === 0) {
    return fail(`The pinned commit ${commit} of lab-workflows has no file under ${SHARED_DIR}/. Pin a commit that has them.`);
  }
  const actual = new Map();
  for (const path of expected.keys()) {
    const full = join(targetDir, path);
    let found = null;
    try {
      // A symbolic link counts as missing. The check reads only real files.
      if (lstatSync(full).isFile()) found = readFileSync(full);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    actual.set(path, found);
  }

  const result = compareFiles(expected, actual);
  if (result.different.length === 0 && result.missing.length === 0) {
    const n = result.same.length;
    const message = `${n} shared ${n === 1 ? 'file is' : 'files are'} equal to lab-workflows ${commit.slice(0, 7)}.`;
    log(message);
    return { exitCode: 0, summary: `### Shared files\n\n${message}` };
  }

  const { annotations, lines } = describeProblems(result, commit);
  for (const { file, message } of annotations) log(`::error file=${escapeProperty(file)},title=Shared file::${escapeData(message)}`);
  for (const line of lines) log(line);
  const summary = [
    '### Shared files',
    '',
    `${annotations.length} shared ${annotations.length === 1 ? 'file does' : 'files do'} not match lab-workflows \`${commit.slice(0, 7)}\`.`,
    '',
    ...result.different.map((file) => `- \`${file}\` differs`),
    ...result.missing.map((file) => `- \`${file}\` is missing`),
  ].join('\n');
  return { exitCode: 1, summary };
}

// ---------------------------------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------------------------------

export function parseRepositories(text, owner) {
  const names = String(text ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (names.length === 0) throw new Error('The list has no repository.');
  const full = new Set();
  for (const name of names) {
    if (!REPOSITORY.test(name)) throw new Error(`${JSON.stringify(name)} is not a repository name.`);
    full.add(name.includes('/') ? name : `${owner}/${name}`);
  }
  return [...full];
}

// latestCommit() gives the SHA of the latest commit that changed shared/.
// fetchFile(fullName, path) gives the text of a file on the default branch, or null when the file does not exist.
// compare(pinned, latest) gives the status that GitHub gives for the two commits (see classifyPin), or throws.
export function runReport({ owner, repositories, issueRepo, dryRun, runUrl, gh, latestCommit, fetchFile, compare, log = console.log }) {
  const result = { exitCode: 0, behind: [], current: [], failed: [], issue: null, summary: '' };

  let latest;
  try {
    latest = latestCommit();
  } catch (error) {
    log(`::error title=Shared files::${escapeData(`Could not find the latest commit that changed ${SHARED_DIR}/: ${error.message}`)}`);
    return { ...result, exitCode: 1, summary: 'The latest commit that changed shared/ could not be found. No service was checked.' };
  }

  const rows = [];
  const items = [];
  for (const fullName of repositories) {
    const repository = fullName.startsWith(`${owner}/`) ? fullName.slice(owner.length + 1) : fullName;
    try {
      const text = fetchFile(fullName, LOCK_FILE);
      const pinned = text === null ? null : parseLock(text).commit;
      const relation = pinned === null ? null : compare(pinned, latest);
      const entry = classifyPin({ repository, pinned, latest, relation });
      if (entry.status === 'current') {
        result.current.push(entry);
        rows.push(`| ${repository} | \`${pinned.slice(0, 7)}\` | current |`);
      } else {
        const item = { ...entry, key: keyOf(entry) };
        items.push(item);
        result.behind.push(item);
        rows.push(`| ${repository} | ${pinned ? `\`${pinned.slice(0, 7)}\`` : 'no pin'} | ${entry.status === 'no-pin' ? 'no pin' : 'behind'} |`);
      }
    } catch (error) {
      result.failed.push({ repository, reason: error.message });
      rows.push(`| ${repository} | | not checked |`);
      log(`::error title=Shared files not checked::${escapeData(`${repository}: ${error.message}`)}`);
    }
  }
  if (result.failed.length > 0) result.exitCode = 1;

  const context = { latest, runUrl };
  result.issue = syncIssue({
    gh,
    repo: issueRepo,
    name: NAME,
    title: TITLE,
    items,
    renderBody: (all) => renderBody(all, context),
    renderComment: (fresh, all) => renderComment(fresh, all, context),
    dryRun,
    log,
  });

  result.summary = [
    '### Shared files',
    '',
    `Latest commit that changed shared/: \`${latest.slice(0, 7)}\``,
    '',
    '| Service | Pin | Status |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `Issue: ${result.issue.action}${result.issue.number ? ` #${result.issue.number}` : ''}${dryRun ? ' (dry run)' : ''}.`,
  ].join('\n');
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// the real world
// ---------------------------------------------------------------------------------------------------------------------

function realGh(args, input) {
  return execFileSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function ghQuiet(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(String(error.stderr || error.message).trim());
  }
}

function realLatestCommit() {
  const sha = ghQuiet(['api', `repos/${SOURCE_REPOSITORY}/commits?path=${SHARED_DIR}&per_page=1`, '--jq', '.[0].sha // empty']).trim();
  if (!sha) throw new Error(`No commit changed ${SHARED_DIR}/.`);
  return sha;
}

function realFetchFile(fullName, path) {
  try {
    return execFileSync('gh', ['api', `repos/${fullName}/contents/${path}`, '-H', 'Accept: application/vnd.github.raw'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (/HTTP 404/.test(String(error.stderr))) return null;
    throw new Error(`Could not read ${path} of ${fullName}: ${String(error.stderr || error.message).trim()}`);
  }
}

function realCompare(pinned, latest) {
  return ghQuiet(['api', `repos/${SOURCE_REPOSITORY}/compare/${pinned}...${latest}?per_page=1`, '--jq', '.status']).trim();
}

const USAGE = 'Usage: cli.mjs pin [--dir <folder>] [--require-if <path>] | check <shared folder> <service folder> | report';

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  return value;
}

export function main(argv, env = process.env, log = console.log) {
  const [command, ...args] = argv;
  try {
    if (command === 'pin') {
      const result = runPin({ dir: option(args, '--dir') ?? '.', requireIf: option(args, '--require-if'), log });
      const text = Object.entries(result.outputs).map(([key, value]) => `${key}=${value}\n`).join('');
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, text);
      else log(text.trimEnd());
      return result.exitCode;
    }
    if (command === 'check' && args.length === 2) {
      const result = runCheck({ sharedDir: args[0], targetDir: args[1], log });
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.summary}\n`);
      return result.exitCode;
    }
    if (command === 'report' && args.length === 0) {
      const owner = env.OWNER || 'jross24';
      const issueRepo = env.ISSUE_REPO || env.GITHUB_REPOSITORY;
      if (!issueRepo) {
        log('::error title=Shared files::ISSUE_REPO or GITHUB_REPOSITORY must name the repository for the issue.');
        return 2;
      }
      const result = runReport({
        owner,
        repositories: parseRepositories(env.REPOSITORIES || DEFAULT_REPOSITORIES, owner),
        issueRepo,
        dryRun: env.DRY_RUN === 'true',
        runUrl: env.RUN_URL || '',
        gh: realGh,
        latestCommit: realLatestCommit,
        fetchFile: realFetchFile,
        compare: realCompare,
        log,
      });
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.summary}\n`);
      else log(result.summary);
      return result.exitCode;
    }
  } catch (error) {
    log(`::error title=Shared files::${escapeData(error.message)}`);
    return 2;
  }
  log(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
