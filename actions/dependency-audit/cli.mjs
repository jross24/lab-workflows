#!/usr/bin/env node
// The command that dependency-audit.yml calls. It needs no package, only Node 22 and npm.
//
//   node cli.mjs run
//
// For each repository it reads package.json and package-lock.json from the default branch through the GitHub API,
// and runs `npm audit --package-lock-only`. It needs no clone and no install. It drops the advisories of
// accepted-advisories.json that have not expired, and the findings below the minimum severity. Then it keeps ONE
// open issue (see ../tracking-issue): it opens the issue for a new finding, or comments on the open issue.
//
// Environment variables:
//   REPOSITORIES   names, separated by spaces, commas or line breaks. A bare name gets OWNER.
//   OWNER          the owner of the bare names. Default: GITHUB_REPOSITORY_OWNER, then jross24.
//   MIN_SEVERITY   info, low, moderate, high or critical. Default: moderate.
//   ISSUE_REPO     owner/name of the repository that holds the issue. Default: GITHUB_REPOSITORY.
//   ACCEPTED_FILE  the list of accepted advisories. Default: accepted-advisories.json in the root of this repository.
//   DRY_RUN        "true" writes nothing and prints what it would write.
//   TODAY          YYYY-MM-DD, for the expiry of accepted advisories. Default: the UTC date of the clock.
//   GH_TOKEN       the token for `gh`. The default token of the workflow is enough: the repositories are public.
//
// lib.mjs holds the rules. This file reads files, calls gh and npm, and sets the exit code.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate, parseList } from '../accepted-advisories/lib.mjs';
import { syncIssue } from '../tracking-issue/sync.mjs';
import { SEVERITIES, parseAudit, renderBody, renderComment, selectFindings } from './lib.mjs';

const NAME = 'dependency-audit';
const TITLE = 'dependency audit: advisories in the lab repositories';
const DEFAULT_ACCEPTED = fileURLToPath(new URL('../../accepted-advisories.json', import.meta.url));
const REPOSITORY = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/;

// The text of a workflow command may not hold %, CR or LF as they are.
function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

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

function shortName(fullName, owner) {
  return fullName.startsWith(`${owner}/`) ? fullName.slice(owner.length + 1) : fullName;
}

function summaryTable(rows) {
  const head = '| Repository | Result | Reported | Accepted | Below minimum |\n| --- | --- | --- | --- | --- |';
  return [head, ...rows].join('\n');
}

