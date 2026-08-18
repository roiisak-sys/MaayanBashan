// Airtable eligibility lookup.
//
// Runs server-side only. Nothing from Airtable is ever returned to the browser
// beyond a boolean decision plus the canonical name to print on the
// certificate.

import { normalizeName, normalizeId, normalizePhone } from './text.mjs';

/** Thrown when Airtable itself is unreachable/misconfigured, as opposed to a
 *  simple "no match" result. Lets the caller distinguish 503 from 401. */
export class AirtableUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AirtableUnavailableError';
  }
}

export function getAirtableConfig(env = process.env) {
  const config = {
    token: env.AIRTABLE_PAT || env.AIRTABLE_TOKEN,
    baseId: env.AIRTABLE_BASE_ID || 'appiziy69WzC5SqDK',
    tableId: env.AIRTABLE_TABLE_NAME || 'tbl3s3NLLL75Siqg3',

    // Field IDs are used rather than names: names in this base are Hebrew and
    // renaming a column in the Airtable UI would silently break lookups.
    nameField: env.AIRTABLE_NAME_FIELD || 'fldtIhXNTeKPPs41O',
    idField: env.AIRTABLE_ID_FIELD || 'fldFPugfcZDT70yhP',
    statusField: env.AIRTABLE_STATUS_FIELD || 'fld9Smx5O2HTn4zus',
    courseField: env.AIRTABLE_COURSE_FIELD || 'fldy6DhZezw4gVZuq',

    // Two phone columns exist and neither is dependably formatted, so both are
    // read and a match against either is accepted.
    phoneField: env.AIRTABLE_PHONE_FIELD || 'fldIaXr31RLDOZgUh',
    phoneFormulaField: env.AIRTABLE_PHONE_FORMULA_FIELD || 'flddifziqcl15DjxE',

    // Formulas can only reference fields by name, so this one is the display
    // name rather than the ID. Must be updated if the column is renamed.
    statusFieldName: env.AIRTABLE_STATUS_FIELD_NAME || 'סטטוס',

    // Eligibility: the July 2026 cohort, fully paid.
    targetCourseRecordId: env.TARGET_COURSE_RECORD_ID || 'recKv98sOFZmx3cOT',
    paidStatus: env.PAID_STATUS || 'שילם',

    // Strict mode: the submitted ID must already match a stored ID.
    // Off by default because the ID column starts out empty — see README.
    requireId: env.CERT_REQUIRE_ID === 'true',

    // Trust-on-first-use: when a participant has no ID on file, store the one
    // they supply so it becomes a verification factor for every later request.
    recordId: env.CERT_WRITE_ID !== 'false',
  };

  if (!config.token) {
    throw new AirtableUnavailableError('AIRTABLE_PAT is not configured');
  }
  return config;
}

/**
 * Fetch the eligible cohort (July 2026 + paid) and match the supplied details
 * against it in memory.
 *
 * Matching is done server-side rather than via filterByFormula because the
 * stored values need the same Unicode/whitespace normalization as the user
 * input before they can be compared reliably — the live data contains names
 * with leading/trailing spaces and mixed casing.
 *
 * Only the fields required for matching are requested from Airtable.
 */
