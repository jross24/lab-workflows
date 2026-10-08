#!/usr/bin/env node
// The commands of the contract check. They need no package, only Node 22. The README section "Contract tests" explains them.
//
//   node cli.mjs pr-check                          check the files of the working directory (the job `contracts` of pr.yml)
//   node cli.mjs validate <file> [pipeline.json]   check one contract.json or expectations.json
//
// pr-check reads GITHUB_REPOSITORY, PR_NUMBER and GH_TOKEN, and the files contract.json, expectations.json and
// pipeline.json in the working directory. It needs no AWS access. It reads releases and labels with `gh api`.
//
// lib.mjs holds the logic. release.mjs finds the release that runs in Production. This file reads files, calls `gh`,
// writes the messages and sets the exit code.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APPROVAL_LABEL,
  CONTRACT_FILE,
  EXPECTATIONS_FILE,
  MARKER_ASSET,
  annotation,
  cleanText,
  compareContracts,
  describeViolation,
  formatFileError,
  parseContract,
  parseExpectations,
  renderSummary,
  verifyExpectations,
} from './lib.mjs';
import { fetchAsset, findProductionRelease, repositoryOf, versionOf } from './release.mjs';

const PIPELINE_FILE = 'pipeline.json';
// GitHub shows 10 error annotations for a step. More lines only fill the log.
const MAX_FORMAT_ERRORS = 20;

