// Tests for cli.mjs. Run them with: node --test actions/dependency-audit/cli.test.mjs
// The tests pass fakes for `gh`, for the files of GitHub and for `npm audit`. No test uses the network or the clock.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeGh } from '../tracking-issue/fake-gh.mjs';
import { parseRepositories, runAudit } from './cli.mjs';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const ACCEPTED = JSON.stringify([
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
]);

// repos: { 'jross24/lab-web': { lock: true, audit: 'audit-brace-expansion.json' }, ... }
function world(repos) {
  const fetched = [];
  const audited = [];
  return {
    fetched,
    audited,
    fetchFile(fullName, path) {
      fetched.push(`${fullName}/${path}`);
      const repo = repos[fullName];
      if (!repo) return null;
      if (path === 'package-lock.json') return repo.lock === false ? null : `lock of ${fullName}`;
      if (path === 'package.json') return repo.package === false ? null : `package of ${fullName}`;
      return null;
    },
    npmAudit(files) {
      const owner = files['package-lock.json'].replace('lock of ', '');
      audited.push(owner);
      const repo = repos[owner];
      if (repo.audit instanceof Error) throw repo.audit;
      return fixture(repo.audit);
    },
  };
}

const settings = (overrides = {}) => ({
  owner: 'jross24',
  repositories: ['jross24/lab-web', 'jross24/lab-flags'],
  minSeverity: 'moderate',
  issueRepo: 'jross24/lab-workflows',
  acceptedText: ACCEPTED,
  today: '2026-10-08',
  dryRun: false,
  runUrl: 'https://github.com/jross24/lab-workflows/actions/runs/1',
  log: () => {},
  ...overrides,
});

describe('parseRepositories', () => {
  it('splits on spaces, commas and line breaks, and adds the owner to a bare name', () => {
    assert.deepEqual(parseRepositories('lab-web, lab-flags\nother/thing  lab-e2e', 'jross24'), [
      'jross24/lab-web',
      'jross24/lab-flags',
      'other/thing',
      'jross24/lab-e2e',
    ]);
  });

  it('refuses an empty list and a name with odd characters', () => {
    assert.throws(() => parseRepositories('  ', 'jross24'), /no repository/);
    assert.throws(() => parseRepositories('lab-web;rm', 'jross24'), /not a repository name/);
    assert.throws(() => parseRepositories('a/b/c', 'jross24'), /not a repository name/);
  });

  it('keeps each repository once', () => {
    assert.deepEqual(parseRepositories('lab-web lab-web jross24/lab-web', 'jross24'), ['jross24/lab-web']);
  });
});

