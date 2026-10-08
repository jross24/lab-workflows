// Tests for lib.mjs. Run them with: node --test actions/dependency-audit/lib.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeFix, findingKey, parseAudit, renderBody, renderComment, selectFindings } from './lib.mjs';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('parseAudit', () => {
  it('turns each advisory of the report into one finding', () => {
    const findings = parseAudit(fixture('audit-brace-expansion.json'));
    assert.deepEqual(
      findings.map((finding) => finding.id).sort(),
      ['GHSA-6j4f-fj2g-mc7p', 'GHSA-q2hr-2g5m-vwhr', 'GHSA-qhr7-859c-m2p7'],
    );
    const moderate = findings.find((finding) => finding.id === 'GHSA-q2hr-2g5m-vwhr');
    assert.equal(moderate.package, 'brace-expansion');
    // The severity of the advisory, not the worst severity of the package.
    assert.equal(moderate.severity, 'moderate');
    assert.equal(moderate.range, '>=4.0.0 <5.0.12');
    assert.equal(moderate.url, 'https://github.com/advisories/GHSA-q2hr-2g5m-vwhr');
    assert.match(moderate.title, /Quadratic-time expansion/);
    assert.equal(moderate.fix, 'run `npm audit fix`');
  });

  it('counts an advisory once, under the package that it is about', () => {
    const findings = parseAudit(fixture('audit-transitive.json'));
    assert.deepEqual(
      findings.map((finding) => `${finding.package}:${finding.id}`).sort(),
      ['left-pad:ADVISORY-4242', 'minimatch:GHSA-3ppc-4f35-3m26'],
    );
  });

  it('names an advisory without a GHSA id by its npm number', () => {
    const leftPad = parseAudit(fixture('audit-transitive.json')).find((finding) => finding.package === 'left-pad');
    assert.equal(leftPad.id, 'ADVISORY-4242');
    assert.equal(leftPad.fix, 'no fix yet');
  });

  it('returns no finding for a clean report', () => {
    assert.deepEqual(parseAudit(fixture('audit-clean.json')), []);
  });

  it('throws the summary of an npm error, so the run does not look clean', () => {
    assert.throws(() => parseAudit(fixture('audit-error.json')), /ENOTFOUND/);
  });

  it('throws for text that is not an audit report', () => {
    assert.throws(() => parseAudit('not json'), /not valid JSON/);
    assert.throws(() => parseAudit('{"hello": 1}'), /no "vulnerabilities"/);
    assert.throws(() => parseAudit(''), /not valid JSON/);
  });

  it('ignores the same advisory when it is listed twice for one package', () => {
    const report = JSON.parse(fixture('audit-brace-expansion.json'));
    report.vulnerabilities['brace-expansion'].via.push(report.vulnerabilities['brace-expansion'].via[0]);
    assert.equal(parseAudit(JSON.stringify(report)).length, 3);
  });
});

describe('describeFix', () => {
  it('describes the shapes of fixAvailable', () => {
    assert.equal(describeFix(true), 'run `npm audit fix`');
    assert.equal(describeFix(false), 'no fix yet');
    assert.equal(describeFix({ name: 'glob', version: '11.0.0', isSemVerMajor: true }), 'update `glob` to 11.0.0 (major change)');
    assert.equal(describeFix({ name: 'glob', version: '10.5.0', isSemVerMajor: false }), 'update `glob` to 10.5.0');
    assert.equal(describeFix(undefined), 'no fix yet');
  });
});

describe('selectFindings', () => {
  const findings = parseAudit(fixture('audit-brace-expansion.json'));

  it('drops the accepted advisories and counts them', () => {
    const result = selectFindings({
      repo: 'lab-web',
      findings,
      acceptedIds: new Set(['GHSA-6j4f-fj2g-mc7p', 'GHSA-qhr7-859c-m2p7']),
      minSeverity: 'moderate',
    });
    assert.deepEqual(
      result.reported.map((finding) => finding.id),
      ['GHSA-q2hr-2g5m-vwhr'],
    );
    assert.deepEqual(result.accepted.sort(), ['GHSA-6j4f-fj2g-mc7p', 'GHSA-qhr7-859c-m2p7']);
    assert.equal(result.belowThreshold, 0);
  });

  it('drops a finding below the minimum severity and counts it', () => {
    const result = selectFindings({ repo: 'lab-web', findings, acceptedIds: new Set(), minSeverity: 'high' });
    assert.deepEqual(
      result.reported.map((finding) => finding.id).sort(),
      ['GHSA-6j4f-fj2g-mc7p', 'GHSA-qhr7-859c-m2p7'],
    );
    assert.equal(result.belowThreshold, 1);
  });

  it('adds the repository to each finding, and gives each a key', () => {
    const [first] = selectFindings({ repo: 'lab-web', findings, acceptedIds: new Set(), minSeverity: 'low' }).reported;
    assert.equal(first.repo, 'lab-web');
    assert.equal(first.key, findingKey(first));
    assert.equal(first.key, `lab-web:brace-expansion:${first.id}`);
  });

  it('orders the findings by severity, then by id', () => {
    const result = selectFindings({ repo: 'lab-web', findings, acceptedIds: new Set(), minSeverity: 'low' });
    assert.deepEqual(
      result.reported.map((finding) => finding.id),
      ['GHSA-6j4f-fj2g-mc7p', 'GHSA-qhr7-859c-m2p7', 'GHSA-q2hr-2g5m-vwhr'],
    );
  });

  it('refuses a minimum severity that does not exist', () => {
    assert.throws(() => selectFindings({ repo: 'x', findings, acceptedIds: new Set(), minSeverity: 'severe' }), /severity/);
  });
});

describe('rendering', () => {
  const pick = (repo, name) =>
    selectFindings({ repo, findings: parseAudit(fixture(name)), acceptedIds: new Set(), minSeverity: 'moderate' }).reported;
  const all = [...pick('lab-web', 'audit-brace-expansion.json'), ...pick('lab-flags', 'audit-transitive.json')];

  it('shows one table row for each finding, with a link to the advisory', () => {
    const body = renderBody(all, { minSeverity: 'moderate' });
    assert.match(body, /\| lab-web \| brace-expansion \| \[GHSA-q2hr-2g5m-vwhr\]\(https:\/\/github\.com\/advisories\/GHSA-q2hr-2g5m-vwhr\) \| moderate \|/);
    assert.match(body, /\| lab-flags \| minimatch \| \[GHSA-3ppc-4f35-3m26\]/);
    assert.equal(body.split('\n').filter((line) => line.startsWith('| lab-')).length, all.length);
  });

  it('says how to resolve a finding, and names the accepted list', () => {
    const body = renderBody(all, { minSeverity: 'moderate' });
    assert.match(body, /accepted-advisories\.json/);
    assert.match(body, /moderate/);
  });

  it('cannot break the table with a pipe or a line break in an advisory title', () => {
    const odd = [{ ...all[0], title: 'a | b\nc' }];
    const row = renderBody(odd, { minSeverity: 'low' })
      .split('\n')
      .find((line) => line.startsWith('| lab-'));
    assert.ok(row);
    assert.match(row, /a \\\| b c/);
  });

  it('puts the new findings first in a comment, then the complete list', () => {
    const [fresh] = all;
    const comment = renderComment([fresh], all, { minSeverity: 'moderate' });
    assert.match(comment, /1 new finding/);
    const newIndex = comment.indexOf(fresh.id);
    const listIndex = comment.indexOf('All open findings');
    assert.ok(newIndex !== -1 && listIndex > newIndex);
  });
});
