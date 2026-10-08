// Tests for cli.mjs. Run them with: node --test actions/published-params/cli.test.mjs
// The tests pass a fake for the AWS call. No test uses the network or AWS. The values are made up.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { main, readWithAws, runCompare, runSnapshot } from './cli.mjs';

const ACCOUNT = '111111111111';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'published-params-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const parameter = (name) => ({ Type: 'AWS::SSM::Parameter', Properties: { Name: name, Type: 'String', Value: 'x' } });

// Writes cdk.out/assembly-<stage>/<stack>.template.json for the given parameter names.
function writeAssembly(stage, names) {
  const assembly = join(dir, 'cdk.out');
  const stageDir = join(assembly, `assembly-${stage}`);
  mkdirSync(stageDir, { recursive: true });
  const resources = Object.fromEntries(names.map((name, index) => [`P${index}`, parameter(name)]));
  writeFileSync(join(stageDir, `${stage}Core.template.json`), JSON.stringify({ Resources: resources }));
  writeFileSync(join(stageDir, 'manifest.json'), '{}');
  return assembly;
}

// A fake SSM. `store` maps names to values. Test code changes the store between the two reads.
function fakeRead(store, { fail } = {}) {
  const calls = [];
  const read = (names) => {
    calls.push(names);
    if (fail) throw new Error(fail);
    return Object.fromEntries(names.filter((name) => Object.hasOwn(store, name)).map((name) => [name, store[name]]));
  };
  return { read, calls };
}

function collector() {
  const lines = [];
  return { log: (line) => lines.push(line), lines, text: () => lines.join('\n') };
}

const NAMES = ['/lab/core/url', '/lab/core/api-arn', '/lab/core/version'];

function settings(overrides = {}) {
  const out = collector();
  const summaries = [];
  return {
    out,
    summaries,
    base: {
      beforeFile: join(dir, 'before.json'),
      stage: 'Production',
      contractFile: join(dir, 'contract.json'),
      writeSummary: (text) => summaries.push(text),
      log: out.log,
      ...overrides,
    },
  };
}

