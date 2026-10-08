#!/usr/bin/env node
// The commands of the check of the published parameters. They need no package, only Node 22 and the AWS CLI.
// The README section "Provider parameters" explains the check. actions/deploy/action.yml runs the two commands.
//
//   node cli.mjs snapshot --assembly <dir> --stage <Stage> --out <file>
//       Before the deployment. Finds the published parameters in the templates of the stage and writes their values to <file>.
//   node cli.mjs compare --before <file> --stage <Stage> [--contract contract.json]
//       After the deployment. Reads the values again and compares them. It writes the result to the job summary
//       (the file GITHUB_STEP_SUMMARY) and the annotations to the log.
//
// The commands NEVER fail. A warning about a stale consumer must not fail the deployment of a correct provider, and a
// check that cannot run must not either. In both cases the command writes a warning and returns 0.
//
// The role github-deploy has ssm:GetParameter and ssm:GetParameters on /lab/*, and no more. So the check cannot list the
// parameters of a path (ssm:GetParametersByPath). It takes the names from the templates of the release, and it reads them
// with get-parameters.
//
// lib.mjs holds the logic. This file reads and writes files, calls the AWS CLI and sets the exit code.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareSnapshots, consumersOf, isWatched, namesFromTemplates, parseName, renderResult } from './lib.mjs';

// get-parameters takes 10 names at most.
const CHUNK = 10;

// ---------------------------------------------------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------------------------------------------------

function runAws(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
}

// readWithAws(names, run) gives { name: value } for the names that exist. A name that does not exist is not in the result.
export function readWithAws(names, run = runAws) {
  const values = {};
  for (let index = 0; index < names.length; index += CHUNK) {
    const chunk = names.slice(index, index + CHUNK);
    const output = run(process.env.AWS_BIN || 'aws', ['ssm', 'get-parameters', '--names', ...chunk, '--output', 'json']);
    for (const entry of JSON.parse(output).Parameters ?? []) values[entry.Name] = entry.Value;
  }
  return values;
}

// The first line of an error, without an account ID. The error of AWS names the ARN of the caller, and the repository is public.
function reasonOf(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const first = (stderr || String(error?.message ?? error)).split('\n')[0];
  return first.replace(/\b\d{12}\b/g, '***').replace(/\.+$/, '');
}

function warning(message) {
  return `::warning title=Published parameters::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------------------------------------

function writeSnapshot(outFile, snapshot) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(snapshot));
}

export function runSnapshot({ assemblyDir, stage, outFile, read, log }) {
  const fail = (reason) => {
    log(warning(`The check of the published parameters cannot run. ${reason} The deployment goes on.`));
    writeSnapshot(outFile, { stage, names: [], values: {}, failed: reason });
  };
  try {
    const stageDir = join(assemblyDir, `assembly-${stage}`);
    if (!existsSync(stageDir)) {
      fail(`The folder assembly-${stage} is not in the cloud assembly.`);
      return;
    }
    const templates = readdirSync(stageDir)
      .filter((file) => file.endsWith('.template.json'))
      .map((file) => JSON.parse(readFileSync(join(stageDir, file), 'utf8')));
    const { names, skipped } = namesFromTemplates(templates);
    if (skipped > 0) {
      log(`::notice title=Published parameters::${plural(skipped, 'SSM parameter')} in the templates of ${stage} ha${skipped === 1 ? 's' : 've'} a name that is not a plain string. The check cannot read ${skipped === 1 ? 'it' : 'them'}.`);
    }
    let values = {};
    if (names.length > 0) {
      try {
        values = read(names);
      } catch (error) {
        fail(`The published parameters could not be read before the deployment: ${reasonOf(error)}.`);
        return;
      }
    }
    writeSnapshot(outFile, { stage, names, values });
    log(`Read ${plural(names.length, 'published parameter')} of ${stage} before the deployment (${Object.keys(values).length} with a value): ${names.join(', ') || 'none'}`);
  } catch (error) {
    fail(`The check failed: ${reasonOf(error)}.`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------------------------------------------------

function readJson(path) {
  if (!path || !existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function finish({ result, log, writeSummary }) {
  for (const annotation of result.annotations) log(annotation);
  writeSummary(result.summary);
}

export function runCompare({ beforeFile, stage, contractFile, read, writeSummary, log }) {
  const environment = stage.toLowerCase();
  const skip = (reason, service) => finish({ result: renderResult({ service, environment, skippedReason: reason }), log, writeSummary });
  try {
    const before = readJson(beforeFile);
    if (!before) {
      skip('The values before the deployment are not there.');
      return;
    }
    if (before.failed) {
      skip(before.failed);
      return;
    }
    const names = (before.names ?? []).filter(isWatched);
    const services = [...new Set(names.map((name) => parseName(name).service))];
    const contract = readJson(contractFile);
    const service = services.length > 0 ? services.join(', ') : contract?.service;

    let after;
    try {
      after = names.length > 0 ? read(names) : {};
    } catch (error) {
      skip(`The published parameters could not be read after the deployment: ${reasonOf(error)}.`, service);
      return;
    }

    const comparison = compareSnapshots(before.values ?? {}, after);
    const counts = `${comparison.changed.length} changed, ${comparison.added.length} new, ${comparison.removed.length} removed`;
    const changes = comparison.changed.length + comparison.added.length + comparison.removed.length;
    const label = service ? `published parameters of ${service} in ${environment}` : `published parameters in ${environment}`;
    log(`${label}: ${changes === 0 ? `no change (${comparison.unchanged.length} compared)` : counts}`);

    let consumers;
    let versions = {};
    if (comparison.changed.length > 0) {
      consumers = services.length === 1 ? consumersOf(contract, services[0]) : undefined;
      if (consumers?.length > 0) {
        try {
          const found = read(consumers.map((consumer) => `/lab/${consumer}/version`));
          versions = Object.fromEntries(consumers.map((consumer) => [consumer, found[`/lab/${consumer}/version`]]));
        } catch (error) {
          log(`::notice title=Published parameters::The versions of the consumers could not be read: ${reasonOf(error)}.`);
        }
      }
    }
    finish({ result: renderResult({ service, environment, comparison, consumers, versions }), log, writeSummary });
  } catch (error) {
    skip(`The check failed: ${reasonOf(error)}.`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key.startsWith('--') || index + 1 >= args.length) throw new Error(`Wrong argument "${key}".`);
    flags[key.slice(2)] = args[index + 1];
  }
  return flags;
}

function need(flags, ...keys) {
  for (const key of keys) {
    if (!flags[key]) throw new Error(`The argument --${key} is missing.`);
  }
}

// main(argv, env, deps) always returns 0. `deps` lets a test replace the AWS call and the log.
export function main(argv, env = process.env, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const read = deps.read ?? ((names) => readWithAws(names));
  const writeSummary = (text) => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
    else log(text);
  };
  try {
    const [command, ...rest] = argv;
    const flags = parseFlags(rest);
    if (command === 'snapshot') {
      need(flags, 'assembly', 'stage', 'out');
      runSnapshot({ assemblyDir: flags.assembly, stage: flags.stage, outFile: flags.out, read, log });
    } else if (command === 'compare') {
      need(flags, 'before', 'stage');
      runCompare({ beforeFile: flags.before, stage: flags.stage, contractFile: flags.contract, read, writeSummary, log });
    } else {
      throw new Error('The command must be snapshot or compare.');
    }
  } catch (error) {
    log(warning(`The check cannot run. ${reasonOf(error)} The deployment goes on.`));
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
