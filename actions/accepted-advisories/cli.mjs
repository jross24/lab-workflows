#!/usr/bin/env node
// The commands that ci.yml and pr.yml call. They need no package, only Node.
//
//   node cli.mjs check [file]    fail when an entry is expired or incomplete (ci.yml of this repository)
//   node cli.mjs allowed [file]  write allow-ghsas=<ids> for the entries that apply today (the job dependencies of pr.yml)
//
// The default file is accepted-advisories.json in the root of this repository.
// The date of today comes from the environment variable TODAY (YYYY-MM-DD). The default is the UTC date of the clock.
// lib.mjs holds the rules. This file reads the file, prints and sets the exit code.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allowList, evaluate, parseList } from './lib.mjs';

const DEFAULT_FILE = fileURLToPath(new URL('../../accepted-advisories.json', import.meta.url));

// The text of a workflow command may not hold %, CR or LF as they are.
function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function setOutput(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
}

function today(env) {
  return env.TODAY || new Date().toISOString().slice(0, 10);
}

function load(file, env) {
  const { allowed, problems } = evaluate(parseList(readFileSync(file, 'utf8')), today(env));
  return { allowed, problems, date: today(env) };
}

function describe(entry) {
  return `${entry.id} (${entry.package}) is accepted until ${entry.expires}: ${entry.reason} Tracked in ${entry.issue}.`;
}

function main(argv, env = process.env) {
  const [command, file = DEFAULT_FILE] = argv;
  if (command !== 'check' && command !== 'allowed') {
    console.error('Usage: cli.mjs check [file] | allowed [file]');
    return 2;
  }
  let loaded;
  try {
    loaded = load(file, env);
  } catch (error) {
    console.log(`::error title=Accepted advisories::${escapeData(error.message)}`);
    return 1;
  }
  const { allowed, problems } = loaded;
  for (const entry of allowed) console.log(`::notice title=Accepted advisory::${escapeData(describe(entry))}`);
  if (command === 'check') {
    for (const problem of problems) console.log(`::error title=Accepted advisory::${escapeData(problem)}`);
    if (problems.length === 0) console.log(`The list holds ${allowed.length} accepted advisories. None is expired. Date: ${loaded.date}.`);
    return problems.length === 0 ? 0 : 1;
  }
  // allowed: an entry with a problem is left out. The dependency check then fails on its advisory again.
  for (const problem of problems) {
    console.log(`::warning title=Accepted advisory not applied::${escapeData(problem)}`);
  }
  setOutput('allow-ghsas', allowList(allowed));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
