// The rules for the list of accepted advisories (accepted-advisories.json in the root of this repository).
// This file has no I/O and does not read the clock. The caller passes the date of today as YYYY-MM-DD.
//
// An entry has five fields. All five are required:
//   id       the GitHub advisory id, for example GHSA-6j4f-fj2g-mc7p
//   package  the package that the advisory is about
//   reason   one line: why nobody can fix it now
//   issue    the issue that tracks the fix, as owner/repo#number
//   expires  the last day that the entry applies, as YYYY-MM-DD
//
// An entry applies up to and including the day of `expires`. The day after, it is expired and the check fails again.

export const MAX_DAYS = 90;

const FIELDS = ['id', 'package', 'reason', 'issue', 'expires'];
// A GHSA id has three groups of four characters. GitHub uses only these characters.
const GHSA_ID = /^GHSA(-[2-9cfghjmpqrvwx]{4}){3}$/;
const ISSUE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function isFilled(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function parseList(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`The list is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(data)) throw new Error('The list must be an array of entries.');
  return data;
}

function nameOf(entry, index) {
  if (entry && isFilled(entry.id)) {
    return isFilled(entry.package) ? `${entry.id} (${entry.package})` : entry.id;
  }
  return `entry ${index + 1}`;
}

function problemsOf(entry, today) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return ['the entry is not an object.'];
  const found = [];
  for (const field of FIELDS) {
    if (!isFilled(entry[field])) found.push(`the field "${field}" is missing or empty.`);
  }
  if (isFilled(entry.id) && !GHSA_ID.test(entry.id)) found.push(`"id" is not a GHSA id: ${JSON.stringify(entry.id)}.`);
  if (isFilled(entry.reason) && /[\r\n]/.test(entry.reason.trim())) found.push('"reason" must be one line.');
  if (isFilled(entry.issue) && !ISSUE.test(entry.issue)) {
    found.push(`"issue" must look like owner/repo#number: ${JSON.stringify(entry.issue)}.`);
  }
  if (entry.expires !== undefined && entry.expires !== null && !isDate(entry.expires)) {
    found.push(`"expires" must be a real date as YYYY-MM-DD: ${JSON.stringify(entry.expires)}.`);
  }
  if (isDate(entry.expires)) {
    if (entry.expires < today) {
      const tracked = isFilled(entry.issue) ? ` (tracked in ${entry.issue})` : '';
      found.push(
        `expired on ${entry.expires}${tracked}. Today is ${today}. Remove the entry, or renew it in a pull request with a new date and a new reason.`,
      );
    } else if ((Date.parse(`${entry.expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS > MAX_DAYS) {
      found.push(`"expires" is more than ${MAX_DAYS} days after today (${today}). Choose a nearer date.`);
    }
  }
  return found;
}

// Splits the entries into the ones that apply today and a list of messages about the others.
// A message starts with the name of the entry, so a reader finds the entry at once.
export function evaluate(entries, today) {
  if (!isDate(today)) throw new Error(`The date of today must be YYYY-MM-DD. Got ${JSON.stringify(today)}.`);
  const allowed = [];
  const problems = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    const found = problemsOf(entry, today);
    if (found.length === 0 && seen.has(entry.id)) found.push('the id is listed twice.');
    if (found.length === 0) {
      seen.add(entry.id);
      allowed.push(entry);
    } else {
      for (const message of found) problems.push(`${nameOf(entry, index)}: ${message}`);
    }
  });
  return { allowed, problems };
}

// The value for the input allow-ghsas of actions/dependency-review-action: ids separated by commas.
export function allowList(allowed) {
  return allowed.map((entry) => entry.id).join(',');
}
