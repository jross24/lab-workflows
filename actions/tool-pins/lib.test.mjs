// Tests for lib.mjs. Run them with: node --test actions/tool-pins/lib.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPins, compareVersions, parsePins, renderBody, renderComment, repoOfUrl, versionOfTag } from './lib.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

const TOOLS = `# A comment line.

actionlint 1.7.12 linux-x86_64 ${SHA_A} https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz
gitleaks 8.30.1 linux-x86_64 ${SHA_B} https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
`;

describe('parsePins', () => {
  it('reads the rows and skips comments and empty lines', () => {
    assert.deepEqual(parsePins(TOOLS), [
      {
        tool: 'actionlint',
        version: '1.7.12',
        platform: 'linux-x86_64',
        sha256: SHA_A,
        url: 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz',
      },
      {
        tool: 'gitleaks',
        version: '8.30.1',
        platform: 'linux-x86_64',
        sha256: SHA_B,
        url: 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz',
      },
    ]);
  });

  it('names the line of a row that does not have five fields', () => {
    assert.throws(() => parsePins(`# c\nactionlint 1.7.12 linux-x86_64 ${SHA_A}\n`), /line 2/);
    assert.throws(() => parsePins(`actionlint 1.7.12 linux-x86_64 ${SHA_A} https://x/y extra\n`), /line 1/);
  });

  it('returns an empty list for a file without rows', () => {
    assert.deepEqual(parsePins('# only a comment\n'), []);
  });
});

describe('repoOfUrl', () => {
  it('reads the repository from the url of a GitHub release download', () => {
    assert.equal(repoOfUrl('https://github.com/rhysd/actionlint/releases/download/v1.7.12/a.tar.gz'), 'rhysd/actionlint');
  });

  it('returns null for any other url', () => {
    assert.equal(repoOfUrl('https://example.com/a.tar.gz'), null);
    assert.equal(repoOfUrl('https://github.com/rhysd/actionlint/archive/v1.tar.gz'), null);
    assert.equal(repoOfUrl('https://github.com.evil.example/o/r/releases/download/v1/a'), null);
    assert.equal(repoOfUrl('not a url'), null);
  });
});

describe('versionOfTag', () => {
  it('removes a leading v', () => {
    assert.equal(versionOfTag('v1.7.12'), '1.7.12');
    assert.equal(versionOfTag('8.30.1'), '8.30.1');
  });

  it('returns null for a tag that is not a plain version', () => {
    assert.equal(versionOfTag('release-2'), null);
    assert.equal(versionOfTag('v1.2.3-rc1'), null);
    assert.equal(versionOfTag(''), null);
    assert.equal(versionOfTag(undefined), null);
  });
});

describe('compareVersions', () => {
  it('compares each number, not the text', () => {
    assert.ok(compareVersions('1.7.12', '1.7.9') > 0);
    assert.ok(compareVersions('1.9', '1.10') < 0);
    assert.ok(compareVersions('8.30.1', '8.31.0') < 0);
    assert.equal(compareVersions('8.30.1', '8.30.1'), 0);
  });

  it('treats a missing number as zero', () => {
    assert.equal(compareVersions('1.7', '1.7.0'), 0);
    assert.ok(compareVersions('1.7', '1.7.1') < 0);
  });
});