describe('runSnapshot', () => {
  it('reads the published parameters of the stage and leaves out the version', () => {
    const assembly = writeAssembly('Production', NAMES);
    const store = { '/lab/core/url': 'u1', '/lab/core/api-arn': 'a1', '/lab/core/version': '1.0.0' };
    const fake = fakeRead(store);
    const out = collector();
    runSnapshot({ assemblyDir: assembly, stage: 'Production', outFile: join(dir, 'before.json'), read: fake.read, log: out.log });
    assert.deepEqual(fake.calls, [['/lab/core/api-arn', '/lab/core/url']]);
    const snapshot = JSON.parse(readFileSync(join(dir, 'before.json'), 'utf8'));
    assert.deepEqual(snapshot.names, ['/lab/core/api-arn', '/lab/core/url']);
    assert.deepEqual(snapshot.values, { '/lab/core/url': 'u1', '/lab/core/api-arn': 'a1' });
    assert.equal(snapshot.failed, undefined);
  });

  it('records a name with no value yet (the first deployment) as a name only', () => {
    const assembly = writeAssembly('Test', ['/lab/core/url']);
    runSnapshot({ assemblyDir: assembly, stage: 'Test', outFile: join(dir, 'before.json'), read: fakeRead({}).read, log: () => {} });
    const snapshot = JSON.parse(readFileSync(join(dir, 'before.json'), 'utf8'));
    assert.deepEqual(snapshot.names, ['/lab/core/url']);
    assert.deepEqual(snapshot.values, {});
  });

  it('makes no AWS call for a stage that publishes nothing', () => {
    const assembly = writeAssembly('Test', ['/lab/core/version']);
    const fake = fakeRead({});
    runSnapshot({ assemblyDir: assembly, stage: 'Test', outFile: join(dir, 'before.json'), read: fake.read, log: () => {} });
    assert.deepEqual(fake.calls, []);
  });

  it('does not throw when the folder of the stage is not in the assembly: it records the reason', () => {
    const assembly = writeAssembly('Test', NAMES);
    const out = collector();
    runSnapshot({ assemblyDir: assembly, stage: 'Staging', outFile: join(dir, 'before.json'), read: fakeRead({}).read, log: out.log });
    const snapshot = JSON.parse(readFileSync(join(dir, 'before.json'), 'utf8'));
    assert.match(snapshot.failed, /assembly-Staging/);
    assert.match(out.text(), /^::warning title=Published parameters::/m);
  });

  it('does not throw when SSM fails: it records the reason and keeps the account ID out of it', () => {
    const assembly = writeAssembly('Test', NAMES);
    const out = collector();
    const fake = fakeRead({}, { fail: `User: arn:aws:sts::${ACCOUNT}:assumed-role/github-deploy/x is not authorized\nsecond line` });
    runSnapshot({ assemblyDir: assembly, stage: 'Test', outFile: join(dir, 'before.json'), read: fake.read, log: out.log });
    const snapshot = JSON.parse(readFileSync(join(dir, 'before.json'), 'utf8'));
    assert.match(snapshot.failed, /not authorized/);
    assert.doesNotMatch(snapshot.failed, new RegExp(ACCOUNT));
    assert.doesNotMatch(snapshot.failed, /second line/);
    assert.doesNotMatch(out.text(), new RegExp(ACCOUNT));
  });

  it('tells the person about a parameter name that it cannot read', () => {
    const assembly = join(dir, 'cdk.out');
    mkdirSync(join(assembly, 'assembly-Test'), { recursive: true });
    const template = { Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: { Name: { 'Fn::Join': ['', ['/lab/core/', { Ref: 'X' }]] } } } } };
    writeFileSync(join(assembly, 'assembly-Test', 'T.template.json'), JSON.stringify(template));
    const out = collector();
    runSnapshot({ assemblyDir: assembly, stage: 'Test', outFile: join(dir, 'before.json'), read: fakeRead({}).read, log: out.log });
    assert.match(out.text(), /^::notice title=Published parameters::.*1 SSM parameter/m);
  });
});

