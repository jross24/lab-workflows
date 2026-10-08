// The logic behind the contract check of a pull request. The README section "Contract tests" explains the design.
// These functions are pure: they read no file, call no API and read no clock. lib.test.mjs tests them.
// The code treats every text from the files as data that a pull request wrote. It never runs it, and it cleans it
// (cleanText) before a person or the runner reads it.

export const APPROVAL_LABEL = 'breaking-change-approved';
export const CONTRACT_FILE = 'contract.json';
export const EXPECTATIONS_FILE = 'expectations.json';
export const MARKER_ASSET = 'deployed-production.json';

// The same pattern as a service name in preflight.sh. A name goes into the name of a repository, so it must be strict.
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;
const REQUEST_INPUT_PATTERN = /^(query|header|body|path):[A-Za-z0-9_.-]+$/;
const ENDPOINT_PATTERN = /^[A-Z]+ \/\S*$/;
const STATUS_PATTERN = /^[0-9]{3}$/;

// The schema subset. Any other keyword is an error, so nobody thinks that it is checked.
const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
const SCHEMA_KEYWORDS = ['type', 'properties', 'required', 'items', 'description'];

const MAX_DEPTH = 16;
export const MAX_FILE_CHARACTERS = 1_000_000;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
// A field can have the name of a property of Object.prototype, for example "constructor". `in` would find it.
const own = (object, key) => Object.hasOwn(object, key);

// ---------------------------------------------------------------------------------------------------------------------
// Text from the files
// ---------------------------------------------------------------------------------------------------------------------

// Makes untrusted text safe for a log line: one line, no control character, no double colon, a limit on the length.
// The double colon starts a workflow command, and a command starts at the start of a line.
export function cleanText(value, max = 200) {
  let text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
  text = text.replace(/:{2,}/g, ':').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}

const escapeData = (text) => text.replace(/%/g, '%25');
const escapeProperty = (text) => text.replace(/%/g, '%25').replace(/,/g, '%2C').replace(/:/g, '%3A');

// One workflow command (::error, ::warning or ::notice). All the text is cleaned, so it cannot start a second command.
export function annotation(level, title, message, { file } = {}) {
  if (!['error', 'warning', 'notice'].includes(level)) throw new Error(`unknown annotation level ${level}`);
  const properties = [];
  if (file) properties.push(`file=${escapeProperty(cleanText(file))}`);
  properties.push(`title=${escapeProperty(cleanText(title))}`);
  return `::${level} ${properties.join(',')}::${escapeData(cleanText(message, 2000))}`;
}