export async function findEligibleParticipant({ name, phone, idNumber, env = process.env, fetchImpl = fetch }) {
  const config = getAirtableConfig(env);

  // filterByFormula can only reference fields by NAME (field IDs are not valid
  // inside a formula), so the status name is configurable separately from the
  // field ID used to read values back.
  const params = new URLSearchParams();
  params.set(
    'filterByFormula',
    `{${config.statusFieldName}} = '${config.paidStatus.replace(/'/g, "\\'")}'`
  );
  params.set('pageSize', '100');
  // Without this the response is keyed by field NAME; we want IDs so that
  // renaming a Hebrew column in the Airtable UI cannot break the lookup.
  params.set('returnFieldsByFieldId', 'true');
  params.append('fields[]', config.nameField);
  params.append('fields[]', config.idField);
  params.append('fields[]', config.courseField);
  params.append('fields[]', config.phoneField);
  params.append('fields[]', config.phoneFormulaField);

  const records = [];
  let offset;

  do {
    if (offset) params.set('offset', offset);
    const url = `https://api.airtable.com/v0/${config.baseId}/${config.tableId}?${params.toString()}`;

    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
    } catch (cause) {
      throw new AirtableUnavailableError(`Airtable request failed: ${cause.message}`);
    }

    if (!response.ok) {
      throw new AirtableUnavailableError(`Airtable responded ${response.status}`);
    }

    const payload = await response.json();
    records.push(...(payload.records ?? []));
    offset = payload.offset;
  } while (offset);

  const wantedName = normalizeName(name);
  const wantedPhone = normalizePhone(phone);
  const wantedId = normalizeId(idNumber);
  if (!wantedName || !wantedPhone || !wantedId) return null;

  // Cohort membership is checked here rather than in the formula: a
  // linked-record field cannot be matched on record ID from within a formula
  // (ARRAYJOIN yields the linked records' display names, not their IDs), but
  // the REST API returns the field as an array of record IDs, which is exact.
  const cohort = records.filter((record) => {
    const links = record.fields?.[config.courseField];
    return Array.isArray(links) && links.includes(config.targetCourseRecordId);
  });

  // Identity requires BOTH the name and the phone number to match. Name alone
  // is too weak here: several participants are recorded under a single first
  // name, which anyone could guess. The ID is then reconciled separately.
  const matches = cohort.filter((record) => {
    const fields = record.fields ?? {};
    if (normalizeName(fields[config.nameField]) !== wantedName) return false;

    // Either phone column may be the well-formed one, so a match on either is
    // accepted; both are canonicalized before comparison.
    const candidates = [
      normalizePhone(fields[config.phoneField]),
      normalizePhone(fields[config.phoneFormulaField]),
    ].filter(Boolean);

    return candidates.includes(wantedPhone);
  });

  // Ambiguity is treated as failure: if two eligible participants share a
  // normalized name we must not guess whose certificate to issue.
  if (matches.length !== 1) return null;

  const record = matches[0];
  const fields = record.fields ?? {};
  const storedId = normalizeId(fields[config.idField]);

  if (config.requireId) {
    // Strict: an ID must be on file and must match.
    if (!storedId || storedId !== wantedId) return null;
  } else if (storedId && storedId !== wantedId) {
    // Trust-on-first-use: once an ID is recorded it is authoritative, so a
    // mismatch is refused. This protects a participant whose ID is already
    // stored from anyone else requesting their certificate by name alone.
    return null;
  }

  return {
    recordId: record.id,
    // The stored spelling goes on the certificate, so the printed name is the
    // one Maayan has on record rather than whatever casing the user typed.
    displayName: String(fields[config.nameField] ?? '').replace(/\s+/g, ' ').trim(),
    idNumber: storedId || wantedId,
    // Only true when the field was blank, so a write never overwrites data.
    shouldRecordId: !storedId && config.recordId,
  };
}

/**
 * Store an ID against a participant record.
 *
 * Called only when the field was previously empty. Failure is non-fatal: the
 * certificate has already been earned, so a write problem must not block the
 * download — it is logged and swallowed by the caller.
 */
export async function recordParticipantId({ recordId, idNumber, env = process.env, fetchImpl = fetch }) {
  const config = getAirtableConfig(env);
  const url = `https://api.airtable.com/v0/${config.baseId}/${config.tableId}/${recordId}`;

  const response = await fetchImpl(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: { [config.idField]: normalizeId(idNumber) } }),
  });

  if (!response.ok) {
    throw new AirtableUnavailableError(`Airtable write responded ${response.status}`);
  }
}