describe('checkPins', () => {
  const pins = parsePins(TOOLS);

  it('puts a pin that is behind into `behind`, with the release', () => {
    const result = checkPins({
      pins,
      latest: { 'rhysd/actionlint': { tag: 'v1.7.12' }, 'gitleaks/gitleaks': { tag: 'v8.31.0' } },
    });
    assert.equal(result.behind.length, 1);
    assert.deepEqual(result.behind[0], {
      key: 'gitleaks:8.30.1:8.31.0',
      tool: 'gitleaks',
      repo: 'gitleaks/gitleaks',
      pinned: '8.30.1',
      latest: '8.31.0',
      platforms: ['linux-x86_64'],
      releaseUrl: 'https://github.com/gitleaks/gitleaks/releases/tag/v8.31.0',
    });
    assert.deepEqual(result.current.map((entry) => entry.tool), ['actionlint']);
    assert.deepEqual(result.unchecked, []);
  });

  it('puts a pin that is newer than the latest release into `ahead`', () => {
    const result = checkPins({
      pins,
      latest: { 'rhysd/actionlint': { tag: 'v1.7.0' }, 'gitleaks/gitleaks': { tag: 'v8.30.1' } },
    });
    assert.deepEqual(result.ahead.map((entry) => entry.tool), ['actionlint']);
    assert.deepEqual(result.behind, []);
  });

  it('joins the platforms of one tool and one version into one entry', () => {
    const more = [
      ...pins,
      { ...pins[1], platform: 'darwin-arm64', sha256: SHA_C, url: 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz' },
    ];
    const result = checkPins({ pins: more, latest: { 'rhysd/actionlint': { tag: 'v1.7.12' }, 'gitleaks/gitleaks': { tag: 'v9.0.0' } } });
    assert.equal(result.behind.length, 1);
    assert.deepEqual(result.behind[0].platforms, ['linux-x86_64', 'darwin-arm64']);
  });

  it('reports a pin that it cannot check, and says why', () => {
    const odd = [
      { ...pins[0], url: 'https://example.com/actionlint.tar.gz' },
      { ...pins[1], tool: 'broken', version: '1.2.3-rc1' },
      { ...pins[1], tool: 'quiet' },
      { ...pins[1], tool: 'weird' },
    ];
    const result = checkPins({
      pins: odd,
      latest: { 'gitleaks/gitleaks': { error: 'Not Found (HTTP 404)' } },
    });
    assert.equal(result.behind.length, 0);
    const reasons = Object.fromEntries(result.unchecked.map((entry) => [entry.tool, entry.reason]));
    assert.match(reasons.actionlint, /not a GitHub release url/);
    assert.match(reasons.broken, /version/);
    assert.match(reasons.quiet, /Not Found/);
  });

  it('reports a latest tag that is not a plain version', () => {
    const result = checkPins({ pins, latest: { 'rhysd/actionlint': { tag: 'nightly' }, 'gitleaks/gitleaks': { tag: 'v8.30.1' } } });
    assert.match(result.unchecked.find((entry) => entry.tool === 'actionlint').reason, /nightly/);
  });
});

describe('rendering', () => {
  const behind = [
    {
      key: 'gitleaks:8.30.1:8.31.0',
      tool: 'gitleaks',
      repo: 'gitleaks/gitleaks',
      pinned: '8.30.1',
      latest: '8.31.0',
      platforms: ['linux-x86_64'],
      releaseUrl: 'https://github.com/gitleaks/gitleaks/releases/tag/v8.31.0',
    },
  ];

  it('shows a table row for each pin that is behind', () => {
    const body = renderBody(behind, { pinsFile: 'actions/install-tool/tools.txt' });
    assert.match(body, /\| gitleaks \| 8\.30\.1 \| \[8\.31\.0\]\(https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/tag\/v8\.31\.0\) \| linux-x86_64 \|/);
  });

  it('says that the check changes no pin, and how a person updates one', () => {
    const body = renderBody(behind, { pinsFile: 'actions/install-tool/tools.txt' });
    assert.match(body, /does not change a pin/);
    assert.match(body, /actions\/install-tool\/tools\.txt/);
    assert.match(body, /SHA-256/);
  });

  it('lists the new pin first in a comment, then all', () => {
    const comment = renderComment(behind, behind, { pinsFile: 'actions/install-tool/tools.txt', runUrl: 'https://example.test/run/1' });
    assert.match(comment, /1 new pin/);
    assert.match(comment, /Run: https:\/\/example\.test\/run\/1/);
  });
});
