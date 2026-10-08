#!/usr/bin/env node
// The commands that diff.yml calls. They need no package, only Node 22.
//
//   node cli.mjs gate                  decide if the diff runs (reads environment variables, writes $GITHUB_OUTPUT)
//   node cli.mjs stacks <dir> <stage>  list the stacks of one stage of a cloud assembly as JSON
//   node cli.mjs report <dir>          post or update the comment, and fail if a stateful change has no label
//
// lib.mjs holds the logic. This file reads files, calls `gh` and sets the exit code.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APPROVAL_LABEL,
  assess,
  cleanDiffOutput,
  decideRun,
  guardVerdict,
  markerFor,
  renderComment,
} from './lib.mjs';

const BOT = 'github-actions[bot]';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------------------------------------------------
// stacks
// ---------------------------------------------------------------------------------------------------------------------

// A cloud assembly has a manifest. The artifacts of a stage are in a nested assembly with its own manifest.
// An empty stage means the stacks that are not in a stage.
export function listStacks(assemblyDir, stage) {
  const stacksOf = (dir) => {
    const manifest = readJson(join(dir, 'manifest.json'));
    return Object.entries(manifest.artifacts ?? {}).flatMap(([id, artifact]) => {
      if (artifact.type !== 'aws:cloudformation:stack') return [];
      return [
        {
          displayName: artifact.displayName ?? id,
          stackName: artifact.properties?.stackName ?? id,
          templateFile: join(dir, artifact.properties.templateFile),
        },
      ];
    });
  };

  if (stage === '') return stacksOf(assemblyDir);

  const root = readJson(join(assemblyDir, 'manifest.json'));
  const nested = Object.values(root.artifacts ?? {}).find(
    (artifact) => artifact.type === 'cdk:cloud-assembly' && artifact.properties?.displayName === stage,
  );
  return nested ? stacksOf(join(assemblyDir, nested.properties.directoryName)) : [];
}

// ---------------------------------------------------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------------------------------------------------

export function gateOutputs(env) {
  const { run, reason } = decideRun({
    eventName: env.EVENT_NAME,
    headRepo: env.HEAD_REPO,
    baseRepo: env.BASE_REPO,
    actor: env.ACTOR,
    accountId: env.ACCOUNT_ID,
  });
  // The value goes into a single line of the output file.
  return { run: String(run), reason: reason.replace(/\s+/g, ' ').trim() };
}

// ---------------------------------------------------------------------------------------------------------------------
// the comment
// ---------------------------------------------------------------------------------------------------------------------

// Keeps one comment for each key. It changes only a comment that the workflow token wrote:
// another user could write the marker text in a comment of his own.
export function upsertComment({ gh, repo, pr, marker, body }) {
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments`]));
  const existing = pages
    .flat()
    .find((comment) => comment.user?.login === BOT && typeof comment.body === 'string' && comment.body.startsWith(marker));
  const input = JSON.stringify({ body });
  if (existing) {
    gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '--input', '-'], input);
    return { action: 'updated', id: existing.id };
  }
  const created = JSON.parse(gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'], input));
  return { action: 'created', id: created.id };
}

function labelsOf({ gh, repo, pr }) {
  return JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/labels`]))
    .flat()
    .map((label) => label.name);
}

// dir holds meta.json and, for each stack, <id>.diff.txt, <id>.new.json and (if deployed) <id>.old.json.
export function runReport({ dir, env, gh, log = console.log }) {
  const meta = readJson(join(dir, 'meta.json'));
  const repo = env.GH_REPO;
  const pr = Number(env.PR_NUMBER);
  const accountIds = (env.ACCOUNT_IDS ?? '').split(',').filter(Boolean);

  const summary = { add: 0, change: 0, replace: 0, delete: 0 };
  const stateful = [];
  const diffs = [];
  for (const stack of meta.stacks) {
    const diff = cleanDiffOutput(readFileSync(join(dir, `${stack.id}.diff.txt`), 'utf8'));
    const newTemplate = readJson(join(dir, `${stack.id}.new.json`));
    const oldPath = join(dir, `${stack.id}.old.json`);
    const oldTemplate = stack.deployed && existsSync(oldPath) ? readJson(oldPath) : undefined;
    const result = assess({ diff, oldTemplate, newTemplate });
    for (const key of Object.keys(summary)) summary[key] += result.summary[key];
    stateful.push(...result.stateful);
    if (diff) diffs.push(diff);
  }

  const verdict = guardVerdict(stateful, labelsOf({ gh, repo, pr }));
  const body = renderComment({
    key: env.KEY,
    title: env.TITLE,
    stackNames: meta.stacks.map((stack) => stack.name),
    commit: meta.commit,
    version: meta.version ?? undefined,
    summary,
    diff: diffs.join('\n\n'),
    stateful,
    verdict,
    label: APPROVAL_LABEL,
    accountIds,
    missingStacks: meta.stacks.filter((stack) => !stack.deployed).map((stack) => stack.name),
    // The fetch job writes the status of each deployed stack. A meta file of an older fetch job has none.
    stackStatuses: meta.stacks.map((stack) => ({ name: stack.name, status: stack.status })),
  });

  const posted = upsertComment({ gh, repo, pr, marker: markerFor(env.KEY), body });
  log(`Comment ${posted.action}.`);
  return { blocked: verdict.blocked, approved: verdict.approved, body, summary, stateful };
}

// ---------------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------------

function realGh(args, input) {
  return execFileSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function setOutputs(values) {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (file) appendFileSync(file, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));
}

function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'gate': {
      const outputs = gateOutputs(process.env);
      setOutputs(outputs);
      if (outputs.run !== 'true') {
        console.log(`::notice title=cdk diff skipped::${outputs.reason}`);
        appendSummary(`### cdk diff skipped\n\n${outputs.reason}`);
      }
      return 0;
    }
    case 'stacks': {
      const [dir, stage = ''] = args;
      console.log(JSON.stringify(listStacks(dir, stage)));
      return 0;
    }
    case 'report': {
      const [dir] = args;
      const result = runReport({ dir, env: process.env, gh: realGh });
      appendSummary(result.body);
      if (result.blocked) {
        console.log(
          `::error title=Stateful change::This pull request deletes or replaces a stateful resource. ` +
            `Add the label ${APPROVAL_LABEL} and re-run the failed job.`,
        );
        return 1;
      }
      return 0;
    }
    default:
      console.error('Usage: cli.mjs gate | stacks <dir> <stage> | report <dir>');
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