describe('runAudit', () => {
  it('opens one issue for the findings of all repositories, and skips the accepted ones', () => {
    const fake = createFakeGh();
    const w = world({
      'jross24/lab-web': { audit: 'audit-brace-expansion.json' },
      'jross24/lab-flags': { audit: 'audit-transitive.json' },
    });
    const result = runAudit({ ...settings(), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.equal(result.exitCode, 0);
    assert.equal(fake.writes.length, 1);
    const { payload } = fake.writes[0];
    assert.match(payload.title, /dependency audit/);
    // lab-web: only the advisory that is not accepted. lab-flags: minimatch (left-pad is low, below the minimum).
    assert.match(payload.body, /\| lab-web \| brace-expansion \| \[GHSA-q2hr-2g5m-vwhr\]/);
    assert.doesNotMatch(payload.body, /GHSA-6j4f-fj2g-mc7p\]/);
    assert.match(payload.body, /\| lab-flags \| minimatch \|/);
    assert.doesNotMatch(payload.body, /left-pad/);
    assert.match(payload.body, /Run: https:\/\/github\.com\/jross24\/lab-workflows\/actions\/runs\/1/);
    assert.deepEqual(
      result.repositories.map((entry) => [entry.repo, entry.reported, entry.accepted.length, entry.belowThreshold]),
      [
        ['lab-web', 1, 2, 0],
        ['lab-flags', 1, 0, 1],
      ],
    );
  });

  it('reads the lockfile and the package file of each repository from its default branch', () => {
    const fake = createFakeGh();
    const w = world({ 'jross24/lab-web': { audit: 'audit-clean.json' }, 'jross24/lab-flags': { audit: 'audit-clean.json' } });
    runAudit({ ...settings(), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.deepEqual(w.fetched.sort(), [
      'jross24/lab-flags/package-lock.json',
      'jross24/lab-flags/package.json',
      'jross24/lab-web/package-lock.json',
      'jross24/lab-web/package.json',
    ]);
  });

  it('opens no issue when nothing is left, and writes nothing', () => {
    const fake = createFakeGh();
    const w = world({ 'jross24/lab-web': { audit: 'audit-clean.json' }, 'jross24/lab-flags': { audit: 'audit-clean.json' } });
    const result = runAudit({ ...settings(), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.writes, []);
  });

  it('skips a repository without a lockfile and does not run npm for it', () => {
    const fake = createFakeGh();
    const w = world({ 'jross24/lab-web': { audit: 'audit-clean.json' }, 'jross24/lab-flags': { lock: false } });
    const result = runAudit({ ...settings(), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.skipped, ['lab-flags']);
    assert.deepEqual(w.audited, ['jross24/lab-web']);
  });

  it('skips a repository that does not exist', () => {
    const fake = createFakeGh();
    const w = world({ 'jross24/lab-web': { audit: 'audit-clean.json' } });
    const result = runAudit({ ...settings(), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.deepEqual(result.skipped, ['lab-flags']);
  });

  it('fails the run for a repository whose audit fails, and still reports the others', () => {
    const fake = createFakeGh();
    const w = world({
      'jross24/lab-web': { audit: new Error('the registry is down') },
      'jross24/lab-flags': { audit: 'audit-transitive.json' },
    });
    const lines = [];
    const result = runAudit({ ...settings({ log: (line) => lines.push(line) }), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.failed.map((entry) => entry.repo), ['lab-web']);
    assert.equal(fake.writes.length, 1);
    assert.match(fake.writes[0].payload.body, /lab-flags/);
    assert.match(lines.join('\n'), /::error[^\n]*lab-web[^\n]*the registry is down/);
  });

  it('fails the run when the audit output is an npm error', () => {
    const fake = createFakeGh();
    const w = world({ 'jross24/lab-web': { audit: 'audit-error.json' }, 'jross24/lab-flags': { audit: 'audit-clean.json' } });
    const result = runAudit({ ...settings(), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.equal(result.exitCode, 1);
    assert.match(result.failed[0].message, /ENOTFOUND/);
  });

  it('fails the run for a repository that has a lockfile but no package.json', () => {
    const fake = createFakeGh();
    const w = world({ 'jross24/lab-web': { package: false, audit: 'audit-clean.json' }, 'jross24/lab-flags': { audit: 'audit-clean.json' } });
    const result = runAudit({ ...settings(), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.equal(result.exitCode, 1);
    assert.match(result.failed[0].message, /package\.json/);
  });

  it('does not repeat the issue or the comment on a second run', () => {
    const fake = createFakeGh();
    const w = world({ 'jross24/lab-web': { audit: 'audit-brace-expansion.json' }, 'jross24/lab-flags': { audit: 'audit-clean.json' } });
    const args = { ...settings(), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit };
    runAudit(args);
    runAudit(args);
    assert.equal(fake.writes.length, 1);
  });

  it('comments on the open issue when a new repository has the finding', () => {
    const fake = createFakeGh();
    const repos = { 'jross24/lab-web': { audit: 'audit-brace-expansion.json' }, 'jross24/lab-flags': { audit: 'audit-brace-expansion.json' } };
    const w = world(repos);
    runAudit({ ...settings({ repositories: ['jross24/lab-web'] }), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    const result = runAudit({ ...settings(), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.equal(fake.writes.length, 2);
    assert.match(fake.writes[1].path, /issues\/\d+\/comments$/);
    assert.match(fake.writes[1].payload.body, /1 new finding/);
    assert.equal(result.issue.action, 'comment');
  });

  it('treats an expired accepted advisory as a finding again', () => {
    const fake = createFakeGh();
    const lines = [];
    const w = world({ 'jross24/lab-web': { audit: 'audit-brace-expansion.json' }, 'jross24/lab-flags': { audit: 'audit-clean.json' } });
    runAudit({ ...settings({ today: '2026-11-09', log: (line) => lines.push(line) }), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.match(fake.writes[0].payload.body, /GHSA-6j4f-fj2g-mc7p\]/);
    assert.match(lines.join('\n'), /::warning[^\n]*Accepted advisory not applied[^\n]*expired on 2026-11-08/);
  });

  it('fails the run when the accepted list is not valid JSON', () => {
    const fake = createFakeGh();
    const w = world({ 'jross24/lab-web': { audit: 'audit-clean.json' }, 'jross24/lab-flags': { audit: 'audit-clean.json' } });
    const result = runAudit({ ...settings({ acceptedText: '{ nope' }), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(w.audited, []);
  });

  it('writes nothing in a dry run', () => {
    const fake = createFakeGh();
    const w = world({ 'jross24/lab-web': { audit: 'audit-brace-expansion.json' }, 'jross24/lab-flags': { audit: 'audit-clean.json' } });
    const result = runAudit({ ...settings({ dryRun: true }), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.writes, []);
    assert.equal(result.issue.dryRun, true);
  });

  it('shows a table of the repositories in the summary', () => {
    const fake = createFakeGh();
    const w = world({ 'jross24/lab-web': { audit: 'audit-brace-expansion.json' }, 'jross24/lab-flags': { lock: false } });
    const result = runAudit({ ...settings(), gh: fake.gh, fetchFile: w.fetchFile, npmAudit: w.npmAudit });
    assert.match(result.summary, /\| lab-web \| audited \| 1 \| 2 \| 0 \|/);
    assert.match(result.summary, /\| lab-flags \| skipped: no package-lock\.json \|/);
  });
});