// A table cell of the job summary. Text from a file must not add markup, a link or a column.
// A backslash before a punctuation mark makes GitHub show the mark as text.
function mdCell(value) {
  return cleanText(value, 300).replace(/[\\`*_[\]<>|~&]/g, '\\$&');
}

// ---------------------------------------------------------------------------------------------------------------------
// The formats: contract.json and expectations.json
// ---------------------------------------------------------------------------------------------------------------------

// The path of a place in a file, for example $.endpoints["GET /items"].responses["200"].type
function step(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

export function formatFileError(file, error) {
  return `${file}: ${error.path}: ${error.message}`;
}

function unknownKeys(object, allowed, path, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      errors.push({ path: step(path, key), message: `This is an unknown key "${key}". Use only: ${allowed.join(', ')}.` });
    }
  }
}

function validateSchema(schema, path, errors, depth) {
  if (!isObject(schema)) {
    errors.push({ path, message: 'A schema must be a JSON object.' });
    return;
  }
  if (depth > MAX_DEPTH) {
    errors.push({ path, message: `The schema is nested deeper than ${MAX_DEPTH} levels.` });
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.includes(key)) {
      errors.push({
        path: step(path, key),
        message: `This is an unsupported keyword "${key}". The check does not use it. Use only: ${SCHEMA_KEYWORDS.join(', ')}.`,
      });
    }
  }
  const type = schema.type;
  if (!own(schema, 'type')) errors.push({ path, message: 'The keyword "type" is required.' });
  else if (!SCHEMA_TYPES.includes(type)) {
    errors.push({ path: step(path, 'type'), message: `The type must be one of: ${SCHEMA_TYPES.join(', ')}.` });
  }
  if (own(schema, 'description') && typeof schema.description !== 'string') {
    errors.push({ path: step(path, 'description'), message: 'The description must be text.' });
  }

  if (own(schema, 'properties')) {
    const at = step(path, 'properties');
    if (type !== 'object') errors.push({ path: at, message: 'The keyword "properties" is allowed only when the type is object.' });
    else if (!isObject(schema.properties)) {
      errors.push({ path: at, message: 'The keyword "properties" must be a JSON object that maps a name to a schema.' });
    } else {
      for (const [name, child] of Object.entries(schema.properties)) validateSchema(child, step(at, name), errors, depth + 1);
    }
  }

  if (own(schema, 'required')) {
    const at = step(path, 'required');
    if (type !== 'object') errors.push({ path: at, message: 'The keyword "required" is allowed only when the type is object.' });
    else if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')) {
      errors.push({ path: at, message: 'The keyword "required" must be a list of names.' });
    } else {
      const seen = new Set();
      schema.required.forEach((name, index) => {
        if (!isObject(schema.properties) || !own(schema.properties, name)) {
          errors.push({ path: step(at, index), message: `The name "${name}" is in required but not in properties.` });
        }
        if (seen.has(name)) errors.push({ path: step(at, index), message: `The name "${name}" is in required more than once.` });
        seen.add(name);
      });
    }
  }

  if (own(schema, 'items')) {
    const at = step(path, 'items');
    if (type !== 'array') errors.push({ path: at, message: 'The keyword "items" is allowed only when the type is array.' });
    else validateSchema(schema.items, at, errors, depth + 1);
  }
}

function validateInputs(list, path, errors) {
  if (!Array.isArray(list)) {
    errors.push({ path, message: 'This must be a list of request inputs.' });
    return [];
  }
  const valid = [];
  list.forEach((entry, index) => {
    if (typeof entry === 'string' && REQUEST_INPUT_PATTERN.test(entry)) valid.push(entry);
    else {
      errors.push({
        path: step(path, index),
        message: `${JSON.stringify(entry)} is not a request input. Use query:<name>, header:<name>, body:<name> or path:<name>.`,
      });
    }
  });
  return valid;
}

function checkDuplicates(inputs, path, errors) {
  const seen = new Set();
  for (const input of inputs) {
    if (seen.has(input)) errors.push({ path, message: `The request input "${input}" is listed more than once.` });
    seen.add(input);
  }
}

function validateRequest(request, path, errors) {
  if (!isObject(request)) {
    errors.push({ path, message: 'The key "request" must be a JSON object.' });
    return;
  }
  unknownKeys(request, ['required', 'optional'], path, errors);
  const required = own(request, 'required') ? validateInputs(request.required, step(path, 'required'), errors) : [];
  const optional = own(request, 'optional') ? validateInputs(request.optional, step(path, 'optional'), errors) : [];
  checkDuplicates([...required, ...optional], path, errors);
}

function validateAnswers(answers, path, errors, { atLeastOne }) {
  if (!isObject(answers)) {
    errors.push({ path, message: 'The key "responses" must be a JSON object that maps a status code to a schema.' });
    return;
  }
  const codes = Object.keys(answers);
  if (atLeastOne && codes.length === 0) errors.push({ path, message: 'An endpoint must list at least one status code.' });
  for (const code of codes) {
    const at = step(path, code);
    if (!STATUS_PATTERN.test(code)) errors.push({ path: at, message: `"${code}" is not a status code. Use 3 digits, for example "200".` });
    else validateSchema(answers[code], at, errors, 0);
  }
}

function validEndpointKey(key, path, errors) {
  if (ENDPOINT_PATTERN.test(key)) return true;
  errors.push({ path: step(path, key), message: `The endpoint "${key}" must have the form "METHOD /path", for example "GET /items".` });
  return false;
}

function checkDescription(object, path, errors) {
  if (own(object, 'description') && typeof object.description !== 'string') {
    errors.push({ path: step(path, 'description'), message: 'The description must be text.' });
  }
}

function checkService(doc, expected, errors) {
  if (!own(doc, 'service')) {
    errors.push({ path: '$', message: 'The key "service" is required.' });
    return;
  }
  if (typeof doc.service !== 'string' || !NAME_PATTERN.test(doc.service)) {
    errors.push({ path: '$.service', message: 'The service must be a name: lower case letters, digits and hyphens.' });
    return;
  }
  if (expected !== undefined && doc.service !== expected) {
    errors.push({ path: '$.service', message: `The service is "${doc.service}", but pipeline.json has "${expected}".` });
  }
}

function validateNames(list, path, self, errors, what) {
  if (!Array.isArray(list)) {
    errors.push({ path, message: `The key "${what}" must be a list of service names.` });
    return;
  }
  const seen = new Set();
  list.forEach((name, index) => {
    const at = step(path, index);
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      errors.push({ path: at, message: 'A service name has lower case letters, digits and hyphens.' });
    } else if (name === self) {
      errors.push({ path: at, message: 'A service cannot be its own consumer.' });
    } else if (seen.has(name)) {
      errors.push({ path: at, message: `The service "${name}" is listed more than once.` });
    }
    seen.add(name);
  });
}

function validateContract(doc, service, errors) {
  if (!isObject(doc)) {
    errors.push({ path: '$', message: 'The file must hold one JSON object.' });
    return;
  }
  unknownKeys(doc, ['service', 'consumers', 'endpoints', 'description'], '$', errors);
  checkService(doc, service, errors);
  checkDescription(doc, '$', errors);
  if (own(doc, 'consumers')) validateNames(doc.consumers, '$.consumers', doc.service, errors, 'consumers');
  if (!own(doc, 'endpoints')) {
    errors.push({ path: '$', message: 'The key "endpoints" is required.' });
    return;
  }
  if (!isObject(doc.endpoints) || Object.keys(doc.endpoints).length === 0) {
    errors.push({ path: '$.endpoints', message: 'The key "endpoints" must be a JSON object with at least one endpoint.' });
    return;
  }
  for (const [key, endpoint] of Object.entries(doc.endpoints)) {
    const at = step('$.endpoints', key);
    validEndpointKey(key, '$.endpoints', errors);
    if (!isObject(endpoint)) {
      errors.push({ path: at, message: 'An endpoint must be a JSON object.' });
      continue;
    }
    unknownKeys(endpoint, ['request', 'responses', 'description'], at, errors);
    checkDescription(endpoint, at, errors);
    if (own(endpoint, 'request')) validateRequest(endpoint.request, step(at, 'request'), errors);
    if (!own(endpoint, 'responses')) errors.push({ path: at, message: 'The key "responses" is required.' });
    else validateAnswers(endpoint.responses, step(at, 'responses'), errors, { atLeastOne: true });
  }
}

function validateExpectations(doc, service, errors) {
  if (!isObject(doc)) {
    errors.push({ path: '$', message: 'The file must hold one JSON object.' });
    return;
  }
  unknownKeys(doc, ['service', 'expects', 'description'], '$', errors);
  checkService(doc, service, errors);
  checkDescription(doc, '$', errors);
  if (!own(doc, 'expects')) {
    errors.push({ path: '$', message: 'The key "expects" is required.' });
    return;
  }
  if (!isObject(doc.expects)) {
    errors.push({ path: '$.expects', message: 'The key "expects" must be a JSON object that maps a provider to its endpoints.' });
    return;
  }
  for (const [provider, endpoints] of Object.entries(doc.expects)) {
    const providerAt = step('$.expects', provider);
    if (!NAME_PATTERN.test(provider)) {
      errors.push({ path: providerAt, message: 'A provider name has lower case letters, digits and hyphens.' });
      continue;
    }
    if (provider === doc.service) {
      errors.push({ path: providerAt, message: 'A service cannot expect something from itself.' });
      continue;
    }
    if (!isObject(endpoints)) {
      errors.push({ path: providerAt, message: 'A provider must map to a JSON object of endpoints.' });
      continue;
    }
    for (const [key, endpoint] of Object.entries(endpoints)) {
      const at = step(providerAt, key);
      validEndpointKey(key, providerAt, errors);
      if (!isObject(endpoint)) {
        errors.push({ path: at, message: 'An endpoint must be a JSON object.' });
        continue;
      }
      unknownKeys(endpoint, ['sends', 'responses', 'description'], at, errors);
      checkDescription(endpoint, at, errors);
      if (own(endpoint, 'sends')) {
        const sends = validateInputs(endpoint.sends, step(at, 'sends'), errors);
        checkDuplicates(sends, step(at, 'sends'), errors);
      }
      // A consumer may call an endpoint and read no body. Then it lists no answer.
      if (own(endpoint, 'responses')) validateAnswers(endpoint.responses, step(at, 'responses'), errors, { atLeastOne: false });
    }
  }
}

function parseJson(text) {
  if (typeof text !== 'string') return { error: { path: '$', message: 'The file could not be read.' } };
  if (text.length > MAX_FILE_CHARACTERS) {
    return { error: { path: '$', message: `The file is larger than ${MAX_FILE_CHARACTERS} characters.` } };
  }
  try {
    return { value: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch (error) {
    return { error: { path: '$', message: `The file is not valid JSON: ${cleanText(error.message)}` } };
  }
}

function parseWith(validate, text, service) {
  const parsed = parseJson(text);
  if (parsed.error) return { doc: undefined, errors: [parsed.error] };
  const errors = [];
  validate(parsed.value, service, errors);
  return errors.length > 0 ? { doc: undefined, errors } : { doc: parsed.value, errors: [] };
}

// Both functions return { doc, errors }. errors is a list of { path, message }. doc is set only if there is no error.
// service is the service of pipeline.json. If it is undefined, the check of the name is left out.
export function parseContract(text, { service } = {}) {
  return parseWith(validateContract, text, service);
}

export function parseExpectations(text, { service } = {}) {
  return parseWith(validateExpectations, text, service);
}

// ---------------------------------------------------------------------------------------------------------------------
// The provider against its own production contract: B1 to B6
// ---------------------------------------------------------------------------------------------------------------------

const LABEL_STEP = `Then add the label ${APPROVAL_LABEL} to this pull request and run this job again.`;
const BREAKING_HINTS = {
  B1: `Move the consumers to the new field and release them first. ${LABEL_STEP}`,
  B2: `Move the consumers to a new field with the new type and release them first. ${LABEL_STEP}`,
  B3: `Release the consumers so that they cope with a missing field. ${LABEL_STEP}`,
  B4: `Move the consumers away from this status code and release them first. ${LABEL_STEP}`,
  B5: `Move the consumers to another endpoint and release them first. ${LABEL_STEP}`,
  B6: `Make the input optional. Or release the consumers so that they send it first, then add the label ${APPROVAL_LABEL} to this pull request and run this job again.`,
};

const joinPath = (path, name) => (path === '' ? name : `${path}.${name}`);

function violation(rule, fields) {
  return { rule, endpoint: '', status: '', path: '', input: '', from: '', to: '', expected: '', actual: '', provider: '', ...fields };
}

function breaking(rule, fields) {
  return { ...violation(rule, fields), hint: BREAKING_HINTS[rule] };
}

function compareSchema(oldSchema, newSchema, path, where, found) {
  if (oldSchema.type !== newSchema.type) {
    // The one allowed change: a reader of a number copes with an integer.
    if (oldSchema.type === 'number' && newSchema.type === 'integer') return;
    found.push(breaking('B2', { ...where, path, from: oldSchema.type, to: newSchema.type }));
    return;
  }
  if (oldSchema.type === 'object') {
    const newProperties = newSchema.properties ?? {};
    const oldRequired = oldSchema.required ?? [];
    const newRequired = newSchema.required ?? [];
    for (const [name, oldChild] of Object.entries(oldSchema.properties ?? {})) {
      const childPath = joinPath(path, name);
      if (!own(newProperties, name)) {
        found.push(breaking('B1', { ...where, path: childPath }));
        continue;
      }
      if (oldRequired.includes(name) && !newRequired.includes(name)) found.push(breaking('B3', { ...where, path: childPath }));
      compareSchema(oldChild, newProperties[name], childPath, where, found);
    }
  } else if (oldSchema.type === 'array' && oldSchema.items) {
    const childPath = `${path}[]`;
    if (!newSchema.items) found.push(breaking('B1', { ...where, path: childPath }));
    else compareSchema(oldSchema.items, newSchema.items, childPath, where, found);
  }
}

// Compares the contract that runs in Production (old) with the contract of the pull request (new).
// Both are valid documents (parseContract). Returns a list of violations. An empty list means that nothing breaks.
export function compareContracts(oldContract, newContract) {
  const found = [];
  for (const [endpoint, oldEndpoint] of Object.entries(oldContract.endpoints)) {
    if (!own(newContract.endpoints, endpoint)) {
      found.push(breaking('B5', { endpoint }));
      continue;
    }
    const newEndpoint = newContract.endpoints[endpoint];
    const oldRequired = oldEndpoint.request?.required ?? [];
    for (const input of newEndpoint.request?.required ?? []) {
      if (!oldRequired.includes(input)) found.push(breaking('B6', { endpoint, input }));
    }
    for (const [status, oldSchema] of Object.entries(oldEndpoint.responses)) {
      if (!own(newEndpoint.responses, status)) {
        found.push(breaking('B4', { endpoint, status }));
        continue;
      }
      compareSchema(oldSchema, newEndpoint.responses[status], '', { endpoint, status }, found);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// The expectations of a consumer against a provider contract: X1 to X5
// ---------------------------------------------------------------------------------------------------------------------

function verifySchema(have, want, path, where, found) {
  if (want.type !== have.type) {
    // An integer is a valid value where the consumer expects a number.
    if (want.type === 'number' && have.type === 'integer') return;
    found.push(violation('X3', { ...where, path, expected: want.type, actual: have.type }));
    return;
  }
  if (want.type === 'object') {
    const haveProperties = have.properties ?? {};
    const haveRequired = have.required ?? [];
    const wantRequired = want.required ?? [];
    for (const [name, wantChild] of Object.entries(want.properties ?? {})) {
      const childPath = joinPath(path, name);
      const needed = wantRequired.includes(name);
      if (!own(haveProperties, name)) {
        // A field that the consumer reads only when it is there does no harm when the contract does not have it.
        if (needed) found.push(violation('X2', { ...where, path: childPath }));
        continue;
      }
      if (needed && !haveRequired.includes(name)) found.push(violation('X4', { ...where, path: childPath }));
      verifySchema(haveProperties[name], wantChild, childPath, where, found);
    }
  } else if (want.type === 'array' && want.items) {
    const childPath = `${path}[]`;
    if (!have.items) found.push(violation('X2', { ...where, path: childPath }));
    else verifySchema(have.items, want.items, childPath, where, found);
  }
}

// Checks what a consumer reads against a provider contract. expectations is the whole document of the consumer.
// The function looks at expectations.expects[providerName]. Both are valid documents.
export function verifyExpectations(contract, expectations, providerName) {
  const wanted = isObject(expectations?.expects) && own(expectations.expects, providerName) ? expectations.expects[providerName] : undefined;
  if (!wanted) return [];
  const found = [];
  for (const [endpoint, want] of Object.entries(wanted)) {
    if (!own(contract.endpoints, endpoint)) {
      found.push(violation('X1', { endpoint, provider: providerName }));
      continue;
    }
    const have = contract.endpoints[endpoint];
    const sends = want.sends ?? [];
    for (const input of have.request?.required ?? []) {
      if (!sends.includes(input)) found.push(violation('X5', { endpoint, input, provider: providerName }));
    }
    for (const [status, wantSchema] of Object.entries(want.responses ?? {})) {
      if (!own(have.responses, status)) {
        found.push(violation('X1', { endpoint, status, provider: providerName }));
        continue;
      }
      verifySchema(have.responses[status], wantSchema, '', { endpoint, status, provider: providerName }, found);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// The words of a violation
// ---------------------------------------------------------------------------------------------------------------------

const BREAKING_TITLES = {
  B1: 'Breaking change B1 (field removed)',
  B2: 'Breaking change B2 (type changed)',
  B3: 'Breaking change B3 (field became optional)',
  B4: 'Breaking change B4 (status removed)',
  B5: 'Breaking change B5 (endpoint removed)',
  B6: 'Breaking change B6 (request input now required)',
};

const CONSUMER_TITLES = {
  X1: 'Consumer expects an answer (X1)',
  X2: 'Consumer expects a field (X2)',
  X3: 'Consumer expects another type (X3)',
  X4: 'Consumer needs a field (X4)',
  X5: 'Consumer does not send an input (X5)',
};

const PROVIDER_TITLES = {
  X1: 'Expected answer not in Production (X1)',
  X2: 'Expected field not in Production (X2)',
  X3: 'Type differs from Production (X3)',
  X4: 'Field not guaranteed in Production (X4)',
  X5: 'Required input not sent (X5)',
};

function describeBreaking(v, ctx, c) {
  const production = `the production contract (${c(ctx.service)} ${c(ctx.version)})`;
  const where = [c(v.endpoint), c(v.status)].filter(Boolean).join(' ');
  switch (v.rule) {
    case 'B1':
      return `${where}: the field ${c(v.path)} is in ${production} but not in this pull request. A consumer may read it.`;
    case 'B2': {
      const subject = v.path === '' ? 'the body of the answer' : `the field ${c(v.path)}`;
      return `${where}: the type of ${subject} is ${c(v.from)} in ${production}, but ${c(v.to)} in this pull request. A consumer may read the old type.`;
    }
    case 'B3':
      return `${where}: the field ${c(v.path)} is required in ${production}, but optional in this pull request. A consumer may rely on it.`;
    case 'B4':
      return `${c(v.endpoint)}: the status ${c(v.status)} is in ${production}, but not in this pull request. A consumer may handle it.`;
    case 'B5':
      return `The endpoint ${c(v.endpoint)} is in ${production}, but not in this pull request. A consumer may call it.`;
    case 'B6':
      return `${c(v.endpoint)}: this pull request requires the input ${c(v.input)}, but ${production} does not. A consumer may not send it.`;
    default:
      throw new Error(`unknown rule ${v.rule}`);
  }
}

// A provider pull request. The consumer runs in Production and expects something of the contract in the pull request.
function describeConsumer(v, ctx, c) {
  const who = `${c(ctx.consumer)} ${c(ctx.version)} (in Production)`;
  const where = [c(v.endpoint), c(v.status)].filter(Boolean).join(' ');
  const field = v.path === '' ? 'the body' : c(v.path);
  const consumer = c(ctx.consumer);
  switch (v.rule) {
    case 'X1':
      return v.status === ''
        ? {
            detail: `${who} expects the endpoint ${c(v.endpoint)}. The contract in this pull request does not have it.`,
            hint: `Release ${consumer} without that endpoint first.`,
          }
        : {
            detail: `${who} expects the status ${c(v.status)} of ${c(v.endpoint)}. The contract in this pull request has no schema for it.`,
            hint: `Release ${consumer} without that status first.`,
          };
    case 'X2':
      return {
        detail: `${who} expects ${where}: ${field}. The contract in this pull request does not have it.`,
        hint: `Release ${consumer} without that field first.`,
      };
    case 'X3':
      return {
        detail: `${who} expects ${where}: ${field} to be ${c(v.expected)}. The contract in this pull request says ${c(v.actual)}.`,
        hint: 'Keep the old type in the contract. Or give the new type a new field name.',
      };
    case 'X4':
      return {
        detail: `${who} needs ${where}: ${field} to be always there. The contract in this pull request does not list it in required.`,
        hint: `Keep the field in required. Or release ${consumer} so that it copes with a missing field first.`,
      };
    case 'X5':
      return {
        detail: `${who} does not send the input ${c(v.input)} to ${c(v.endpoint)}. The contract in this pull request requires it.`,
        hint: `Make the input optional. Or release ${consumer} so that it sends the input first.`,
      };
    default:
      throw new Error(`unknown rule ${v.rule}`);
  }
}

// A consumer pull request. The provider runs in Production, and the pull request expects something of its contract.
function describeProvider(v, ctx, c) {
  const provider = c(ctx.provider);
  const production = `The production contract (${provider} ${c(ctx.version)})`;
  const where = [c(v.endpoint), c(v.status)].filter(Boolean).join(' ');
  const field = v.path === '' ? 'the body' : c(v.path);
  switch (v.rule) {
    case 'X1':
      return v.status === ''
        ? {
            detail: `This pull request expects the endpoint ${c(v.endpoint)} of ${provider}. ${production} does not have it.`,
            hint: `Release ${provider} with that endpoint first. Or remove it from expectations.json.`,
          }
        : {
            detail: `This pull request expects the status ${c(v.status)} of ${c(v.endpoint)} of ${provider}. ${production} has no schema for it.`,
            hint: `Release ${provider} with that status first. Or remove it from expectations.json.`,
          };
    case 'X2':
      return {
        detail: `This pull request expects ${where} of ${provider}: ${field}. ${production} does not have it.`,
        hint: `Release ${provider} with that field first. Or make the field optional in expectations.json.`,
      };
    case 'X3':
      return {
        detail: `This pull request expects ${where} of ${provider}: ${field} to be ${c(v.expected)}. ${production} says ${c(v.actual)}.`,
        hint: `Change the type in expectations.json. Or release ${provider} with that type first.`,
      };
    case 'X4':
      return {
        detail: `This pull request needs ${where} of ${provider}: ${field} to be always there. ${production} does not list it in required.`,
        hint: `Make the field optional in expectations.json. Or release ${provider} with the field in required first.`,
      };
    case 'X5':
      return {
        detail: `This pull request does not send the input ${c(v.input)} to ${c(v.endpoint)} of ${provider}. ${production} requires it.`,
        hint: 'Add the input to sends in expectations.json, and send it in the code.',
      };
    default:
      throw new Error(`unknown rule ${v.rule}`);
  }
}

// Turns a violation into words. ctx says who is who:
//   { kind: 'breaking', service, version }     a provider pull request against its production contract (B1 to B6)
//   { kind: 'consumer', consumer, version }    a provider pull request against a consumer in Production (X1 to X5)
//   { kind: 'provider', provider, version }    a consumer pull request against a provider in Production (X1 to X5)
// Every text from a file goes through cleanText. The message is safe for a log line.
export function describeViolation(v, ctx) {
  const c = (value) => cleanText(value);
  const where = [c(v.endpoint), c(v.status)].filter(Boolean).join(' ');
  const field = v.path !== '' ? c(v.path) : c(v.input);
  let title;
  let detail;
  let hint;
  if (ctx.kind === 'breaking') {
    title = BREAKING_TITLES[v.rule];
    detail = describeBreaking(v, ctx, c);
    hint = v.hint ?? BREAKING_HINTS[v.rule];
  } else if (ctx.kind === 'consumer' || ctx.kind === 'provider') {
    title = (ctx.kind === 'consumer' ? CONSUMER_TITLES : PROVIDER_TITLES)[v.rule];
    ({ detail, hint } = (ctx.kind === 'consumer' ? describeConsumer : describeProvider)(v, ctx, c));
  } else {
    throw new Error(`unknown context ${ctx.kind}`);
  }
  return { rule: v.rule, title, where, field, detail, hint, message: `${detail} ${hint}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// The job summary
// ---------------------------------------------------------------------------------------------------------------------

// checks:   [{ name, result, detail }]   one row for each comparison that the job made
// findings: [{ status: 'failed' | 'approved', rule, where, field, detail, hint }]
export function renderSummary({ checks = [], findings = [] }) {
  const lines = ['### Contract check', ''];
  if (checks.length > 0) {
    lines.push('| Check | Result | Detail |', '| --- | --- | --- |');
    for (const check of checks) lines.push(`| ${mdCell(check.name)} | ${mdCell(check.result)} | ${mdCell(check.detail)} |`);
  }
  if (findings.length > 0) {
    if (checks.length > 0) lines.push('');
    lines.push('| Result | Rule | Where | Field or input | What is wrong | What to do |', '| --- | --- | --- | --- | --- | --- |');
    for (const finding of findings) {
      const result = finding.status === 'approved' ? 'Approved by label' : 'Failed';
      lines.push(
        `| ${result} | ${mdCell(finding.rule)} | ${mdCell(finding.where)} | ${mdCell(finding.field)} | ${mdCell(finding.detail)} | ${mdCell(finding.hint)} |`,
      );
    }
  }
  if (findings.some((finding) => finding.status === 'approved')) {
    lines.push(
      '',
      `The label \`${APPROVAL_LABEL}\` is on this pull request. It lets the breaking changes B1 to B6 pass. It never lets X1 to X5 pass.`,
    );
  }
  return lines.join('\n');
}