class UsageError extends Error {}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// The first line of the error of `gh`, without a full stop at the end.
function reasonOf(error) {
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  const first = (stderr || String(error.message)).split('\n')[0];
  return cleanText(first).replace(/\.+$/, '');
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// pipeline.json: the name of the service
// ---------------------------------------------------------------------------------------------------------------------

// The contract check needs one thing from pipeline.json: the name of the service. The job `version` of release.yml
// checks the rest of the file.
function serviceOf(pipelineText) {
  if (pipelineText === undefined) {
    return { errors: [{ path: '$', message: 'The file is missing. The contract check reads the name of the service from it.' }] };
  }
  let doc;
  try {
    doc = JSON.parse(pipelineText.replace(/^﻿/, ''));
  } catch {
    return { errors: [{ path: '$', message: 'The file is not valid JSON.' }] };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { errors: [{ path: '$', message: 'The file must hold one JSON object.' }] };
  }
  if (typeof doc.service !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(doc.service)) {
    return { errors: [{ path: '$.service', message: 'The key "service" is required. It is a name with lower case letters, digits and hyphens.' }] };
  }
  return { service: doc.service, errors: [] };
}

// ---------------------------------------------------------------------------------------------------------------------
// pr-check
// ---------------------------------------------------------------------------------------------------------------------

// Runs the check and returns { ok, summary, checks, findings }. The lines for the log go to log().
//   cwd  the folder with the files of the pull request
//   env  GITHUB_REPOSITORY, PR_NUMBER (GH_TOKEN is read by gh itself)
//   gh   gh(args) runs `gh <args>` and returns the output text
export function runPrCheck({ cwd = '.', env, gh, log = console.log }) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new UsageError('GITHUB_REPOSITORY is not set, or it is not of the form owner/name.');
  }
  const owner = repo.split('/')[0];
  const pr = /^[0-9]+$/.test(env.PR_NUMBER ?? '') ? env.PR_NUMBER : '';

  let ok = true;
  const checks = [];
  const findings = [];
  const notice = (title, message) => log(annotation('notice', title, message));
  const warning = (title, message) => log(annotation('warning', title, message));
  const fail = (title, message, options) => {
    ok = false;
    log(annotation('error', title, message, options));
  };
  const finish = () => ({ ok, checks, findings, summary: renderSummary({ checks, findings }) });

  // --- Step 1: the files ---
  const contractText = readText(join(cwd, CONTRACT_FILE));
  const expectationsText = readText(join(cwd, EXPECTATIONS_FILE));
  if (contractText === undefined && expectationsText === undefined) {
    notice('No contract files', `This repository has no ${CONTRACT_FILE} and no ${EXPECTATIONS_FILE}. The contract check has nothing to do.`);
    checks.push({
      name: 'Contract files',
      result: 'Skipped',
      detail: `There is nothing to check: this repository has no ${CONTRACT_FILE} and no ${EXPECTATIONS_FILE}.`,
    });
    return finish();
  }

  // --- Step 2: the format of every file that exists ---
  const pipeline = serviceOf(readText(join(cwd, PIPELINE_FILE)));
  const service = pipeline.service;
  let contract;
  let expectations;
  const problems = [];
  for (const error of pipeline.errors) problems.push({ file: PIPELINE_FILE, title: 'Pipeline file error', error });
  if (contractText !== undefined) {
    const parsed = parseContract(contractText, { service });
    contract = parsed.doc;
    for (const error of parsed.errors) problems.push({ file: CONTRACT_FILE, title: 'Contract format error', error });
  }
  if (expectationsText !== undefined) {
    const parsed = parseExpectations(expectationsText, { service });
    expectations = parsed.doc;
    for (const error of parsed.errors) problems.push({ file: EXPECTATIONS_FILE, title: 'Expectations format error', error });
  }
  if (problems.length > 0) {
    for (const { file, title, error } of problems.slice(0, MAX_FORMAT_ERRORS)) fail(title, formatFileError(file, error), { file });
    if (problems.length > MAX_FORMAT_ERRORS) fail('More format errors', `${problems.length - MAX_FORMAT_ERRORS} more errors are not shown. Fix these and run this job again.`);
    for (const { file, error } of problems.slice(0, MAX_FORMAT_ERRORS)) {
      checks.push({ name: `Format of ${file}`, result: 'Failed', detail: `${error.path}: ${error.message}` });
    }
    return finish();
  }

  // --- The labels. The job reads them with the API at the time it runs, so a re-run sees a new label. ---
  let labels;
  const labelsOfPullRequest = () => {
    if (labels !== undefined) return labels;
    labels = [];
    if (pr === '') {
      notice('No pull request number', `The job has no pull request number, so it cannot read the labels. The label ${APPROVAL_LABEL} has no effect.`);
      return labels;
    }
    try {
      labels = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/labels`])).flat().map((label) => label.name);
    } catch (error) {
      fail('Cannot read the labels', `The check cannot read the labels of pull request ${pr}. ${reasonOf(error)}. Run this job again.`);
    }
    return labels;
  };

  // --- The release that runs in Production, and one of its files ---
  // Returns { doc, version } or { skip: <reason> }. It writes the notice or the error itself.
  const productionFile = ({ repoFull, assetName, parse, noRelease, noAsset }) => {
    let found;
    try {
      found = findProductionRelease(repoFull, gh);
    } catch (error) {
      fail(
        'Cannot read the releases',
        `The check cannot read the releases of ${repoFull}. ${reasonOf(error)}. Run this job again. If the name of the service is wrong, fix it in ${CONTRACT_FILE} or ${EXPECTATIONS_FILE}.`,
      );
      return { skip: 'The releases cannot be read.', failed: true };
    }
    if (found === null) {
      notice('No production release', noRelease);
      return { skip: 'No release is recorded in Production yet.' };
    }
    const version = versionOf(found);
    let text;
    try {
      text = fetchAsset(repoFull, found, assetName, gh);
    } catch (error) {
      fail(
        'Cannot read the asset',
        `The check cannot read the asset ${assetName} of the release ${found.tag_name} of ${repoFull}. ${reasonOf(error)}. Run this job again.`,
      );
      return { skip: 'The asset cannot be read.', failed: true };
    }
    if (text === null) {
      notice(noAsset.title, noAsset.message(found.tag_name));
      return { skip: `The release ${cleanText(found.tag_name)} has no ${assetName}.` };
    }
    const parsed = parse(text);
    if (parsed.errors.length > 0) {
      // The pull request cannot fix a file that was released. So this is a warning and not an error.
      const first = formatFileError(assetName, parsed.errors[0]);
      warning('Asset not valid', `The asset ${assetName} of the release ${found.tag_name} of ${repoFull} is not valid. ${first} The check skips it.`);
      return { skip: `The ${assetName} of release ${cleanText(found.tag_name)} is not valid.` };
    }
    return { doc: parsed.doc, version };
  };

  const noContractAsset = (repoFull, tail) => ({
    title: 'No contract in the production release',
    message: (tag) => `The release ${tag} of ${repoFull} runs in Production, but it has no asset ${CONTRACT_FILE}. ${tail}`,
  });

  // --- Step 3a and 3b: the contract against the contract that runs in Production ---
  if (contract !== undefined) {
    const own = productionFile({
      repoFull: repo,
      assetName: CONTRACT_FILE,
      parse: (text) => parseContract(text, { service }),
      noRelease: `No release of ${repo} is recorded in Production yet. No release has the asset ${MARKER_ASSET}. The check skips the comparison with Production.`,
      noAsset: noContractAsset(repo, 'The check skips the comparison with Production.'),
    });
    if (own.skip !== undefined) {
      checks.push({ name: 'This contract against Production', result: 'Skipped', detail: own.skip });
    } else {
      const violations = compareContracts(own.doc, contract);
      const count = plural(Object.keys(own.doc.endpoints).length, 'endpoint');
      if (violations.length === 0) {
        checks.push({ name: 'This contract against Production', result: 'Passed', detail: `${service} ${cleanText(own.version)}: ${count} compared. Nothing breaks.` });
      } else {
        const approved = labelsOfPullRequest().includes(APPROVAL_LABEL);
        for (const violation of violations) {
          const words = describeViolation(violation, { kind: 'breaking', service, version: own.version });
          findings.push({ status: approved ? 'approved' : 'failed', ...pick(words) });
          if (approved) notice(`Approved by label (${violation.rule})`, `${words.detail} The label ${APPROVAL_LABEL} is on this pull request.`);
          else fail(words.title, words.message);
        }
        checks.push({
          name: 'This contract against Production',
          result: approved ? 'Approved by label' : 'Failed',
          detail: `${service} ${cleanText(own.version)}: ${plural(violations.length, 'breaking change')}.`,
        });
      }
    }

    // --- Step 3c: the consumers that run in Production ---
    for (const consumer of contract.consumers ?? []) {
      const consumerRepo = `${owner}/${repositoryOf(consumer)}`;
      const found = productionFile({
        repoFull: consumerRepo,
        assetName: EXPECTATIONS_FILE,
        parse: (text) => parseExpectations(text, { service: consumer }),
        noRelease: `No release of ${consumerRepo} is recorded in Production yet. The check skips ${consumer}.`,
        noAsset: {
          title: 'No expectations in the production release',
          message: (tag) =>
            `The release ${tag} of ${consumerRepo} runs in Production, but it has no asset ${EXPECTATIONS_FILE}. The consumer ${consumer} has published nothing, so the check skips it.`,
        },
      });
      const name = `Consumer ${consumer} against this contract`;
      if (found.skip !== undefined) {
        checks.push({ name, result: 'Skipped', detail: found.skip });
        continue;
      }
      if (!Object.hasOwn(found.doc.expects, service)) {
        checks.push({ name, result: 'Passed', detail: `${consumer} ${cleanText(found.version)} expects nothing from ${service}.` });
        continue;
      }
      const violations = verifyExpectations(contract, found.doc, service);
      for (const violation of violations) {
        const words = describeViolation(violation, { kind: 'consumer', consumer, version: found.version });
        findings.push({ status: 'failed', ...pick(words) });
        fail(words.title, words.message);
      }
      const reads = plural(Object.keys(found.doc.expects[service]).length, 'endpoint');
      checks.push({
        name,
        result: violations.length === 0 ? 'Passed' : 'Failed',
        detail: `${consumer} ${cleanText(found.version)} (in Production) reads ${reads} of ${service}. ${plural(violations.length, 'problem')}.`,
      });
    }
  }

  // --- Step 4: the expectations against the contracts that run in Production ---
  if (expectations !== undefined) {
    for (const provider of Object.keys(expectations.expects)) {
      const providerRepo = `${owner}/${repositoryOf(provider)}`;
      const found = productionFile({
        repoFull: providerRepo,
        assetName: CONTRACT_FILE,
        parse: (text) => parseContract(text, { service: provider }),
        noRelease: `No release of ${providerRepo} is recorded in Production yet. The check skips ${provider}.`,
        noAsset: noContractAsset(providerRepo, `The check skips ${provider}.`),
      });
      const name = `These expectations against ${provider}`;
      if (found.skip !== undefined) {
        checks.push({ name, result: 'Skipped', detail: found.skip });
        continue;
      }
      const violations = verifyExpectations(found.doc, expectations, provider);
      for (const violation of violations) {
        const words = describeViolation(violation, { kind: 'provider', provider, version: found.version });
        findings.push({ status: 'failed', ...pick(words) });
        fail(words.title, words.message);
      }
      const reads = plural(Object.keys(expectations.expects[provider]).length, 'endpoint');
      checks.push({
        name,
        result: violations.length === 0 ? 'Passed' : 'Failed',
        detail: `${provider} ${cleanText(found.version)} (in Production): ${reads} compared. ${plural(violations.length, 'problem')}.`,
      });
    }
  }

  return finish();
}

// The fields of a described violation that the summary table needs.
function pick({ rule, where, field, detail, hint }) {
  return { rule, where, field, detail, hint };
}

// ---------------------------------------------------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------------------------------------------------

// Checks one file. The kind comes from the name of the file (contract.json or expectations.json), or from the content.
// pipeline is the path of a pipeline.json. If it is not given, the pipeline.json next to the file is used, if there is one.
// Returns { kind, errors, summary }.
export function validateFile(file, { pipeline } = {}) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { kind: undefined, errors: [{ path: '$', message: `The file cannot be read: ${reasonOf(error)}.` }], summary: '' };
  }

  let kind = { [CONTRACT_FILE]: 'contract', [EXPECTATIONS_FILE]: 'expectations' }[basename(file)];
  if (kind === undefined) {
    try {
      const doc = JSON.parse(text.replace(/^﻿/, ''));
      if (typeof doc === 'object' && doc !== null && 'endpoints' in doc) kind = 'contract';
      else if (typeof doc === 'object' && doc !== null && 'expects' in doc) kind = 'expectations';
    } catch {
      // parseContract reports the syntax error below, if the name tells the kind. Otherwise the message after this block does.
    }
  }
  if (kind === undefined) {
    return {
      kind,
      errors: [{ path: '$', message: 'The file is neither a contract nor expectations. A contract has the key "endpoints". Expectations have the key "expects".' }],
      summary: '',
    };
  }

  let service;
  const next = join(dirname(file), PIPELINE_FILE);
  const pipelinePath = pipeline ?? (existsSync(next) ? next : undefined);
  if (pipelinePath !== undefined) {
    const read = serviceOf(readText(pipelinePath));
    if (read.errors.length > 0 && pipeline !== undefined) return { kind, errors: read.errors.map((error) => ({ ...error, message: `${PIPELINE_FILE}: ${error.message}` })), summary: '' };
    service = read.service;
  }

  const { doc, errors } = (kind === 'contract' ? parseContract : parseExpectations)(text, { service });
  if (errors.length > 0) return { kind, errors, summary: '' };
  const summary =
    kind === 'contract'
      ? `contract of ${doc.service} with ${plural(Object.keys(doc.endpoints).length, 'endpoint')}`
      : `expectations of ${doc.service} for ${Object.keys(doc.expects).join(', ') || 'no provider'}`;
  return { kind, errors, summary };
}

// ---------------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------------

function realGh(args, input) {
  return execFileSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'pr-check': {
      try {
        const result = runPrCheck({ cwd: process.cwd(), env: process.env, gh: realGh });
        appendSummary(result.summary);
        return result.ok ? 0 : 1;
      } catch (error) {
        if (!(error instanceof UsageError)) throw error;
        console.error(error.message);
        return 2;
      }
    }
    case 'validate': {
      const [file, pipeline] = args;
      if (!file) {
        console.error('Usage: cli.mjs validate <file> [pipeline.json]');
        return 2;
      }
      const result = validateFile(file, { pipeline });
      if (result.errors.length > 0) {
        for (const error of result.errors.slice(0, 50)) console.log(cleanText(formatFileError(basename(file), error), 400));
        return 1;
      }
      console.log(`OK ${basename(file)}: ${result.summary}.`);
      return 0;
    }
    default:
      console.error('Usage: cli.mjs pr-check | validate <file> [pipeline.json]');
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
