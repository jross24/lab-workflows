// Tests for lib.mjs. Run them with: node --test actions/cdk-diff/
// The fixtures are real output of `cdk diff --template` (CDK CLI 2.1144.0) and the templates behind it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMMENT_MARKER_PREFIX,
  STATEFUL_TYPES,
  assess,
  cleanDiffOutput,
  decideRun,
  fenceFor,
  findRemovedStateful,
  guardVerdict,
  markerFor,
  parseDiff,
  redact,
  renderComment,
  summarize,
  truncateMiddle,
} from './lib.mjs';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const template = (name) => JSON.parse(fixture(`template-${name}.json`));
const diffText = (name) => fixture(`diff-${name}.txt`);

const ACCOUNT = '123456789012';

describe('redact', () => {
  it('replaces the known account ID wherever it appears, even glued to a word', () => {
    const text = `role/cdk-hnb659fds-deploy-role-${ACCOUNT}-eu-west-2 and x${ACCOUNT}y`;
    assert.equal(redact(text, [ACCOUNT]), 'role/cdk-hnb659fds-deploy-role-[account-id]-eu-west-2 and x[account-id]y');
  });

  it('replaces the account field of an ARN', () => {
    assert.equal(
      redact(`arn:aws:iam::${ACCOUNT}:role/github-deploy`, []),
      'arn:aws:iam::[account-id]:role/github-deploy',
    );
  });

  it('replaces an unknown 12 digit number that stands alone', () => {
    for (const text of [
      'aws://999988887777/eu-west-2',
      '999988887777.dkr.ecr.eu-west-2.amazonaws.com',
      'bucket-999988887777-eu-west-2',
      '"Account": "999988887777"',
      'a_999988887777_b',
    ]) {
      assert.match(redact(text, []), /\[account-id\]/, text);
      assert.doesNotMatch(redact(text, []), /999988887777/, text);
    }
  });

  it('keeps numbers that are not account IDs', () => {
    for (const text of ['1759913600123', '12345678901', 'sha256:ab123456789012cd', 'asset.9f86d081884c7d659a2f', 'v1.2.3']) {
      assert.equal(redact(text, []), text);
    }
  });

  it('replaces every occurrence on every line', () => {
    const out = redact(`${ACCOUNT}\n${ACCOUNT}:${ACCOUNT}`, [ACCOUNT]);
    assert.equal(out, '[account-id]\n[account-id]:[account-id]');
  });

  it('ignores empty or odd IDs and does not treat an ID as a pattern', () => {
    assert.equal(redact('abc.def', ['', undefined, null, '.*']), 'abc.def');
    assert.equal(redact('a.*b', ['.*']), 'a[account-id]b');
  });

  it('is idempotent', () => {
    const once = redact(`arn:aws:iam::${ACCOUNT}:root`, [ACCOUNT]);
    assert.equal(redact(once, [ACCOUNT]), once);
  });
});

describe('cleanDiffOutput', () => {
  it('drops the noise before the first stack and the summary line after the last', () => {
    const out = cleanDiffOutput(diffText('rename-table'));
    assert.ok(out.startsWith('Stack Fx (fx)\nResources\n'), out);
    assert.doesNotMatch(out, /AI agent|WARNING|✨/);
    assert.ok(out.includes('[-] AWS::DynamoDB::Table Orders Orders destroy'));
    assert.ok(!out.endsWith('\n'));
  });

  it('returns an empty text when there is no stack', () => {
    assert.equal(cleanDiffOutput('AI agent detected\nThere were no differences\n'), '');
  });

  it('keeps all the stacks of a multi stack output', () => {
    const out = cleanDiffOutput('noise\nStack A (a)\nResources\n[+] AWS::SQS::Queue Q Q\n\nStack B (b)\nResources\n[+] AWS::SQS::Queue R R\n');
    assert.match(out, /Stack A[\s\S]*Stack B/);
  });
});

