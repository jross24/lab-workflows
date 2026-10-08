// Tests for lib.mjs. Run them with: node --test actions/published-params/lib.test.mjs
// The values in these tests are made up. A real value can hold the account ID, and the code must never print it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareSnapshots,
  consumersOf,
  isWatched,
  namesFromTemplates,
  parseName,
  renderResult,
  repositoryOf,
} from './lib.mjs';

const OLD_URL = 'https://old1.example.test/';
const NEW_URL = 'https://new2.example.test/';
const OLD_ARN = 'arn:aws:execute-api:eu-west-2:111111111111:old1/*';
const NEW_ARN = 'arn:aws:execute-api:eu-west-2:111111111111:new2/*';

describe('parseName', () => {
  it('splits /lab/<service>/<key> into the service and the key', () => {
    assert.deepEqual(parseName('/lab/core/url'), { service: 'core', key: 'url' });
    assert.deepEqual(parseName('/lab/flags/state/show-discounts'), { service: 'flags', key: 'state/show-discounts' });
  });

  it('gives nothing for a name that is not under /lab/<service>/', () => {
    assert.equal(parseName('/other/core/url'), undefined);
    assert.equal(parseName('/lab/core'), undefined);
    assert.equal(parseName('/lab//url'), undefined);
    assert.equal(parseName('lab/core/url'), undefined);
    assert.equal(parseName(undefined), undefined);
  });

  it('refuses a name with a character that could break a log line', () => {
    assert.equal(parseName('/lab/core/url\n::error::x'), undefined);
    assert.equal(parseName('/lab/core/ur l'), undefined);
    assert.equal(parseName('/lab/core/ur%l'), undefined);
  });
});

describe('isWatched', () => {
  it('watches the parameters that a consumer can read when it deploys', () => {
    for (const name of ['/lab/core/url', '/lab/core/api-arn', '/lab/flags/application-id', '/lab/catalogue/url']) {
      assert.equal(isWatched(name), true, name);
    }
  });

  it('ignores the version, because every release changes it', () => {
    assert.equal(isWatched('/lab/core/version'), false);
    assert.equal(isWatched('/lab/web/version'), false);
  });

  it('ignores the rollback floor and the state of a flag, which no consumer stack reads', () => {
    assert.equal(isWatched('/lab/core/min-rollback-version'), false);
    assert.equal(isWatched('/lab/flags/state/show-discounts'), false);
  });

  it('does not watch a name outside /lab/<service>/', () => {
    assert.equal(isWatched('/other/core/url'), false);
    assert.equal(isWatched('nonsense'), false);
  });
});

describe('namesFromTemplates', () => {
  const template = (...parameters) => ({
    Resources: Object.fromEntries(
      parameters.map((properties, index) => [`P${index}`, { Type: 'AWS::SSM::Parameter', Properties: properties }]),
    ),
  });

  it('lists the watched names of the SSM parameters, sorted and without duplicates', () => {
    const result = namesFromTemplates([
      template(
        { Name: '/lab/core/url', Type: 'String', Value: { 'Fn::GetAtt': ['Api', 'ApiEndpoint'] } },
        { Name: '/lab/core/api-arn', Type: 'String', Value: 'x' },
        { Name: '/lab/core/version', Type: 'String', Value: '1.0.0' },
      ),
      template({ Name: '/lab/core/url', Type: 'String', Value: 'x' }),
    ]);
    assert.deepEqual(result, { names: ['/lab/core/api-arn', '/lab/core/url'], skipped: 0 });
  });

  it('ignores resources that are not SSM parameters', () => {
    const result = namesFromTemplates([
      { Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Name: '/lab/core/url' } } } },
    ]);
    assert.deepEqual(result, { names: [], skipped: 0 });
  });

  it('counts a parameter whose name is not a plain string, because it cannot be read', () => {
    const result = namesFromTemplates([
      template({ Name: { 'Fn::Join': ['', ['/lab/core/', { Ref: 'X' }]] }, Type: 'String', Value: 'x' }),
    ]);
    assert.deepEqual(result, { names: [], skipped: 1 });
  });

  it('copes with a template that has no resources', () => {
    assert.deepEqual(namesFromTemplates([{}, { Resources: {} }]), { names: [], skipped: 0 });
  });
});

