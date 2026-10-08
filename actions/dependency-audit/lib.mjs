// The rules of the scheduled dependency audit. This file has no I/O and does not read the clock.
//
// `npm audit --json` gives one entry for each vulnerable package. An entry lists its advisories in `via`.
// An item of `via` is an object when the advisory is about this package. It is a string, the name of another
// package, when the package is vulnerable only because it uses that package. Only the objects are findings:
// a string would count the same advisory again under each package that depends on the vulnerable one.

export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

// A GHSA id has three groups of four characters. GitHub uses only these characters.
const GHSA_IN_URL = /GHSA(?:-[2-9cfghjmpqrvwx]{4}){3}/i;

export function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
}

// fixAvailable of npm audit is true, false, or an object that names the package to update.
export function describeFix(fixAvailable) {
  if (fixAvailable === true) return 'run `npm audit fix`';
  if (fixAvailable && typeof fixAvailable === 'object') {
    const major = fixAvailable.isSemVerMajor ? ' (major change)' : '';
    return `update \`${fixAvailable.name}\` to ${fixAvailable.version}${major}`;
  }
  return 'no fix yet';
}

function advisoryId(advisory) {
  const match = GHSA_IN_URL.exec(String(advisory.url ?? ''));
  // The prefix is upper case and the three groups are lower case, as GitHub writes an id.
  if (match) return `GHSA${match[0].slice(4).toLowerCase()}`;
  return `ADVISORY-${advisory.source}`;
}

// Reads the text that `npm audit --json` wrote. Throws when the text is not a report, or when npm reports an error,
// so a failed audit never looks like a clean one.
export function parseAudit(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`The npm audit output is not valid JSON: ${error.message}`);
  }
  if (data && typeof data === 'object' && data.error) {
    const { code = 'error', summary = '' } = data.error;
    throw new Error(`npm audit failed (${code}): ${String(summary).trim()}`);
  }
  if (!data || typeof data !== 'object' || !data.vulnerabilities || typeof data.vulnerabilities !== 'object') {
    throw new Error('The npm audit output has no "vulnerabilities" field.');
  }
  const findings = [];
  const seen = new Set();
  for (const [name, vulnerability] of Object.entries(data.vulnerabilities)) {
    for (const advisory of vulnerability.via ?? []) {
      if (advisory === null || typeof advisory !== 'object') continue;
      const finding = {
        package: advisory.name ?? name,
        id: advisoryId(advisory),
        severity: advisory.severity ?? vulnerability.severity ?? 'info',
        title: String(advisory.title ?? ''),
        range: String(advisory.range ?? ''),
        url: String(advisory.url ?? ''),
        fix: describeFix(vulnerability.fixAvailable),
      };
      const dedupe = `${finding.package}:${finding.id}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      findings.push(finding);
    }
  }
  return findings;
}

export function findingKey(finding) {
  return `${finding.repo}:${finding.package}:${finding.id}`;
}

// acceptedIds: a Set of the ids that apply today (see actions/accepted-advisories). minSeverity: one of SEVERITIES.
// Returns { reported, accepted, belowThreshold }. reported holds the findings that need a person.
export function selectFindings({ repo, findings, acceptedIds, minSeverity }) {
  const floor = severityRank(minSeverity);
  if (floor === -1) throw new Error(`The minimum severity must be one of ${SEVERITIES.join(', ')}. Got ${JSON.stringify(minSeverity)}.`);
  const reported = [];
  const accepted = new Set();
  let belowThreshold = 0;
  for (const finding of findings) {
    if (severityRank(finding.severity) < floor) {
      belowThreshold += 1;
    } else if (acceptedIds.has(finding.id)) {
      accepted.add(finding.id);
    } else {
      const withRepo = { ...finding, repo };
      reported.push({ ...withRepo, key: findingKey(withRepo) });
    }
  }
  reported.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id) || a.package.localeCompare(b.package),
  );
  return { reported, accepted: [...accepted], belowThreshold };
}

// ---------------------------------------------------------------------------------------------------------------------
// text of the issue and of the comment
// ---------------------------------------------------------------------------------------------------------------------

function cell(text) {
  return String(text).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

function row(finding) {
  const advisory = finding.url ? `[${finding.id}](${finding.url})` : finding.id;
  return `| ${cell(finding.repo)} | ${cell(finding.package)} | ${advisory} | ${cell(finding.severity)} | ${cell(finding.title)} | ${cell(finding.fix)} |`;
}

function table(findings) {
  const head = '| Repository | Package | Advisory | Severity | Title | Fix (from npm) |\n| --- | --- | --- | --- | --- | --- |';
  return [head, ...findings.map(row)].join('\n');
}

function footer({ minSeverity, runUrl }) {
  const lines = [
    '**What to do.** Fix the dependency in a pull request of the repository. If no fixed version exists, add the advisory to `accepted-advisories.json` in jross24/lab-workflows.',
    'An entry there needs a reason, a tracking issue and an expiry date of 90 days at most. The audit skips an accepted advisory until its date.',
    '',
    `The audit runs each week on the default branch of each repository. It lists advisories of severity \`${minSeverity}\` or higher. It adds a comment here when a new finding appears. It does not repeat a finding that this issue already holds.`,
    'The issue is in this repository because the token of a workflow can write only to the repository of its run.',
  ];
  if (runUrl) lines.push('', `Run: ${runUrl}`);
  return lines.join('\n');
}

export function renderBody(findings, context) {
  return [
    `The scheduled \`npm audit\` found ${findings.length} ${findings.length === 1 ? 'advisory' : 'advisories'} that nobody accepted. It read the lockfile of the default branch of each repository.`,
    '',
    table(findings),
    '',
    footer(context),
  ].join('\n');
}

export function renderComment(fresh, all, context) {
  return [
    `The scheduled \`npm audit\` found ${fresh.length} new finding${fresh.length === 1 ? '' : 's'}.`,
    '',
    table(fresh),
    '',
    `All open findings (${all.length}):`,
    '',
    table(all),
    ...(context.runUrl ? ['', `Run: ${context.runUrl}`] : []),
  ].join('\n');
}
