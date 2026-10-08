// Tests for cli.mjs. Run them with: node --test actions/preview/cli.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { allStackNames, planOutputs, runComment, sweepPlan } from './cli.mjs';
import { PREVIEW_COMMENT_MARKER } from './lib.mjs';

const ACCOUNT = '123456789012';

describe('planOutputs', () => {
  const env = {
    EVENT_NAME: 'pull_request',
    ACTION: 'synchronize',
    LABEL_NAME: '',
    LABELS: JSON.stringify(['preview']),
    HEAD_REPO: 'jross24/lab-svc-catalogue',
    BASE_REPO: 'jross24/lab-svc-catalogue',
    ACTOR: 'jross24',
    ACCOUNT_ID: ACCOUNT,
    REPOSITORY: 'lab-svc-catalogue',
    PR_NUMBER: '12',
    SHA: 'abc1234def5678',
  };

  it('gives the action and the names for a deployment', () => {
    assert.deepEqual(planOutputs(env), {
      action: 'deploy',
      reason: 'The pull request has the label preview.',
      namespace: 'pr-12',
      stack: 'lab-svc-catalogue-pr-12',
      version: '0.0.0-pr12.abc1234',
    });
  });

  it('gives the names for a destroy, and none for no action', () => {
    assert.equal(planOutputs({ ...env, ACTION: 'closed' }).action, 'destroy');
    assert.equal(planOutputs({ ...env, ACTION: 'closed' }).stack, 'lab-svc-catalogue-pr-12');
    const none = planOutputs({ ...env, LABELS: '[]' });
    assert.equal(none.action, 'none');
    assert.equal(none.stack, '');
  });

  it('treats labels that are not a JSON list as no label', () => {
    assert.equal(planOutputs({ ...env, LABELS: 'preview' }).action, 'none');
    assert.equal(planOutputs({ ...env, LABELS: '' }).action, 'none');
  });

  it('fails for an action with a bad pull request number, and does not build a name from it', () => {
    assert.throws(() => planOutputs({ ...env, PR_NUMBER: '12; id' }));
  });

  it('keeps every value on one line, so it is safe in the output file', () => {
    for (const value of Object.values(planOutputs({ ...env, HEAD_REPO: 'a/b' }))) assert.doesNotMatch(value, /\n/);
  });
});

function fakeAssembly(stackNames) {
  const root = mkdtempSync(join(tmpdir(), 'preview-test-'));
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      artifacts: { 'assembly-Dev': { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Dev', displayName: 'Dev' } } },
    }),
  );
  const dir = join(root, 'assembly-Dev');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      artifacts: Object.fromEntries(
        stackNames.map((name, i) => [`S${i}`, { type: 'aws:cloudformation:stack', displayName: `Dev/S${i}`, properties: { templateFile: 't.json', stackName: name } }]),
      ),
    }),
  );
  return root;
}

describe('allStackNames', () => {
  it('lists the stack names of every stage', () => {
    assert.deepEqual(allStackNames(fakeAssembly(['lab-svc-catalogue-pr-12'])), ['lab-svc-catalogue-pr-12']);
  });

  it('lists more than one stack', () => {
    assert.deepEqual(allStackNames(fakeAssembly(['a', 'b'])).sort(), ['a', 'b']);
  });
});

function fakeGh(comments) {
  return (args, input) => {
    const isWrite = args[1] === '-X';
    const method = isWrite ? args[2] : 'GET';
    if (method === 'GET') return JSON.stringify([comments]);
    if (method === 'PATCH') {
      comments.find((c) => c.id === Number(args[3].split('/').pop())).body = JSON.parse(input).body;
      return '{}';
    }
    const created = { id: 100 + comments.length, user: { login: 'github-actions[bot]' }, body: JSON.parse(input).body };
    comments.push(created);
    return JSON.stringify(created);
  };
}