describe('parseDiff', () => {
  it('reads an add, a destroy and a replace from real output', () => {
    assert.deepEqual(parseDiff(diffText('rename-table')), [
      { kind: '-', type: 'AWS::DynamoDB::Table', path: 'Orders', logicalId: 'Orders', action: 'destroy' },
      { kind: '+', type: 'AWS::DynamoDB::Table', path: 'OrdersV2', logicalId: 'OrdersV2', action: '' },
    ]);
    assert.deepEqual(parseDiff(diffText('replace-table')), [
      { kind: '~', type: 'AWS::DynamoDB::Table', path: 'Orders', logicalId: 'Orders', action: 'replace' },
    ]);
    assert.deepEqual(parseDiff(diffText('remove-retained-bucket')), [
      { kind: '-', type: 'AWS::S3::Bucket', path: 'Keep', logicalId: 'Keep', action: 'orphan' },
    ]);
  });

  it('reads the real Lambda output of lab-svc-catalogue, with nested property lines and an IAM table', () => {
    const text = [
      'Stack Production/Catalogue (lab-svc-catalogue) (aws://x/eu-west-2)',
      'IAM Statement Changes',
      '┌───┬──────────┬────────┐',
      '│   │ Resource │ Effect │',
      '│ + │ ${Role.Arn} │ Allow │',
      '└───┴──────────┴────────┘',
      'Resources',
      '[-] AWS::Lambda::Version Catalogue/ProductsFunction/CurrentVersion ProductsFunctionCurrentVersionAE700B96a190 destroy',
      '[+] AWS::Lambda::Version Catalogue/ProductsFunction/CurrentVersion ProductsFunctionCurrentVersionAE700B96e2d1',
      '[~] AWS::Lambda::Function Catalogue/ProductsFunction ProductsFunctionFE1C163A',
      ' ├─ [~] Environment',
      ' │   └─ [~] .Variables:',
      ' │       └─ [~] .VERSION:',
      ' │           ├─ [-] 0.3.1',
      ' │           └─ [+] 0.0.0-dev',
      ' └─ [~] Metadata',
      '',
      'Outputs',
      '[~] Output Catalogue/Version Version: {"Value":"0.3.1"} to {"Value":"0.0.0-dev"}',
    ].join('\n');
    const changes = parseDiff(text);
    assert.deepEqual(
      changes.map((c) => `${c.kind} ${c.type} ${c.action}`.trim()),
      ['- AWS::Lambda::Version destroy', '+ AWS::Lambda::Version', '~ AWS::Lambda::Function'],
    );
    assert.equal(changes[2].logicalId, 'ProductsFunctionFE1C163A');
  });

  it('does not read property lines or output lines as resources', () => {
    assert.deepEqual(parseDiff(' └─ [~] KeySchema (requires replacement)\n[~] Output A B: {} to {}\n'), []);
  });

  it('returns no change for a text without differences', () => {
    assert.deepEqual(parseDiff('There were no differences'), []);
  });
});

describe('summarize', () => {
  it('counts add, change, replace and delete', () => {
    const changes = [
      ...parseDiff(diffText('rename-table')),
      ...parseDiff(diffText('replace-bucket')),
      ...parseDiff(diffText('remove-retained-bucket')),
      { kind: '~', type: 'AWS::Lambda::Function', path: 'F', logicalId: 'F', action: '' },
    ];
    assert.deepEqual(summarize(changes), { add: 1, change: 1, replace: 1, delete: 2 });
  });

  it('counts an orphan as a delete', () => {
    assert.deepEqual(summarize(parseDiff(diffText('remove-retained-bucket'))), { add: 0, change: 0, replace: 0, delete: 1 });
  });

  it('is all zero for no change', () => {
    assert.deepEqual(summarize([]), { add: 0, change: 0, replace: 0, delete: 0 });
  });
});

describe('the stateful types', () => {
  it('are a short explicit list', () => {
    assert.ok(STATEFUL_TYPES.length >= 5 && STATEFUL_TYPES.length <= 12, `${STATEFUL_TYPES.length} types`);
    for (const type of ['AWS::DynamoDB::Table', 'AWS::S3::Bucket', 'AWS::RDS::DBInstance', 'AWS::Logs::LogGroup']) {
      assert.ok(STATEFUL_TYPES.includes(type), type);
    }
    assert.equal(new Set(STATEFUL_TYPES).size, STATEFUL_TYPES.length);
  });
});

