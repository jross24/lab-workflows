// The logic of the check of the published parameters. The README section "Provider parameters" explains the check.
//
// A service publishes SSM parameters for its consumers, for example /lab/core/url. CloudFormation reads them when it
// deploys a consumer. If the provider gets a new value, a consumer that is already deployed keeps the old one.
// The check reads the values before and after the deployment of a provider. If a value changed, it tells the person.
//
// This file has no side effect: no AWS call, no file, no output. cli.mjs does those.

// A parameter name has the form /lab/<service>/<key>. The key may hold more parts, for example state/show-discounts.
// The pattern also keeps a character that could break a log line or an annotation out of every message.
const NAME = /^\/lab\/([a-z][a-z0-9-]*)\/([A-Za-z0-9_.\-/]+)$/;
const SERVICE = /^[a-z][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;

// The keys that are NOT published for a consumer. No consumer stack reads them when it deploys:
//   version              every release changes it, and the consumers do not read it. The preflight check reads it.
//   min-rollback-version the migration step of the service writes it. Only the preflight check reads it.
//   state/<flag>         the flags stack writes the declared state of a flag for the E2E suite. A consumer reads
//                        the flag at run time from AppConfig.
// A change of one of these is normal, and a warning would be a false alarm.
const IGNORED_KEYS = new Set(['version', 'min-rollback-version']);
const IGNORED_PREFIXES = ['state/'];

export function parseName(name) {
  if (typeof name !== 'string') return undefined;
  const match = NAME.exec(name);
  return match ? { service: match[1], key: match[2] } : undefined;
}

export function isWatched(name) {
  const parsed = parseName(name);
  if (!parsed) return false;
  if (IGNORED_KEYS.has(parsed.key)) return false;
  return !IGNORED_PREFIXES.some((prefix) => parsed.key.startsWith(prefix));
}

// namesFromTemplates(templates)
// Takes the parsed CloudFormation templates of one stage. Gives the watched names of their AWS::SSM::Parameter resources.
// A name that is not a plain string (for example Fn::Join) cannot be read, so the result counts it in `skipped`.
export function namesFromTemplates(templates) {
  const names = new Set();
  let skipped = 0;
  for (const template of templates) {
    for (const resource of Object.values(template?.Resources ?? {})) {
      if (resource?.Type !== 'AWS::SSM::Parameter') continue;
      const name = resource.Properties?.Name;
      if (typeof name !== 'string') {
        skipped += 1;
      } else if (isWatched(name)) {
        names.add(name);
      }
    }
  }
  return { names: [...names].sort(), skipped };
}

// compareSnapshots(before, after)
// Both arguments map a parameter name to its value. A name that is not in a map had no value then.
//   changed    in both, with different values. This is the case that makes a consumer stale.
//   added      only after. This is a new parameter or the first deployment of the service. No consumer holds an old value.
//   removed    only before.
//   unchanged  in both, with the same value.
// The version and the other ignored names are left out of every list.
export function compareSnapshots(before, after) {
  const result = { changed: [], added: [], removed: [], unchanged: [] };
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of [...names].filter(isWatched).sort()) {
    const had = Object.hasOwn(before, name);
    const has = Object.hasOwn(after, name);
    if (had && has) result[before[name] === after[name] ? 'unchanged' : 'changed'].push(name);
    else if (has) result.added.push(name);
    else result.removed.push(name);
  }
  return result;
}

// consumersOf(contract, service)
// Reads the list `consumers` of contract.json (see "Contract tests" in the README). Gives nothing if the file is not
// there, belongs to another service, or has no list.
export function consumersOf(contract, service) {
  if (!contract || contract.service !== service || !Array.isArray(contract.consumers)) return undefined;
  return contract.consumers.filter((name) => typeof name === 'string' && SERVICE.test(name));
}

// The lab names the repository of a service lab-svc-<name>, except for web and flags. preflight.sh has the same rule.
export function repositoryOf(service) {
  if (service === 'web') return 'lab-web';
  if (service === 'flags') return 'lab-flags';
  return `lab-svc-${service}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function codeList(names) {
  return names.map((name) => `\`${name}\``).join(', ');
}

