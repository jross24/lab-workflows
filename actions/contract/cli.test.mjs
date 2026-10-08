// Tests for release.mjs and cli.mjs. Run them with: node --test actions/contract/cli.test.mjs
// The tests use a fake `gh` that keeps the releases of some repositories in memory. They call no API.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runPrCheck, validateFile } from './cli.mjs';
import { fetchAsset, findProductionRelease, repositoryOf, versionOf } from './release.mjs';

const CLI = join(import.meta.dirname, 'cli.mjs');
const fixture = (name) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const contractDoc = () => JSON.parse(fixture('contract-core.json'));
const expectationsDoc = () => JSON.parse(fixture('expectations-catalogue.json'));
const listItem = (doc) => doc.endpoints['GET /items'].responses['200'].properties.items.items;
// Removes the field items[].name from a contract, and from the list of required fields, so the file stays valid.
function dropName(doc) {
  const item = listItem(doc);
  delete item.properties.name;
  item.required = item.required.filter((name) => name !== 'name');
}

const CORE = 'jross24/lab-svc-core';
const CATALOGUE = 'jross24/lab-svc-catalogue';
const ACCOUNT = 'jross24/lab-svc-account';
const MARKER = 'deployed-production.json';

// ---------------------------------------------------------------------------------------------------------------------
// A fake GitHub
// ---------------------------------------------------------------------------------------------------------------------

let nextId = 100;
const asset = (name, content, updatedAt, state = 'uploaded') => ({ id: nextId++, name, state, updated_at: updatedAt, content });
const release = (tag, assets, { draft = false } = {}) => ({ id: nextId++, tag_name: tag, draft, assets });
const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

// A release that runs in Production: it has the marker, and the files that the test gives.
function live(tag, files, at = '2026-10-08T10:00:00Z') {
  return release(tag, [...Object.entries(files).map(([name, content]) => asset(name, text(content), at)), asset(MARKER, '{}', at)]);
}

// repos maps "owner/name" to a list of releases. Labels map "owner/name#number" to a list of label names.
// The fake returns the releases in pages of pageSize, like `gh api --paginate --slurp`.
function fakeGh(repos, { labels = {}, pageSize = 2 } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const url = args.find((arg) => arg.startsWith('repos/')) ?? '';
    let match = /^repos\/([^/]+\/[^/]+)\/releases\?per_page=100$/.exec(url);
    if (match) {
      assert.ok(args.includes('--paginate') && args.includes('--slurp'), 'the listing must paginate');
      if (!repos[match[1]]) throw new Error('gh: Not Found (HTTP 404)');
      const all = repos[match[1]].map(({ content, ...rest }) => ({ ...rest, assets: rest.assets.map(({ content: _c, ...a }) => a) }));
      const pages = [];
      for (let i = 0; i < all.length; i += pageSize) pages.push(all.slice(i, i + pageSize));
      return JSON.stringify(pages.length > 0 ? pages : [[]]);
    }
    match = /^repos\/([^/]+\/[^/]+)\/releases\/assets\/(\d+)$/.exec(url);
    if (match) {
      assert.ok(args.includes('Accept: application/octet-stream'), 'an asset needs the octet-stream header');
      const found = (repos[match[1]] ?? []).flatMap((r) => r.assets).find((a) => a.id === Number(match[2]));
      if (!found) throw new Error('gh: Not Found (HTTP 404)');
      return found.content;
    }
    match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels$/.exec(url);
    if (match) return JSON.stringify([(labels[`${match[1]}#${match[2]}`] ?? []).map((name) => ({ name }))]);
    throw new Error(`unexpected call ${args.join(' ')}`);
  };
  gh.calls = calls;
  gh.called = (pattern) => calls.some((args) => args.join(' ').includes(pattern));
  return gh;
}

// ---------------------------------------------------------------------------------------------------------------------
// repositoryOf, findProductionRelease, fetchAsset
// ---------------------------------------------------------------------------------------------------------------------

describe('repositoryOf', () => {
  it('names lab-web for web and lab-svc-<name> for the others', () => {
    assert.equal(repositoryOf('web'), 'lab-web');
    assert.equal(repositoryOf('core'), 'lab-svc-core');
    assert.equal(repositoryOf('catalogue'), 'lab-svc-catalogue');
  });
});

