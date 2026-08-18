// Airtable eligibility lookup.
//
// Runs server-side only. Nothing from Airtable is ever returned to the browser
// beyond a boolean decision plus the canonical name to print on the
// certificate.

import { normalizeName, normalizeId } from './text.mjs';

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
export async function findEligibleParticipant({ name, idNumber, env = process.env, fetchImpl = fetch }) {
  const config = getAirtableConfig(env);

  const formula = `AND({${config.statusField}} = '${config.paidStatus.replace(/'/g, "\\'")}', FIND('${config.targetCourseRecordId}', ARRAYJOIN({${config.courseField}})) > 0)`;

  const params = new URLSearchParams();
  params.set('filterByFormula', formula);
  params.set('pageSize', '100');
  params.append('fields[]', config.nameField);
  params.append('fields[]', config.idField);

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
  const wantedId = normalizeId(idNumber);
  if (!wantedName || !wantedId) return null;

  // Identity is established by name against the already-filtered eligible
  // cohort. The ID is then reconciled against whatever is on file.
  const matches = records.filter(
    (record) => normalizeName(record.fields?.[config.nameField]) === wantedName
  );

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