function quote(lines) {
  return lines.map((line) => (line === '' ? '>' : `> ${line}`));
}

// The data of a workflow command must not hold %, CR or LF.
function annotationData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// One sentence for each consumer: the cure.
function cureLines(service, environment, consumers, versions) {
  if (consumers === undefined || consumers.length === 0) {
    return [
      `The contract.json of ${service} does not list its consumers. Redeploy each service that has ${service} in \`requires\` of its pipeline.json to ${environment}, with its \`redeploy\` workflow.`,
    ];
  }
  return consumers.map((consumer) => {
    const version = VERSION.test(versions?.[consumer] ?? '') ? ` ${versions[consumer]}` : '';
    return `Redeploy ${consumer}${version} to ${environment} with its \`redeploy\` workflow (repository ${repositoryOf(consumer)}).`;
  });
}

// renderResult({ service, environment, comparison, consumers, versions, skippedReason })
// Gives { summary, annotations }. The summary is Markdown for the job summary. Each annotation is a workflow command.
// The text holds names, never values. A value can be an ARN with the account ID in it, and the repository is public.
export function renderResult({ service, environment, comparison, consumers, versions, skippedReason }) {
  const heading = service ? `### Published parameters of ${service} in ${environment}` : `### Published parameters in ${environment}`;
  if (skippedReason) {
    return {
      summary: [
        heading,
        '',
        ...quote(['[!NOTE]', `The check did not run. ${skippedReason} The deployment itself is not affected.`]),
        '',
      ].join('\n'),
      annotations: [
        `::warning title=Published parameters::${annotationData(`The check of the published parameters${service ? ` of ${service}` : ''} did not run. ${skippedReason}`)}`,
      ],
    };
  }

  const lines = [heading, ''];
  const annotations = [];
  const { changed, added, removed, unchanged } = comparison;

  if (changed.length > 0) {
    const cure = cureLines(service, environment, consumers, versions);
    const generic = !consumers || consumers.length === 0;
    lines.push(
      ...quote([
        '[!WARNING]',
        `**${service} has a new value for ${plural(changed.length, 'published parameter')} in ${environment}.** The deployment of ${service} is correct, and this job did not fail.`,
        '',
        `Changed: ${codeList(changed)}.`,
        '',
        'A consumer reads a published parameter when CloudFormation deploys the consumer. It does not read it when it runs. So each consumer keeps the old value until its next deployment.',
        '',
        ...(generic ? cure : ['Do this for each consumer:', '', ...cure.map((line) => `- ${line}`)]),
      ]),
      '',
    );
    annotations.push(
      `::warning title=Provider parameter changed::${annotationData(
        `${service} has a new value in ${environment} for ${changed.join(', ')}. A consumer reads a published parameter only when it is deployed, so it keeps the old value. ${cure.join(' ')}`,
      )}`,
    );
  }

  if (removed.length > 0) {
    lines.push(
      ...quote([
        '[!NOTE]',
        `${service} no longer publishes ${codeList(removed)} in ${environment}. A consumer that is deployed keeps the old value. Its next deployment fails, because the parameter is gone.`,
      ]),
      '',
    );
  }

  if (added.length > 0) {
    lines.push(`New in ${environment}: ${codeList(added)}. There was no value before, so no consumer holds an old one.`, '');
  }

  if (changed.length === 0 && removed.length === 0) {
    const compared = unchanged.length;
    lines.push(
      compared > 0
        ? `No change. The job compared ${plural(compared, 'parameter')} before and after the deployment: ${codeList(unchanged)}.`
        : `No change. There is no published parameter to compare in ${environment}.`,
      '',
    );
  } else if (unchanged.length > 0) {
    lines.push(`Unchanged: ${codeList(unchanged)}.`, '');
  }

  return { summary: lines.join('\n'), annotations };
}
