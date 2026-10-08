// Tests for cli.mjs. Run them with: node --test actions/cdk-diff/cli.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gateOutputs, listStacks, runReport, upsertComment } from './cli.mjs';
import { markerFor } from './lib.mjs';

const ACCOUNT = '123456789012';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'cdk-diff-test-'));
}

// A cloud assembly like the one that `cdk synth` makes for an app with stages.
function fakeAssembly() {
  const root = tempDir();
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      version: '54.0.0',
      artifacts: {
        'assembly-Production': { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Production', displayName: 'Production' } },
        'assembly-Test': { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Test', displayName: 'Test' } },
        'Platform': { type: 'aws:cloudformation:stack', displayName: 'Platform', properties: { templateFile: 'Platform.template.json', stackName: 'lab-platform-test' } },
        Tree: { type: 'cdk:tree', properties: { file: 'tree.json' } },
      },
    }),
  );
  for (const stage of ['Production', 'Test']) {
    const dir = join(root, `assembly-${stage}`);
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '54.0.0',
        artifacts: {
          [`${stage}Catalogue`]: {
            type: 'aws:cloudformation:stack',
            displayName: `${stage}/Catalogue`,
            properties: { templateFile: `${stage}Catalogue.template.json`, stackName: 'lab-svc-catalogue' },
          },
          [`${stage}Catalogue.assets`]: { type: 'cdk:asset-manifest', properties: { file: 'x.assets.json' } },
        },
      }),
    );
    writeFileSync(join(dir, `${stage}Catalogue.template.json`), '{"Resources":{}}');
  }
  writeFileSync(join(root, 'Platform.template.json'), '{"Resources":{}}');
  return root;
}

describe('listStacks', () => {
  it('lists the stacks of one stage with the stack name and the template path', () => {
    const root = fakeAssembly();
    assert.deepEqual(listStacks(root, 'Production'), [
      {
        displayName: 'Production/Catalogue',
        stackName: 'lab-svc-catalogue',
        templateFile: join(root, 'assembly-Production', 'ProductionCatalogue.template.json'),
      },
    ]);
  });

  it('lists the stacks that are not in a stage when the stage is empty', () => {
    const root = fakeAssembly();
    assert.deepEqual(
      listStacks(root, '').map((stack) => stack.stackName),
      ['lab-platform-test'],
    );
  });

  it('returns nothing for a stage that does not exist', () => {
    assert.deepEqual(listStacks(fakeAssembly(), 'Staging'), []);
  });
});

describe('gateOutputs', () => {
  const env = { EVENT_NAME: 'pull_request', HEAD_REPO: 'jross24/lab-x', BASE_REPO: 'jross24/lab-x', ACTOR: 'jross24', ACCOUNT_ID: ACCOUNT };

  it('says run=true for a pull request of the same repository', () => {
    assert.deepEqual(gateOutputs(env), { run: 'true', reason: '' });
  });

  it('says run=false with a reason for a fork', () => {
    const out = gateOutputs({ ...env, HEAD_REPO: 'other/lab-x' });
    assert.equal(out.run, 'false');
    assert.match(out.reason, /fork/);
  });

  it('keeps the reason on one line, so it is safe in the output file', () => {
    assert.doesNotMatch(gateOutputs({ ...env, HEAD_REPO: 'other/lab-x' }).reason, /\n/);
  });
});

// A fake `gh` that keeps the comments of one pull request in memory.
function fakeGh(comments) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    const isWrite = args[1] === '-X';
    const method = isWrite ? args[2] : 'GET';
    const url = isWrite ? args[3] : args.find((a) => a.startsWith('repos/'));
    if (method === 'GET') {
      if (url.endsWith('/comments')) return JSON.stringify([comments]);
      if (url.endsWith('/labels')) return JSON.stringify([gh.labels ?? []]);
    }
    if (method === 'PATCH') {
      const id = Number(url.split('/').pop());
      const comment = comments.find((c) => c.id === id);
      comment.body = JSON.parse(input).body;
      return JSON.stringify(comment);
    }
    if (method === 'POST') {
      const created = { id: 1000 + comments.length, user: { login: 'github-actions[bot]' }, body: JSON.parse(input).body };
      comments.push(created);
      return JSON.stringify(created);
    }
    throw new Error(`unexpected call ${args.join(' ')}`);
  };
  gh.calls = calls;
  return gh;
}

describe('upsertComment', () => {
  const repo = 'jross24/lab-x';

  it('creates the comment when there is none', () => {
    const comments = [{ id: 1, user: { login: 'someone' }, body: 'hello' }];
    const gh = fakeGh(comments);
    const result = upsertComment({ gh, repo, pr: 7, marker: markerFor('a'), body: `${markerFor('a')}\nfirst` });
    assert.equal(result.action, 'created');
    assert.equal(comments.length, 2);
  });

  it('updates the same comment on the next call, so there is one comment only', () => {
    const comments = [];
    const gh = fakeGh(comments);
    upsertComment({ gh, repo, pr: 7, marker: markerFor('a'), body: `${markerFor('a')}\nfirst` });
    const result = upsertComment({ gh, repo, pr: 7, marker: markerFor('a'), body: `${markerFor('a')}\nsecond` });
    assert.equal(result.action, 'updated');
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /second/);
  });

  it('keeps one comment for each key', () => {
    const comments = [];
    const gh = fakeGh(comments);
    upsertComment({ gh, repo, pr: 7, marker: markerFor('test'), body: `${markerFor('test')}\nt` });
    upsertComment({ gh, repo, pr: 7, marker: markerFor('prod'), body: `${markerFor('prod')}\np` });
    upsertComment({ gh, repo, pr: 7, marker: markerFor('test'), body: `${markerFor('test')}\nt2` });
    assert.equal(comments.length, 2);
  });

  it('does not take over a comment that another user wrote with the marker', () => {
    const comments = [{ id: 5, user: { login: 'mallory' }, body: `${markerFor('a')} fake` }];
    const gh = fakeGh(comments);
    const result = upsertComment({ gh, repo, pr: 7, marker: markerFor('a'), body: `${markerFor('a')}\nreal` });
    assert.equal(result.action, 'created');
    assert.equal(comments[0].body, `${markerFor('a')} fake`);
  });

  it('sends the body on stdin and not in an argument', () => {
    const comments = [];
    const gh = fakeGh(comments);
    upsertComment({ gh, repo, pr: 7, marker: markerFor('a'), body: `${markerFor('a')}\nx` });
    for (const call of gh.calls) {
      assert.ok(call.args.every((arg) => !arg.includes('lab-cdk-diff')), call.args.join(' '));
    }
    assert.ok(gh.calls.some((call) => call.input?.includes('lab-cdk-diff')));
  });
});

