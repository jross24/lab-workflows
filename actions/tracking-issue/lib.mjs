// The rules for one tracking issue that a scheduled workflow keeps. This file has no I/O.
//
// A scheduled check finds items (an advisory in a repository, a tool pin that is behind). The check must not open a new
// issue each week for the same item. So it keeps ONE open issue for a check, and it follows three rules:
//   1. The issue starts with a hidden marker, `<!-- NAME -->`. Only an open issue that the bot wrote counts.
//   2. Each item has a key. The issue body and each comment of the bot end with `<!-- NAME-keys: key key -->`.
//   3. An item whose key is in no marker is new. A new item makes a comment, or an issue if none is open.
//
// A person who closes the issue starts a new round: the next run opens a new issue for the items that remain.
// To silence an item for good, fix it, or (for an advisory) add it to accepted-advisories.json.

export const BOT = 'github-actions[bot]';

// A key sits inside an HTML comment and is separated from the others by spaces.
// So it has no space and it cannot hold the characters "-->" in a row, which would end the comment.
const KEY = /^[A-Za-z0-9_.:@/+]+(?:-[A-Za-z0-9_.:@/+]+)*$/;

export function openingMarker(name) {
  return `<!-- ${name} -->`;
}

export function keysMarker(name, keys) {
  for (const key of keys) {
    if (typeof key !== 'string' || !KEY.test(key)) throw new Error(`${JSON.stringify(key)} is not a valid key.`);
  }
  return `<!-- ${name}-keys: ${keys.join(' ')} -->`;
}

// texts: the body of the issue and the bodies of the comments of the bot.
export function knownKeys(name, texts) {
  const pattern = new RegExp(`<!-- ${name}-keys: ([^>]*?) -->`, 'g');
  const keys = new Set();
  for (const text of texts) {
    for (const match of String(text ?? '').matchAll(pattern)) {
      for (const key of match[1].split(/\s+/).filter(Boolean)) keys.add(key);
    }
  }
  return keys;
}

// issues: the open issues of the repository as the REST API lists them (it lists pull requests too).
export function findIssue(name, issues) {
  const marker = openingMarker(name);
  const found = issues
    .filter((issue) => !issue.pull_request)
    .filter((issue) => issue.user?.login === BOT)
    .filter((issue) => typeof issue.body === 'string' && issue.body.startsWith(marker))
    .sort((a, b) => a.number - b.number);
  return found[0] ?? null;
}

export function newItems(items, known) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.key)) throw new Error(`The key ${item.key} is in the list twice.`);
    seen.add(item.key);
  }
  return items.filter((item) => !known.has(item.key));
}

const CUT_NOTE = '\n\n(cut: the text was too long. The log of the run has the full list.)';

// GitHub refuses a body of more than 65536 characters. Cut at a line end, so a table row stays whole.
export function clipText(text, max) {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  const kept = [];
  let size = CUT_NOTE.length;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join('\n') + CUT_NOTE;
}
