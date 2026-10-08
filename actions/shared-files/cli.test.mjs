// Tests for cli.mjs. Run them with: node --test actions/shared-files/cli.test.mjs
// The tests use temporary folders and fakes for `gh`. No test uses the network.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createFakeGh } from '../tracking-issue/fake-gh.mjs';
import { LOCK_FILE, renderLock } from './lib.mjs';
import { main, readTree, runCheck, runPin, runReport } from './cli.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

let root;
let shared;
let service;

const put = (dir, path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shared-files-cli-'));
  shared = join(root, 'shared');
  service = join(root, 'service');
  mkdirSync(shared);
  mkdirSync(service);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const collector = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(line), text: () => lines.join('\n') };
};

describe('readTree', () => {
  it('reads every file below a folder as bytes, with relative paths in sorted order', () => {
    put(shared, 'lib/b.ts', 'b');
    put(shared, 'lib/a.ts', 'a');
    put(shared, 'test/support/s.ts', 's');
    const tree = readTree(shared);
    assert.deepEqual([...tree.keys()], ['lib/a.ts', 'lib/b.ts', 'test/support/s.ts']);
    assert.deepEqual(tree.get('lib/a.ts'), Buffer.from('a'));
  });

  it('returns an empty map for a folder that does not exist', () => {
    assert.equal(readTree(join(root, 'nothing')).size, 0);
  });
});

describe('runPin', () => {
  it('reports the commit of a pin', () => {
    put(service, LOCK_FILE, renderLock(SHA_A));
    const out = collector();
    const result = runPin({ dir: service, requireIf: null, log: out.log });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.outputs, { present: 'true', commit: SHA_A });
  });

  it('passes with a notice when there is no pin and the repository does not need one', () => {
    const out = collector();
    const result = runPin({ dir: service, requireIf: null, log: out.log });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.outputs, { present: 'false', commit: '' });
    assert.match(out.text(), /^::notice /m);
    assert.match(out.text(), /shared\.lock\.json/);
  });

  it('passes when there is no pin and the file that makes a pin necessary is absent', () => {
    const result = runPin({ dir: service, requireIf: 'lib/tracing.ts', log: () => {} });
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs.present, 'false');
  });

  it('fails when there is no pin and the repository has the file that makes a pin necessary', () => {
    put(service, 'lib/tracing.ts', 'x');
    const out = collector();
    const result = runPin({ dir: service, requireIf: 'lib/tracing.ts', log: out.log });
    assert.equal(result.exitCode, 1);
    assert.match(out.text(), /^::error /m);
    assert.match(out.text(), /lib\/tracing\.ts/);
    assert.match(out.text(), /sync\.mjs/);
  });

  it('fails on a pin that it cannot read', () => {
    put(service, LOCK_FILE, '{"repository":"jross24/lab-workflows","commit":"main"}');
    const out = collector();
    assert.equal(runPin({ dir: service, requireIf: null, log: out.log }).exitCode, 1);
    assert.match(out.text(), /^::error /m);
  });

  it('refuses a require-if path that leaves the folder', () => {
    assert.throws(() => runPin({ dir: service, requireIf: '../x', log: () => {} }), /inside/);
  });
});

