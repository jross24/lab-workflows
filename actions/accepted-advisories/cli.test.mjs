// Tests for cli.mjs. Run them with: node --test actions/accepted-advisories/cli.test.mjs
// Every test sets TODAY. No test reads the clock.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));

const list = [
  {
    id: 'GHSA-6j4f-fj2g-mc7p',
    package: 'brace-expansion',
    reason: 'Bundled inside aws-cdk-lib. No patched release exists.',
    issue: 'jross24/lab-platform#15',
    expires: '2026-11-08',
  },
  {
    id: 'GHSA-qhr7-859c-m2p7',
    package: 'brace-expansion',
    reason: 'Same copy, second advisory.',
    issue: 'jross24/lab-platform#15',
    expires: '2026-11-08',
  },
];

function run(command, { entries = list, text, today } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'accepted-advisories-'));
  const file = join(dir, 'list.json');
  writeFileSync(file, text ?? JSON.stringify(entries));
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  const env = { ...process.env, GITHUB_OUTPUT: output };
  delete env.TODAY;
  if (today) env.TODAY = today;
  const result = spawnSync(process.execPath, [CLI, command, file], { env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: readFileSync(output, 'utf8') };
}

describe('check', () => {
  it('passes when no entry has expired', () => {
    const result = run('check', { today: '2026-10-08' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /GHSA-6j4f-fj2g-mc7p/);
  });

  it('fails when an entry is past its date, and names the entry', () => {
    const result = run('check', { today: '2026-11-09' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error[^\n]*GHSA-6j4f-fj2g-mc7p[^\n]*expired on 2026-11-08/);
    assert.match(result.stdout, /::error[^\n]*GHSA-qhr7-859c-m2p7/);
  });

  it('fails when an entry lacks a field, and names the entry and the field', () => {
    const broken = [{ ...list[0], issue: undefined }];
    const result = run('check', { entries: broken, today: '2026-10-08' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error[^\n]*GHSA-6j4f-fj2g-mc7p[^\n]*"issue"/);
  });

  it('fails when the file is not JSON', () => {
    const result = run('check', { text: '{ nope', today: '2026-10-08' });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /not valid JSON/);
  });

  it('passes for an empty list', () => {
    assert.equal(run('check', { entries: [], today: '2026-10-08' }).status, 0);
  });
});

describe('allowed', () => {
  it('writes the ids of the entries that have not expired to the step output', () => {
    const result = run('allowed', { today: '2026-10-08' });
    assert.equal(result.status, 0);
    assert.equal(result.output, 'allow-ghsas=GHSA-6j4f-fj2g-mc7p,GHSA-qhr7-859c-m2p7\n');
    assert.match(result.stdout, /::notice[^\n]*GHSA-6j4f-fj2g-mc7p[^\n]*2026-11-08/);
  });

  it('leaves out an expired entry and warns, so the dependency check itself fails again', () => {
    const result = run('allowed', { today: '2026-11-09' });
    assert.equal(result.status, 0);
    assert.equal(result.output, 'allow-ghsas=\n');
    assert.match(result.stdout, /::warning[^\n]*GHSA-6j4f-fj2g-mc7p[^\n]*expired on 2026-11-08/);
  });

  it('keeps the good entry when another entry has a problem', () => {
    const mixed = [{ ...list[0], expires: '2026-10-01' }, list[1]];
    const result = run('allowed', { entries: mixed, today: '2026-10-08' });
    assert.equal(result.status, 0);
    assert.equal(result.output, 'allow-ghsas=GHSA-qhr7-859c-m2p7\n');
  });

  it('fails closed when the file is not JSON', () => {
    const result = run('allowed', { text: '[', today: '2026-10-08' });
    assert.equal(result.status, 1);
    assert.equal(result.output, '');
  });
});

describe('usage', () => {
  it('exits 2 for an unknown command', () => {
    assert.equal(run('nope', { today: '2026-10-08' }).status, 2);
  });
});
