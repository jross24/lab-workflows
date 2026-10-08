// A fake `gh` for tests. It keeps issues and comments in memory and answers the calls of sync.mjs.
// It is a test helper. No workflow runs it.
//
//   const fake = createFakeGh({ issues: [...] });
//   fake.gh(['api', '--paginate', '--slurp', 'repos/o/r/issues?state=open&per_page=100'])
//   fake.calls   every call, in order, as { args, input }
//   fake.writes  only the POST and PATCH calls, as { method, path, payload }
const ISSUES = /^repos\/([^/]+\/[^/?]+)\/issues\?state=open&per_page=100$/;
const COMMENTS = /^repos\/([^/]+\/[^/?]+)\/issues\/(\d+)\/comments\?per_page=100$/;
const CREATE = /^repos\/([^/]+\/[^/?]+)\/issues$/;
const COMMENT = /^repos\/([^/]+\/[^/?]+)\/issues\/(\d+)\/comments$/;

export function createFakeGh({ issues = [], comments = {} } = {}) {
  const state = { issues: [...issues], comments: { ...comments }, next: 100 };
  const calls = [];
  const writes = [];

  function gh(args, input) {
    calls.push({ args, input });
    if (args[0] !== 'api') throw new Error(`fake gh: unexpected command ${args.join(' ')}`);
    const post = args[1] === '-X' && args[2] === 'POST';
    const path = post ? args[3] : args.find((arg) => arg.startsWith('repos/'));
    if (!post) {
      if (ISSUES.test(path)) return JSON.stringify([state.issues]);
      const match = COMMENTS.exec(path);
      if (match) return JSON.stringify([state.comments[Number(match[2])] ?? []]);
      throw new Error(`fake gh: unexpected GET ${path}`);
    }
    const payload = JSON.parse(input);
    if (COMMENT.test(path)) {
      const number = Number(COMMENT.exec(path)[2]);
      state.comments[number] = [...(state.comments[number] ?? []), { user: { login: 'github-actions[bot]' }, body: payload.body }];
      writes.push({ method: 'POST', path, payload });
      return JSON.stringify({ id: 1 });
    }
    if (CREATE.test(path)) {
      const number = state.next++;
      state.issues.push({ number, user: { login: 'github-actions[bot]' }, title: payload.title, body: payload.body });
      writes.push({ method: 'POST', path, payload });
      return JSON.stringify({ number, html_url: `https://github.com/${CREATE.exec(path)[1]}/issues/${number}` });
    }
    throw new Error(`fake gh: unexpected POST ${path}`);
  }

  return { gh, calls, writes, state };
}
