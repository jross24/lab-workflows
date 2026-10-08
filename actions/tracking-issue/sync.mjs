// Keeps the one tracking issue of a check. The rules are in lib.mjs. This file calls `gh` through the function that the caller passes.
//
//   syncIssue({ gh, repo, name, title, items, renderBody, renderComment, dryRun, log })
//
//   gh(args, input)               runs the gh CLI and returns its output. Tests pass a fake.
//   repo                          owner/name of the repository that holds the issue
//   name                          the name of the check, for example dependency-audit. It is part of the markers.
//   items                         [{ key, ... }] all the items that exist now
//   renderBody(items)             the text of the new issue. syncIssue adds the markers.
//   renderComment(fresh, items)   the text of a comment: the new items first, then all
//
// It returns { action: 'none' | 'create' | 'comment', number, newItems, dryRun }.
import { BOT, clipText, findIssue, keysMarker, knownKeys, newItems, openingMarker } from './lib.mjs';

// The marker lines and the clip note use some of the 65536 characters. Leave room.
const MAX_TEXT = 60000;

function pagesOf(output) {
  return JSON.parse(output).flat();
}

export function syncIssue({ gh, repo, name, title, items, renderBody, renderComment, dryRun = false, log = console.log }) {
  const issues = pagesOf(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues?state=open&per_page=100`]));
  const issue = findIssue(name, issues);
  let known = new Set();
  if (issue) {
    const comments = pagesOf(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${issue.number}/comments?per_page=100`]));
    const botTexts = comments.filter((comment) => comment.user?.login === BOT).map((comment) => comment.body ?? '');
    known = knownKeys(name, [issue.body ?? '', ...botTexts]);
  }
  const fresh = newItems(items, known);

  if (items.length === 0) {
    log(issue ? `The open issue #${issue.number} has no item left. Close it when you agree.` : 'No item was found. No issue is needed.');
    return { action: 'none', number: issue?.number, newItems: [], dryRun };
  }
  if (fresh.length === 0) {
    log(`All ${items.length} items are in the open issue #${issue.number}. Nothing to add.`);
    return { action: 'none', number: issue.number, newItems: [], dryRun };
  }

  const action = issue ? 'comment' : 'create';
  const text = issue
    ? `${clipText(renderComment(fresh, items), MAX_TEXT)}\n\n${keysMarker(name, fresh.map((item) => item.key))}`
    : `${openingMarker(name)}\n${clipText(renderBody(items), MAX_TEXT)}\n\n${keysMarker(name, items.map((item) => item.key))}`;

  if (dryRun) {
    log(`Dry run. Would ${issue ? `comment on issue #${issue.number}` : `open the issue "${title}"`}:\n${text}`);
    return { action, number: issue?.number, newItems: fresh, dryRun };
  }
  if (issue) {
    gh(['api', '-X', 'POST', `repos/${repo}/issues/${issue.number}/comments`, '--input', '-'], JSON.stringify({ body: text }));
    log(`Commented on the open issue #${issue.number}: ${fresh.length} new items.`);
    return { action, number: issue.number, newItems: fresh, dryRun };
  }
  const created = JSON.parse(gh(['api', '-X', 'POST', `repos/${repo}/issues`, '--input', '-'], JSON.stringify({ title, body: text })));
  log(`Opened the issue #${created.number}: ${created.html_url ?? ''}`.trim());
  return { action, number: created.number, url: created.html_url, newItems: fresh, dryRun };
}