describe('runReport', () => {
  function reportDir({ renameTable }) {
    const dir = tempDir();
    const fixtures = join(import.meta.dirname, 'fixtures');
    const read = (name) => readFileSync(join(fixtures, name), 'utf8');
    writeFileSync(join(dir, 'stack-1.diff.txt'), read(renameTable ? 'diff-rename-table.txt' : 'diff-safe-changes.txt'));
    writeFileSync(join(dir, 'stack-1.new.json'), read(renameTable ? 'template-rename-table.json' : 'template-safe-changes.json'));
    writeFileSync(join(dir, 'stack-1.old.json'), read('template-base.json'));
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        commit: 'abcdef1234567',
        version: '0.3.1',
        stacks: [{ name: `fx-${ACCOUNT}`, id: 'stack-1', deployed: true }],
      }),
    );
    return dir;
  }

  function run({ renameTable, labels = [] }) {
    const comments = [];
    const gh = fakeGh(comments);
    gh.labels = labels.map((name) => ({ name }));
    const written = [];
    const result = runReport({
      dir: reportDir({ renameTable }),
      env: {
        GH_REPO: 'jross24/lab-x',
        PR_NUMBER: '7',
        KEY: 'production',
        TITLE: 'cdk diff against Production',
        ACCOUNT_IDS: ACCOUNT,
      },
      gh,
      log: (line) => written.push(line),
    });
    return { result, comments, written };
  }

  it('posts one comment with the summary and passes for a safe change', () => {
    const { result, comments } = run({ renameTable: false });
    assert.equal(result.blocked, false);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /1 to add, 0 to change, 0 to replace, 0 to delete/);
  });

  it('blocks a stateful change without the label and still posts the comment', () => {
    const { result, comments } = run({ renameTable: true });
    assert.equal(result.blocked, true);
    assert.match(comments[0].body, /Blocked/);
    assert.match(comments[0].body, /destructive-change-approved/);
  });

  it('passes a stateful change when the label is on the pull request', () => {
    const { result, comments } = run({ renameTable: true, labels: ['destructive-change-approved'] });
    assert.equal(result.blocked, false);
    assert.match(comments[0].body, /Approved by the label/);
  });

  it('never posts an account ID', () => {
    const { comments } = run({ renameTable: true });
    assert.doesNotMatch(comments[0].body, /\d{12}/);
  });
});

// Items 2 and 3 of lab-platform#44, from the files of the jobs to the posted comment.
describe('runReport: a template change without a resource change, and the status of the stack', () => {
  function reportDirFor({ diffFile, status }) {
    const dir = tempDir();
    const fixtures = join(import.meta.dirname, 'fixtures');
    const base = readFileSync(join(fixtures, 'template-base.json'), 'utf8');
    writeFileSync(join(dir, 'stack-1.diff.txt'), readFileSync(join(fixtures, diffFile), 'utf8'));
    writeFileSync(join(dir, 'stack-1.old.json'), base);
    writeFileSync(join(dir, 'stack-1.new.json'), JSON.stringify({ ...JSON.parse(base), Description: 'New description' }));
    const stack = { name: 'lab-svc-fx', id: 'stack-1', deployed: true };
    if (status !== undefined) stack.status = status;
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ commit: 'abcdef1234567', version: null, stacks: [stack] }));
    return dir;
  }

  function post({ diffFile, status }) {
    const comments = [];
    const result = runReport({
      dir: reportDirFor({ diffFile, status }),
      env: { GH_REPO: 'jross24/lab-x', PR_NUMBER: '7', KEY: 'production', TITLE: 'cdk diff against Production', ACCOUNT_IDS: ACCOUNT },
      gh: fakeGh(comments),
      log: () => {},
    });
    return { result, body: comments[0].body };
  }

  it('says that something else differs for a change of the description only', () => {
    const { result, body } = post({ diffFile: 'diff-description-only.txt' });
    assert.equal(result.blocked, false);
    assert.match(body, /0 to add, 0 to change, 0 to replace, 0 to delete, but something else differs/);
    assert.match(body, /Old description to New description/);
  });

  it('shows the status of a stack that is in the middle of a deployment', () => {
    const { body } = post({ diffFile: 'diff-safe-changes.txt', status: 'UPDATE_IN_PROGRESS' });
    assert.match(body, /`lab-svc-fx`[^\n]*`UPDATE_IN_PROGRESS`/);
    assert.match(body, /may be against a release that still runs/);
  });

  it('shows no status for a stable stack, and none for a meta file of the older fetch job', () => {
    for (const status of ['UPDATE_COMPLETE', undefined, null]) {
      const { body } = post({ diffFile: 'diff-safe-changes.txt', status });
      assert.doesNotMatch(body, /still runs/, String(status));
    }
  });
});
