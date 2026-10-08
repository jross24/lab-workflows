// The rules of the monthly check of the tool pins. This file has no I/O.
//
// actions/install-tool/tools.txt pins each tool that the pipeline downloads. One row for each tool and platform:
//
//   tool  version  platform  sha256-of-the-download  url
//
// Dependabot does not read this file. So this check reads the pins, asks GitHub for the latest release of each
// tool, and lists the pins that are behind. It never changes a pin: a person must change the version, the url and the
// hash together, and compare the hash with the checksums file of the release.

const FIELDS = 5;
const RELEASE_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/download\//;
// A plain version is numbers separated by dots. A tag may start with v. A suffix such as -rc1 is not plain.
const PLAIN = /^v?(\d+(?:\.\d+)*)$/;

export function parsePins(text) {
  const pins = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const fields = line.split(/\s+/);
    if (fields.length !== FIELDS) {
      throw new Error(`The pin file has a bad row on line ${index + 1}. A row has ${FIELDS} fields: tool, version, platform, sha256, url.`);
    }
    const [tool, version, platform, sha256, url] = fields;
    pins.push({ tool, version, platform, sha256, url });
  });
  return pins;
}

export function repoOfUrl(url) {
  const match = RELEASE_URL.exec(String(url));
  return match ? match[1] : null;
}

export function versionOfTag(tag) {
  const match = PLAIN.exec(String(tag ?? ''));
  return match ? match[1] : null;
}

export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

// latest: { 'owner/repo': { tag } | { error } }, the answer of GitHub for each repository.
// Returns { behind, current, ahead, unchecked }. A pin that cannot be compared is `unchecked`, never silently fine.
export function checkPins({ pins, latest }) {
  const result = { behind: [], current: [], ahead: [], unchecked: [] };
  const groups = new Map();
  for (const pin of pins) {
    const id = `${pin.tool}\u0000${pin.version}`;
    if (!groups.has(id)) groups.set(id, { ...pin, platforms: [], urls: [] });
    const group = groups.get(id);
    group.platforms.push(pin.platform);
    group.urls.push(pin.url);
  }
  for (const group of groups.values()) {
    const { tool, version: pinned, platforms } = group;
    const repos = [...new Set(group.urls.map(repoOfUrl))];
    if (repos.includes(null)) {
      result.unchecked.push({ tool, reason: 'the url is not a GitHub release url, so the check cannot find the latest release.' });
      continue;
    }
    if (repos.length > 1) {
      result.unchecked.push({ tool, reason: `the urls of the platforms point to ${repos.length} repositories.` });
      continue;
    }
    if (!PLAIN.test(pinned)) {
      result.unchecked.push({ tool, reason: `the pinned version ${JSON.stringify(pinned)} is not a plain version (numbers and dots).` });
      continue;
    }
    const [repo] = repos;
    const answer = latest[repo];
    if (!answer) {
      result.unchecked.push({ tool, reason: `no release lookup for ${repo}.` });
      continue;
    }
    if (answer.error) {
      result.unchecked.push({ tool, reason: `the lookup of ${repo} failed: ${answer.error}` });
      continue;
    }
    const newest = versionOfTag(answer.tag);
    if (newest === null) {
      result.unchecked.push({ tool, reason: `the latest tag ${JSON.stringify(answer.tag)} of ${repo} is not a plain version.` });
      continue;
    }
    const order = compareVersions(pinned, newest);
    if (order < 0) {
      result.behind.push({
        key: `${tool}:${pinned}:${newest}`,
        tool,
        repo,
        pinned,
        latest: newest,
        platforms,
        releaseUrl: `https://github.com/${repo}/releases/tag/${answer.tag}`,
      });
    } else if (order > 0) {
      result.ahead.push({ tool, pinned, latest: newest });
    } else {
      result.current.push({ tool, pinned });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// text of the issue and of the comment
// ---------------------------------------------------------------------------------------------------------------------

function table(behind) {
  const head = '| Tool | Pinned | Latest release | Platforms |\n| --- | --- | --- | --- |';
  const rows = behind.map((entry) => `| ${entry.tool} | ${entry.pinned} | [${entry.latest}](${entry.releaseUrl}) | ${entry.platforms.join(', ')} |`);
  return [head, ...rows].join('\n');
}

function footer({ pinsFile, runUrl }) {
  const lines = [
    `**What to do.** Change the version, the url and the SHA-256 of the tool together in \`${pinsFile}\`, in one pull request.`,
    'Take the hash from your own download. Compare it with the checksums file of the release and with the digest that the GitHub API shows for the file. Then run `bash actions/install-tool/test.sh`.',
    '',
    'The check runs each month. It does not change a pin. It adds a comment here when a new release appears for a tool that is still behind. It does not repeat a pin that this issue already holds.',
  ];
  if (runUrl) lines.push('', `Run: ${runUrl}`);
  return lines.join('\n');
}

export function renderBody(behind, context) {
  return [
    `${behind.length} pinned ${behind.length === 1 ? 'tool is' : 'tools are'} behind the latest release on GitHub.`,
    '',
    table(behind),
    '',
    footer(context),
  ].join('\n');
}

export function renderComment(fresh, all, context) {
  return [
    `${fresh.length} new pin${fresh.length === 1 ? '' : 's'} behind the latest release.`,
    '',
    table(fresh),
    '',
    `All pins that are behind (${all.length}):`,
    '',
    table(all),
    ...(context.runUrl ? ['', `Run: ${context.runUrl}`] : []),
  ].join('\n');
}
