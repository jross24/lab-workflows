// Tests for lib.mjs. Run them with: node --test actions/shared-files/lib.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LOCK_FILE,
  SOURCE_REPOSITORY,
  classifyPin,
  compareFiles,
  decidePin,
  describeProblems,
  isCommit,
  isSafePath,
  keyOf,
  parseLock,
  planSync,
  renderBody,
  renderComment,
  renderLock,
  syncCommandFor,
} from './lib.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b1'.repeat(20);
const buf = (text) => Buffer.from(text, 'utf8');
const files = (object) => new Map(Object.entries(object).map(([path, text]) => [path, text === null ? null : buf(text)]));

describe('isCommit', () => {
  it('accepts 40 lowercase hex characters only', () => {
    assert.equal(isCommit(SHA_A), true);
    assert.equal(isCommit(SHA_A.toUpperCase()), false);
    assert.equal(isCommit('abc1234'), false);
    assert.equal(isCommit(`${SHA_A}0`), false);
    assert.equal(isCommit('main'), false);
    assert.equal(isCommit(undefined), false);
  });
});

describe('isSafePath', () => {
  it('accepts a relative path with plain parts', () => {
    assert.equal(isSafePath('lib/instrument.ts'), true);
    assert.equal(isSafePath('test/support/contract-schema.ts'), true);
  });

  it('refuses an absolute path, a parent part, a backslash, an empty part and an empty path', () => {
    for (const bad of ['/etc/passwd', '../x.ts', 'lib/../../x.ts', 'lib\\x.ts', 'lib//x.ts', '', 'C:/x.ts', './x.ts', 'lib/\0x.ts', 'lib/']) {
      assert.equal(isSafePath(bad), false, JSON.stringify(bad));
    }
  });
});

describe('the lock file', () => {
  it('renders and parses the same pin', () => {
    const text = renderLock(SHA_A);
    assert.equal(text, `{\n  "repository": "${SOURCE_REPOSITORY}",\n  "commit": "${SHA_A}"\n}\n`);
    assert.deepEqual(parseLock(text), { repository: SOURCE_REPOSITORY, commit: SHA_A });
  });

  it('refuses a commit that is not 40 hex characters, and names the file', () => {
    assert.throws(() => renderLock('main'), /40/);
    assert.throws(() => parseLock(JSON.stringify({ repository: SOURCE_REPOSITORY, commit: 'main' })), new RegExp(LOCK_FILE.replace('.', '\\.')));
    assert.throws(() => parseLock(JSON.stringify({ repository: SOURCE_REPOSITORY, commit: 'abc1234' })), /40/);
  });

  it('refuses another repository, so the pin cannot point the check at a repository of someone else', () => {
    assert.throws(() => parseLock(JSON.stringify({ repository: 'evil/lab-workflows', commit: SHA_A })), /repository/);
    assert.throws(() => parseLock(JSON.stringify({ commit: SHA_A })), /repository/);
  });

  it('refuses text that is not a JSON object', () => {
    assert.throws(() => parseLock('not json'), /JSON/);
    assert.throws(() => parseLock('[]'), /object/);
    assert.throws(() => parseLock('null'), /object/);
  });

  it('refuses a field it does not know, so a typo does not pass', () => {
    assert.throws(() => parseLock(JSON.stringify({ repository: SOURCE_REPOSITORY, commit: SHA_A, comit: SHA_B })), /comit/);
  });
});