describe('compareSnapshots', () => {
  it('reports no change when every value is the same', () => {
    const snapshot = { '/lab/core/url': OLD_URL, '/lab/core/api-arn': OLD_ARN };
    assert.deepEqual(compareSnapshots(snapshot, { ...snapshot }), {
      changed: [],
      added: [],
      removed: [],
      unchanged: ['/lab/core/api-arn', '/lab/core/url'],
    });
  });

  it('reports a changed value, and only the parameter that changed', () => {
    const before = { '/lab/core/url': OLD_URL, '/lab/core/api-arn': OLD_ARN };
    const after = { '/lab/core/url': NEW_URL, '/lab/core/api-arn': OLD_ARN };
    assert.deepEqual(compareSnapshots(before, after), {
      changed: ['/lab/core/url'],
      added: [],
      removed: [],
      unchanged: ['/lab/core/api-arn'],
    });
  });

  it('reports two changed values in sorted order', () => {
    const before = { '/lab/core/url': OLD_URL, '/lab/core/api-arn': OLD_ARN };
    const after = { '/lab/core/url': NEW_URL, '/lab/core/api-arn': NEW_ARN };
    assert.deepEqual(compareSnapshots(before, after).changed, ['/lab/core/api-arn', '/lab/core/url']);
  });

  it('does not call a new parameter a change: there was no value before', () => {
    const before = { '/lab/core/url': OLD_URL };
    const after = { '/lab/core/url': OLD_URL, '/lab/core/api-arn': NEW_ARN };
    const result = compareSnapshots(before, after);
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.added, ['/lab/core/api-arn']);
  });

  it('treats the first deployment of a service as new parameters and no change', () => {
    const result = compareSnapshots({}, { '/lab/core/url': NEW_URL, '/lab/core/api-arn': NEW_ARN });
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.added, ['/lab/core/api-arn', '/lab/core/url']);
  });

  it('reports a removed parameter apart from a change', () => {
    const before = { '/lab/core/url': OLD_URL, '/lab/core/api-arn': OLD_ARN };
    const after = { '/lab/core/url': OLD_URL };
    const result = compareSnapshots(before, after);
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.removed, ['/lab/core/api-arn']);
  });

  it('ignores the version parameter, also when it changed', () => {
    const before = { '/lab/core/url': OLD_URL, '/lab/core/version': '1.0.0' };
    const after = { '/lab/core/url': OLD_URL, '/lab/core/version': '1.1.0' };
    assert.deepEqual(compareSnapshots(before, after), {
      changed: [],
      added: [],
      removed: [],
      unchanged: ['/lab/core/url'],
    });
  });

  it('ignores a version parameter that is new or removed', () => {
    assert.deepEqual(compareSnapshots({}, { '/lab/core/version': '1.0.0' }).added, []);
    assert.deepEqual(compareSnapshots({ '/lab/core/version': '1.0.0' }, {}).removed, []);
  });

  it('treats an empty value as a value', () => {
    const result = compareSnapshots({ '/lab/core/url': OLD_URL }, { '/lab/core/url': '' });
    assert.deepEqual(result.changed, ['/lab/core/url']);
  });
});

describe('consumersOf', () => {
  it('reads the consumers of the service from contract.json', () => {
    assert.deepEqual(consumersOf({ service: 'core', consumers: ['catalogue', 'account'] }, 'core'), [
      'catalogue',
      'account',
    ]);
  });

  it('gives nothing when the file has no list, or belongs to another service', () => {
    assert.equal(consumersOf({ service: 'core' }, 'core'), undefined);
    assert.equal(consumersOf({ service: 'core', consumers: ['catalogue'] }, 'flags'), undefined);
    assert.equal(consumersOf(undefined, 'core'), undefined);
    assert.equal(consumersOf({ service: 'core', consumers: 'catalogue' }, 'core'), undefined);
  });

  it('drops a name that is not a service name', () => {
    assert.deepEqual(consumersOf({ service: 'core', consumers: ['catalogue', '../x', 5, 'a b'] }, 'core'), [
      'catalogue',
    ]);
  });
});

describe('repositoryOf', () => {
  it('names the repository of a service', () => {
    assert.equal(repositoryOf('catalogue'), 'lab-svc-catalogue');
    assert.equal(repositoryOf('web'), 'lab-web');
    assert.equal(repositoryOf('flags'), 'lab-flags');
  });
});

