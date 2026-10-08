#!/usr/bin/env node
// The commands that preview.yml and preview-sweeper.yml call. They need no package, only Node 22.
//
//   node cli.mjs plan                              decide what a pull request event means (reads environment variables)
//   node cli.mjs check-assembly <cdk.out> <stack>  fail unless the assembly holds exactly the stack of this pull request
//   node cli.mjs comment <deployed|destroyed|failed>  post or update the one comment
//   node cli.mjs sweep <describe-stacks.json>      decide which previews to remove (writes sweep.json)
//
// lib.mjs holds the logic. This file reads files, calls `gh` and sets the exit code.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { upsertComment } from '../cdk-diff/cli.mjs';
import {
  PREVIEW_COMMENT_MARKER,
  assertStackNames,
  decidePreview,
  namesFor,
  parsePreviewStacks,
  renderPreviewComment,
  shouldSweep,
} from './lib.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------------------------------

function parseLabels(text) {
  try {
    const labels = JSON.parse(text ?? '');
    return Array.isArray(labels) ? labels.filter((label) => typeof label === 'string') : [];
  } catch {
    return [];
  }
}

export function planOutputs(env) {
  const decision = decidePreview({
    eventName: env.EVENT_NAME,
    action: env.ACTION,
    labelName: env.LABEL_NAME,
    labels: parseLabels(env.LABELS),
    headRepo: env.HEAD_REPO,
    baseRepo: env.BASE_REPO,
    actor: env.ACTOR,
    accountId: env.ACCOUNT_ID,
  });
  if (decision.action === 'none') {
    return { action: 'none', reason: oneLine(decision.reason), namespace: '', stack: '', version: '' };
  }
  const names = namesFor({ repository: env.REPOSITORY, pr: Number(env.PR_NUMBER), sha: env.SHA });
  return { action: decision.action, reason: oneLine(decision.reason), ...names };
}

// ---------------------------------------------------------------------------------------------------------------------
// check-assembly
// ---------------------------------------------------------------------------------------------------------------------

// The names of all the stacks of a cloud assembly, in every stage.
export function allStackNames(assemblyDir) {
  const names = [];
  const visit = (dir) => {
    const manifest = readJson(join(dir, 'manifest.json'));
    for (const [id, artifact] of Object.entries(manifest.artifacts ?? {})) {
      if (artifact.type === 'aws:cloudformation:stack') names.push(artifact.properties?.stackName ?? id);
      if (artifact.type === 'cdk:cloud-assembly') visit(join(dir, artifact.properties.directoryName));
    }
  };
  visit(assemblyDir);
  return names;
}

// ---------------------------------------------------------------------------------------------------------------------
// comment
// ---------------------------------------------------------------------------------------------------------------------

export function runComment({ state, env, gh, log = console.log }) {
  if (!['deployed', 'destroyed', 'failed'].includes(state)) {
    throw new Error(`The state must be deployed, destroyed or failed. Got ${JSON.stringify(state)}.`);
  }
  const body = renderPreviewComment({
    state,
    stack: env.STACK,
    url: env.URL,
    commit: env.COMMIT,
    runUrl: env.RUN_URL,
    accountIds: (env.ACCOUNT_IDS ?? '').split(',').filter(Boolean),
  });
  const posted = upsertComment({ gh, repo: env.GH_REPO, pr: Number(env.PR_NUMBER), marker: PREVIEW_COMMENT_MARKER, body });
  log(`Comment ${posted.action}.`);
  return posted;
}

// ---------------------------------------------------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------------------------------------------------

// stacks is the list `Stacks` of `aws cloudformation describe-stacks`. getPrState(repo, number) gives
// open, closed, merged or unknown.
export function sweepPlan({ stacks, owner, maxAgeDays, now, getPrState }) {
  const { previews, skipped } = parsePreviewStacks(stacks, owner);
  const asked = new Map();
  const stateOf = (preview) => {
    const key = `${preview.repo}#${preview.pr}`;
    if (!asked.has(key)) asked.set(key, getPrState(preview.repo, preview.pr));
    return asked.get(key);
  };
  const plan = { delete: [], keep: [], skipped };
  for (const preview of previews) {
    const prState = stateOf(preview);
    const verdict = shouldSweep({ preview, prState, now, maxAgeDays });
    (verdict.sweep ? plan.delete : plan.keep).push({ stack: preview.stack, repo: preview.repo, pr: preview.pr, reason: verdict.reason });
  }
  return plan;
}

function realGh(args, input) {
  return execFileSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function ghPrState(repo, pr) {
  try {
    const pull = JSON.parse(realGh(['api', `repos/${repo}/pulls/${pr}`]));
    if (pull.merged) return 'merged';
    return pull.state === 'closed' ? 'closed' : 'open';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------------

function setOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));
}

function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'plan': {
      const outputs = planOutputs(process.env);
      setOutputs(outputs);
      if (outputs.action === 'none') {
        console.log(`::notice title=No preview change::${outputs.reason}`);
        appendSummary(`### No preview change\n\n${outputs.reason}`);
      }
      return 0;
    }
    case 'check-assembly': {
      const [dir, expected] = args;
      assertStackNames(allStackNames(dir), expected);
      console.log(`The assembly holds exactly the stack ${expected}.`);
      return 0;
    }
    case 'comment': {
      runComment({ state: args[0], env: process.env, gh: realGh });
      return 0;
    }
    case 'sweep': {
      const [file] = args;
      const maxAgeDays = Number(process.env.MAX_AGE_DAYS ?? '3');
      const stacks = readJson(file).Stacks ?? [];
      const plan = sweepPlan({ stacks, owner: process.env.OWNER ?? 'jross24', maxAgeDays, now: Date.now(), getPrState: ghPrState });
      writeFileSync('sweep.json', JSON.stringify(plan, null, 2));
      const rows = [
        ...plan.delete.map((item) => `| \`${item.stack}\` | remove | ${item.reason} |`),
        ...plan.keep.map((item) => `| \`${item.stack}\` | keep | ${item.reason} |`),
        ...plan.skipped.map((item) => `| \`${item.stack}\` | skipped | ${item.reason} |`),
      ];
      appendSummary(['### Preview sweeper', '', '| Stack | Decision | Reason |', '| --- | --- | --- |', ...rows].join('\n'));
      setOutputs({ count: String(plan.delete.length) });
      for (const item of plan.delete) console.log(`remove ${item.stack}: ${item.reason}`);
      return 0;
    }
    default:
      console.error('Usage: cli.mjs plan | check-assembly <dir> <stack> | comment <state> | sweep <file>');
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
