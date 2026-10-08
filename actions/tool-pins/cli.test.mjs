// Tests for cli.mjs. Run them with: node --test actions/tool-pins/cli.test.mjs
// The tests pass fakes for `gh` and for the lookup of the latest release. No test uses the network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeGh } from '../tracking-issue/fake-gh.mjs';
import { runPins } from './cli.mjs';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const REAL = read('../install-tool/tools.txt');
const BEHIND = read('./fixtures/tools-behind.txt');
const BEHIND_MORE = read('./fixtures/tools-behind-more.txt');

// tags: { 'owner/repo': 'v1.2.3' | Error }
const lookup = (tags) => (repo) => {
  const tag = tags[repo];
  if (tag instanceof Error) throw tag;
  return tag;
};

const settings = (overrides = {}) => ({
  pinsText: REAL,
  pinsFile: 'actions/install-tool/tools.txt',
  issueRepo: 'jross24/lab-workflows',
  dryRun: false,
  runUrl: 'https://github.com/jross24/lab-workflows/actions/runs/2',
  log: () => {},
  ...overrides,
});

const CURRENT = { 'rhysd/actionlint': 'v1.7.12', 'gitleaks/gitleaks': 'v8.30.1' };

describe('the real pin file', () => {
  it('has pins that the check can read and compare', () => {
    const fake = createFakeGh();
    const result = runPins({ ...settings(), gh: fake.gh, latestTag: lookup(CURRENT) });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.unchecked, []);
    assert.deepEqual(result.current.map((entry) => entry.tool).sort(), ['actionlint', 'gitleaks']);
  });
});

describe('runPins', () => {
  it('opens no issue when every pin is current', () => {
    const fake = createFakeGh();
    const result = runPins({ ...settings(), gh: fake.gh, latestTag: lookup(CURRENT) });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.writes, []);
  });

  it('opens one issue when a pin is behind, and does not touch the pins', () => {
    const fake = createFakeGh();
    const result = runPins({
      ...settings({ pinsText: BEHIND, pinsFile: 'actions/tool-pins/fixtures/tools-behind.txt' }),
      gh: fake.gh,
      latestTag: lookup(CURRENT),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(fake.writes.length, 1);
    const { payload } = fake.writes[0];
    assert.match(payload.title, /tool pins/);
    assert.match(payload.body, /\| gitleaks \| 8\.0\.0 \| \[8\.30\.1\]/);
    assert.match(payload.body, /actions\/tool-pins\/fixtures\/tools-behind\.txt/);
    // Every call of gh reads an issue or writes an issue. None writes a file or a branch.
    assert.ok(fake.calls.every(({ args }) => args[0] === 'api' && args.some((arg) => /\/issues/.test(arg))));
  });

  it('does not repeat the issue on a second run', () => {
    const fake = createFakeGh();
    const args = { ...settings({ pinsText: BEHIND }), gh: fake.gh, latestTag: lookup(CURRENT) };
    runPins(args);
    runPins(args);
    assert.equal(fake.writes.length, 1);
  });

  it('comments on the open issue when another tool falls behind', () => {
    const fake = createFakeGh();
    runPins({ ...settings({ pinsText: BEHIND }), gh: fake.gh, latestTag: lookup(CURRENT) });
    const result = runPins({ ...settings({ pinsText: BEHIND_MORE }), gh: fake.gh, latestTag: lookup(CURRENT) });
    assert.equal(result.issue.action, 'comment');
    assert.equal(fake.writes.length, 2);
    assert.match(fake.writes[1].payload.body, /1 new pin/);
    assert.match(fake.writes[1].payload.body, /\| actionlint \| 1\.0\.0 \|/);
  });

  it('comments again when the latest release of a tool that is behind moves on', () => {
    const fake = createFakeGh();
    runPins({ ...settings({ pinsText: BEHIND }), gh: fake.gh, latestTag: lookup(CURRENT) });
    const result = runPins({
      ...settings({ pinsText: BEHIND }),
      gh: fake.gh,
      latestTag: lookup({ ...CURRENT, 'gitleaks/gitleaks': 'v8.31.0' }),
    });
    assert.equal(result.issue.action, 'comment');
  });

  it('fails the run when the lookup of a release fails, and still reports the other pins', () => {
    const fake = createFakeGh();
    const lines = [];
    const result = runPins({
      ...settings({ pinsText: BEHIND_MORE, log: (line) => lines.push(line) }),
      gh: fake.gh,
      latestTag: lookup({ ...CURRENT, 'rhysd/actionlint': new Error('rate limit') }),
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.unchecked.map((entry) => entry.tool), ['actionlint']);
    assert.match(lines.join('\n'), /::error[^\n]*actionlint[^\n]*rate limit/);
    assert.equal(fake.writes.length, 1);
    assert.match(fake.writes[0].payload.body, /gitleaks/);
  });

  it('fails the run for a pin file that it cannot read, or that has no pin', () => {
    const fake = createFakeGh();
    assert.equal(runPins({ ...settings({ pinsText: 'a b c' }), gh: fake.gh, latestTag: lookup(CURRENT) }).exitCode, 1);
    assert.equal(runPins({ ...settings({ pinsText: '# nothing\n' }), gh: fake.gh, latestTag: lookup(CURRENT) }).exitCode, 1);
    assert.deepEqual(fake.writes, []);
  });

  it('writes nothing in a dry run', () => {
    const fake = createFakeGh();
    const result = runPins({ ...settings({ pinsText: BEHIND, dryRun: true }), gh: fake.gh, latestTag: lookup(CURRENT) });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.writes, []);
    assert.equal(result.issue.dryRun, true);
  });

  it('asks for the latest release once for each repository', () => {
    const asked = [];
    const fake = createFakeGh();
    runPins({
      ...settings({ pinsText: BEHIND_MORE }),
      gh: fake.gh,
      latestTag: (repo) => {
        asked.push(repo);
        return CURRENT[repo];
      },
    });
    assert.deepEqual(asked.sort(), ['gitleaks/gitleaks', 'rhysd/actionlint']);
  });

  it('shows a table of all the pins in the summary', () => {
    const fake = createFakeGh();
    const result = runPins({ ...settings({ pinsText: BEHIND_MORE }), gh: fake.gh, latestTag: lookup(CURRENT) });
    assert.match(result.summary, /\| gitleaks \| 8\.0\.0 \| 8\.30\.1 \| behind \|/);
    assert.match(result.summary, /\| actionlint \| 1\.0\.0 \| 1\.7\.12 \| behind \|/);
  });
});
