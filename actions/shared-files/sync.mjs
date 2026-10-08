#!/usr/bin/env node
// Copies the shared files of one commit of lab-workflows into a service repository, and writes the pin.
// It needs no package, only Node 22 and git. Run it in a clone of lab-workflows:
//
//   node actions/shared-files/sync.mjs <path to the service> [commit]
//
// The commit is any git ref of this clone. The default is origin/main, after a `git fetch`. The script reads the files
// from the git object database, so the working tree of the clone (a dirty file, a line ending setting) cannot change them.
// It writes the 40-character commit in shared.lock.json. A pull request of the service then checks its copies against
// that commit. The script does not commit anything. A person reviews the diff and opens the pull request.
//
// It copies each file of shared/ to the same relative path in the service. It removes a file that the previous pin owned
// and the new commit no longer has. It never removes a file that the previous pin did not own.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCK_FILE, SHARED_DIR, isSafePath, parseLock, planSync, renderLock } from './lib.mjs';

function readCurrent(targetDir, path) {
  const full = join(targetDir, path);
  try {
    const info = lstatSync(full);
    // A symbolic link counts as missing, so the sync replaces it and does not write through it.
    if (info.isSymbolicLink() || !info.isFile()) return null;
    return readFileSync(full);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// source: { list(commit) -> paths relative to shared/, read(commit, path) -> Buffer, root? }
export function syncShared({ source, targetDir, commit, log = console.log }) {
  let info;
  try {
    info = statSync(targetDir);
  } catch {
    throw new Error(`${targetDir} is not a folder.`);
  }
  if (!info.isDirectory()) throw new Error(`${targetDir} is not a folder.`);
  try {
    statSync(join(targetDir, 'package.json'));
  } catch {
    throw new Error(`${targetDir} has no package.json. Give the path of a service repository.`);
  }
  if (source.root && realpathSync(source.root) === realpathSync(targetDir)) {
    throw new Error('The target is the source repository itself. Give the path of a service repository.');
  }

  const paths = source.list(commit);
  if (paths.length === 0) throw new Error(`The commit ${commit} has no file under ${SHARED_DIR}/.`);
  for (const path of paths) {
    if (!isSafePath(path)) throw new Error(`Unsafe path in the list of shared files: ${JSON.stringify(path)}.`);
  }
  const wanted = new Map(paths.map((path) => [path, source.read(commit, path)]));

  // The files that the previous pin owned.
  let previousPaths = [];
  const lockPath = join(targetDir, LOCK_FILE);
  const lockInfo = (() => {
    try {
      return lstatSync(lockPath);
    } catch {
      return null;
    }
  })();
  if (lockInfo?.isFile()) {
    try {
      const previous = parseLock(readFileSync(lockPath, 'utf8'));
      if (previous.commit !== commit) previousPaths = source.list(previous.commit);
    } catch (error) {
      log(`Could not read the files of the previous pin, so no file is removed: ${error.message}`);
    }
  }

  const current = new Map();
  for (const path of new Set([...wanted.keys(), ...previousPaths])) {
    if (isSafePath(path)) current.set(path, readCurrent(targetDir, path));
  }
  const plan = planSync({ wanted, current, previousPaths });

  for (const path of plan.write) {
    const full = join(targetDir, path);
    mkdirSync(dirname(full), { recursive: true });
    rmSync(full, { force: true });
    writeFileSync(full, wanted.get(path));
  }
  for (const path of plan.remove) rmSync(join(targetDir, path), { force: true });
  writeFileSync(lockPath, renderLock(commit));

  log(`Synced ${targetDir} to lab-workflows ${commit}.`);
  log(`  written: ${plan.write.length}, unchanged: ${plan.unchanged.length}, removed: ${plan.remove.length}`);
  for (const path of plan.write) log(`  + ${path}`);
  for (const path of plan.remove) log(`  - ${path}`);
  return { commit, written: plan.write, unchanged: plan.unchanged, removed: plan.remove };
}

// ---------------------------------------------------------------------------------------------------------------------
// the real source: a clone of lab-workflows
// ---------------------------------------------------------------------------------------------------------------------

export function gitSource(root) {
  const git = (args, options = {}) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  return {
    root,
    resolve(ref) {
      try {
        return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
      } catch {
        throw new Error(`${JSON.stringify(ref)} is not a commit of this clone. Run git fetch, or give a commit that exists.`);
      }
    },
    latest() {
      try {
        git(['fetch', '--quiet', 'origin', 'main']);
      } catch (error) {
        console.log(`Warning: git fetch failed, so origin/main may be old: ${String(error.stderr || error.message).trim()}`);
      }
      return this.resolve('origin/main');
    },
    list(commit) {
      const output = git(['ls-tree', '-r', '-z', '--name-only', commit, '--', `${SHARED_DIR}/`], { encoding: 'utf8' });
      return output
        .split('\0')
        .filter(Boolean)
        .map((path) => path.slice(SHARED_DIR.length + 1));
    },
    read(commit, path) {
      return git(['show', `${commit}:${SHARED_DIR}/${path}`]);
    },
  };
}

const USAGE = 'Usage: node actions/shared-files/sync.mjs <path to the service repository> [commit]';

export function main(argv, { source, log = console.log } = {}) {
  const [target, ref, ...extra] = argv;
  if (!target || extra.length > 0 || target.startsWith('-')) {
    log(USAGE);
    return 2;
  }
  try {
    const sourceOfFiles = source ?? gitSource(execFileSync('git', ['-C', dirname(fileURLToPath(import.meta.url)), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
    const commit = ref ? sourceOfFiles.resolve(ref) : sourceOfFiles.latest();
    syncShared({ source: sourceOfFiles, targetDir: resolve(target), commit, log });
    return 0;
  } catch (error) {
    log(`Error: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
