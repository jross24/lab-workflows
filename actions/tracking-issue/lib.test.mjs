// Tests for lib.mjs and sync.mjs. Run them with: node --test actions/tracking-issue/lib.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeGh } from './fake-gh.mjs';
import { BOT, findIssue, keysMarker, knownKeys, openingMarker, newItems, clipText } from './lib.mjs';
import { syncIssue } from './sync.mjs';

const NAME = 'dependency-audit';
const REPO = 'jross24/lab-workflows';

const item = (key, extra = {}) => ({ key, ...extra });
const renderBody = (items) => `Body with ${items.map((entry) => entry.key).join(', ')}`;
const renderComment = (fresh, all) => `New: ${fresh.map((entry) => entry.key).join(', ')}. All: ${all.length}.`;

describe('markers', () => {
  it('writes the opening marker and the keys marker as HTML comments', () => {
    assert.equal(openingMarker(NAME), '<!-- dependency-audit -->');
    assert.equal(keysMarker(NAME, ['a:b', 'c:d']), '<!-- dependency-audit-keys: a:b c:d -->');
  });

  it('refuses a key that could break out of the comment', () => {
    assert.throws(() => keysMarker(NAME, ['a --> b']), /not a valid key/);
    assert.throws(() => keysMarker(NAME, ['']), /not a valid key/);
    assert.throws(() => keysMarker(NAME, ['two words']), /not a valid key/);
  });

  it('reads the keys from several texts', () => {
    const texts = [`x\n${keysMarker(NAME, ['a:1', 'b:2'])}`, 'no marker here', keysMarker(NAME, ['c:3'])];
    assert.deepEqual([...knownKeys(NAME, texts)].sort(), ['a:1', 'b:2', 'c:3']);
  });

  it('ignores the keys marker of another name', () => {
    assert.deepEqual([...knownKeys(NAME, [keysMarker('tool-pins', ['a:1'])])], []);
  });
});

describe('findIssue', () => {
  const body = `${openingMarker(NAME)}\ntext`;
  it('finds the open issue that the bot made, with the marker', () => {
    const issues = [{ number: 7, user: { login: BOT }, body }];
    assert.equal(findIssue(NAME, issues).number, 7);
  });

  it('ignores an issue from a person, also when it has the marker', () => {
    assert.equal(findIssue(NAME, [{ number: 7, user: { login: 'someone' }, body }]), null);
  });

  it('ignores a pull request and an issue with another marker', () => {
    const issues = [
      { number: 1, user: { login: BOT }, body, pull_request: {} },
      { number: 2, user: { login: BOT }, body: `${openingMarker('tool-pins')}\ntext` },
      { number: 3, user: { login: BOT }, body: null },
    ];
    assert.equal(findIssue(NAME, issues), null);
  });

  it('takes the oldest issue when two match', () => {
    const issues = [
      { number: 9, user: { login: BOT }, body },
      { number: 4, user: { login: BOT }, body },
    ];
    assert.equal(findIssue(NAME, issues).number, 4);
  });
});

describe('newItems', () => {
  it('returns the items whose key is not known', () => {
    const items = [item('a'), item('b'), item('c')];
    assert.deepEqual(
      newItems(items, new Set(['b'])).map((entry) => entry.key),
      ['a', 'c'],
    );
  });

  it('refuses two items with the same key', () => {
    assert.throws(() => newItems([item('a'), item('a')], new Set()), /twice/);
  });
});

describe('clipText', () => {
  it('keeps a short text as it is', () => {
    assert.equal(clipText('a\nb', 100), 'a\nb');
  });

  it('cuts a long text at a line end and says so', () => {
    const text = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n');
    const clipped = clipText(text, 120);
    assert.ok(clipped.length <= 120, `length ${clipped.length}`);
    assert.match(clipped, /cut: the text was too long/);
    assert.ok(clipped.startsWith('line 0\nline 1'));
  });
});