describe('runCompare', () => {
  function snapshotFile(store, names = ['/lab/core/api-arn', '/lab/core/url'], extra = {}) {
    const values = Object.fromEntries(names.filter((name) => Object.hasOwn(store, name)).map((name) => [name, store[name]]));
    writeFileSync(join(dir, 'before.json'), JSON.stringify({ stage: 'Production', names, values, ...extra }));
  }

  function contractFile() {
    writeFileSync(join(dir, 'contract.json'), JSON.stringify({ service: 'core', consumers: ['catalogue', 'account'] }));
  }

  it('says "no change" in the log and the summary when the values are the same', () => {
    const store = { '/lab/core/url': 'u1', '/lab/core/api-arn': 'a1', '/lab/catalogue/version': '0.7.1' };
    snapshotFile(store);
    contractFile();
    const { out, summaries, base } = settings();
    runCompare({ ...base, read: fakeRead(store).read });
    assert.match(out.text(), /published parameters of core in production: no change \(2 compared\)/);
    assert.doesNotMatch(out.text(), /::warning/);
    assert.match(summaries.join('\n'), /No change/);
    assert.doesNotMatch(summaries.join('\n'), /\[!WARNING\]/);
  });

  it('warns, names the consumers with their present versions, and does not throw, when a value changed', () => {
    const before = { '/lab/core/url': 'u1', '/lab/core/api-arn': 'a1' };
    snapshotFile(before);
    contractFile();
    const after = { ...before, '/lab/core/url': 'u2', '/lab/catalogue/version': '0.7.1', '/lab/account/version': '0.6.0' };
    const fake = fakeRead(after);
    const { out, summaries, base } = settings();
    runCompare({ ...base, read: fake.read });
    // The second read gets the versions of the consumers.
    assert.deepEqual(fake.calls[1], ['/lab/catalogue/version', '/lab/account/version']);
    const summary = summaries.join('\n');
    assert.match(summary, /\[!WARNING\]/);
    assert.match(summary, /`\/lab\/core\/url`/);
    assert.doesNotMatch(summary, /Changed:.*api-arn/);
    assert.match(summary, /Redeploy catalogue 0\.7\.1 to production with its `redeploy` workflow/);
    assert.match(summary, /Redeploy account 0\.6\.0 to production with its `redeploy` workflow/);
    assert.match(out.text(), /^::warning title=Provider parameter changed::/m);
    assert.match(out.text(), /published parameters of core in production: 1 changed/);
  });

  it('prints no value, also when a value changed', () => {
    const before = { '/lab/core/url': `https://old.example.test/${ACCOUNT}`, '/lab/core/api-arn': `arn:aws:execute-api:eu-west-2:${ACCOUNT}:a/*` };
    snapshotFile(before);
    contractFile();
    const after = { ...before, '/lab/core/api-arn': `arn:aws:execute-api:eu-west-2:${ACCOUNT}:b/*` };
    const { out, summaries, base } = settings();
    runCompare({ ...base, read: fakeRead(after).read });
    assert.doesNotMatch(`${out.text()}\n${summaries.join('\n')}`, new RegExp(`${ACCOUNT}|example\\.test|arn:aws`));
  });

  it('does not call the first deployment a change', () => {
    snapshotFile({});
    contractFile();
    const { out, summaries, base } = settings();
    runCompare({ ...base, read: fakeRead({ '/lab/core/url': 'u1', '/lab/core/api-arn': 'a1' }).read });
    assert.doesNotMatch(out.text(), /::warning/);
    assert.doesNotMatch(summaries.join('\n'), /\[!WARNING\]/);
    assert.match(summaries.join('\n'), /New in production/);
    assert.match(out.text(), /0 changed, 2 new, 0 removed/);
  });

  it('ignores a change of the version', () => {
    const names = ['/lab/core/url', '/lab/core/version'];
    writeFileSync(join(dir, 'before.json'), JSON.stringify({ stage: 'Production', names, values: { '/lab/core/url': 'u1', '/lab/core/version': '1.0.0' } }));
    contractFile();
    const { out, base } = settings();
    runCompare({ ...base, read: fakeRead({ '/lab/core/url': 'u1', '/lab/core/version': '1.1.0' }).read });
    assert.doesNotMatch(out.text(), /::warning/);
    assert.match(out.text(), /no change \(1 compared\)/);
  });

  it('gives the generic cure when contract.json is not there', () => {
    const before = { '/lab/flags/profile-id': 'p1' };
    snapshotFile(before, ['/lab/flags/profile-id']);
    const { summaries, base } = settings();
    runCompare({ ...base, read: fakeRead({ '/lab/flags/profile-id': 'p2' }).read });
    assert.match(summaries.join('\n'), /does not list its consumers/);
    assert.match(summaries.join('\n'), /Redeploy each service that has flags in `requires`/);
  });

  it('still warns when the versions of the consumers cannot be read', () => {
    const before = { '/lab/core/url': 'u1' };
    snapshotFile(before, ['/lab/core/url']);
    contractFile();
    let calls = 0;
    const read = (names) => {
      calls += 1;
      if (calls === 2) throw new Error('throttled');
      return Object.fromEntries(names.map((name) => [name, 'u2']));
    };
    const { summaries, base } = settings();
    runCompare({ ...base, read });
    assert.match(summaries.join('\n'), /Redeploy catalogue to production with its `redeploy` workflow/);
  });

  it('says that the check did not run when the read before the deployment failed', () => {
    snapshotFile({}, [], { failed: 'The parameters could not be read before the deployment.' });
    const { out, summaries, base } = settings();
    runCompare({ ...base, read: fakeRead({}).read });
    assert.match(summaries.join('\n'), /did not run/i);
    assert.match(out.text(), /^::warning title=Published parameters::/m);
  });

  it('says that the check did not run when the read after the deployment fails', () => {
    snapshotFile({ '/lab/core/url': 'u1' }, ['/lab/core/url']);
    const { out, summaries, base } = settings();
    runCompare({ ...base, read: fakeRead({}, { fail: `denied for ${ACCOUNT}` }).read });
    assert.match(summaries.join('\n'), /did not run/i);
    assert.doesNotMatch(`${out.text()}\n${summaries.join('\n')}`, new RegExp(ACCOUNT));
  });

  it('says that the check did not run when the snapshot file is missing', () => {
    const { out, summaries, base } = settings();
    runCompare({ ...base, read: fakeRead({}).read });
    assert.match(summaries.join('\n'), /did not run/i);
    assert.match(out.text(), /^::warning title=Published parameters::/m);
  });

  it('copes with a contract.json that is not valid JSON', () => {
    snapshotFile({ '/lab/core/url': 'u1' }, ['/lab/core/url']);
    writeFileSync(join(dir, 'contract.json'), '{ not json');
    const { summaries, base } = settings();
    runCompare({ ...base, read: fakeRead({ '/lab/core/url': 'u2' }).read });
    assert.match(summaries.join('\n'), /does not list its consumers/);
  });
});