describe('findRemovedStateful', () => {
  it('finds a table that the new template does not have', () => {
    assert.deepEqual(findRemovedStateful(template('base'), template('rename-table')), [
      { type: 'AWS::DynamoDB::Table', logicalId: 'Orders', action: 'destroy' },
    ]);
  });

  it('reports a retained bucket as an orphan', () => {
    assert.deepEqual(findRemovedStateful(template('base'), template('remove-retained-bucket')), [
      { type: 'AWS::S3::Bucket', logicalId: 'Keep', action: 'orphan' },
    ]);
  });

  it('finds a log group and ignores a queue', () => {
    assert.deepEqual(findRemovedStateful(template('base'), template('remove-loggroup-and-queue')), [
      { type: 'AWS::Logs::LogGroup', logicalId: 'AppLogs', action: 'destroy' },
    ]);
  });

  it('finds nothing when resources are only added or changed in place', () => {
    assert.deepEqual(findRemovedStateful(template('base'), template('safe-changes')), []);
  });

  it('treats a stack that does not exist yet, or a missing template, as nothing to remove', () => {
    assert.deepEqual(findRemovedStateful(undefined, template('base')), []);
    assert.deepEqual(findRemovedStateful({ Resources: {} }, template('base')), []);
    assert.deepEqual(findRemovedStateful(template('base'), undefined), []);
    assert.deepEqual(findRemovedStateful({}, {}), []);
  });
});

describe('assess', () => {
  it('flags a renamed table from the text and from the templates, once', () => {
    const result = assess({ diff: diffText('rename-table'), oldTemplate: template('base'), newTemplate: template('rename-table') });
    assert.deepEqual(result.summary, { add: 1, change: 0, replace: 0, delete: 1 });
    assert.deepEqual(result.stateful, [{ type: 'AWS::DynamoDB::Table', logicalId: 'Orders', action: 'destroy' }]);
  });

  it('flags a replaced table, which only the text shows', () => {
    const result = assess({ diff: diffText('replace-table'), oldTemplate: template('base'), newTemplate: template('replace-table') });
    assert.deepEqual(result.stateful, [{ type: 'AWS::DynamoDB::Table', logicalId: 'Orders', action: 'replace' }]);
    assert.deepEqual(result.summary, { add: 0, change: 0, replace: 1, delete: 0 });
  });

  it('flags a replaced bucket', () => {
    const result = assess({ diff: diffText('replace-bucket'), oldTemplate: template('base'), newTemplate: template('replace-bucket') });
    assert.deepEqual(result.stateful, [{ type: 'AWS::S3::Bucket', logicalId: 'Uploads', action: 'replace' }]);
  });

  it('flags an orphaned bucket and a destroyed log group', () => {
    assert.deepEqual(
      assess({ diff: diffText('remove-retained-bucket'), oldTemplate: template('base'), newTemplate: template('remove-retained-bucket') }).stateful,
      [{ type: 'AWS::S3::Bucket', logicalId: 'Keep', action: 'orphan' }],
    );
    assert.deepEqual(
      assess({ diff: diffText('remove-loggroup-and-queue'), oldTemplate: template('base'), newTemplate: template('remove-loggroup-and-queue') }).stateful,
      [{ type: 'AWS::Logs::LogGroup', logicalId: 'AppLogs', action: 'destroy' }],
    );
  });

  it('does not flag a queue that goes away, or a new resource', () => {
    assert.deepEqual(
      assess({ diff: '[-] AWS::SQS::Queue Jobs Jobs destroy', oldTemplate: undefined, newTemplate: undefined }).stateful,
      [],
    );
    const result = assess({ diff: diffText('safe-changes'), oldTemplate: template('base'), newTemplate: template('safe-changes') });
    assert.deepEqual(result.stateful, []);
    assert.deepEqual(result.summary, { add: 1, change: 0, replace: 0, delete: 0 });
  });

  it('still flags the change when the text cannot be read but the templates show it', () => {
    const result = assess({ diff: 'a format that the CLI may use one day', oldTemplate: template('base'), newTemplate: template('rename-table') });
    assert.equal(result.stateful.length, 1);
  });

  it('flags a database that the text shows as replaced', () => {
    const result = assess({ diff: '[~] AWS::RDS::DBInstance Db Db replace', oldTemplate: undefined, newTemplate: undefined });
    assert.deepEqual(result.stateful, [{ type: 'AWS::RDS::DBInstance', logicalId: 'Db', action: 'replace' }]);
  });

  it('does not flag an in place change of a table', () => {
    const result = assess({ diff: '[~] AWS::DynamoDB::Table Orders Orders\n └─ [~] BillingMode', oldTemplate: undefined, newTemplate: undefined });
    assert.deepEqual(result.stateful, []);
  });
});