describe('syncIssue', () => {
  const base = { repo: REPO, name: NAME, title: 'a title', renderBody, renderComment, log: () => {} };

  it('does nothing when there is no item', () => {
    const fake = createFakeGh();
    const result = syncIssue({ ...base, gh: fake.gh, items: [] });
    assert.equal(result.action, 'none');
    assert.deepEqual(fake.writes, []);
  });

  it('opens one issue when there is an item and no open issue', () => {
    const fake = createFakeGh();
    const result = syncIssue({ ...base, gh: fake.gh, items: [item('a:1')] });
    assert.equal(result.action, 'create');
    assert.equal(fake.writes.length, 1);
    const { path, payload } = fake.writes[0];
    assert.equal(path, `repos/${REPO}/issues`);
    assert.equal(payload.title, 'a title');
    assert.ok(payload.body.startsWith(openingMarker(NAME)));
    assert.match(payload.body, /Body with a:1/);
    assert.match(payload.body, /<!-- dependency-audit-keys: a:1 -->/);
  });

  it('adds nothing when every item is already in the open issue', () => {
    const fake = createFakeGh();
    syncIssue({ ...base, gh: fake.gh, items: [item('a:1')] });
    const again = syncIssue({ ...base, gh: fake.gh, items: [item('a:1')] });
    assert.equal(again.action, 'none');
    assert.equal(fake.writes.length, 1);
  });

  it('comments on the open issue when an item is new, and lists only the new item as new', () => {
    const fake = createFakeGh();
    syncIssue({ ...base, gh: fake.gh, items: [item('a:1')] });
    const result = syncIssue({ ...base, gh: fake.gh, items: [item('a:1'), item('b:2')] });
    assert.equal(result.action, 'comment');
    assert.equal(fake.writes.length, 2);
    const { path, payload } = fake.writes[1];
    assert.equal(path, `repos/${REPO}/issues/${result.number}/comments`);
    assert.match(payload.body, /New: b:2\. All: 2\./);
    assert.match(payload.body, /<!-- dependency-audit-keys: b:2 -->/);
  });

  it('does not comment twice for the same new item', () => {
    const fake = createFakeGh();
    syncIssue({ ...base, gh: fake.gh, items: [item('a:1')] });
    const items = [item('a:1'), item('b:2')];
    syncIssue({ ...base, gh: fake.gh, items });
    const third = syncIssue({ ...base, gh: fake.gh, items });
    assert.equal(third.action, 'none');
    assert.equal(fake.writes.length, 2);
  });

  it('opens a new issue when the old one is closed (it is not in the open list)', () => {
    const fake = createFakeGh();
    syncIssue({ ...base, gh: fake.gh, items: [item('a:1')] });
    fake.state.issues.length = 0; // the person closed the issue
    const result = syncIssue({ ...base, gh: fake.gh, items: [item('a:1')] });
    assert.equal(result.action, 'create');
  });

  it('does not trust a comment from a person that holds a keys marker', () => {
    const fake = createFakeGh();
    const first = syncIssue({ ...base, gh: fake.gh, items: [item('a:1')] });
    fake.state.comments[first.number] = [{ user: { login: 'someone' }, body: keysMarker(NAME, ['b:2']) }];
    const result = syncIssue({ ...base, gh: fake.gh, items: [item('a:1'), item('b:2')] });
    assert.equal(result.action, 'comment');
  });

  it('writes nothing in a dry run, and says what it would do', () => {
    const fake = createFakeGh();
    const lines = [];
    const result = syncIssue({ ...base, gh: fake.gh, items: [item('a:1')], dryRun: true, log: (line) => lines.push(line) });
    assert.equal(result.action, 'create');
    assert.equal(result.dryRun, true);
    assert.deepEqual(fake.writes, []);
    assert.match(lines.join('\n'), /Dry run/);
  });

  it('notes an open issue that has no item left, and writes nothing', () => {
    const fake = createFakeGh();
    syncIssue({ ...base, gh: fake.gh, items: [item('a:1')] });
    const lines = [];
    const result = syncIssue({ ...base, gh: fake.gh, items: [], log: (line) => lines.push(line) });
    assert.equal(result.action, 'none');
    assert.match(lines.join('\n'), /no item left/);
    assert.equal(fake.writes.length, 1);
  });
});