describe('versionOf', () => {
  it('takes the version from the tag', () => {
    assert.equal(versionOf({ tag_name: 'v0.8.0' }), '0.8.0');
    assert.equal(versionOf({ tag_name: '0.8.0' }), '0.8.0');
  });
});

describe('findProductionRelease', () => {
  const at = (hour) => `2026-10-08T${hour}:00:00Z`;

  it('returns null when no release has the marker', () => {
    const gh = fakeGh({ [CORE]: [release('v0.8.0', [asset('contract.json', '{}', at('09'))])] });
    assert.equal(findProductionRelease(CORE, gh), null);
  });

  it('returns null for a repository without releases', () => {
    assert.equal(findProductionRelease(CORE, fakeGh({ [CORE]: [] })), null);
  });

  it('picks the release with the newest marker', () => {
    const gh = fakeGh({ [CORE]: [live('v0.9.0', {}, at('12')), live('v0.8.0', {}, at('10')), live('v0.7.0', {}, at('08'))] });
    assert.equal(findProductionRelease(CORE, gh).tag_name, 'v0.9.0');
  });

  it('picks an older release when its marker is newer (a redeploy went back)', () => {
    const gh = fakeGh({ [CORE]: [live('v0.9.0', {}, at('12')), live('v0.8.0', {}, at('14'))] });
    assert.equal(findProductionRelease(CORE, gh).tag_name, 'v0.8.0');
  });

  it('skips a release without the marker, even when it is the newest', () => {
    const gh = fakeGh({ [CORE]: [release('v0.9.0', []), live('v0.8.0', {}, at('10'))] });
    assert.equal(findProductionRelease(CORE, gh).tag_name, 'v0.8.0');
  });

  it('skips a draft release', () => {
    const draft = release('v0.9.0', [asset(MARKER, '{}', at('12'))], { draft: true });
    const gh = fakeGh({ [CORE]: [draft, live('v0.8.0', {}, at('10'))] });
    assert.equal(findProductionRelease(CORE, gh).tag_name, 'v0.8.0');
  });

  it('skips a marker whose upload did not finish', () => {
    const half = release('v0.9.0', [asset(MARKER, '', at('12'), 'starter')]);
    const gh = fakeGh({ [CORE]: [half, live('v0.8.0', {}, at('10'))] });
    assert.equal(findProductionRelease(CORE, gh).tag_name, 'v0.8.0');
  });

  it('reads every page of the listing', () => {
    const releases = [live('v0.5.0', {}, at('05')), live('v0.4.0', {}, at('04')), live('v0.3.0', {}, at('03')), live('v0.6.0', {}, at('23'))];
    const gh = fakeGh({ [CORE]: releases }, { pageSize: 1 });
    assert.equal(findProductionRelease(CORE, gh).tag_name, 'v0.6.0');
  });

  it('uses the same rule for another asset name', () => {
    const gh = fakeGh({ [CORE]: [release('v0.8.0', [asset('tested-with.json', '{}', at('09'))])] });
    assert.equal(findProductionRelease(CORE, gh, 'tested-with.json').tag_name, 'v0.8.0');
  });

  it('lets an error of gh through', () => {
    assert.throws(() => findProductionRelease('jross24/none', fakeGh({})), /Not Found/);
  });
});

