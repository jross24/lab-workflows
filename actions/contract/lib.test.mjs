// Tests for lib.mjs. Run them with: node --test actions/contract/lib.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  APPROVAL_LABEL,
  annotation,
  cleanText,
  compareContracts,
  describeViolation,
  formatFileError,
  parseContract,
  parseExpectations,
  renderSummary,
  verifyExpectations,
} from './lib.mjs';

const fixture = (name) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const contract = () => JSON.parse(fixture('contract-core.json'));
const expectations = () => JSON.parse(fixture('expectations-catalogue.json'));

// The schema of one array item of GET /items 200, and of the whole answer.
const listAnswer = (doc) => doc.endpoints['GET /items'].responses['200'];
const listItem = (doc) => listAnswer(doc).properties.items.items;
const wantAnswer = (doc) => doc.expects.core['GET /items'].responses['200'];
const wantItem = (doc) => wantAnswer(doc).properties.items.items;

// Checks the fields of a violation that matter. Other fields (the hint, the empty fields) are not compared.
function assertViolation(violation, expected) {
  assert.ok(violation, 'a violation was expected');
  for (const [key, value] of Object.entries(expected)) assert.equal(violation[key], value, `field ${key}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The formats
// ---------------------------------------------------------------------------------------------------------------------

describe('parseContract', () => {
  const parse = (doc, service = 'core') => parseContract(JSON.stringify(doc), { service });
  const errorsOf = (doc, service) => parse(doc, service).errors;

  it('accepts the example contract', () => {
    const result = parseContract(fixture('contract-core.json'), { service: 'core' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.doc.service, 'core');
  });

  it('gives a format error for text that is not JSON', () => {
    const { errors, doc } = parseContract('{ "service": ', { service: 'core' });
    assert.equal(doc, undefined);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /not valid JSON/);
  });

  it('rejects a document that is not an object', () => {
    assert.match(parseContract('[]', { service: 'core' }).errors[0].message, /JSON object/);
  });

  it('rejects a service that differs from the service of pipeline.json', () => {
    const errors = errorsOf(contract(), 'catalogue');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, '$.service');
    assert.match(errors[0].message, /"core".*"catalogue"/);
  });

  it('rejects a missing service', () => {
    const doc = contract();
    delete doc.service;
    assert.match(errorsOf(doc)[0].message, /"service" is required/);
  });

  it('rejects an unknown key at the top, so a typo does not pass in silence', () => {
    const doc = contract();
    doc.endpoint = {};
    const errors = errorsOf(doc);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, '$.endpoint');
    assert.match(errors[0].message, /unknown key "endpoint"/);
  });

  it('rejects a keyword that the check does not use (unsupported keyword)', () => {
    for (const keyword of ['enum', 'pattern', 'oneOf', 'additionalProperties', '$ref', 'format', 'minimum', 'nullable']) {
      const doc = contract();
      listItem(doc).properties.id[keyword] = 'x';
      const errors = errorsOf(doc);
      assert.equal(errors.length, 1, keyword);
      assert.match(errors[0].message, new RegExp(`unsupported keyword "${keyword.replace('$', '\\$')}"`));
      assert.match(errors[0].path, /\.items\.properties\.id/);
    }
  });

  it('rejects a schema without type, and an unknown type', () => {
    let doc = contract();
    delete listItem(doc).properties.id.type;
    assert.match(errorsOf(doc)[0].message, /"type" is required/);
    doc = contract();
    listItem(doc).properties.id.type = 'null';
    assert.match(errorsOf(doc)[0].message, /type must be one of/);
  });

  it('rejects a name in required that is not in properties', () => {
    const doc = contract();
    listItem(doc).required.push('sku');
    const errors = errorsOf(doc);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /"sku" is in required but not in properties/);
    assert.match(errors[0].path, /required\[2\]$/);
  });

  it('rejects required on a schema that has no properties at all', () => {
    const doc = contract();
    listAnswer(doc).properties.version = { type: 'object', required: ['x'] };
    assert.match(errorsOf(doc)[0].message, /"x" is in required but not in properties/);
  });

  it('rejects properties on a type that is not object, and items on a type that is not array', () => {
    let doc = contract();
    listItem(doc).properties.id.properties = {};
    assert.match(errorsOf(doc)[0].message, /"properties" is allowed only when the type is object/);
    doc = contract();
    listItem(doc).items = { type: 'string' };
    assert.match(errorsOf(doc)[0].message, /"items" is allowed only when the type is array/);
  });

  it('rejects a required list that is not a list of strings', () => {
    const doc = contract();
    listItem(doc).required = 'id';
    assert.match(errorsOf(doc)[0].message, /"required" must be a list of names/);
  });

  it('rejects a request input that does not match the pattern', () => {
    for (const bad of ['cookie:session', 'query:', 'query:a b', 'limit', 'query:li/mit']) {
      const doc = contract();
      doc.endpoints['GET /items'].request.optional.push(bad);
      const errors = errorsOf(doc);
      assert.equal(errors.length, 1, bad);
      assert.match(errors[0].message, /request input/);
    }
  });

  it('rejects an input that is listed twice', () => {
    const doc = contract();
    doc.endpoints['GET /items'].request.required.push('query:limit');
    assert.match(errorsOf(doc)[0].message, /query:limit.*(twice|more than once)/);
  });

  it('rejects an endpoint key that is not "METHOD /path"', () => {
    for (const bad of ['/items', 'get /items', 'GET items', 'GET  /items']) {
      const doc = contract();
      doc.endpoints[bad] = doc.endpoints['GET /items'];
      const errors = errorsOf(doc);
      assert.equal(errors.length, 1, bad);
      assert.match(errors[0].message, /METHOD \/path/);
    }
  });

  it('rejects a status code that does not have three digits', () => {
    for (const bad of ['20', '2xx', '2000', 'ok']) {
      const doc = contract();
      doc.endpoints['GET /items'].responses[bad] = { type: 'object' };
      const errors = errorsOf(doc);
      assert.equal(errors.length, 1, bad);
      assert.match(errors[0].message, /status code/);
    }
  });

  it('rejects an endpoint without an answer', () => {
    const doc = contract();
    doc.endpoints['GET /items'].responses = {};
    assert.match(errorsOf(doc)[0].message, /at least one status code/);
  });

  it('rejects consumers with a bad name, a duplicate, or the service itself', () => {
    for (const bad of [['Catalogue'], ['catalogue', 'catalogue'], ['core'], ['../x'], 'catalogue']) {
      const doc = contract();
      doc.consumers = bad;
      assert.equal(errorsOf(doc).length > 0, true, JSON.stringify(bad));
    }
  });

  it('accepts a contract without consumers and without a request block', () => {
    const doc = contract();
    delete doc.consumers;
    delete doc.endpoints['GET /items'].request;
    assert.deepEqual(errorsOf(doc), []);
  });

  it('accepts description on the file, on an endpoint and on a schema', () => {
    const doc = contract();
    doc.description = 'The core service';
    doc.endpoints['GET /items'].description = 'List the items';
    listItem(doc).properties.id.description = 'The id';
    assert.deepEqual(errorsOf(doc), []);
  });

  it('rejects a schema that is nested too deep', () => {
    let schema = { type: 'string' };
    for (let i = 0; i < 40; i += 1) schema = { type: 'object', properties: { a: schema } };
    const doc = contract();
    doc.endpoints['GET /items'].responses['200'] = schema;
    assert.match(errorsOf(doc)[0].message, /nested deeper/);
  });

  it('reports the path of the error in the file', () => {
    const doc = contract();
    listItem(doc).properties.id.enum = ['a'];
    assert.equal(
      errorsOf(doc)[0].path,
      '$.endpoints["GET /items"].responses["200"].properties.items.items.properties.id.enum',
    );
  });

  it('formats an error with the file name and the path', () => {
    assert.equal(
      formatFileError('contract.json', { path: '$.service', message: 'x is wrong.' }),
      'contract.json: $.service: x is wrong.',
    );
  });
});

describe('parseExpectations', () => {
  const parse = (doc, service = 'catalogue') => parseExpectations(JSON.stringify(doc), { service });
  const errorsOf = (doc, service) => parse(doc, service).errors;

  it('accepts the example expectations', () => {
    const result = parseExpectations(fixture('expectations-catalogue.json'), { service: 'catalogue' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.doc.service, 'catalogue');
  });

  it('rejects a service that differs from the service of pipeline.json', () => {
    const errors = errorsOf(expectations(), 'account');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, '$.service');
  });

  it('rejects an unsupported keyword in the schema of an expectation', () => {
    const doc = expectations();
    wantItem(doc).properties.name.enum = ['a'];
    assert.match(errorsOf(doc)[0].message, /unsupported keyword "enum"/);
  });

  it('rejects a name in required that is not in properties', () => {
    const doc = expectations();
    wantAnswer(doc).required.push('total');
    assert.match(errorsOf(doc)[0].message, /"total" is in required but not in properties/);
  });

  it('rejects a provider name that is not a service name, and the service itself', () => {
    let doc = expectations();
    doc.expects['../orgs'] = doc.expects.core;
    assert.equal(errorsOf(doc).length, 1);
    doc = expectations();
    doc.expects.catalogue = doc.expects.core;
    assert.match(errorsOf(doc)[0].message, /itself/);
  });

  it('rejects a sends entry that does not match the pattern', () => {
    const doc = expectations();
    doc.expects.core['GET /items'].sends.push('cookie:x');
    assert.match(errorsOf(doc)[0].message, /request input/);
  });

  it('rejects an unknown key, and a missing expects', () => {
    let doc = expectations();
    doc.expect = {};
    assert.match(errorsOf(doc)[0].message, /unknown key "expect"/);
    doc = expectations();
    delete doc.expects;
    assert.match(errorsOf(doc)[0].message, /"expects" is required/);
  });

  it('accepts an endpoint without sends and without answers (the consumer reads no body)', () => {
    const doc = expectations();
    doc.expects.core['GET /health'] = {};
    assert.deepEqual(errorsOf(doc), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Provider against its own production contract: B1 to B6
// ---------------------------------------------------------------------------------------------------------------------

describe('compareContracts: the breaking changes', () => {
  const compare = (change) => {
    const next = contract();
    change(next);
    return compareContracts(contract(), next);
  };

  it('finds no difference between two equal contracts', () => {
    assert.deepEqual(compareContracts(contract(), contract()), []);
  });

  it('B1: a field that is gone', () => {
    const [v, ...rest] = compare((next) => delete listAnswer(next).properties.service);
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'B1', endpoint: 'GET /items', status: '200', path: 'service' });
    assert.match(v.hint, /breaking-change-approved/);
  });

  it('B1: a field in an array item has the path items[].name', () => {
    const [v, ...rest] = compare((next) => delete listItem(next).properties.name);
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'B1', endpoint: 'GET /items', status: '200', path: 'items[].name' });
  });

  it('B1: a removed field is not reported a second time as B3', () => {
    const found = compare((next) => {
      delete listItem(next).properties.name;
      listItem(next).required = ['id'];
    });
    assert.deepEqual(found.map((v) => v.rule), ['B1']);
  });

  it('B1: a field in an object in an array in an object, and an array of arrays', () => {
    const old = contract();
    old.endpoints['GET /items'].responses['200'].properties.grid = {
      type: 'array',
      items: { type: 'array', items: { type: 'object', required: ['cell'], properties: { cell: { type: 'string' } } } },
    };
    old.endpoints['GET /items'].responses['200'].properties.meta = {
      type: 'object',
      properties: { page: { type: 'object', properties: { size: { type: 'integer' } } } },
    };
    const next = structuredClone(old);
    delete next.endpoints['GET /items'].responses['200'].properties.grid.items.items.properties.cell;
    next.endpoints['GET /items'].responses['200'].properties.grid.items.items.required = [];
    delete next.endpoints['GET /items'].responses['200'].properties.meta.properties.page.properties.size;
    const found = compareContracts(old, next);
    assert.deepEqual(found.map((v) => [v.rule, v.path]), [
      ['B1', 'grid[][].cell'],
      ['B1', 'meta.page.size'],
    ]);
  });

  it('B1: the item schema of an array is gone', () => {
    const [v] = compare((next) => delete listAnswer(next).properties.items.items);
    assertViolation(v, { rule: 'B1', path: 'items[]' });
  });

  it('B1: finds a field that is named like a property of Object.prototype', () => {
    const old = contract();
    listAnswer(old).properties.constructor = { type: 'string' };
    const found = compareContracts(old, contract());
    assert.deepEqual(found.map((v) => [v.rule, v.path]), [['B1', 'constructor']]);
  });

  it('B2: a type that changed', () => {
    const [v, ...rest] = compare((next) => {
      listItem(next).properties.id.type = 'number';
    });
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'B2', endpoint: 'GET /items', status: '200', path: 'items[].id', from: 'string', to: 'number' });
  });

  it('B2: integer to number is breaking', () => {
    const old = contract();
    listItem(old).properties.price = { type: 'integer' };
    const next = contract();
    listItem(next).properties.price = { type: 'number' };
    assertViolation(compareContracts(old, next)[0], { rule: 'B2', path: 'items[].price', from: 'integer', to: 'number' });
  });

  it('B2: a field that was an object and is an array now', () => {
    const [v] = compare((next) => {
      listAnswer(next).properties.items = { type: 'object' };
    });
    assertViolation(v, { rule: 'B2', path: 'items', from: 'array', to: 'object' });
  });

  it('B2: the type of the answer itself, with the path of the body', () => {
    const [v] = compare((next) => {
      next.endpoints['GET /items'].responses['200'] = { type: 'array' };
    });
    assertViolation(v, { rule: 'B2', path: '', from: 'object', to: 'array' });
  });

  it('B2: does not look inside a field that changed its type', () => {
    const found = compare((next) => {
      listAnswer(next).properties.items = { type: 'string' };
    });
    assert.deepEqual(found.map((v) => v.rule), ['B2']);
  });

  it('B3: a field that became optional', () => {
    const [v, ...rest] = compare((next) => {
      listItem(next).required = ['id'];
    });
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'B3', endpoint: 'GET /items', status: '200', path: 'items[].name' });
  });

  it('B3: a field of the answer that became optional', () => {
    const [v] = compare((next) => {
      listAnswer(next).required = ['service', 'version'];
    });
    assertViolation(v, { rule: 'B3', path: 'items' });
  });

  it('B4: a status code without a schema', () => {
    const [v, ...rest] = compare((next) => delete next.endpoints['GET /items/{id}'].responses['404']);
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'B4', endpoint: 'GET /items/{id}', status: '404' });
  });

  it('B5: an endpoint that is gone', () => {
    const [v, ...rest] = compare((next) => delete next.endpoints['GET /items/{id}']);
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'B5', endpoint: 'GET /items/{id}', status: '' });
  });

  it('B6: a new required request input', () => {
    const [v, ...rest] = compare((next) => next.endpoints['GET /items'].request.required.push('header:x-trace'));
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'B6', endpoint: 'GET /items', input: 'header:x-trace' });
  });

  it('B6: an optional request input that became required', () => {
    const [v] = compare((next) => {
      next.endpoints['GET /items'].request = { required: ['query:limit'], optional: [] };
    });
    assertViolation(v, { rule: 'B6', endpoint: 'GET /items', input: 'query:limit' });
  });

  it('reports several violations in the order of the contract', () => {
    const found = compare((next) => {
      delete next.endpoints['GET /items'].responses['200'].properties.service;
      delete next.endpoints['GET /items/{id}'];
    });
    assert.deepEqual(found.map((v) => v.rule), ['B1', 'B5']);
  });

  it('gives every violation a hint that names the label', () => {
    const found = compare((next) => {
      delete listItem(next).properties.name;
      listItem(next).properties.id.type = 'number';
      delete next.endpoints['GET /items/{id}'].responses['404'];
      delete next.endpoints['GET /items/{id}'].responses['200'].properties.name;
      next.endpoints['GET /items'].request.required.push('query:q');
    });
    assert.deepEqual(new Set(found.map((v) => v.rule)), new Set(['B1', 'B2', 'B4', 'B6']));
    for (const v of found) assert.match(v.hint, /label breaking-change-approved/, v.rule);
  });
});

describe('compareContracts: the changes that pass', () => {
  const pass = (change) => {
    const next = contract();
    change(next);
    assert.deepEqual(compareContracts(contract(), next), []);
  };

  it('a new property', () => pass((next) => (listItem(next).properties.color = { type: 'string' })));
  it('a new required property', () =>
    pass((next) => {
      listItem(next).properties.color = { type: 'string' };
      listItem(next).required.push('color');
    }));
  it('a new endpoint, also with a required input', () =>
    pass((next) => {
      next.endpoints['POST /items'] = {
        request: { required: ['body:name'], optional: [] },
        responses: { 201: { type: 'object' } },
      };
    }));
  it('a new status code', () => pass((next) => (next.endpoints['GET /items'].responses['500'] = { type: 'object' })));
  it('a new optional request input', () =>
    pass((next) => next.endpoints['GET /items'].request.optional.push('query:offset')));
  it('an optional request input that stays optional', () => pass(() => {}));
  it('a required request input that stays required', () => pass(() => {}));
  it('a request input that is gone (the provider ignores what the consumer sends)', () =>
    pass((next) => (next.endpoints['GET /items'].request.optional = [])));
  it('an optional field that became required (the provider promises more)', () =>
    pass((next) => {
      listItem(next).required.push('price');
    }));
  it('number to integer (the new type is narrower)', () => {
    const old = contract();
    const next = contract();
    next.endpoints['GET /items'].responses['200'].properties.items.items.properties.price = { type: 'integer' };
    assert.deepEqual(compareContracts(old, next), []);
  });
  it('a new description', () => pass((next) => (listItem(next).properties.id.description = 'The id')));
  it('a new consumer', () => pass((next) => next.consumers.push('web')));
});

// ---------------------------------------------------------------------------------------------------------------------
// Consumer expectations against a provider contract: X1 to X5
// ---------------------------------------------------------------------------------------------------------------------

describe('verifyExpectations', () => {
  const verify = ({ change, changeWant } = {}) => {
    const c = contract();
    const e = expectations();
    change?.(c);
    changeWant?.(e);
    return verifyExpectations(c, e, 'core');
  };

  it('finds nothing when the contract keeps every promise that the consumer reads', () => {
    assert.deepEqual(verify(), []);
  });

  it('finds nothing when the consumer expects nothing from this provider', () => {
    assert.deepEqual(verifyExpectations(contract(), expectations(), 'account'), []);
  });

  it('passes when the contract has more than the consumer reads', () => {
    assert.deepEqual(
      verify({
        change: (c) => {
          listItem(c).properties.color = { type: 'string' };
          c.endpoints['POST /items'] = { responses: { 201: { type: 'object' } } };
        },
      }),
      [],
    );
  });

  it('X1: the contract has no such endpoint', () => {
    const [v, ...rest] = verify({ change: (c) => delete c.endpoints['GET /items'] });
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'X1', endpoint: 'GET /items', status: '', provider: 'core' });
  });

  it('X1: the contract has no schema for the expected status code', () => {
    const [v, ...rest] = verify({
      change: (c) => delete c.endpoints['GET /items/{id}'].responses['200'],
    });
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'X1', endpoint: 'GET /items/{id}', status: '200' });
  });

  it('X2: a required field that the contract does not have', () => {
    const [v, ...rest] = verify({ change: (c) => delete listAnswer(c).properties.version });
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'X2', endpoint: 'GET /items', status: '200', path: 'version' });
  });

  it('X2: a field in an array item has the path items[].name', () => {
    const [v] = verify({ change: (c) => delete listItem(c).properties.name });
    assertViolation(v, { rule: 'X2', path: 'items[].name' });
  });

  it('passes when an optional field of the consumer is not in the contract', () => {
    // price is in properties, but not in required, so the consumer copes when it is missing.
    assert.deepEqual(verify({ change: (c) => delete listItem(c).properties.price }), []);
  });

  it('X2: the item schema of an array is not in the contract', () => {
    const [v] = verify({ change: (c) => delete listAnswer(c).properties.items.items });
    assertViolation(v, { rule: 'X2', path: 'items[]' });
  });

  it('X3: another type, for a required field', () => {
    const [v, ...rest] = verify({ change: (c) => (listItem(c).properties.name.type = 'number') });
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'X3', path: 'items[].name', expected: 'string', actual: 'number' });
  });

  it('X3: another type, for an optional field', () => {
    const [v] = verify({ change: (c) => (listItem(c).properties.price.type = 'string') });
    assertViolation(v, { rule: 'X3', path: 'items[].price', expected: 'number', actual: 'string' });
  });

  it('X3: an array where the consumer expects an object', () => {
    const [v] = verify({ change: (c) => (listAnswer(c).properties.items = { type: 'object' }) });
    assertViolation(v, { rule: 'X3', path: 'items', expected: 'array', actual: 'object' });
  });

  it('passes when the contract says integer and the consumer expects number', () => {
    assert.deepEqual(verify({ change: (c) => (listItem(c).properties.price.type = 'integer') }), []);
  });

  it('X3: the contract says number and the consumer expects integer', () => {
    const [v] = verify({
      changeWant: (e) => (wantItem(e).properties.price.type = 'integer'),
    });
    assertViolation(v, { rule: 'X3', path: 'items[].price', expected: 'integer', actual: 'number' });
  });

  it('X4: the consumer needs a field, and the contract does not require it', () => {
    const [v, ...rest] = verify({ change: (c) => (listItem(c).required = ['id']) });
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'X4', path: 'items[].name' });
  });

  it('X5: the contract requires an input that the consumer does not send', () => {
    const [v, ...rest] = verify({ change: (c) => c.endpoints['GET /items'].request.required.push('query:page') });
    assert.equal(rest.length, 0);
    assertViolation(v, { rule: 'X5', endpoint: 'GET /items', input: 'query:page' });
  });

  it('passes when the consumer sends the required input', () => {
    assert.deepEqual(
      verify({ change: (c) => c.endpoints['GET /items'].request.required.push('query:page'), changeWant: (e) => e.expects.core['GET /items'].sends.push('query:page') }),
      [],
    );
  });

  it('reports every violation of an endpoint, in order', () => {
    const found = verify({
      change: (c) => {
        delete listAnswer(c).properties.version;
        listItem(c).properties.name.type = 'number';
        c.endpoints['GET /items'].request.required.push('query:page');
      },
    });
    assert.deepEqual(found.map((v) => v.rule), ['X5', 'X2', 'X3']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------------------------

describe('cleanText', () => {
  it('removes newlines, control characters and the double colon', () => {
    const text = cleanText('a\r\nb\u0000c ::error::x ::::y');
    assert.doesNotMatch(text, /[\n\r\u0000]/);
    assert.doesNotMatch(text, /::/);
  });

  it('cuts a long text', () => {
    assert.ok(cleanText('x'.repeat(5000)).length <= 201);
  });
});

describe('annotation', () => {
  it('writes a workflow command with a title and a message', () => {
    assert.equal(annotation('error', 'A title', 'A message.'), '::error title=A title::A message.');
  });

  it('adds the file when it is given', () => {
    assert.equal(annotation('error', 'T', 'M', { file: 'contract.json' }), '::error file=contract.json,title=T::M');
  });

  it('cannot be used to inject a command through untrusted text', () => {
    const line = annotation('error', 'T', 'field a\n::set-output name=x::y and ::add-mask::z 100%\r\n::error::w');
    assert.equal(line.split('\n').length, 1);
    assert.equal(line.match(/::/g).length, 2, line);
    assert.match(line, /100%25/);
  });

  it('removes a comma or a colon from the title, so it cannot add a property', () => {
    const line = annotation('error', 'T,file=x::y', 'M');
    assert.equal(line.match(/::/g).length, 2);
    assert.doesNotMatch(line, /title=T,file/);
  });
});

describe('describeViolation', () => {
  const breaking = { kind: 'breaking', service: 'core', version: '0.8.0' };

  it('B1 says what changed, why it matters and what to do', () => {
    const v = compareContracts(contract(), (() => {
      const next = contract();
      delete listItem(next).properties.name;
      return next;
    })())[0];
    const d = describeViolation(v, breaking);
    assert.equal(d.title, 'Breaking change B1 (field removed)');
    assert.equal(
      d.message,
      'GET /items 200: the field items[].name is in the production contract (core 0.8.0) but not in this pull request. ' +
        'A consumer may read it. ' +
        'Move the consumers to the new field and release them first. ' +
        'Then add the label breaking-change-approved to this pull request and run this job again.',
    );
  });

  it('B2, B3, B4, B5 and B6 name the thing that changed', () => {
    const base = { endpoint: 'GET /items', status: '200', path: '', input: '', from: '', to: '' };
    const text = (v) => describeViolation({ ...base, ...v, hint: 'h.' }, breaking).message;
    assert.match(text({ rule: 'B2', path: 'items[].id', from: 'string', to: 'number' }), /items\[\]\.id.*string.*number/);
    assert.match(text({ rule: 'B3', path: 'items[].name' }), /items\[\]\.name.*required.*optional/);
    assert.match(text({ rule: 'B4', status: '404' }), /status 404/);
    assert.match(text({ rule: 'B5', status: '' }), /endpoint GET \/items/);
    assert.match(text({ rule: 'B6', input: 'query:q' }), /query:q/);
  });

  it('X2 for a provider pull request names the consumer in Production', () => {
    const next = contract();
    delete listItem(next).properties.name;
    const [v] = verifyExpectations(next, expectations(), 'core');
    const d = describeViolation(v, { kind: 'consumer', consumer: 'catalogue', version: '0.7.1' });
    assert.equal(d.title, 'Consumer expects a field (X2)');
    assert.match(d.message, /^catalogue 0\.7\.1 \(in Production\) expects GET \/items 200: items\[\]\.name\. /);
    assert.match(d.message, /Release catalogue without that field first\.$/);
  });

  it('X2 for a consumer pull request names the provider in Production', () => {
    const c = contract();
    delete listItem(c).properties.name;
    const [v] = verifyExpectations(c, expectations(), 'core');
    const d = describeViolation(v, { kind: 'provider', provider: 'core', version: '0.8.0' });
    assert.match(d.message, /core/);
    assert.match(d.message, /items\[\]\.name/);
    assert.match(d.message, /0\.8\.0/);
    assert.match(d.message, /Release core with that field first/);
  });

  it('writes a message for every rule in both directions', () => {
    for (const ctx of [
      { kind: 'consumer', consumer: 'catalogue', version: '0.7.1' },
      { kind: 'provider', provider: 'core', version: '0.8.0' },
    ]) {
      for (const rule of ['X1', 'X2', 'X3', 'X4', 'X5']) {
        const d = describeViolation(
          { rule, endpoint: 'GET /items', status: rule === 'X5' ? '' : '200', path: 'a.b', input: 'query:q', expected: 'string', actual: 'number', provider: 'core' },
          ctx,
        );
        assert.match(d.title, new RegExp(`\\(${rule}\\)$`));
        assert.ok(d.message.length > 40, rule);
        assert.doesNotMatch(d.message, /undefined/, rule);
      }
    }
  });

  it('removes a newline and a double colon from a field name', () => {
    const d = describeViolation(
      { rule: 'B1', endpoint: 'GET /items', status: '200', path: 'a\n::error::pwned', input: '', from: '', to: '', hint: 'Do it.' },
      breaking,
    );
    assert.doesNotMatch(d.message, /[\n\r]/);
    assert.doesNotMatch(d.message, /::/);
    assert.match(d.message, /pwned/);
  });
});

describe('renderSummary', () => {
  it('writes a table of the checks', () => {
    const text = renderSummary({
      checks: [{ name: 'This contract against Production (core 0.8.0)', result: 'Passed', detail: '2 endpoints compared.' }],
      findings: [],
    });
    assert.match(text, /^### Contract check/);
    assert.match(text, /\| Check \| Result \| Detail \|/);
    assert.match(text, /\| This contract against Production \(core 0\.8\.0\) \| Passed \| 2 endpoints compared\. \|/);
  });

  it('writes a table of the findings, and says which ones the label approved', () => {
    const text = renderSummary({
      checks: [],
      findings: [
        { status: 'failed', rule: 'X2', where: 'GET /items 200', field: 'items[].name', detail: 'A detail.', hint: 'A hint.' },
        { status: 'approved', rule: 'B1', where: 'GET /items 200', field: 'service', detail: 'Another detail.', hint: 'Another hint.' },
      ],
    });
    assert.match(text, /\| Failed \| X2 \| GET \/items 200 \| items\\\[\\\]\.name \|/);
    assert.match(text, /\| Approved by label \| B1 \|/);
    assert.match(text, new RegExp(APPROVAL_LABEL));
  });

  it('does not let a field name break the table or add markup', () => {
    const text = renderSummary({
      checks: [],
      findings: [
        { status: 'failed', rule: 'B1', where: 'GET /items 200', field: 'a|b\n`<img src=x>`[x](http://evil)', detail: 'd.', hint: 'h.' },
      ],
    });
    const row = text.split('\n').find((line) => line.startsWith('| Failed'));
    assert.ok(row);
    // Take away every character that a backslash protects. What is left must hold no markup character,
    // and exactly the 7 bars of a table row with 6 columns.
    const bare = row.replace(/\\./g, '');
    assert.doesNotMatch(bare, /[<>[\]`]/);
    assert.equal(bare.match(/\|/g).length, 7);
  });
});