describe('readWithAws', () => {
  it('asks for 10 names in one call, and gives the values of the names that exist', () => {
    const names = Array.from({ length: 12 }, (_, index) => `/lab/s/p${String(index).padStart(2, '0')}`);
    const calls = [];
    const run = (command, args) => {
      calls.push([command, args]);
      const asked = args.slice(args.indexOf('--names') + 1, args.indexOf('--output'));
      const found = asked.filter((name) => name !== '/lab/s/p03');
      return JSON.stringify({
        Parameters: found.map((name) => ({ Name: name, Value: `v-${name}` })),
        InvalidParameters: asked.filter((name) => name === '/lab/s/p03'),
      });
    };
    const values = readWithAws(names, run);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'aws');
    assert.deepEqual(calls[0][1].slice(0, 2), ['ssm', 'get-parameters']);
    assert.equal(calls[0][1].filter((arg) => arg.startsWith('/lab/')).length, 10);
    assert.equal(calls[1][1].filter((arg) => arg.startsWith('/lab/')).length, 2);
    assert.equal(Object.keys(values).length, 11);
    assert.equal(values['/lab/s/p03'], undefined);
    assert.equal(values['/lab/s/p11'], 'v-/lab/s/p11');
  });
});

describe('main', () => {
  it('returns 0 and warns when the arguments are wrong: the check never fails a deployment', () => {
    const out = collector();
    assert.equal(main(['compare'], {}, { log: out.log }), 0);
    assert.match(out.text(), /^::warning title=Published parameters::/m);
  });

  it('returns 0 for an unknown command', () => {
    const out = collector();
    assert.equal(main(['nonsense'], {}, { log: out.log }), 0);
    assert.match(out.text(), /^::warning title=Published parameters::/m);
  });

  it('runs a snapshot and a compare from the arguments, and appends the summary to the file of the job', () => {
    const assembly = writeAssembly('Production', NAMES);
    const store = { '/lab/core/url': 'u1', '/lab/core/api-arn': 'a1' };
    const out = collector();
    const summaryFile = join(dir, 'summary.md');
    const deps = { log: out.log, read: fakeRead(store).read };
    const env = { GITHUB_STEP_SUMMARY: summaryFile };
    const snapshot = join(dir, 'snap.json');
    assert.equal(main(['snapshot', '--assembly', assembly, '--stage', 'Production', '--out', snapshot], env, deps), 0);
    assert.equal(main(['compare', '--before', snapshot, '--stage', 'Production', '--contract', join(dir, 'none.json')], env, deps), 0);
    assert.match(readFileSync(summaryFile, 'utf8'), /No change/);
    assert.match(out.text(), /no change \(2 compared\)/);
  });
});
