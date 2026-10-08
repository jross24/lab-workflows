// Tests for lib.mjs. Run them with: node --test actions/preview/lib.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PREVIEW_COMMENT_MARKER,
  assertStackNames,
  decidePreview,
  namesFor,
  parsePreviewStacks,
  renderPreviewComment,
  shouldSweep,
} from './lib.mjs';

describe('namesFor', () => {
  it('builds the namespace, the stack name and the version from the repository and the pull request', () => {
    assert.deepEqual(namesFor({ repository: 'lab-svc-catalogue', pr: 12, sha: 'abc1234def5678' }), {
      namespace: 'pr-12',
      stack: 'lab-svc-catalogue-pr-12',
      version: '0.0.0-pr12.abc1234',
    });
  });

  it('gives two pull requests two different names', () => {
    const a = namesFor({ repository: 'lab-svc-catalogue', pr: 1, sha: 'aaaaaaaa' });
    const b = namesFor({ repository: 'lab-svc-catalogue', pr: 11, sha: 'aaaaaaaa' });
    assert.notEqual(a.stack, b.stack);
    assert.notEqual(a.namespace, b.namespace);
    assert.notEqual(a.version, b.version);
  });

  it('gives two repositories two different stacks for the same pull request number', () => {
    assert.notEqual(
      namesFor({ repository: 'lab-svc-catalogue', pr: 5, sha: 'aaaaaaa' }).stack,
      namesFor({ repository: 'lab-svc-account', pr: 5, sha: 'aaaaaaa' }).stack,
    );
  });

  it('never collides with a name that a person picks for the laptop', () => {
    // The namespace pr-<number> is reserved for the pipeline. A laptop namespace such as "jonathan" differs.
    assert.match(namesFor({ repository: 'lab-web', pr: 3, sha: 'aaaaaaa' }).namespace, /^pr-[0-9]+$/);
  });

  it('produces a version that the services accept', () => {
    // The services accept a version like 1.2.3 with an optional suffix of letters, digits, dots and hyphens.
    assert.match(namesFor({ repository: 'lab-web', pr: 3, sha: 'ABCDEF1234' }).version, /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/);
  });

  it('rejects input that is not a repository name, a number or a commit', () => {
    for (const bad of [
      { repository: 'Lab_Web', pr: 1, sha: 'abc1234' },
      { repository: 'lab-web;rm', pr: 1, sha: 'abc1234' },
      { repository: '', pr: 1, sha: 'abc1234' },
      { repository: 'lab-web', pr: 0, sha: 'abc1234' },
      { repository: 'lab-web', pr: -3, sha: 'abc1234' },
      { repository: 'lab-web', pr: '12; id', sha: 'abc1234' },
      { repository: 'lab-web', pr: 1.5, sha: 'abc1234' },
      { repository: 'lab-web', pr: 1, sha: 'xyz' },
      { repository: 'lab-web', pr: 1, sha: '' },
    ]) {
      assert.throws(() => namesFor(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe('decidePreview', () => {
  const base = {
    eventName: 'pull_request',
    action: 'synchronize',
    labelName: '',
    labels: ['preview'],
    headRepo: 'jross24/lab-x',
    baseRepo: 'jross24/lab-x',
    actor: 'jross24',
    accountId: '123456789012',
  };
  const decide = (change) => decidePreview({ ...base, ...change });

  it('deploys when a push reaches a pull request that has the label', () => {
    assert.equal(decide({}).action, 'deploy');
    assert.equal(decide({ action: 'opened' }).action, 'deploy');
    assert.equal(decide({ action: 'reopened' }).action, 'deploy');
  });

  it('deploys when the label preview is added', () => {
    assert.equal(decide({ action: 'labeled', labelName: 'preview' }).action, 'deploy');
  });

  it('does nothing for a push to a pull request without the label', () => {
    const result = decide({ labels: ['bug'] });
    assert.equal(result.action, 'none');
    assert.match(result.reason, /label/);
  });

  it('does nothing when another label is added', () => {
    assert.equal(decide({ action: 'labeled', labelName: 'bug', labels: ['preview', 'bug'] }).action, 'none');
  });

  it('destroys when the label preview is removed', () => {
    assert.equal(decide({ action: 'unlabeled', labelName: 'preview', labels: [] }).action, 'destroy');
  });

  it('does nothing when another label is removed', () => {
    assert.equal(decide({ action: 'unlabeled', labelName: 'bug' }).action, 'none');
  });

  it('destroys when a pull request that has the label closes, for a merge and for a close without merge', () => {
    assert.equal(decide({ action: 'closed' }).action, 'destroy');
  });

  it('does nothing when a pull request without the label closes, so it needs no AWS login', () => {
    assert.equal(decide({ action: 'closed', labels: ['bug'] }).action, 'none');
    assert.equal(decide({ action: 'closed', labels: [] }).action, 'none');
  });

  it('does nothing for a fork, which has no OIDC token', () => {
    for (const action of ['opened', 'synchronize', 'closed', 'labeled']) {
      const result = decide({ action, labelName: 'preview', headRepo: 'someone/lab-x' });
      assert.equal(result.action, 'none', action);
      assert.match(result.reason, /fork/);
    }
  });

  it('does nothing for Dependabot', () => {
    assert.equal(decide({ actor: 'dependabot[bot]' }).action, 'none');
  });

  it('does nothing when the repository has no account secret', () => {
    assert.equal(decide({ accountId: '' }).action, 'none');
    assert.equal(decide({ accountId: undefined }).action, 'none');
  });

  it('does nothing for another event or another action', () => {
    assert.equal(decide({ eventName: 'push' }).action, 'none');
    assert.equal(decide({ action: 'edited' }).action, 'none');
    assert.equal(decide({ action: 'ready_for_review' }).action, 'none');
  });

  it('requires the exact label name', () => {
    assert.equal(decide({ labels: ['Preview'] }).action, 'none');
    assert.equal(decide({ labels: ['preview '] }).action, 'none');
    assert.equal(decide({ labels: ['previews'] }).action, 'none');
  });

  it('keeps the reason on one line and free of the account ID', () => {
    for (const change of [{ headRepo: 'a/b' }, { accountId: '' }, { labels: [] }, { eventName: 'push' }]) {
      const { reason } = decide(change);
      assert.doesNotMatch(reason, /\n/);
      assert.doesNotMatch(reason, /123456789012/);
    }
  });
});

describe('assertStackNames', () => {
  it('accepts an assembly that has exactly the expected stack', () => {
    assert.doesNotThrow(() => assertStackNames(['lab-svc-catalogue-pr-12'], 'lab-svc-catalogue-pr-12'));
  });

  it('refuses an assembly that would touch the baseline stack', () => {
    // Code that does not know the namespace gives the baseline name. A deploy or a destroy would change the baseline.
    assert.throws(() => assertStackNames(['lab-svc-catalogue'], 'lab-svc-catalogue-pr-12'), /lab-svc-catalogue-pr-12/);
  });

  it('refuses an assembly with an extra stack', () => {
    assert.throws(() => assertStackNames(['lab-svc-catalogue-pr-12', 'CDKToolkit'], 'lab-svc-catalogue-pr-12'));
  });

  it('refuses a stack of another pull request and an empty assembly', () => {
    assert.throws(() => assertStackNames(['lab-svc-catalogue-pr-13'], 'lab-svc-catalogue-pr-12'));
    assert.throws(() => assertStackNames([], 'lab-svc-catalogue-pr-12'));
  });
});

describe('renderPreviewComment', () => {
  const base = { stack: 'lab-svc-catalogue-pr-12', commit: 'abc1234def', runUrl: 'https://github.com/o/r/actions/runs/1', accountIds: ['123456789012'] };

  it('starts with the marker, so the next run finds the comment', () => {
    assert.ok(renderPreviewComment({ ...base, state: 'deployed', url: 'https://x.execute-api.eu-west-2.amazonaws.com/products' }).startsWith(PREVIEW_COMMENT_MARKER));
  });

  it('shows the URL, the commit and the way the preview ends when it is ready', () => {
    const body = renderPreviewComment({ ...base, state: 'deployed', url: 'https://x.execute-api.eu-west-2.amazonaws.com/products' });
    assert.match(body, /Preview is ready/);
    assert.match(body, /https:\/\/x\.execute-api\.eu-west-2\.amazonaws\.com\/products/);
    assert.match(body, /abc1234/);
    assert.doesNotMatch(body, /abc1234d/);
    assert.match(body, /closes/);
  });

  it('says that the preview is gone after a destroy', () => {
    const body = renderPreviewComment({ ...base, state: 'destroyed' });
    assert.match(body, /removed/);
    assert.doesNotMatch(body, /https:\/\/x\./);
  });

  it('links the run when the deployment fails', () => {
    const body = renderPreviewComment({ ...base, state: 'failed' });
    assert.match(body, /failed/);
    assert.match(body, /actions\/runs\/1/);
  });

  it('never contains an account ID', () => {
    const body = renderPreviewComment({ ...base, state: 'deployed', url: 'https://x/products?a=123456789012', stack: 'lab-123456789012' });
    assert.doesNotMatch(body, /\d{12}/);
  });
});

describe('parsePreviewStacks', () => {
  const stack = (over = {}) => ({
    StackName: 'lab-svc-catalogue-pr-12',
    StackStatus: 'CREATE_COMPLETE',
    CreationTime: '2026-10-08T09:00:00Z',
    Tags: [
      { Key: 'lab-preview-repo', Value: 'jross24/lab-svc-catalogue' },
      { Key: 'lab-preview-pr', Value: '12' },
    ],
    ...over,
  });

  it('reads the repository, the pull request number and the creation time from the tags', () => {
    assert.deepEqual(parsePreviewStacks([stack()], 'jross24').previews, [
      { stack: 'lab-svc-catalogue-pr-12', repo: 'jross24/lab-svc-catalogue', pr: 12, createdAt: '2026-10-08T09:00:00Z', status: 'CREATE_COMPLETE' },
    ]);
  });

  it('ignores a stack without the preview tags, such as the baseline', () => {
    const result = parsePreviewStacks([stack({ StackName: 'lab-svc-catalogue', Tags: [] }), stack({ StackName: 'CDKToolkit', Tags: undefined })], 'jross24');
    assert.deepEqual(result.previews, []);
    assert.deepEqual(result.skipped, []);
  });

  it('skips a stack whose name does not match its tags, and says why', () => {
    // A person could tag the baseline stack. The sweeper must not delete it.
    const result = parsePreviewStacks([stack({ StackName: 'lab-svc-catalogue' })], 'jross24');
    assert.deepEqual(result.previews, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /name/);
  });

  it('skips a stack of another owner or a repository that is not a lab repository', () => {
    const other = stack({ Tags: [{ Key: 'lab-preview-repo', Value: 'evil/lab-svc-catalogue' }, { Key: 'lab-preview-pr', Value: '12' }] });
    const notLab = stack({ StackName: 'tool-pr-12', Tags: [{ Key: 'lab-preview-repo', Value: 'jross24/tool' }, { Key: 'lab-preview-pr', Value: '12' }] });
    assert.deepEqual(parsePreviewStacks([other, notLab], 'jross24').previews, []);
  });

  it('skips a pull request number that is not a number', () => {
    const bad = stack({ Tags: [{ Key: 'lab-preview-repo', Value: 'jross24/lab-svc-catalogue' }, { Key: 'lab-preview-pr', Value: '12x' }] });
    assert.deepEqual(parsePreviewStacks([bad], 'jross24').previews, []);
  });

  it('leaves out a stack that is already being deleted or is deleted', () => {
    const result = parsePreviewStacks([stack({ StackStatus: 'DELETE_IN_PROGRESS' }), stack({ StackStatus: 'DELETE_COMPLETE' })], 'jross24');
    assert.deepEqual(result.previews, []);
  });

  it('keeps a stack in a failed state, so the sweeper can clean it', () => {
    for (const status of ['ROLLBACK_COMPLETE', 'CREATE_FAILED', 'DELETE_FAILED', 'UPDATE_ROLLBACK_COMPLETE']) {
      assert.equal(parsePreviewStacks([stack({ StackStatus: status })], 'jross24').previews.length, 1, status);
    }
  });
});

describe('shouldSweep', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const preview = (createdAt) => ({ createdAt });

  it('sweeps the preview of a closed pull request', () => {
    const result = shouldSweep({ preview: preview('2026-10-10T11:00:00Z'), prState: 'closed', now, maxAgeDays: 3 });
    assert.equal(result.sweep, true);
    assert.match(result.reason, /closed/);
  });

  it('sweeps the preview of a merged pull request', () => {
    assert.equal(shouldSweep({ preview: preview('2026-10-10T11:00:00Z'), prState: 'merged', now, maxAgeDays: 3 }).sweep, true);
  });

  it('keeps the preview of an open pull request that is young', () => {
    assert.equal(shouldSweep({ preview: preview('2026-10-09T12:00:00Z'), prState: 'open', now, maxAgeDays: 3 }).sweep, false);
  });

  it('sweeps the preview of an open pull request that is older than the limit', () => {
    const result = shouldSweep({ preview: preview('2026-10-06T11:59:00Z'), prState: 'open', now, maxAgeDays: 3 });
    assert.equal(result.sweep, true);
    assert.match(result.reason, /3 days/);
  });

  it('keeps a preview of exactly the limit age', () => {
    assert.equal(shouldSweep({ preview: preview('2026-10-07T12:00:00Z'), prState: 'open', now, maxAgeDays: 3 }).sweep, false);
  });

  it('keeps a young preview when the state of the pull request is unknown, and sweeps an old one', () => {
    assert.equal(shouldSweep({ preview: preview('2026-10-10T08:00:00Z'), prState: 'unknown', now, maxAgeDays: 3 }).sweep, false);
    assert.equal(shouldSweep({ preview: preview('2026-10-01T08:00:00Z'), prState: 'unknown', now, maxAgeDays: 3 }).sweep, true);
  });

  it('rejects a limit that is not a positive number, so a typo cannot sweep everything', () => {
    for (const maxAgeDays of [0, -1, NaN, undefined, '3']) {
      assert.throws(() => shouldSweep({ preview: preview('2026-10-10T11:00:00Z'), prState: 'open', now, maxAgeDays }), /maxAgeDays/);
    }
  });

  it('keeps a preview with a creation time that cannot be read', () => {
    assert.equal(shouldSweep({ preview: preview('not a time'), prState: 'open', now, maxAgeDays: 3 }).sweep, false);
  });
});
