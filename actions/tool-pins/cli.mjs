#!/usr/bin/env node
// The command that tool-pins.yml calls. It needs no package, only Node 22 and `gh`.
//
//   node cli.mjs run
//
// It reads the pin file, asks GitHub for the latest release of each tool, and keeps ONE open issue
// (see ../tracking-issue) for the pins that are behind. It never changes a pin. It only reads the pin file and
// writes an issue.
//
// Environment variables:
//   PINS_FILE    the pin file. Default: actions/install-tool/tools.txt in this repository.
//   ISSUE_REPO   owner/name of the repository that holds the issue. Default: GITHUB_REPOSITORY.
//   DRY_RUN      "true" writes nothing and prints what it would write.
//   RUN_URL      the link to the run, for the text of the issue.
//   GH_TOKEN     the token for `gh`. The default token of the workflow is enough: the tools are public.
//
// lib.mjs holds the rules. This file reads the file, calls gh and sets the exit code.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncIssue } from '../tracking-issue/sync.mjs';
import { checkPins, parsePins, renderBody, renderComment, repoOfUrl } from './lib.mjs';

const NAME = 'tool-pins';
const TITLE = 'tool pins: a pinned tool is behind its latest release';
const DEFAULT_PINS = fileURLToPath(new URL('../install-tool/tools.txt', import.meta.url));

// The text of a workflow command may not hold %, CR or LF as they are.
function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// latestTag(repo) gives the tag of the latest release of owner/name, or throws.
export function runPins({ pinsText, pinsFile, issueRepo, dryRun, runUrl, gh, latestTag, log = console.log }) {
  const result = { exitCode: 0, behind: [], current: [], ahead: [], unchecked: [], issue: null, summary: '' };

  let pins;
  try {
    pins = parsePins(pinsText);
    if (pins.length === 0) throw new Error('The pin file has no pin.');
  } catch (error) {
    log(`::error title=Tool pins::${escapeData(error.message)}`);
    return { ...result, exitCode: 1, summary: `The pin file could not be read: ${error.message}` };
  }

  const latest = {};
  for (const repo of new Set(pins.map((pin) => repoOfUrl(pin.url)).filter(Boolean))) {
    try {
      latest[repo] = { tag: String(latestTag(repo)).trim() };
    } catch (error) {
      latest[repo] = { error: String(error.message).trim() };
    }
  }

  Object.assign(result, checkPins({ pins, latest }));
  for (const entry of result.unchecked) {
    log(`::error title=Tool pin not checked::${escapeData(`${entry.tool}: ${entry.reason}`)}`);
  }
  if (result.unchecked.length > 0) result.exitCode = 1;
  for (const entry of result.ahead) {
    log(`::notice title=Tool pin ahead::${escapeData(`${entry.tool} ${entry.pinned} is newer than the latest release ${entry.latest}.`)}`);
  }

  const context = { pinsFile, runUrl };
  result.issue = syncIssue({
    gh,
    repo: issueRepo,
    name: NAME,
    title: TITLE,
    items: result.behind,
    renderBody: (all) => renderBody(all, context),
    renderComment: (fresh, all) => renderComment(fresh, all, context),
    dryRun,
    log,
  });

  const rows = [
    ...result.behind.map((entry) => `| ${entry.tool} | ${entry.pinned} | ${entry.latest} | behind |`),
    ...result.current.map((entry) => `| ${entry.tool} | ${entry.pinned} | ${entry.pinned} | current |`),
    ...result.ahead.map((entry) => `| ${entry.tool} | ${entry.pinned} | ${entry.latest} | ahead |`),
    ...result.unchecked.map((entry) => `| ${entry.tool} | | | not checked |`),
  ];
  result.summary = [
    '### Tool pins',
    '',
    '| Tool | Pinned | Latest | Status |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `Issue: ${result.issue.action}${result.issue.number ? ` #${result.issue.number}` : ''}${dryRun ? ' (dry run)' : ''}.`,
  ].join('\n');
  return result;
}

function realGh(args, input) {
  return execFileSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function realLatestTag(repo) {
  try {
    return execFileSync('gh', ['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(String(error.stderr || error.message).trim());
  }
}

function main(env = process.env) {
  const issueRepo = env.ISSUE_REPO || env.GITHUB_REPOSITORY;
  if (!issueRepo) {
    console.log('::error title=Tool pins::ISSUE_REPO or GITHUB_REPOSITORY must name the repository for the issue.');
    return 2;
  }
  const pinsFile = env.PINS_FILE || 'actions/install-tool/tools.txt';
  // The file must lie inside the checkout of this repository.
  if (isAbsolute(pinsFile) || pinsFile.split(/[\\/]/).includes('..')) {
    console.log('::error title=Tool pins::PINS_FILE must be a path inside the repository.');
    return 2;
  }
  let pinsText;
  try {
    pinsText = readFileSync(env.PINS_FILE || DEFAULT_PINS, 'utf8');
  } catch (error) {
    console.log(`::error title=Tool pins::${escapeData(error.message)}`);
    return 1;
  }
  const result = runPins({
    pinsText,
    pinsFile,
    issueRepo,
    dryRun: env.DRY_RUN === 'true',
    runUrl: env.RUN_URL || '',
    gh: realGh,
    latestTag: realLatestTag,
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