describe('guardVerdict', () => {
  const finding = [{ type: 'AWS::DynamoDB::Table', logicalId: 'Orders', action: 'destroy' }];

  it('passes when nothing stateful changes', () => {
    assert.deepEqual(guardVerdict([], []), { blocked: false, approved: false });
    assert.deepEqual(guardVerdict([], ['destructive-change-approved']), { blocked: false, approved: false });
  });

  it('blocks a stateful change without the label', () => {
    assert.deepEqual(guardVerdict(finding, []), { blocked: true, approved: false });
    assert.deepEqual(guardVerdict(finding, ['preview', 'bug']), { blocked: true, approved: false });
  });

  it('passes a stateful change with the exact label', () => {
    assert.deepEqual(guardVerdict(finding, ['x', 'destructive-change-approved']), { blocked: false, approved: true });
  });

  it('does not accept a label with another spelling', () => {
    for (const label of ['Destructive-Change-Approved', 'destructive-change-approved ', 'destructive-change', 'approved']) {
      assert.equal(guardVerdict(finding, [label]).blocked, true, label);
    }
  });
});

describe('decideRun', () => {
  const base = { eventName: 'pull_request', headRepo: 'jross24/lab-x', baseRepo: 'jross24/lab-x', actor: 'jross24', accountId: ACCOUNT };

  it('runs for a pull request from the same repository', () => {
    assert.deepEqual(decideRun(base), { run: true, reason: '' });
  });

  it('skips a pull request from a fork, with a reason that a reader understands', () => {
    const result = decideRun({ ...base, headRepo: 'someone/lab-x' });
    assert.equal(result.run, false);
    assert.match(result.reason, /fork/);
    assert.match(result.reason, /OIDC/);
  });

  it('skips when the head repository is unknown', () => {
    assert.equal(decideRun({ ...base, headRepo: '' }).run, false);
    assert.equal(decideRun({ ...base, headRepo: undefined }).run, false);
  });

  it('skips a Dependabot pull request, which gets no OIDC token', () => {
    const result = decideRun({ ...base, actor: 'dependabot[bot]' });
    assert.equal(result.run, false);
    assert.match(result.reason, /Dependabot/);
  });

  it('skips when the repository has no account secret', () => {
    for (const accountId of ['', undefined]) {
      const result = decideRun({ ...base, accountId });
      assert.equal(result.run, false);
      assert.match(result.reason, /secret/);
    }
  });

  it('skips any other event', () => {
    assert.equal(decideRun({ ...base, eventName: 'push' }).run, false);
    assert.equal(decideRun({ ...base, eventName: 'workflow_dispatch' }).run, false);
  });

  it('never prints the account ID in the reason', () => {
    for (const input of [{ ...base, headRepo: 'a/b' }, { ...base, accountId: '' }, { ...base, eventName: 'push' }]) {
      assert.doesNotMatch(decideRun(input).reason, new RegExp(ACCOUNT));
    }
  });
});

describe('fenceFor', () => {
  it('uses three backticks for plain text', () => {
    assert.equal(fenceFor('hello'), '```');
  });

  it('is longer than any run of backticks in the text', () => {
    assert.equal(fenceFor('a ``` b'), '````');
    assert.equal(fenceFor('x `````` y'), '```````');
  });
});

describe('truncateMiddle', () => {
  it('keeps a short text', () => {
    assert.equal(truncateMiddle('abc', 10), 'abc');
  });

  it('cuts the middle of a long text, keeps both ends and says so', () => {
    const text = `${'a'.repeat(100)}${'b'.repeat(100)}`;
    const out = truncateMiddle(text, 120);
    assert.ok(out.length <= 160, String(out.length));
    assert.ok(out.startsWith('aaaa') && out.endsWith('bbbb'));
    assert.match(out, /lines? omitted|characters omitted/);
  });
});

