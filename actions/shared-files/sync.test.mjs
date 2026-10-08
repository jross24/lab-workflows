// Tests for sync.mjs. Run them with: node --test actions/shared-files/sync.test.mjs
// Most tests use a source in memory and a temporary folder. One group uses a real git repository in a temporary folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LOCK_FILE, parseLock, renderLock } from './lib.mjs';
import { gitSource, main, syncShared } from './sync.mjs';

const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);
const SHA_3 = '3'.repeat(40);

// commits: { sha: { 'lib/a.ts': 'text' } }. The paths are relative to shared/.
function memorySource(commits) {
  return {
    list: (commit) => {
      if (!(commit in commits)) throw new Error(`unknown commit ${commit}`);
      return Object.keys(commits[commit]);
    },
    read: (commit, path) => Buffer.from(commits[commit][path], 'utf8'),
    resolve: (ref) => (ref in commits ? ref : (() => { throw new Error(`unknown ref ${ref}`); })()),
    latest: () => SHA_3,
  };
}

let root;
let target;
const quiet = () => {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shared-files-sync-'));
  target = join(root, 'service');
  mkdirSync(target);
  writeFileSync(join(target, 'package.json'), '{}\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (path) => readFileSync(join(target, path), 'utf8');
const write = (path, text) => {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  writeFileSync(join(target, path), text);
};

describe('syncShared', () => {
  it('copies every file of the commit and writes the pin', () => {
    const source = memorySource({ [SHA_1]: { 'lib/a.ts': 'a1', 'test/support/s.ts': 's1' } });
    const result = syncShared({ source, targetDir: target, commit: SHA_1, log: quiet });
    assert.equal(read('lib/a.ts'), 'a1');
    assert.equal(read('test/support/s.ts'), 's1');
    assert.deepEqual(parseLock(read(LOCK_FILE)), { repository: 'jross24/lab-workflows', commit: SHA_1 });
    assert.deepEqual(result.written, ['lib/a.ts', 'test/support/s.ts']);
    assert.deepEqual(result.removed, []);
  });

  it('copies the bytes, with no change of the line ending', () => {
    const source = { ...memorySource({ [SHA_1]: { 'lib/a.ts': 'x' } }), read: () => Buffer.from([0x61, 0x0d, 0x0a, 0xff, 0x00]) };
    syncShared({ source, targetDir: target, commit: SHA_1, log: quiet });
    assert.deepEqual(readFileSync(join(target, 'lib/a.ts')), Buffer.from([0x61, 0x0d, 0x0a, 0xff, 0x00]));
  });

  it('restores a file that someone edited by hand', () => {
    const source = memorySource({ [SHA_1]: { 'lib/a.ts': 'a1' } });
    syncShared({ source, targetDir: target, commit: SHA_1, log: quiet });
    write('lib/a.ts', 'hand edit');
    const result = syncShared({ source, targetDir: target, commit: SHA_1, log: quiet });
    assert.equal(read('lib/a.ts'), 'a1');
    assert.deepEqual(result.written, ['lib/a.ts']);
  });

  it('writes nothing for files that are equal, and does not touch the files of the service', () => {
    const source = memorySource({ [SHA_1]: { 'lib/a.ts': 'a1' } });
    write('lib/own.ts', 'mine');
    syncShared({ source, targetDir: target, commit: SHA_1, log: quiet });
    const result = syncShared({ source, targetDir: target, commit: SHA_1, log: quiet });
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.unchanged, ['lib/a.ts']);
    assert.equal(read('lib/own.ts'), 'mine');
  });

  it('moves the pin to a newer commit and removes a file that the new commit dropped', () => {
    const source = memorySource({
      [SHA_1]: { 'lib/a.ts': 'a1', 'lib/old.ts': 'old' },
      [SHA_2]: { 'lib/a.ts': 'a2' },
    });
    write('lib/own.ts', 'mine');
    syncShared({ source, targetDir: target, commit: SHA_1, log: quiet });
    const result = syncShared({ source, targetDir: target, commit: SHA_2, log: quiet });
    assert.equal(read('lib/a.ts'), 'a2');
    assert.equal(existsSync(join(target, 'lib/old.ts')), false);
    assert.equal(read('lib/own.ts'), 'mine');
    assert.deepEqual(result.removed, ['lib/old.ts']);
    assert.equal(parseLock(read(LOCK_FILE)).commit, SHA_2);
  });

  it('still syncs when the previous pin is not in the source, and says so', () => {
    const source = memorySource({ [SHA_2]: { 'lib/a.ts': 'a2' } });
    write(LOCK_FILE, renderLock(SHA_1));
    const lines = [];
    const result = syncShared({ source, targetDir: target, commit: SHA_2, log: (line) => lines.push(line) });
    assert.equal(read('lib/a.ts'), 'a2');
    assert.deepEqual(result.removed, []);
    assert.match(lines.join('\n'), /previous pin/i);
  });

  it('replaces a pin that it cannot read', () => {
    const source = memorySource({ [SHA_1]: { 'lib/a.ts': 'a1' } });
    write(LOCK_FILE, 'garbage');
    syncShared({ source, targetDir: target, commit: SHA_1, log: quiet });
    assert.equal(parseLock(read(LOCK_FILE)).commit, SHA_1);
  });

  it('refuses a commit that has no file under shared/, and writes nothing', () => {
    const source = memorySource({ [SHA_1]: {} });
    assert.throws(() => syncShared({ source, targetDir: target, commit: SHA_1, log: quiet }), /no file/i);
    assert.equal(existsSync(join(target, LOCK_FILE)), false);
  });

  it('refuses a target that is not a folder with a package.json', () => {
    const source = memorySource({ [SHA_1]: { 'lib/a.ts': 'a1' } });
    assert.throws(() => syncShared({ source, targetDir: join(root, 'missing'), commit: SHA_1, log: quiet }), /folder/);
    const empty = join(root, 'empty');
    mkdirSync(empty);
    assert.throws(() => syncShared({ source, targetDir: empty, commit: SHA_1, log: quiet }), /package\.json/);
    assert.equal(existsSync(join(empty, 'lib')), false);
  });

  it('refuses a path that leaves the target, and writes nothing', () => {
    const source = memorySource({ [SHA_1]: { 'lib/a.ts': 'a1', '../escape.ts': 'x' } });
    assert.throws(() => syncShared({ source, targetDir: target, commit: SHA_1, log: quiet }), /unsafe/i);
    assert.equal(existsSync(join(target, 'lib/a.ts')), false);
    assert.equal(existsSync(join(root, 'escape.ts')), false);
  });

  it('refuses to write into the source repository itself', () => {
    const source = { ...memorySource({ [SHA_1]: { 'lib/a.ts': 'a1' } }), root: target };
    assert.throws(() => syncShared({ source, targetDir: target, commit: SHA_1, log: quiet }), /lab-workflows itself|source repository/i);
  });

  it('replaces a symbolic link with the file and does not write through it', (t) => {
    const outside = join(root, 'outside.ts');
    writeFileSync(outside, 'outside');
    mkdirSync(join(target, 'lib'));
    try {
      symlinkSync(outside, join(target, 'lib/a.ts'));
    } catch {
      t.skip('the system cannot make a symbolic link');
      return;
    }
    const source = memorySource({ [SHA_1]: { 'lib/a.ts': 'a1' } });
    syncShared({ source, targetDir: target, commit: SHA_1, log: quiet });
    assert.equal(readFileSync(outside, 'utf8'), 'outside');
    assert.equal(read('lib/a.ts'), 'a1');
  });
});

describe('main', () => {
  it('syncs the commit that the argument names, and resolves it to 40 characters', () => {
    const source = memorySource({ [SHA_1]: { 'lib/a.ts': 'a1' } });
    const code = main([target, SHA_1], { source, log: quiet });
    assert.equal(code, 0);
    assert.equal(parseLock(read(LOCK_FILE)).commit, SHA_1);
  });

  it('syncs the latest main when no commit is given', () => {
    const source = memorySource({ [SHA_3]: { 'lib/a.ts': 'a3' } });
    assert.equal(main([target], { source, log: quiet }), 0);
    assert.equal(parseLock(read(LOCK_FILE)).commit, SHA_3);
  });

  it('prints the usage and returns 2 without a target', () => {
    const lines = [];
    assert.equal(main([], { source: memorySource({}), log: (line) => lines.push(line) }), 2);
    assert.match(lines.join('\n'), /Usage/);
  });

  it('returns 1 and names the problem when the sync fails', () => {
    const lines = [];
    const source = memorySource({ [SHA_1]: {} });
    assert.equal(main([target, SHA_1], { source, log: (line) => lines.push(line) }), 1);
    assert.match(lines.join('\n'), /no file/i);
  });
});

describe('gitSource', () => {
  let repo;

  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=true', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });

  beforeEach(() => {
    repo = join(root, 'workflows');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
  });

  it('lists the files under shared/ at a commit, reads their bytes from the object database, and resolves a ref', () => {
    mkdirSync(join(repo, 'shared/lib'), { recursive: true });
    mkdirSync(join(repo, 'actions'), { recursive: true });
    writeFileSync(join(repo, 'shared/lib/a.ts'), 'line 1\nline 2\n');
    writeFileSync(join(repo, 'shared/lib/b b.ts'), 'space in the name\n');
    writeFileSync(join(repo, 'actions/other.mjs'), 'not shared\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const first = git('rev-parse', 'HEAD').trim();
    // The working tree changes after the commit. The source must read the commit and not the working tree.
    writeFileSync(join(repo, 'shared/lib/a.ts'), 'edited later\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'second');

    const source = gitSource(repo);
    assert.deepEqual([...source.list(first)].sort(), ['lib/a.ts', 'lib/b b.ts']);
    assert.equal(source.read(first, 'lib/a.ts').toString('utf8'), 'line 1\nline 2\n');
    assert.equal(source.resolve('main'), git('rev-parse', 'HEAD').trim());
    assert.equal(source.resolve(first.slice(0, 10)), first);
  });

  it('throws for a ref that does not exist', () => {
    writeFileSync(join(repo, 'f'), 'x');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    assert.throws(() => gitSource(repo).resolve('no-such-ref'), /no-such-ref/);
  });
});