describe('runComment', () => {
  const env = { GH_REPO: 'jross24/lab-svc-catalogue', PR_NUMBER: '12', STACK: 'lab-svc-catalogue-pr-12', COMMIT: 'abc1234def', RUN_URL: 'https://github.com/o/r/actions/runs/1', ACCOUNT_IDS: ACCOUNT, URL: 'https://x.execute-api.eu-west-2.amazonaws.com/products' };

  it('creates the comment, then updates the same comment', () => {
    const comments = [];
    const gh = fakeGh(comments);
    runComment({ state: 'deployed', env, gh, log: () => {} });
    runComment({ state: 'destroyed', env, gh, log: () => {} });
    assert.equal(comments.length, 1);
    assert.ok(comments[0].body.startsWith(PREVIEW_COMMENT_MARKER));
    assert.match(comments[0].body, /removed/);
  });

  it('rejects a state that it does not know', () => {
    assert.throws(() => runComment({ state: 'whatever', env, gh: fakeGh([]), log: () => {} }), /state/);
  });
});

describe('sweepPlan', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const stack = (name, repo, pr, created, status = 'CREATE_COMPLETE') => ({
    StackName: name,
    StackStatus: status,
    CreationTime: created,
    Tags: [
      { Key: 'lab-preview-repo', Value: repo },
      { Key: 'lab-preview-pr', Value: String(pr) },
    ],
  });
  const states = { 'jross24/lab-svc-catalogue#1': 'closed', 'jross24/lab-svc-catalogue#2': 'open', 'jross24/lab-svc-catalogue#3': 'merged' };
  const getPrState = (repo, pr) => states[`${repo}#${pr}`] ?? 'unknown';

  const stacks = [
    stack('lab-svc-catalogue-pr-1', 'jross24/lab-svc-catalogue', 1, '2026-10-10T10:00:00Z'),
    stack('lab-svc-catalogue-pr-2', 'jross24/lab-svc-catalogue', 2, '2026-10-10T10:00:00Z'),
    stack('lab-svc-catalogue-pr-3', 'jross24/lab-svc-catalogue', 3, '2026-10-10T10:00:00Z'),
    stack('lab-svc-catalogue-pr-4', 'jross24/lab-svc-catalogue', 4, '2026-10-01T10:00:00Z'),
    { StackName: 'lab-svc-catalogue', StackStatus: 'UPDATE_COMPLETE', CreationTime: '2026-10-01T00:00:00Z', Tags: [] },
    { StackName: 'CDKToolkit', StackStatus: 'CREATE_COMPLETE', CreationTime: '2026-10-01T00:00:00Z' },
    // A tagged baseline stack: the name does not fit the tags.
    stack('lab-svc-catalogue', 'jross24/lab-svc-catalogue', 9, '2026-09-01T00:00:00Z'),
  ];

  it('sweeps closed, merged and old previews, and keeps the open young one', () => {
    const plan = sweepPlan({ stacks, owner: 'jross24', maxAgeDays: 3, now, getPrState });
    assert.deepEqual(plan.delete.map((item) => item.stack).sort(), ['lab-svc-catalogue-pr-1', 'lab-svc-catalogue-pr-3', 'lab-svc-catalogue-pr-4']);
    assert.deepEqual(plan.keep.map((item) => item.stack), ['lab-svc-catalogue-pr-2']);
  });

  it('never deletes the baseline stack or the bootstrap stack, even when a tag names it', () => {
    const plan = sweepPlan({ stacks, owner: 'jross24', maxAgeDays: 3, now, getPrState });
    const all = [...plan.delete, ...plan.keep].map((item) => item.stack);
    assert.ok(!all.includes('lab-svc-catalogue'));
    assert.ok(!all.includes('CDKToolkit'));
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].stack, 'lab-svc-catalogue');
  });

  it('gives a reason for each decision', () => {
    const plan = sweepPlan({ stacks, owner: 'jross24', maxAgeDays: 3, now, getPrState });
    for (const item of [...plan.delete, ...plan.keep]) assert.ok(item.reason.length > 0);
  });

  it('asks for the state of each pull request once', () => {
    const asked = [];
    sweepPlan({ stacks, owner: 'jross24', maxAgeDays: 3, now, getPrState: (repo, pr) => { asked.push(`${repo}#${pr}`); return 'open'; } });
    assert.equal(new Set(asked).size, asked.length);
  });

  it('is empty when there is no preview', () => {
    assert.deepEqual(sweepPlan({ stacks: [], owner: 'jross24', maxAgeDays: 3, now, getPrState }), { delete: [], keep: [], skipped: [] });
  });
});