// fetchFile(fullName, path) gives the text of a file on the default branch, or null when the file does not exist.
// npmAudit({ 'package.json': text, 'package-lock.json': text }) gives the text that `npm audit --json` wrote.
export function runAudit({ owner, repositories, minSeverity, issueRepo, acceptedText, today, dryRun, runUrl, gh, fetchFile, npmAudit, log = console.log }) {
  const result = { exitCode: 0, repositories: [], skipped: [], failed: [], issue: null, summary: '' };

  let acceptedIds;
  try {
    const { allowed, problems } = evaluate(parseList(acceptedText), today);
    acceptedIds = new Set(allowed.map((entry) => entry.id));
    // An entry with a problem is left out, so its advisory is a finding again. Same rule as the pull request check.
    for (const problem of problems) log(`::warning title=Accepted advisory not applied::${escapeData(problem)}`);
  } catch (error) {
    log(`::error title=Accepted advisories::${escapeData(error.message)}`);
    return { ...result, exitCode: 1, summary: 'The list of accepted advisories could not be read. No repository was audited.' };
  }

  const rows = [];
  const items = [];
  for (const fullName of repositories) {
    const repo = shortName(fullName, owner);
    try {
      const lock = fetchFile(fullName, 'package-lock.json');
      if (lock === null) {
        log(`::notice title=Dependency audit::${escapeData(repo)} has no package-lock.json. Skipped.`);
        result.skipped.push(repo);
        rows.push(`| ${repo} | skipped: no package-lock.json | | | |`);
        continue;
      }
      const manifest = fetchFile(fullName, 'package.json');
      if (manifest === null) throw new Error('package-lock.json exists, but package.json does not.');
      const findings = parseAudit(npmAudit({ 'package.json': manifest, 'package-lock.json': lock }));
      const picked = selectFindings({ repo, findings, acceptedIds, minSeverity });
      result.repositories.push({ repo, reported: picked.reported.length, accepted: picked.accepted, belowThreshold: picked.belowThreshold });
      items.push(...picked.reported);
      rows.push(`| ${repo} | audited | ${picked.reported.length} | ${picked.accepted.length} | ${picked.belowThreshold} |`);
      log(`${repo}: ${picked.reported.length} reported, ${picked.accepted.length} accepted, ${picked.belowThreshold} below ${minSeverity}.`);
    } catch (error) {
      result.failed.push({ repo, message: error.message });
      rows.push(`| ${repo} | failed: ${String(error.message).replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 200)} | | | |`);
      log(`::error title=Dependency audit failed::${escapeData(`${repo}: ${error.message}`)}`);
    }
  }
  if (result.failed.length > 0) result.exitCode = 1;

  const context = { minSeverity, runUrl };
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
    `### Dependency audit (minimum severity: ${minSeverity})`,
    '',
    summaryTable(rows),
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

function realFetchFile(fullName, path) {
  try {
    return execFileSync('gh', ['api', `repos/${fullName}/contents/${path}`, '-H', 'Accept: application/vnd.github.raw'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (/HTTP 404/.test(String(error.stderr))) return null;
    throw new Error(`Could not read ${path} of ${fullName}: ${String(error.stderr || error.message).trim()}`);
  }
}

// npm audit exits with 1 when it finds something, so the exit code says nothing. The JSON on stdout does.
function realNpmAudit(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-audit-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const windows = process.platform === 'win32';
    const run = spawnSync(windows ? 'npm.cmd' : 'npm', ['audit', '--package-lock-only', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      shell: windows,
    });
    if (!run.stdout) throw new Error(`npm audit wrote no output. ${String(run.stderr || run.error || '').trim()}`);
    return run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(env = process.env) {
  const owner = env.OWNER || env.GITHUB_REPOSITORY_OWNER || 'jross24';
  const minSeverity = env.MIN_SEVERITY || 'moderate';
  if (!SEVERITIES.includes(minSeverity)) {
    console.log(`::error title=Dependency audit::MIN_SEVERITY must be one of ${SEVERITIES.join(', ')}. Got ${escapeData(JSON.stringify(minSeverity))}.`);
    return 2;
  }
  const issueRepo = env.ISSUE_REPO || env.GITHUB_REPOSITORY;
  if (!issueRepo) {
    console.log('::error title=Dependency audit::ISSUE_REPO or GITHUB_REPOSITORY must name the repository for the issue.');
    return 2;
  }
  let repositories;
  try {
    repositories = parseRepositories(env.REPOSITORIES, owner);
  } catch (error) {
    console.log(`::error title=Dependency audit::${escapeData(error.message)}`);
    return 2;
  }
  let acceptedText;
  try {
    acceptedText = readFileSync(env.ACCEPTED_FILE || DEFAULT_ACCEPTED, 'utf8');
  } catch (error) {
    console.log(`::error title=Accepted advisories::${escapeData(error.message)}`);
    return 1;
  }
  const result = runAudit({
    owner,
    repositories,
    minSeverity,
    issueRepo,
    acceptedText,
    today: env.TODAY || new Date().toISOString().slice(0, 10),
    dryRun: env.DRY_RUN === 'true',
    runUrl: env.RUN_URL || '',
    gh: realGh,
    fetchFile: realFetchFile,
    npmAudit: realNpmAudit,
  });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.summary}\n`);
  else console.log(result.summary);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'run') {
    console.error('Usage: cli.mjs run');
    process.exitCode = 2;
  } else {
    process.exitCode = main();
  }
}