describe('renderComment', () => {
  const base = {
    key: 'production',
    title: 'cdk diff against Production',
    stackNames: ['lab-svc-catalogue'],
    commit: 'abc1234def',
    version: '0.3.1',
    summary: { add: 1, change: 2, replace: 0, delete: 1 },
    diff: 'Stack A\nResources\n[+] AWS::SQS::Queue Q Q',
    stateful: [],
    verdict: { blocked: false, approved: false },
    label: 'destructive-change-approved',
    accountIds: [ACCOUNT],
  };

  it('starts with the marker, so the next run finds the comment', () => {
    const body = renderComment(base);
    assert.ok(body.startsWith(markerFor('production')));
    assert.ok(markerFor('production').startsWith(COMMENT_MARKER_PREFIX));
  });

  it('has the one line summary and the diff in a details block', () => {
    const body = renderComment(base);
    assert.match(body, /1 to add, 2 to change, 0 to replace, 1 to delete/);
    assert.match(body, /<details>\s*<summary>[^<]+<\/summary>/);
    assert.match(body, /<\/details>/);
    assert.match(body, /\[\+\] AWS::SQS::Queue Q Q/);
  });

  it('says that there is no change when the summary is empty', () => {
    const body = renderComment({ ...base, summary: { add: 0, change: 0, replace: 0, delete: 0 }, diff: '' });
    assert.match(body, /No change/);
    assert.doesNotMatch(body, /<details>/);
  });

  it('leaves out the details block when the CLI only says that there were no differences', () => {
    const diff = 'Stack A (a)\nThere were no differences';
    const body = renderComment({ ...base, summary: { add: 0, change: 0, replace: 0, delete: 0 }, diff });
    assert.match(body, /No change/);
    assert.doesNotMatch(body, /<details>/);
  });

  it('keeps the details block when only an output or a parameter differs', () => {
    const diff = 'Stack A (a)\nOutputs\n[~] Output A/Version Version: {"Value":"1"} to {"Value":"2"}';
    const body = renderComment({ ...base, summary: { add: 0, change: 0, replace: 0, delete: 0 }, diff });
    assert.doesNotMatch(body, /\*\*No change/);
    assert.match(body, /<details>/);
    assert.match(body, /Output A\/Version/);
  });

  it('removes every account ID from the whole comment', () => {
    const body = renderComment({
      ...base,
      diff: `[~] AWS::IAM::Role R R\n arn:aws:iam::${ACCOUNT}:role/x\n bucket-${ACCOUNT}-eu\n arn:aws:s3:::other-999988887777`,
      stackNames: [`lab-${ACCOUNT}`],
    });
    assert.doesNotMatch(body, /\d{12}/);
    assert.match(body, /\[account-id\]/);
  });

  it('shows the blocked guard with the finding and the way out', () => {
    const body = renderComment({
      ...base,
      stateful: [{ type: 'AWS::DynamoDB::Table', logicalId: 'Orders', action: 'destroy' }],
      verdict: { blocked: true, approved: false },
    });
    assert.match(body, /Blocked/);
    assert.match(body, /AWS::DynamoDB::Table/);
    assert.match(body, /Orders/);
    assert.match(body, /destructive-change-approved/);
    assert.match(body, /Re-run/i);
  });

  it('shows the approved guard', () => {
    const body = renderComment({
      ...base,
      stateful: [{ type: 'AWS::S3::Bucket', logicalId: 'Uploads', action: 'replace' }],
      verdict: { blocked: false, approved: true },
    });
    assert.match(body, /Approved by the label/);
    assert.doesNotMatch(body, /Blocked/);
  });

  it('puts a diff that holds backticks in a fence that it cannot close', () => {
    const body = renderComment({ ...base, diff: 'x\n```\n<script>alert(1)</script>\n```\ny' });
    assert.match(body, /````text/);
  });

  it('keeps the body below the comment limit of GitHub', () => {
    const body = renderComment({ ...base, diff: 'line of diff\n'.repeat(20000) });
    assert.ok(body.length < 65000, String(body.length));
    assert.match(body, /omitted/);
  });

  it('names the commit by its first seven characters and the deployed version', () => {
    const body = renderComment(base);
    assert.match(body, /abc1234/);
    assert.doesNotMatch(body, /abc1234d/);
    assert.match(body, /0\.3\.1/);
  });

  it('says when the stack does not exist in the account yet', () => {
    const body = renderComment({ ...base, version: undefined, missingStacks: ['lab-svc-catalogue'] });
    assert.match(body, /not deployed yet/);
  });

  // Item 2 of lab-platform#44. A change of the description, a parameter or an output has no resource line,
  // so all four counts are zero. The summary line must not read as "nothing changes".
  describe('when only something other than a resource differs', () => {
    const zero = { add: 0, change: 0, replace: 0, delete: 0 };
    const summaryOf = (body) => body.split('\n').find((line) => line.startsWith('**'));

    for (const [what, file] of [
      ['the description', 'description-only'],
      ['an output', 'output-only'],
      ['a parameter', 'parameter-only'],
    ]) {
      it(`says that something else differs when ${what} is the only change (real CLI output)`, () => {
        const diff = cleanDiffOutput(diffText(file));
        const result = assess({ diff });
        assert.deepEqual(result.summary, zero);
        const body = renderComment({ ...base, summary: result.summary, diff });
        assert.match(summaryOf(body), /0 to add, 0 to change, 0 to replace, 0 to delete/);
        assert.match(summaryOf(body), /something else differs/);
        assert.match(summaryOf(body), /parameter, an output or the description/);
        assert.doesNotMatch(body, /No change/);
        assert.match(body, /<details>/);
      });
    }

    it('does not say it when the counts are not zero', () => {
      const body = renderComment(base);
      assert.doesNotMatch(summaryOf(body), /something else/);
    });

    it('does not say it when there is no difference at all', () => {
      const body = renderComment({ ...base, summary: zero, diff: 'Stack A (a)\nThere were no differences' });
      assert.match(body, /No change/);
      assert.doesNotMatch(body, /something else/);
    });

    it('does not say it when the guard found a stateful resource that the text did not show', () => {
      const body = renderComment({
        ...base,
        summary: zero,
        diff: 'Stack A (a)\nOutputs\n[~] Output A/V V: {"Value":"1"} to {"Value":"2"}',
        stateful: [{ type: 'AWS::DynamoDB::Table', logicalId: 'Orders', action: 'destroy' }],
        verdict: { blocked: true, approved: false },
      });
      assert.doesNotMatch(summaryOf(body), /something else/);
    });
  });

  // Item 3 of lab-platform#44. While a deployment runs, CloudFormation holds the template of a release that
  // is still on its way. The comment shows the status of the stack when it is not a stable *_COMPLETE status.
  describe('the status of the deployed stack', () => {
    const withStatus = (status, extra = {}) =>
      renderComment({ ...base, stackStatuses: [{ name: 'lab-svc-catalogue', status }], ...extra });

    it('shows UPDATE_IN_PROGRESS with one sentence that the comparison may be against a release that still runs', () => {
      const body = withStatus('UPDATE_IN_PROGRESS');
      assert.match(body, /`lab-svc-catalogue`/);
      assert.match(body, /`UPDATE_IN_PROGRESS`/);
      assert.match(body, /may be against a release that still runs/);
    });

    it('shows a failed or a rollback status that is still moving', () => {
      for (const status of ['UPDATE_ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS']) {
        assert.match(withStatus(status), new RegExp(`\`${status}\``), status);
      }
    });

    it('shows nothing for a stable *_COMPLETE status', () => {
      for (const status of ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE']) {
        const body = withStatus(status);
        assert.doesNotMatch(body, /may be against/, status);
        assert.doesNotMatch(body, new RegExp(status), status);
      }
    });

    it('shows nothing when the status is unknown', () => {
      for (const stackStatuses of [undefined, [], [{ name: 'lab-svc-catalogue', status: null }], [{ name: 'lab-svc-catalogue' }]]) {
        const body = renderComment({ ...base, stackStatuses });
        assert.doesNotMatch(body, /may be against/);
      }
    });

    it('treats the status as data and shows nothing for a value that is not a status', () => {
      const body = withStatus('UPDATE_COMPLETE`\n<script>alert(1)</script>');
      assert.doesNotMatch(body, /script/);
      assert.doesNotMatch(body, /may be against/);
    });

    it('names each stack that is not stable, and says the sentence once', () => {
      const body = renderComment({
        ...base,
        stackNames: ['lab-a', 'lab-b', 'lab-c'],
        stackStatuses: [
          { name: 'lab-a', status: 'UPDATE_IN_PROGRESS' },
          { name: 'lab-b', status: 'UPDATE_COMPLETE' },
          { name: 'lab-c', status: 'CREATE_IN_PROGRESS' },
        ],
      });
      assert.match(body, /`lab-a`[^\n]*`UPDATE_IN_PROGRESS`/);
      assert.match(body, /`lab-c`[^\n]*`CREATE_IN_PROGRESS`/);
      assert.doesNotMatch(body, /UPDATE_COMPLETE/);
      assert.equal(body.match(/may be against a release that still runs/g).length, 1);
    });

    it('also shows it when the comment says no change', () => {
      const body = withStatus('UPDATE_IN_PROGRESS', { summary: { add: 0, change: 0, replace: 0, delete: 0 }, diff: '' });
      assert.match(body, /No change/);
      assert.match(body, /`UPDATE_IN_PROGRESS`/);
    });

    it('keeps the account ID out of the comment', () => {
      const body = renderComment({
        ...base,
        stackNames: [`lab-${ACCOUNT}`],
        stackStatuses: [{ name: `lab-${ACCOUNT}`, status: 'UPDATE_IN_PROGRESS' }],
      });
      assert.doesNotMatch(body, /\d{12}/);
    });
  });
});