describe('renderResult', () => {
  const base = {
    service: 'core',
    environment: 'production',
    consumers: ['catalogue', 'account'],
    versions: { catalogue: '0.7.1', account: '0.6.0' },
  };
  const change = (overrides) => ({ changed: [], added: [], removed: [], unchanged: [], ...overrides });

  it('says "no change" and gives no warning and no annotation when nothing changed', () => {
    const result = renderResult({
      ...base,
      comparison: change({ unchanged: ['/lab/core/api-arn', '/lab/core/url'] }),
    });
    assert.match(result.summary, /no change/i);
    assert.match(result.summary, /2 parameters/);
    assert.doesNotMatch(result.summary, /\[!WARNING\]/);
    assert.deepEqual(result.annotations, []);
  });

  it('writes a [!WARNING] block that names the parameter, the consumers and the cure', () => {
    const result = renderResult({ ...base, comparison: change({ changed: ['/lab/core/url'] }) });
    assert.match(result.summary, /^> \[!WARNING\]$/m);
    assert.match(result.summary, /`\/lab\/core\/url`/);
    assert.match(result.summary, /Redeploy catalogue 0\.7\.1 to production with its `redeploy` workflow/);
    assert.match(result.summary, /Redeploy account 0\.6\.0 to production with its `redeploy` workflow/);
    assert.match(result.summary, /lab-svc-catalogue/);
    // Every line of the block stays inside the quote, or GitHub ends the alert.
    const block = result.summary.split('\n').slice(result.summary.split('\n').indexOf('> [!WARNING]'));
    assert.ok(block.every((line) => line === '' || line.startsWith('>')), block.join('\n'));
  });

  it('writes one warning annotation with the parameter, the consumers and the cure', () => {
    const result = renderResult({
      ...base,
      comparison: change({ changed: ['/lab/core/url', '/lab/core/api-arn'] }),
    });
    assert.equal(result.annotations.length, 1);
    const [annotation] = result.annotations;
    assert.match(annotation, /^::warning title=Provider parameter changed::/);
    assert.match(annotation, /\/lab\/core\/url/);
    assert.match(annotation, /\/lab\/core\/api-arn/);
    assert.match(annotation, /Redeploy catalogue 0\.7\.1 to production with its `redeploy` workflow/);
    assert.match(annotation, /Redeploy account 0\.6\.0 to production with its `redeploy` workflow/);
    assert.equal(annotation.split('\n').length, 1);
  });

  it('leaves the version out of the cure when it is not known', () => {
    const result = renderResult({
      ...base,
      versions: { account: '0.6.0' },
      comparison: change({ changed: ['/lab/core/url'] }),
    });
    assert.match(result.summary, /Redeploy catalogue to production with its `redeploy` workflow/);
    assert.match(result.summary, /Redeploy account 0\.6\.0 to production/);
  });

  it('tells the person to find the consumers when the service lists none', () => {
    const result = renderResult({ ...base, consumers: undefined, comparison: change({ changed: ['/lab/flags/profile-id'] }) , service: 'flags'});
    assert.match(result.summary, /\[!WARNING\]/);
    assert.match(result.summary, /does not list its consumers/);
    assert.match(result.summary, /`requires`/);
    assert.match(result.annotations[0], /does not list its consumers/);
  });

  it('never prints a value', () => {
    const result = renderResult({ ...base, comparison: change({ changed: ['/lab/core/api-arn', '/lab/core/url'] }) });
    const text = `${result.summary}\n${result.annotations.join('\n')}`;
    assert.doesNotMatch(text, /111111111111|example\.test|arn:aws/);
  });

  it('keeps a new parameter out of the warning and lists it as new', () => {
    const result = renderResult({ ...base, comparison: change({ added: ['/lab/core/api-arn'], unchanged: ['/lab/core/url'] }) });
    assert.doesNotMatch(result.summary, /\[!WARNING\]/);
    assert.match(result.summary, /new/i);
    assert.match(result.summary, /`\/lab\/core\/api-arn`/);
    assert.deepEqual(result.annotations, []);
  });

  it('lists a removed parameter in a note and not in a warning', () => {
    const result = renderResult({ ...base, comparison: change({ removed: ['/lab/core/api-arn'] }) });
    assert.match(result.summary, /^> \[!NOTE\]$/m);
    assert.doesNotMatch(result.summary, /\[!WARNING\]/);
    assert.match(result.summary, /`\/lab\/core\/api-arn`/);
  });

  it('writes both blocks when a value changed and another parameter is new', () => {
    const result = renderResult({
      ...base,
      comparison: change({ changed: ['/lab/core/url'], added: ['/lab/core/extra'] }),
    });
    assert.match(result.summary, /\[!WARNING\]/);
    assert.match(result.summary, /`\/lab\/core\/extra`/);
  });

  it('says that the check did not run when it has a reason', () => {
    const result = renderResult({ ...base, skippedReason: 'The parameters could not be read.' });
    assert.match(result.summary, /did not run/i);
    assert.match(result.summary, /could not be read/);
    assert.doesNotMatch(result.summary, /no change/i);
  });
});