describe('compareFiles', () => {
  it('finds no problem when every file is equal', () => {
    const expected = files({ 'lib/a.ts': 'one', 'test/a.test.ts': 'two' });
    const actual = files({ 'lib/a.ts': 'one', 'test/a.test.ts': 'two', 'lib/own.ts': 'only here' });
    assert.deepEqual(compareFiles(expected, actual), { same: ['lib/a.ts', 'test/a.test.ts'], different: [], missing: [] });
  });

  it('finds a file that differs by one byte', () => {
    const expected = files({ 'lib/a.ts': 'one' });
    const actual = files({ 'lib/a.ts': 'onf' });
    assert.deepEqual(compareFiles(expected, actual).different, ['lib/a.ts']);
  });

  it('finds a difference in the line ending and in the final newline', () => {
    assert.deepEqual(compareFiles(files({ 'x.ts': 'a\nb\n' }), files({ 'x.ts': 'a\r\nb\r\n' })).different, ['x.ts']);
    assert.deepEqual(compareFiles(files({ 'x.ts': 'a\n' }), files({ 'x.ts': 'a' })).different, ['x.ts']);
  });

  it('finds a missing file, whether the map has null for it or no entry', () => {
    const expected = files({ 'lib/a.ts': 'one', 'lib/b.ts': 'two' });
    const actual = files({ 'lib/a.ts': 'one', 'lib/b.ts': null });
    assert.deepEqual(compareFiles(expected, actual).missing, ['lib/b.ts']);
    assert.deepEqual(compareFiles(expected, files({ 'lib/a.ts': 'one' })).missing, ['lib/b.ts']);
  });

  it('lists the paths in sorted order', () => {
    const expected = files({ 'b.ts': '1', 'a.ts': '1', 'c.ts': '1' });
    assert.deepEqual(compareFiles(expected, files({})).missing, ['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('syncCommandFor', () => {
  it('gives the command to run in a clone of lab-workflows', () => {
    assert.equal(syncCommandFor('<path to this repository>'), 'node actions/shared-files/sync.mjs <path to this repository>');
    assert.equal(syncCommandFor('../lab-web', SHA_A), `node actions/shared-files/sync.mjs ../lab-web ${SHA_A}`);
  });
});

describe('describeProblems', () => {
  it('names each file, the pinned commit and the sync command', () => {
    const { lines } = describeProblems({ different: ['lib/instrument.ts'], missing: ['lib/logger.ts'] }, SHA_A);
    const text = lines.join('\n');
    assert.match(text, /lib\/instrument\.ts/);
    assert.match(text, /lib\/logger\.ts/);
    assert.match(text, new RegExp(SHA_A.slice(0, 7)));
    assert.match(text, /node actions\/shared-files\/sync\.mjs/);
    assert.match(text, /shared\/lib\/instrument\.ts/);
  });

  it('gives one annotation line for each file, and says whether it differs or is missing', () => {
    const { annotations } = describeProblems({ different: ['lib/a.ts'], missing: ['lib/b.ts'] }, SHA_A);
    assert.equal(annotations.length, 2);
    assert.deepEqual(annotations.map((a) => a.file), ['lib/a.ts', 'lib/b.ts']);
    assert.match(annotations[0].message, /differs/);
    assert.match(annotations[1].message, /missing/);
  });
});

describe('decidePin', () => {
  it('uses the pin when the file exists', () => {
    assert.deepEqual(decidePin({ lockText: renderLock(SHA_A), required: false }), { present: true, commit: SHA_A, failure: null, notice: null });
  });

  it('passes with a notice when the file is missing and the repository does not need it', () => {
    const result = decidePin({ lockText: null, required: false });
    assert.equal(result.present, false);
    assert.equal(result.failure, null);
    assert.match(result.notice, new RegExp(LOCK_FILE.replace('.', '\\.')));
  });

  it('fails when the file is missing and the repository needs it, and names the sync command', () => {
    const result = decidePin({ lockText: null, required: true, requiredReason: 'lib/tracing.ts' });
    assert.equal(result.present, false);
    assert.match(result.failure, /lib\/tracing\.ts/);
    assert.match(result.failure, /sync\.mjs/);
  });

  it('fails on a pin it cannot read, even when the repository does not need one', () => {
    const result = decidePin({ lockText: '{"repository":"x"}', required: false });
    assert.equal(result.present, false);
    assert.match(result.failure, /repository/);
  });
});

describe('planSync', () => {
  const wanted = files({ 'lib/a.ts': 'new a', 'lib/b.ts': 'same b', 'lib/c.ts': 'new c' });

  it('writes a file that is new or different and leaves an equal file alone', () => {
    const current = files({ 'lib/a.ts': 'old a', 'lib/b.ts': 'same b' });
    assert.deepEqual(planSync({ wanted, current, previousPaths: [] }), {
      write: ['lib/a.ts', 'lib/c.ts'],
      unchanged: ['lib/b.ts'],
      remove: [],
    });
  });

  it('removes a file of the previous pin that the new commit no longer has', () => {
    const current = files({ 'lib/a.ts': 'new a', 'lib/gone.ts': 'old', 'lib/own.ts': 'mine' });
    const plan = planSync({ wanted, current, previousPaths: ['lib/a.ts', 'lib/gone.ts'] });
    assert.deepEqual(plan.remove, ['lib/gone.ts']);
  });

  it('never removes a file that the previous pin did not own', () => {
    const current = files({ 'lib/own.ts': 'mine' });
    assert.deepEqual(planSync({ wanted, current, previousPaths: ['lib/a.ts'] }).remove, []);
  });

  it('does not remove a file that is already gone', () => {
    const current = files({});
    assert.deepEqual(planSync({ wanted, current, previousPaths: ['lib/gone.ts'] }).remove, []);
  });

  it('refuses a path that could leave the repository', () => {
    assert.throws(() => planSync({ wanted: files({ '../x.ts': 'x' }), current: files({}), previousPaths: [] }), /unsafe/i);
    assert.throws(() => planSync({ wanted, current: files({}), previousPaths: ['../../etc/x'] }), /unsafe/i);
  });
});

describe('classifyPin', () => {
  const base = { repository: 'lab-web', latest: SHA_B };

  it('is current when the pin is the latest commit that changed shared/', () => {
    assert.equal(classifyPin({ ...base, pinned: SHA_B, relation: 'identical' }).status, 'current');
  });

  it('is current when the pin is a later commit than the latest change of shared/', () => {
    assert.equal(classifyPin({ ...base, pinned: SHA_A, relation: 'behind' }).status, 'current');
  });

  it('is behind when the latest change of shared/ is not in the pin', () => {
    assert.equal(classifyPin({ ...base, pinned: SHA_A, relation: 'ahead' }).status, 'behind');
    assert.equal(classifyPin({ ...base, pinned: SHA_A, relation: 'diverged' }).status, 'behind');
  });

  it('is no-pin when the repository has no lock file', () => {
    assert.equal(classifyPin({ ...base, pinned: null, relation: null }).status, 'no-pin');
  });

  it('refuses a relation it does not know, so a new answer of the API cannot pass as current', () => {
    assert.throws(() => classifyPin({ ...base, pinned: SHA_A, relation: 'sideways' }), /sideways/);
  });
});

describe('keyOf', () => {
  it('makes a key that the tracking issue accepts, and that changes with the latest commit', () => {
    assert.equal(keyOf({ repository: 'lab-svc-core', status: 'behind', latest: SHA_B }), `lab-svc-core@${SHA_B.slice(0, 7)}`);
    assert.equal(keyOf({ repository: 'lab-web', status: 'no-pin', latest: SHA_B }), 'lab-web@no-pin');
  });
});

describe('the text of the issue', () => {
  const behind = [
    { repository: 'lab-svc-core', status: 'behind', pinned: SHA_A, latest: SHA_B, key: 'lab-svc-core@b1b1b1b' },
    { repository: 'lab-web', status: 'no-pin', pinned: null, latest: SHA_B, key: 'lab-web@no-pin' },
  ];
  const context = { latest: SHA_B, runUrl: 'https://github.com/jross24/lab-workflows/actions/runs/9' };

  it('lists each service with its pin and gives the sync command', () => {
    const body = renderBody(behind, context);
    assert.match(body, /2 services/);
    assert.match(body, /lab-svc-core/);
    assert.match(body, new RegExp(SHA_A.slice(0, 7)));
    assert.match(body, /no pin/);
    assert.match(body, /node actions\/shared-files\/sync\.mjs/);
    assert.match(body, /Run: https:\/\/github\.com\/jross24\/lab-workflows\/actions\/runs\/9/);
  });

  it('uses the singular for one service', () => {
    assert.match(renderBody([behind[0]], context), /1 service is/);
  });

  it('puts the new rows first in a comment, and then all rows', () => {
    const comment = renderComment([behind[1]], behind, context);
    assert.match(comment, /1 new/);
    assert.ok(comment.indexOf('lab-web') < comment.indexOf('lab-svc-core'));
  });
});
