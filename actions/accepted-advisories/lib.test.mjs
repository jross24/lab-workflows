// Tests for lib.mjs. Run them with: node --test actions/accepted-advisories/lib.test.mjs
// Every test passes the date. No test reads the clock.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_DAYS, allowList, evaluate, parseList } from './lib.mjs';

const TODAY = '2026-10-08';

const entry = (overrides = {}) => ({
  id: 'GHSA-6j4f-fj2g-mc7p',
  package: 'brace-expansion',
  reason: 'Bundled inside aws-cdk-lib. No patched release exists.',
  issue: 'jross24/lab-platform#15',
  expires: '2026-11-08',
  ...overrides,
});

describe('parseList', () => {
  it('returns the entries of a JSON array', () => {
    assert.deepEqual(parseList(JSON.stringify([entry()])), [entry()]);
    assert.deepEqual(parseList('[]'), []);
  });

  it('throws a clear error for text that is not JSON', () => {
    assert.throws(() => parseList('{ nope'), /not valid JSON/);
  });

  it('throws when the JSON is not an array', () => {
    assert.throws(() => parseList('{"id": "x"}'), /must be an array/);
  });
});

describe('evaluate', () => {
  it('allows an entry that has not expired', () => {
    const result = evaluate([entry()], TODAY);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(
      result.allowed.map((item) => item.id),
      ['GHSA-6j4f-fj2g-mc7p'],
    );
  });

  it('allows an entry on the day of its date, and expires it the day after', () => {
    assert.equal(evaluate([entry()], '2026-11-08').allowed.length, 1);
    const after = evaluate([entry()], '2026-11-09');
    assert.deepEqual(after.allowed, []);
    assert.equal(after.problems.length, 1);
  });

  it('names the entry, the date and the issue in the message of an expired entry', () => {
    const [message] = evaluate([entry()], '2026-11-09').problems;
    assert.match(message, /GHSA-6j4f-fj2g-mc7p/);
    assert.match(message, /brace-expansion/);
    assert.match(message, /expired on 2026-11-08/);
    assert.match(message, /lab-platform#15/);
  });

  it('names the missing field', () => {
    for (const field of ['id', 'package', 'reason', 'issue', 'expires']) {
      const result = evaluate([entry({ [field]: undefined })], TODAY);
      assert.deepEqual(result.allowed, [], field);
      assert.match(result.problems[0], new RegExp(`"${field}"`), field);
    }
  });

  it('treats a blank field as missing', () => {
    const result = evaluate([entry({ reason: '   ' })], TODAY);
    assert.deepEqual(result.allowed, []);
    assert.match(result.problems[0], /"reason"/);
  });

  it('names an entry without an id by its position', () => {
    const result = evaluate([entry(), entry({ id: undefined })], TODAY);
    assert.match(result.problems[0], /^entry 2:/);
  });

  it('rejects a value that is not a GHSA id', () => {
    const result = evaluate([entry({ id: 'CVE-2024-1234' })], TODAY);
    assert.deepEqual(result.allowed, []);
    assert.match(result.problems[0], /not a GHSA id/);
  });

  it('rejects an issue that is not owner/repo#number', () => {
    const result = evaluate([entry({ issue: '#15' })], TODAY);
    assert.deepEqual(result.allowed, []);
    assert.match(result.problems[0], /"issue"/);
  });

  it('rejects a date that is not a real calendar date', () => {
    for (const bad of ['2026-02-30', '08-11-2026', 'soon', 20261108]) {
      const result = evaluate([entry({ expires: bad })], TODAY);
      assert.deepEqual(result.allowed, [], String(bad));
      assert.match(result.problems[0], /"expires"/, String(bad));
    }
  });

  it('rejects a reason on more than one line', () => {
    const result = evaluate([entry({ reason: 'line one\nline two' })], TODAY);
    assert.deepEqual(result.allowed, []);
    assert.match(result.problems[0], /one line/);
  });

  it('rejects a date too far away, because the list must stay short-lived', () => {
    assert.equal(MAX_DAYS, 90);
    assert.equal(evaluate([entry({ expires: '2027-01-06' })], TODAY).allowed.length, 1); // exactly 90 days
    const result = evaluate([entry({ expires: '2027-01-07' })], TODAY);
    assert.deepEqual(result.allowed, []);
    assert.match(result.problems[0], /more than 90 days/);
  });

  it('rejects an id that is listed twice', () => {
    const result = evaluate([entry(), entry()], TODAY);
    assert.equal(result.allowed.length, 1);
    assert.match(result.problems[0], /listed twice/);
  });

  it('keeps the good entries when another entry is bad', () => {
    const good = entry({ id: 'GHSA-qhr7-859c-m2p7' });
    const result = evaluate([entry({ expires: '2026-10-01' }), good], TODAY);
    assert.deepEqual(result.allowed, [good]);
    assert.equal(result.problems.length, 1);
  });

  it('rejects an entry that is not an object', () => {
    const result = evaluate(['GHSA-6j4f-fj2g-mc7p'], TODAY);
    assert.deepEqual(result.allowed, []);
    assert.match(result.problems[0], /^entry 1: .*object/);
  });

  it('throws when the date of today is not a date', () => {
    assert.throws(() => evaluate([entry()], 'today'), /YYYY-MM-DD/);
  });
});

describe('allowList', () => {
  it('joins the ids with commas, the format of the input allow-ghsas', () => {
    assert.equal(allowList([entry(), entry({ id: 'GHSA-qhr7-859c-m2p7' })]), 'GHSA-6j4f-fj2g-mc7p,GHSA-qhr7-859c-m2p7');
  });

  it('gives an empty text for an empty list', () => {
    assert.equal(allowList([]), '');
  });
});