describe('fetchAsset', () => {
  it('downloads the asset by its id with the octet-stream header', () => {
    const gh = fakeGh({ [CORE]: [live('v0.8.0', { 'contract.json': '{"a":1}' })] });
    const found = findProductionRelease(CORE, gh);
    assert.equal(fetchAsset(CORE, found, 'contract.json', gh), '{"a":1}');
    const call = gh.calls.at(-1);
    assert.deepEqual(call.slice(0, 3), ['api', '-H', 'Accept: application/octet-stream']);
    assert.match(call[3], /^repos\/jross24\/lab-svc-core\/releases\/assets\/\d+$/);
  });

  it('returns null when the release has no such asset, and calls nothing', () => {
    const gh = fakeGh({ [CORE]: [live('v0.8.0', {})] });
    const found = findProductionRelease(CORE, gh);
    const before = gh.calls.length;
    assert.equal(fetchAsset(CORE, found, 'contract.json', gh), null);
    assert.equal(gh.calls.length, before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// pr-check
// ---------------------------------------------------------------------------------------------------------------------

function workspace(files) {
  const dir = mkdtempSync(join(tmpdir(), 'contract-test-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), text(content));
  return dir;
}

function run({ repo = CORE, files, repos = {}, labels = {}, pr = '7', env = {} }) {
  const gh = fakeGh(repos, { labels });
  const lines = [];
  const result = runPrCheck({
    cwd: workspace(files),
    env: { GITHUB_REPOSITORY: repo, PR_NUMBER: pr, GH_TOKEN: 'x', ...env },
    gh,
    log: (line) => lines.push(line),
  });
  return { result, lines, gh, summary: result.summary };
}

const CORE_FILES = () => ({ 'contract.json': contractDoc(), 'pipeline.json': fixture('pipeline-core.json') });
const CATALOGUE_FILES = () => ({ 'expectations.json': expectationsDoc(), 'pipeline.json': fixture('pipeline-catalogue.json') });

// Core in Production holds the example contract. Catalogue in Production holds the example expectations.
const productionRepos = (overrides = {}) => ({
  [CORE]: [live('v0.8.0', { 'contract.json': contractDoc() })],
  [CATALOGUE]: [live('v0.7.1', { 'expectations.json': expectationsDoc() })],
  [ACCOUNT]: [],
  ...overrides,
});

const errorsOf = (lines) => lines.filter((line) => line.startsWith('::error'));
const noticesOf = (lines) => lines.filter((line) => line.startsWith('::notice'));

describe('pr-check: no files', () => {
  it('writes a notice and passes when the repository has no contract file', () => {
    const { result, lines, gh, summary } = run({ files: { 'pipeline.json': fixture('pipeline-core.json') } });
    assert.equal(result.ok, true);
    assert.deepEqual(lines, [
      '::notice title=No contract files::This repository has no contract.json and no expectations.json. The contract check has nothing to do.',
    ]);
    assert.equal(gh.calls.length, 0);
    assert.match(summary, /nothing to check/i);
  });

  it('needs no pipeline.json when there is nothing to check', () => {
    assert.equal(run({ files: {} }).result.ok, true);
  });

  it('stops when GITHUB_REPOSITORY is not set', () => {
    assert.throws(() => runPrCheck({ cwd: workspace({}), env: {}, gh: fakeGh({}), log() {} }), /GITHUB_REPOSITORY/);
  });
});

describe('pr-check: the provider against its production contract', () => {
  it('passes when the contract did not change', () => {
    const { result, lines, summary } = run({ files: CORE_FILES(), repos: productionRepos() });
    assert.equal(result.ok, true, lines.join('\n'));
    assert.deepEqual(errorsOf(lines), []);
    assert.match(summary, /core 0\.8\.0/);
    assert.match(summary, /Passed/);
  });

  it('passes an additive change', () => {
    const files = CORE_FILES();
    const doc = contractDoc();
    listItem(doc).properties.color = { type: 'string' };
    doc.endpoints['GET /items'].request.optional.push('query:offset');
    files['contract.json'] = doc;
    assert.equal(run({ files, repos: productionRepos() }).result.ok, true);
  });

  it('notices that no release is recorded in Production, and passes', () => {
    const repos = productionRepos({ [CORE]: [release('v0.8.0', [asset('contract.json', text(contractDoc()), '2026-10-08T09:00:00Z')])] });
    const { result, lines } = run({ files: CORE_FILES(), repos });
    assert.equal(result.ok, true);
    assert.ok(
      lines.includes(
        '::notice title=No production release::No release of jross24/lab-svc-core is recorded in Production yet. ' +
          'No release has the asset deployed-production.json. The check skips the comparison with Production.',
      ),
      lines.join('\n'),
    );
  });

  it('notices a marker without a contract asset, and passes', () => {
    const repos = productionRepos({ [CORE]: [live('v0.8.0', {})] });
    const { result, lines } = run({ files: CORE_FILES(), repos });
    assert.equal(result.ok, true);
    assert.ok(
      lines.includes(
        '::notice title=No contract in the production release::The release v0.8.0 of jross24/lab-svc-core runs in Production, ' +
          'but it has no asset contract.json. The check skips the comparison with Production.',
      ),
      lines.join('\n'),
    );
  });

  describe('B1 to B6', () => {
    const changes = {
      B1: (doc) => dropName(doc),
      B2: (doc) => (listItem(doc).properties.id.type = 'number'),
      B3: (doc) => (listItem(doc).required = ['id']),
      B4: (doc) => delete doc.endpoints['GET /items/{id}'].responses['404'],
      B5: (doc) => delete doc.endpoints['GET /items/{id}'],
      B6: (doc) => doc.endpoints['GET /items'].request.required.push('header:x-trace'),
    };

    for (const [rule, change] of Object.entries(changes)) {
      it(`${rule} fails the job, and the label lets it pass`, () => {
        const doc = contractDoc();
        change(doc);
        // Core has no consumer here, so only the comparison with Production can fail.
        doc.consumers = [];
        const files = { ...CORE_FILES(), 'contract.json': doc };
        const failed = run({ files, repos: productionRepos() });
        assert.equal(failed.result.ok, false);
        assert.equal(errorsOf(failed.lines).length, 1, failed.lines.join('\n'));
        assert.match(errorsOf(failed.lines)[0], new RegExp(`^::error title=Breaking change ${rule} `));
        assert.match(failed.summary, new RegExp(`\\| Failed \\| ${rule} \\|`));

        const approved = run({ files, repos: productionRepos(), labels: { [`${CORE}#7`]: ['breaking-change-approved'] } });
        assert.equal(approved.result.ok, true, approved.lines.join('\n'));
        assert.deepEqual(errorsOf(approved.lines), []);
        assert.match(approved.summary, new RegExp(`\\| Approved by label \\| ${rule} \\|`));
        assert.match(approved.summary, /approved by label|Approved by label/);
      });
    }
  });

  it('writes the message of B1 the way the README shows it', () => {
    const doc = contractDoc();
    dropName(doc);
    doc.consumers = [];
    const { lines } = run({ files: { ...CORE_FILES(), 'contract.json': doc }, repos: productionRepos() });
    assert.deepEqual(errorsOf(lines), [
      '::error title=Breaking change B1 (field removed)::GET /items 200: the field items[].name is in the production contract (core 0.8.0) ' +
        'but not in this pull request. A consumer may read it. Move the consumers to the new field and release them first. ' +
        'Then add the label breaking-change-approved to this pull request and run this job again.',
    ]);
  });

  it('reads the labels at the time it runs, so a re-run sees a new label', () => {
    const doc = contractDoc();
    dropName(doc);
    doc.consumers = [];
    const files = { ...CORE_FILES(), 'contract.json': doc };
    const labels = {};
    assert.equal(run({ files, repos: productionRepos(), labels }).result.ok, false);
    labels[`${CORE}#7`] = ['breaking-change-approved'];
    assert.equal(run({ files, repos: productionRepos(), labels }).result.ok, true);
  });

  it('does not read the labels when nothing breaks', () => {
    const { gh } = run({ files: CORE_FILES(), repos: productionRepos() });
    assert.equal(gh.called('/labels'), false);
  });

  it('does not accept another label', () => {
    const doc = contractDoc();
    dropName(doc);
    doc.consumers = [];
    const labels = { [`${CORE}#7`]: ['destructive-change-approved', 'breaking-change'] };
    assert.equal(run({ files: { ...CORE_FILES(), 'contract.json': doc }, repos: productionRepos(), labels }).result.ok, false);
  });

  it('cannot read a label without a pull request number, so the breaking change fails', () => {
    const doc = contractDoc();
    dropName(doc);
    doc.consumers = [];
    const { result, lines } = run({ files: { ...CORE_FILES(), 'contract.json': doc }, repos: productionRepos(), pr: '' });
    assert.equal(result.ok, false);
    assert.ok(noticesOf(lines).some((line) => /no pull request number/i.test(line)), lines.join('\n'));
  });

  it('uses the release with the newest marker', () => {
    const older = contractDoc();
    older.endpoints['GET /items'].responses['200'].properties.legacy = { type: 'string' };
    const repos = productionRepos({
      [CORE]: [
        live('v0.9.0', { 'contract.json': contractDoc() }, '2026-10-08T12:00:00Z'),
        live('v0.8.0', { 'contract.json': older }, '2026-10-08T10:00:00Z'),
      ],
    });
    // v0.9.0 is the newest marker. Against v0.9.0 the example contract has no change.
    assert.equal(run({ files: CORE_FILES(), repos }).result.ok, true);
    // After a redeploy of v0.8.0 its marker is the newest. Then "legacy" is in the production contract, and it is gone now.
    repos[CORE][1] = live('v0.8.0', { 'contract.json': older }, '2026-10-08T14:00:00Z');
    const { result, lines } = run({ files: CORE_FILES(), repos });
    assert.equal(result.ok, false);
    assert.match(errorsOf(lines)[0], /legacy.*core 0\.8\.0/);
  });
});

describe('pr-check: the consumers of a provider', () => {
  it('X2 fails the job, and the label does not help', () => {
    const doc = contractDoc();
    dropName(doc);
    listItem(doc).required = ['id'];
    const labels = { [`${CORE}#7`]: ['breaking-change-approved'] };
    const { result, lines, summary } = run({ files: { ...CORE_FILES(), 'contract.json': doc }, repos: productionRepos(), labels });
    assert.equal(result.ok, false);
    const errors = errorsOf(lines);
    assert.equal(errors.length, 1, lines.join('\n'));
    assert.equal(
      errors[0],
      '::error title=Consumer expects a field (X2)::catalogue 0.7.1 (in Production) expects GET /items 200: items[].name. ' +
        'The contract in this pull request does not have it. Release catalogue without that field first.',
    );
    assert.match(summary, /\| Approved by label \| B1 \|/);
    assert.match(summary, /\| Failed \| X2 \|/);
  });

  it('X1, X3, X4 and X5 fail the job', () => {
    const cases = {
      X1: (doc) => delete doc.endpoints['GET /items/{id}'],
      X3: (doc) => (listItem(doc).properties.name.type = 'number'),
      X4: (doc) => (listItem(doc).required = ['id']),
      X5: (doc) => doc.endpoints['GET /items'].request.required.push('query:page'),
    };
    for (const [rule, change] of Object.entries(cases)) {
      const doc = contractDoc();
      change(doc);
      // The label approves the B rules, so only the X rules are left.
      const labels = { [`${CORE}#7`]: ['breaking-change-approved'] };
      const { result, lines } = run({ files: { ...CORE_FILES(), 'contract.json': doc }, repos: productionRepos(), labels });
      assert.equal(result.ok, false, rule);
      assert.ok(errorsOf(lines).some((line) => line.includes(`(${rule})`)), `${rule}\n${lines.join('\n')}`);
    }
  });

  it('notices a consumer without a release in Production, and passes', () => {
    const { result, lines } = run({ files: CORE_FILES(), repos: productionRepos() });
    assert.equal(result.ok, true);
    assert.ok(
      lines.includes(
        '::notice title=No production release::No release of jross24/lab-svc-account is recorded in Production yet. The check skips account.',
      ),
      lines.join('\n'),
    );
  });

  it('notices a consumer without an expectations.json, and passes', () => {
    const repos = productionRepos({ [CATALOGUE]: [live('v0.7.1', {})] });
    const { result, lines } = run({ files: CORE_FILES(), repos });
    assert.equal(result.ok, true);
    assert.ok(
      lines.includes(
        '::notice title=No expectations in the production release::The release v0.7.1 of jross24/lab-svc-catalogue runs in Production, ' +
          'but it has no asset expectations.json. The consumer catalogue has published nothing, so the check skips it.',
      ),
      lines.join('\n'),
    );
  });

  it('checks the consumers even when core has no release in Production yet', () => {
    const doc = contractDoc();
    dropName(doc);
    listItem(doc).required = ['id'];
    const repos = productionRepos({ [CORE]: [] });
    const { result, lines } = run({ files: { ...CORE_FILES(), 'contract.json': doc }, repos });
    assert.equal(result.ok, false);
    assert.ok(errorsOf(lines).some((line) => line.includes('(X2)')));
    assert.ok(noticesOf(lines).some((line) => line.includes('No release of jross24/lab-svc-core')));
  });

  it('passes a consumer that expects nothing from this provider', () => {
    const other = expectationsDoc();
    other.expects = { account: other.expects.core };
    const repos = productionRepos({ [CATALOGUE]: [live('v0.7.1', { 'expectations.json': other })] });
    const { result, summary } = run({ files: CORE_FILES(), repos });
    assert.equal(result.ok, true);
    assert.match(summary, /expects nothing from core/);
  });

  it('skips a production expectations.json that is not valid, with a warning', () => {
    const repos = productionRepos({ [CATALOGUE]: [live('v0.7.1', { 'expectations.json': '{ not json' })] });
    const { result, lines } = run({ files: CORE_FILES(), repos });
    assert.equal(result.ok, true);
    assert.ok(lines.some((line) => line.startsWith('::warning title=Asset not valid::')), lines.join('\n'));
  });
});

describe('pr-check: the expectations of a consumer', () => {
  const catalogueRepos = (core) => ({ [CORE]: core });

  it('passes when the production contract of the provider keeps every promise', () => {
    const { result, summary } = run({
      repo: CATALOGUE,
      files: CATALOGUE_FILES(),
      repos: catalogueRepos([live('v0.8.0', { 'contract.json': contractDoc() })]),
    });
    assert.equal(result.ok, true);
    assert.match(summary, /core 0\.8\.0/);
  });

  it('X2 fails when the production contract does not have a field that the pull request needs', () => {
    const core = contractDoc();
    delete listItem(core).properties.name;
    listItem(core).required = ['id'];
    const { result, lines } = run({
      repo: CATALOGUE,
      files: CATALOGUE_FILES(),
      repos: catalogueRepos([live('v0.8.0', { 'contract.json': core })]),
      labels: { [`${CATALOGUE}#7`]: ['breaking-change-approved'] },
    });
    assert.equal(result.ok, false);
    assert.equal(
      errorsOf(lines)[0],
      '::error title=Expected field not in Production (X2)::This pull request expects GET /items 200 of core: items[].name. ' +
        'The production contract (core 0.8.0) does not have it. Release core with that field first. Or make the field optional in expectations.json.',
    );
  });

  it('notices a provider without a release in Production, and passes', () => {
    const { result, lines } = run({ repo: CATALOGUE, files: CATALOGUE_FILES(), repos: catalogueRepos([]) });
    assert.equal(result.ok, true);
    assert.ok(
      lines.includes('::notice title=No production release::No release of jross24/lab-svc-core is recorded in Production yet. The check skips core.'),
      lines.join('\n'),
    );
  });

  it('notices a provider whose production release has no contract.json, and passes', () => {
    const { result, lines } = run({ repo: CATALOGUE, files: CATALOGUE_FILES(), repos: catalogueRepos([live('v0.8.0', {})]) });
    assert.equal(result.ok, true);
    assert.ok(
      lines.includes(
        '::notice title=No contract in the production release::The release v0.8.0 of jross24/lab-svc-core runs in Production, ' +
          'but it has no asset contract.json. The check skips core.',
      ),
      lines.join('\n'),
    );
  });

  it('checks both parts in a repository that has both files', () => {
    const catalogueContract = {
      service: 'catalogue',
      consumers: ['web'],
      endpoints: { 'GET /products': { responses: { 200: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } } } } },
    };
    const web = { service: 'web', expects: { catalogue: { 'GET /products': { responses: { 200: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } } } } } } };
    const repos = {
      [CORE]: [live('v0.8.0', { 'contract.json': contractDoc() })],
      [CATALOGUE]: [live('v0.7.1', { 'contract.json': catalogueContract })],
      'jross24/lab-web': [live('v0.4.4', { 'expectations.json': web })],
    };
    const { result, summary } = run({
      repo: CATALOGUE,
      files: { ...CATALOGUE_FILES(), 'contract.json': catalogueContract },
      repos,
    });
    assert.equal(result.ok, true);
    assert.match(summary, /web 0\.4\.4/);
    assert.match(summary, /core 0\.8\.0/);
    assert.match(summary, /catalogue 0\.7\.1/);
  });
});

describe('pr-check: errors in the files', () => {
  it('fails on a file that is not JSON, names the file, and calls no API', () => {
    const { result, lines, gh } = run({ files: { 'contract.json': '{ "service": ', 'pipeline.json': fixture('pipeline-core.json') }, repos: productionRepos() });
    assert.equal(result.ok, false);
    assert.equal(gh.calls.length, 0);
    assert.match(errorsOf(lines)[0], /^::error file=contract\.json,title=Contract format error::contract\.json: \$: The file is not valid JSON/);
  });

  it('fails on an unsupported keyword and names the path in the file', () => {
    const doc = contractDoc();
    listItem(doc).properties.id.enum = ['a'];
    const { result, lines } = run({ files: { ...CORE_FILES(), 'contract.json': doc }, repos: productionRepos() });
    assert.equal(result.ok, false);
    assert.match(errorsOf(lines)[0], /contract\.json: \$\.endpoints\["GET \/items"\]\.responses\["200"\]\..*\.id\.enum: This is an unsupported keyword "enum"/);
  });

  it('fails when the service differs from the service of pipeline.json', () => {
    const files = { ...CORE_FILES(), 'pipeline.json': fixture('pipeline-catalogue.json') };
    const { result, lines } = run({ files, repos: productionRepos() });
    assert.equal(result.ok, false);
    assert.match(errorsOf(lines)[0], /contract\.json: \$\.service: The service is "core", but pipeline\.json has "catalogue"\./);
  });

  it('fails when pipeline.json is missing or has no service', () => {
    let { result, lines } = run({ files: { 'contract.json': contractDoc() }, repos: productionRepos() });
    assert.equal(result.ok, false);
    assert.match(errorsOf(lines)[0], /pipeline\.json/);
    ({ result, lines } = run({ files: { 'contract.json': contractDoc(), 'pipeline.json': '{}' }, repos: productionRepos() }));
    assert.equal(result.ok, false);
    assert.match(errorsOf(lines)[0], /pipeline\.json: \$\.service/);
  });

  it('fails on a bad expectations.json too', () => {
    const doc = expectationsDoc();
    doc.expects.core['GET /items'].sends.push('cookie:x');
    const { result, lines } = run({ repo: CATALOGUE, files: { ...CATALOGUE_FILES(), 'expectations.json': doc }, repos: {} });
    assert.equal(result.ok, false);
    assert.match(errorsOf(lines)[0], /^::error file=expectations\.json,title=Expectations format error::/);
  });

  it('reports the errors of both files in one run', () => {
    const files = { ...CORE_FILES(), 'contract.json': '[]', 'expectations.json': '[]' };
    const { lines } = run({ files, repos: {} });
    assert.equal(errorsOf(lines).length, 2);
  });
});

describe('pr-check: errors of the API', () => {
  it('fails, and says what to do, when gh cannot read the releases of a consumer', () => {
    const repos = productionRepos();
    delete repos[ACCOUNT];
    const { result, lines } = run({ files: CORE_FILES(), repos });
    assert.equal(result.ok, false);
    assert.match(errorsOf(lines)[0], /^::error title=Cannot read the releases::The check cannot read the releases of jross24\/lab-svc-account\. gh: Not Found \(HTTP 404\)\. /);
    assert.match(errorsOf(lines)[0], /Run this job again/);
  });

  it('skips a production contract that is not valid, with a warning', () => {
    const repos = productionRepos({ [CORE]: [live('v0.8.0', { 'contract.json': '{ "service": "core" }' })] });
    const { result, lines } = run({ files: CORE_FILES(), repos });
    assert.equal(result.ok, true);
    assert.ok(lines.some((line) => line.startsWith('::warning title=Asset not valid::')), lines.join('\n'));
  });
});

describe('pr-check: untrusted text', () => {
  it('cannot inject a workflow command through a field name', () => {
    const hostile = 'a\n::error::pwned\r\n::add-mask::x %0A';
    const old = contractDoc();
    old.endpoints['GET /items'].responses['200'].properties[hostile] = { type: 'string' };
    old.consumers = [];
    const doc = contractDoc();
    doc.consumers = [];
    const repos = productionRepos({ [CORE]: [live('v0.8.0', { 'contract.json': old })] });
    const { result, lines, summary } = run({ files: { ...CORE_FILES(), 'contract.json': doc }, repos });
    assert.equal(result.ok, false);
    assert.equal(errorsOf(lines).length, 1);
    for (const line of lines) {
      assert.equal(line.includes('\n'), false);
      assert.equal(line.includes('\r'), false);
      assert.equal(line.match(/::/g).length, 2, line);
      assert.match(line, /^::(error|notice|warning) /);
    }
    assert.match(errorsOf(lines)[0], /pwned/);
    assert.doesNotMatch(summary, /\n::/);
  });

  it('cannot inject a command through a format error in the pull request', () => {
    const doc = contractDoc();
    doc['x\n::error::pwned'] = 1;
    const { lines } = run({ files: { ...CORE_FILES(), 'contract.json': doc } });
    for (const line of lines) assert.equal(line.match(/::/g).length, 2, line);
    assert.equal(lines.length, 1);
  });

  it('cannot reach another repository through a service name', () => {
    const doc = contractDoc();
    doc.consumers = ['../orgs'];
    const { result, gh } = run({ files: { ...CORE_FILES(), 'contract.json': doc }, repos: productionRepos() });
    assert.equal(result.ok, false);
    assert.equal(gh.calls.length, 0);
  });
});

describe('pr-check as a process', () => {
  it('prints the notice and writes the job summary when the repository has no contract file', () => {
    const dir = workspace({});
    const summaryFile = join(dir, 'summary.md');
    writeFileSync(summaryFile, '');
    const result = spawnSync(process.execPath, [CLI, 'pr-check'], {
      cwd: dir,
      env: { ...process.env, GITHUB_REPOSITORY: CORE, GITHUB_STEP_SUMMARY: summaryFile },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^::notice title=No contract files::/);
    assert.match(readFileSync(summaryFile, 'utf8'), /### Contract check/);
  });

  it('exits with 2 and a message when GITHUB_REPOSITORY is not set', () => {
    const env = { ...process.env };
    delete env.GITHUB_REPOSITORY;
    const result = spawnSync(process.execPath, [CLI, 'pr-check'], { cwd: workspace({}), env, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /GITHUB_REPOSITORY/);
  });

  it('exits with 1 when the files have an error', () => {
    const dir = workspace({ 'contract.json': '[]', 'pipeline.json': fixture('pipeline-core.json') });
    const result = spawnSync(process.execPath, [CLI, 'pr-check'], {
      cwd: dir,
      env: { ...process.env, GITHUB_REPOSITORY: CORE },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^::error file=contract\.json/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------------------------------------------------

describe('validateFile', () => {
  const file = (name, content) => join(workspace({ [name]: content }), name);

  it('accepts the example contract and says what it is', () => {
    const result = validateFile(file('contract.json', contractDoc()));
    assert.deepEqual(result.errors, []);
    assert.equal(result.kind, 'contract');
    assert.match(result.summary, /contract of core with 2 endpoints/);
  });

  it('accepts the example expectations', () => {
    const result = validateFile(file('expectations.json', expectationsDoc()));
    assert.deepEqual(result.errors, []);
    assert.equal(result.kind, 'expectations');
    assert.match(result.summary, /expectations of catalogue/);
  });

  it('tells the kind from the content when the file has another name', () => {
    assert.equal(validateFile(file('x.json', contractDoc())).kind, 'contract');
    assert.equal(validateFile(file('y.json', expectationsDoc())).kind, 'expectations');
  });

  it('reports a file that is neither', () => {
    const result = validateFile(file('z.json', { hello: 1 }));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /contract.*expectations/);
  });

  it('checks the service against pipeline.json when the file is given', () => {
    const dir = workspace({ 'contract.json': contractDoc(), 'pipeline.json': fixture('pipeline-catalogue.json') });
    const result = validateFile(join(dir, 'contract.json'), { pipeline: join(dir, 'pipeline.json') });
    assert.match(result.errors[0].message, /"core".*"catalogue"/);
  });

  it('uses the pipeline.json next to the file', () => {
    const dir = workspace({ 'contract.json': contractDoc(), 'pipeline.json': fixture('pipeline-catalogue.json') });
    assert.equal(validateFile(join(dir, 'contract.json')).errors.length, 1);
  });

  it('reports a file that does not exist', () => {
    const result = validateFile(join(workspace({}), 'contract.json'));
    assert.match(result.errors[0].message, /cannot be read/);
  });
});

describe('validate as a process', () => {
  const validate = (...args) => spawnSync(process.execPath, [CLI, 'validate', ...args], { encoding: 'utf8' });

  it('exits with 0 for a good file', () => {
    const dir = workspace({ 'contract.json': contractDoc(), 'pipeline.json': fixture('pipeline-core.json') });
    const result = validate(join(dir, 'contract.json'));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /^OK contract\.json: contract of core with 2 endpoints/);
  });

  it('exits with 1 for a bad file and prints the path in the file', () => {
    const doc = contractDoc();
    listItem(doc).properties.id.pattern = 'x';
    const dir = workspace({ 'contract.json': doc });
    const result = validate(join(dir, 'contract.json'));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /contract\.json: \$\..*\.id\.pattern: This is an unsupported keyword "pattern"/);
  });

  it('exits with 2 without a file name', () => {
    assert.equal(validate().status, 2);
  });
});