describe('runCheck', () => {
  beforeEach(() => {
    put(shared, 'lib/a.ts', 'export const a = 1;\n');
    put(shared, 'lib/b.ts', 'export const b = 2;\n');
    put(shared, 'test/support/s.ts', 's\n');
    for (const [path, text] of readTree(shared)) put(service, path, text.toString('utf8'));
    put(service, LOCK_FILE, renderLock(SHA_A));
  });

  it('passes when every shared file is equal, and ignores a file of the service itself', () => {
    put(service, 'lib/own.ts', 'mine');
    const out = collector();
    assert.equal(runCheck({ sharedDir: shared, targetDir: service, log: out.log }).exitCode, 0);
    assert.match(out.text(), /3 shared files/);
  });

  it('fails when one byte of a copy changes, and names the file, the pin and the sync command', () => {
    put(service, 'lib/b.ts', 'export const b = 3;\n');
    const out = collector();
    const result = runCheck({ sharedDir: shared, targetDir: service, log: out.log });
    assert.equal(result.exitCode, 1);
    assert.match(out.text(), /^::error file=lib\/b\.ts,title=Shared file::/m);
    assert.match(out.text(), /lib\/b\.ts differs/);
    assert.match(out.text(), /node actions\/shared-files\/sync\.mjs/);
    assert.match(out.text(), new RegExp(SHA_A));
    assert.doesNotMatch(out.text(), /lib\/a\.ts differs/);
  });

  it('fails when the line ending of a copy changes', () => {
    put(service, 'lib/a.ts', 'export const a = 1;\r\n');
    assert.equal(runCheck({ sharedDir: shared, targetDir: service, log: () => {} }).exitCode, 1);
  });

  it('fails when a shared file is missing', () => {
    rmSync(join(service, 'test/support/s.ts'));
    const out = collector();
    assert.equal(runCheck({ sharedDir: shared, targetDir: service, log: out.log }).exitCode, 1);
    assert.match(out.text(), /^::error file=test\/support\/s\.ts,title=Shared file::/m);
    assert.match(out.text(), /missing/);
  });

  it('names every problem file, not only the first', () => {
    put(service, 'lib/a.ts', 'x');
    rmSync(join(service, 'lib/b.ts'));
    const out = collector();
    runCheck({ sharedDir: shared, targetDir: service, log: out.log });
    assert.match(out.text(), /file=lib\/a\.ts/);
    assert.match(out.text(), /file=lib\/b\.ts/);
  });

  it('fails when the pinned commit has no shared file, so an empty pin cannot pass', () => {
    rmSync(shared, { recursive: true, force: true });
    mkdirSync(shared);
    const out = collector();
    assert.equal(runCheck({ sharedDir: shared, targetDir: service, log: out.log }).exitCode, 1);
    assert.match(out.text(), /no file/i);
  });

  it('fails when the pin file is missing or unreadable', () => {
    rmSync(join(service, LOCK_FILE));
    assert.equal(runCheck({ sharedDir: shared, targetDir: service, log: () => {} }).exitCode, 1);
    put(service, LOCK_FILE, 'garbage');
    assert.equal(runCheck({ sharedDir: shared, targetDir: service, log: () => {} }).exitCode, 1);
  });

  it('writes a summary for the page of the run', () => {
    put(service, 'lib/b.ts', 'changed');
    const result = runCheck({ sharedDir: shared, targetDir: service, log: () => {} });
    assert.match(result.summary, /lib\/b\.ts/);
  });
});

describe('runReport', () => {
  const LOCKS = {
    'lab-svc-core': renderLock(SHA_A),
    'lab-svc-catalogue': renderLock(SHA_B),
    'lab-svc-account': null,
  };
  const REPOS = Object.keys(LOCKS).map((name) => `jross24/${name}`);

  // relations: { [pinned sha]: 'identical' | 'ahead' | 'behind' | 'diverged' | Error }
  function settings(overrides = {}) {
    const fake = overrides.fake ?? createFakeGh();
    return {
      fake,
      options: {
        owner: 'jross24',
        repositories: REPOS,
        issueRepo: 'jross24/lab-workflows',
        dryRun: false,
        runUrl: 'https://github.com/jross24/lab-workflows/actions/runs/5',
        gh: fake.gh,
        latestCommit: () => SHA_C,
        fetchFile: (fullName) => {
          const name = fullName.split('/')[1];
          if (!(name in LOCKS)) throw new Error(`unexpected repository ${fullName}`);
          return LOCKS[name];
        },
        compare: (pinned) => {
          const relation = { [SHA_A]: 'ahead', [SHA_B]: 'identical', ...(overrides.relations ?? {}) }[pinned];
          if (relation instanceof Error) throw relation;
          return relation;
        },
        log: () => {},
        ...overrides.options,
      },
    };
  }

  it('opens one issue that names the service that is behind and the one with no pin', () => {
    const { fake, options } = settings();
    const result = runReport(options);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.behind.map((item) => item.repository).sort(), ['lab-svc-account', 'lab-svc-core']);
    assert.equal(fake.writes.length, 1);
    const body = fake.writes[0].payload.body;
    assert.match(body, /lab-svc-core/);
    assert.match(body, /lab-svc-account/);
    assert.doesNotMatch(body, /lab-svc-catalogue/);
    assert.match(body, /<!-- shared-files -->/);
  });

  it('writes nothing when every service is current', () => {
    const { fake, options } = settings({ relations: { [SHA_A]: 'identical' }, options: { fetchFile: () => renderLock(SHA_A) } });
    const result = runReport(options);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.writes, []);
  });

  it('does not write a second time for the same rows, and comments when shared/ changes again', () => {
    const fake = createFakeGh();
    runReport(settings({ fake }).options);
    runReport(settings({ fake }).options);
    assert.equal(fake.writes.length, 1);
    const next = settings({ fake, options: { latestCommit: () => SHA_B } });
    runReport(next.options);
    assert.equal(fake.writes.length, 2);
    assert.match(fake.writes[1].path, /\/comments$/);
  });

  it('fails the run when a pin cannot be compared, and still reports the other services', () => {
    const { fake, options } = settings({ relations: { [SHA_A]: new Error('HTTP 404: no common ancestor') } });
    const out = collector();
    const result = runReport({ ...options, log: out.log });
    assert.equal(result.exitCode, 1);
    assert.match(out.text(), /^::error .*lab-svc-core/m);
    assert.deepEqual(result.behind.map((item) => item.repository), ['lab-svc-account']);
    assert.equal(fake.writes.length, 1);
  });

  it('fails the run for a pin file that it cannot read', () => {
    const { options } = settings({ options: { fetchFile: () => '{"repository":"x"}' } });
    const out = collector();
    const result = runReport({ ...options, log: out.log });
    assert.equal(result.exitCode, 1);
    assert.match(out.text(), /^::error /m);
  });

  it('writes nothing in a dry run', () => {
    const { fake, options } = settings({ options: { dryRun: true } });
    runReport(options);
    assert.deepEqual(fake.writes, []);
  });

  it('gives a summary table of all services', () => {
    const { options } = settings();
    const { summary } = runReport(options);
    assert.match(summary, /lab-svc-core.*behind/);
    assert.match(summary, /lab-svc-catalogue.*current/);
    assert.match(summary, /lab-svc-account.*no pin/);
  });
});

describe('main', () => {
  it('prints the usage and returns 2 for an unknown command', () => {
    const out = collector();
    assert.equal(main(['nonsense'], {}, out.log), 2);
    assert.match(out.text(), /Usage/);
  });

  it('writes the outputs of the command pin to the file GITHUB_OUTPUT', () => {
    put(service, LOCK_FILE, renderLock(SHA_B));
    const outputFile = join(root, 'github-output');
    const code = main(['pin', '--dir', service], { GITHUB_OUTPUT: outputFile }, () => {});
    assert.equal(code, 0);
    assert.equal(readFileSync(outputFile, 'utf8'), `present=true\ncommit=${SHA_B}\n`);
  });

  it('passes --require-if on to the pin command', () => {
    put(service, 'lib/tracing.ts', 'x');
    assert.equal(main(['pin', '--dir', service, '--require-if', 'lib/tracing.ts'], {}, () => {}), 1);
  });

  it('runs the command check with two folders', () => {
    put(shared, 'lib/a.ts', 'a');
    put(service, 'lib/a.ts', 'a');
    put(service, LOCK_FILE, renderLock(SHA_A));
    assert.equal(main(['check', shared, service], {}, () => {}), 0);
    put(service, 'lib/a.ts', 'b');
    assert.equal(main(['check', shared, service], {}, () => {}), 1);
  });
});
