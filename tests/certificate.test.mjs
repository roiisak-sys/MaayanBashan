// Test suite for the certificate issuance system.
//   npm test
//
// Uses node:test — no extra dependencies.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeName,
  normalizeId,
  isValidIsraeliId,
  formatIdForDisplay,
  normalizePhone,
  toVisualOrder,
} from '../netlify/functions/lib/text.mjs';
import { findEligibleParticipant, recordParticipantId, AirtableUnavailableError } from '../netlify/functions/lib/airtable.mjs';
import { generateCertificate, buildFilename, getLayout } from '../netlify/functions/lib/certificate.mjs';
import { checkRateLimit, resetRateLimits, getClientIp } from '../netlify/functions/lib/rate-limit.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const NAME_FIELD = 'fldtIhXNTeKPPs41O';
const ID_FIELD = 'fldFPugfcZDT70yhP';
const COURSE_FIELD = 'fldCourse';
const PHONE_FIELD = 'fldPhone';
const PHONE_FORMULA_FIELD = 'fldPhoneFormula';
const TARGET_COURSE = 'recJuly2026';
const OTHER_COURSE = 'recDec2025';

const BASE_ENV = {
  AIRTABLE_PAT: 'test-token',
  AIRTABLE_BASE_ID: 'appTest',
  AIRTABLE_TABLE_NAME: 'tblTest',
  AIRTABLE_NAME_FIELD: NAME_FIELD,
  AIRTABLE_ID_FIELD: ID_FIELD,
  AIRTABLE_STATUS_FIELD: 'fldStatus',
  AIRTABLE_COURSE_FIELD: COURSE_FIELD,
  AIRTABLE_PHONE_FIELD: PHONE_FIELD,
  AIRTABLE_PHONE_FORMULA_FIELD: PHONE_FORMULA_FIELD,
  TARGET_COURSE_RECORD_ID: 'recJuly2026',
  PAID_STATUS: 'שילם',
};

/**
 * Fake Airtable modelling the real REST contract:
 *   - filterByFormula narrows to paid records only (the course link CANNOT be
 *     filtered in a formula, so every paid record is returned regardless of
 *     cohort and the caller must exclude other courses itself)
 *   - returnFieldsByFieldId means keys are field IDs
 *   - a multipleRecordLinks field comes back as an array of record IDs
 *
 * Getting this shape wrong is what allowed a broken query to pass tests while
 * failing against the live API.
 */
function fakeAirtable(paidRecords, { onWrite } = {}) {
  return async (url, options) => {
    if (options?.method === 'PATCH') {
      onWrite?.({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        records: paidRecords.map((fields, i) => ({ id: `recFake${i}`, fields })),
      }),
    };
  };
}

/** Helper: a paid record in the target cohort, with a phone by default. */
const inCohort = (fields) => ({
  [COURSE_FIELD]: [TARGET_COURSE],
  [PHONE_FIELD]: '0509482733',
  ...fields,
});

// Mirrors production today: names + phones present, ID column blank.
// The phone formats deliberately mirror the messy real data.
const COHORT = [
  inCohort({ [NAME_FIELD]: 'ישראל ישראלי' }),
  inCohort({ [NAME_FIELD]: ' מור חסון', [PHONE_FIELD]: '052-1112233' }),
  inCohort({ [NAME_FIELD]: 'Yaffa Adler', [PHONE_FIELD]: '⁦+972 54-333-4455⁩' }),
];

// A cohort where IDs have already been backfilled.
const COHORT_WITH_IDS = [
  inCohort({ [NAME_FIELD]: 'ישראל ישראלי', [ID_FIELD]: '012345678' }),
  inCohort({ [NAME_FIELD]: ' מור חסון', [ID_FIELD]: '311111118', [PHONE_FIELD]: '052-1112233' }),
];

describe('name normalization', () => {
  test('collapses repeated and edge whitespace', () => {
    assert.equal(normalizeName('  מור   חסון '), 'מור חסון');
    assert.equal(normalizeName('ישראל ישראלי'), 'ישראל ישראלי');
  });

  test('is case-insensitive for Latin names', () => {
    assert.equal(normalizeName('Yaffa  ADLER'), 'yaffa adler');
  });

  test('strips invisible bidi marks pasted from messaging apps', () => {
    assert.equal(normalizeName('‏ישראל ישראלי‎'), 'ישראל ישראלי');
  });

  test('does not merge genuinely different names', () => {
    assert.notEqual(normalizeName('מיכל בן-שאול'), normalizeName('מיכל בן שאול'));
  });
});

describe('Israeli ID normalization', () => {
  test('preserves leading zeros and returns a string', () => {
    const result = normalizeId('012345678');
    assert.equal(result, '012345678');
    assert.equal(typeof result, 'string');
  });

  test('strips separators and whitespace', () => {
    assert.equal(normalizeId(' 012-345 678 '), '012345678');
  });

  test('never coerces to a number', () => {
    assert.equal(normalizeId('000000018'), '000000018');
    assert.notEqual(normalizeId('000000018'), String(18));
  });

  test('pads to 9 digits for display', () => {
    assert.equal(formatIdForDisplay('12345678'), '012345678');
  });

  test('validates the check digit', () => {
    assert.equal(isValidIsraeliId('000000018'), true);
    assert.equal(isValidIsraeliId('123456789'), false);
  });
});

describe('phone normalization', () => {
  test('folds every format found in the live data to one canonical form', () => {
    const expected = '0509482733';
    for (const variant of [
      '0509482733',           // 80 records
      '050-9482733',          // 4 records
      '050 948 2733',
      '⁦+972 50-948-2733⁩',    // 5 records, bidi-isolated
      '+972509482733',        // 1 record
      '972509482733',         // Phone_Formula shape
      '00972509482733',
      'י 050-9482733',        // 1 record, stray Hebrew letter
      ' 050-9482733 ',
    ]) {
      assert.equal(normalizePhone(variant), expected, `failed for ${JSON.stringify(variant)}`);
    }
  });

  test('accepts 9-digit landline form', () => {
    assert.equal(normalizePhone('03-1234567'), '031234567');
  });

  test('rejects values that cannot be a phone number', () => {
    assert.equal(normalizePhone(''), '');
    assert.equal(normalizePhone('abc'), '');
    assert.equal(normalizePhone('12345'), '');
    assert.equal(normalizePhone('05094827331234'), '');
    assert.equal(normalizePhone(null), '');
  });

  test('does not conflate different numbers', () => {
    assert.notEqual(normalizePhone('0509482733'), normalizePhone('0509482734'));
  });
});

describe('RTL / bidi handling', () => {
  test('reverses pure Hebrew into visual order', () => {
    assert.equal(toVisualOrder('ישראל ישראלי'), 'ילארשי לארשי');
  });

  test('round-trips pure Hebrew', () => {
    const original = 'יעל סאקסטין יונה';
    assert.equal(toVisualOrder(toVisualOrder(original)), original);
  });

  test('leaves pure Latin untouched', () => {
    assert.equal(toVisualOrder('Yaffa Adler'), 'Yaffa Adler');
  });

  test('keeps embedded Latin readable instead of reversing it', () => {
    // The whole-string reversal that a naive implementation produces would be
    // 'nehoC דוד' — the Latin surname must stay forwards.
    const visual = toVisualOrder('דוד Cohen');
    assert.ok(visual.includes('Cohen'), `expected 'Cohen' intact, got ${visual}`);
    assert.ok(!visual.includes('nehoC'));
  });

  test('keeps digit groups in natural order', () => {
    const visual = toVisualOrder('אילנה מסר 7');
    assert.ok(visual.includes('7'));
    assert.equal(toVisualOrder('שרה 25 לוי').includes('25'), true);
  });

  test('handles empty input', () => {
    assert.equal(toVisualOrder(''), '');
    assert.equal(toVisualOrder(null), '');
  });
});

describe('eligibility verification', () => {
  test('succeeds by name for a paid July 2026 participant with no ID on file', async () => {
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.ok(result);
    assert.equal(result.displayName, 'ישראל ישראלי');
    // The submitted ID is used verbatim on the certificate.
    assert.equal(result.idNumber, '012345678');
    // ...and flagged to be written back, since the field was blank.
    assert.equal(result.shouldRecordId, true);
  });

  test('writes the submitted ID back to the blank record', async () => {
    const writes = [];
    const participant = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    await recordParticipantId({
      recordId: participant.recordId,
      idNumber: participant.idNumber,
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT, { onWrite: (w) => writes.push(w) }),
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.fields[ID_FIELD], '012345678');
    assert.match(writes[0].url, /recFake0$/);
  });

  test('preserves leading zeros when writing back', async () => {
    const writes = [];
    await recordParticipantId({
      recordId: 'recFake0',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT, { onWrite: (w) => writes.push(w) }),
    });
    assert.equal(writes[0].body.fields[ID_FIELD], '012345678');
    assert.equal(typeof writes[0].body.fields[ID_FIELD], 'string');
  });

  test('accepts the matching ID once one is on file, without rewriting', async () => {
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT_WITH_IDS),
    });
    assert.ok(result);
    assert.equal(result.shouldRecordId, false);
  });

  test('refuses a different ID once one is on file (trust on first use)', async () => {
    // Protects a participant whose ID is already recorded from someone else
    // requesting their certificate using only their name.
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      idNumber: '311111118',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT_WITH_IDS),
    });
    assert.equal(result, null);
  });

  test('never overwrites an existing ID', async () => {
    const result = await findEligibleParticipant({
      name: ' מור חסון',
      phone: '052-1112233',
      idNumber: '311111118',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT_WITH_IDS),
    });
    assert.ok(result);
    assert.equal(result.shouldRecordId, false, 'must not rewrite a populated field');
  });

  test('write-back can be disabled', async () => {
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      phone: '050-9482733',
      idNumber: '012345678',
      env: { ...BASE_ENV, CERT_WRITE_ID: 'false' },
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.ok(result, 'still issues the certificate');
    assert.equal(result.shouldRecordId, false, 'but records nothing');
  });

  test('strict mode still requires a stored ID to match', async () => {
    const strict = { ...BASE_ENV, CERT_REQUIRE_ID: 'true' };
    const args = { name: 'ישראל ישראלי', phone: '050-9482733', idNumber: '012345678', env: strict };
    // Blank stored ID cannot satisfy strict verification.
    assert.equal(await findEligibleParticipant({ ...args, fetchImpl: fakeAirtable(COHORT) }), null);
    // Populated and matching does.
    assert.ok(await findEligibleParticipant({ ...args, fetchImpl: fakeAirtable(COHORT_WITH_IDS) }));
  });

  test('rejects the right name with the WRONG phone', async () => {
    // The whole point of the second factor: a guessable first name is no
    // longer sufficient on its own.
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      phone: '050-0000000',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.equal(result, null);
  });

  test('rejects a missing phone', async () => {
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      phone: '',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.equal(result, null);
  });

  test('matches when only the formula column holds a usable phone', async () => {
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable([
        {
          [NAME_FIELD]: 'ישראל ישראלי',
          [COURSE_FIELD]: [TARGET_COURSE],
          [PHONE_FIELD]: '',
          [PHONE_FORMULA_FIELD]: '972509482733',
        },
      ]),
    });
    assert.ok(result, 'either phone column may carry the usable value');
  });

  test('rejects a wrong name', async () => {
    const result = await findEligibleParticipant({
      name: 'מישהו אחר',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.equal(result, null);
  });

  test('rejects someone who is unpaid', async () => {
    // Unpaid records are excluded by filterByFormula, so they never appear.
    const result = await findEligibleParticipant({
      name: 'נרשמת שלא שילמה',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.equal(result, null);
  });

  test('REGRESSION: excludes a paid participant from a DIFFERENT course', async () => {
    // The course link cannot be filtered inside a formula, so every paid
    // record arrives and the cohort check must happen server-side. A previous
    // version filtered on the formula alone and matched nobody at all.
    const result = await findEligibleParticipant({
      name: 'בוגרת קורס אחר',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable([
        ...COHORT,
        { [NAME_FIELD]: 'בוגרת קורס אחר', [COURSE_FIELD]: [OTHER_COURSE] },
      ]),
    });
    assert.equal(result, null, 'other-cohort participant must not be issued a certificate');
  });

  test('REGRESSION: matches a participant linked to several courses', async () => {
    const result = await findEligibleParticipant({
      name: 'בוגרת שני קורסים',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable([
        { [NAME_FIELD]: 'בוגרת שני קורסים', [PHONE_FIELD]: '0509482733', [COURSE_FIELD]: [OTHER_COURSE, TARGET_COURSE] },
      ]),
    });
    assert.ok(result, 'membership of the target cohort is what matters');
  });

  test('REGRESSION: a record with no course link is never eligible', async () => {
    const result = await findEligibleParticipant({
      name: 'ליד ללא קורס',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable([{ [NAME_FIELD]: 'ליד ללא קורס' }]),
    });
    assert.equal(result, null);
  });

  test('requests field IDs back, and filters paid in the formula by field NAME', async () => {
    // Formulas cannot reference field IDs; responses are name-keyed unless
    // returnFieldsByFieldId is set. Both were wrong in an earlier version.
    let captured;
    await findEligibleParticipant({
      name: 'ישראל ישראלי',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: async (url) => {
        captured = url;
        return { ok: true, status: 200, json: async () => ({ records: [] }) };
      },
    });
    const params = new URL(captured).searchParams;
    assert.equal(params.get('returnFieldsByFieldId'), 'true');

    const formula = params.get('filterByFormula');
    assert.equal(formula, "{סטטוס} = 'שילם'", 'formula must reference the field by name');
    assert.ok(!formula.includes('{fld'), 'formula must not reference field IDs');
    assert.ok(!formula.includes('ARRAYJOIN'), 'course link cannot be formula-filtered');

    // The course link must be requested so it can be checked server-side.
    assert.ok(params.getAll('fields[]').includes(COURSE_FIELD));
  });

  test('tolerates stored names with stray whitespace', async () => {
    const result = await findEligibleParticipant({
      name: 'מור חסון',
      phone: '052-1112233',
      idNumber: '311111118',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.ok(result);
    assert.equal(result.displayName, 'מור חסון');
  });

  test('matches Latin names case-insensitively', async () => {
    const result = await findEligibleParticipant({
      name: 'yaffa adler',
      // Stored as an international number wrapped in bidi isolates.
      phone: '054-3334455',
      idNumber: '987654321',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.ok(result);
  });

  test('refuses ambiguous duplicate names rather than guessing', async () => {
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      phone: '050-9482733',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable([
        { [NAME_FIELD]: 'ישראל ישראלי', [ID_FIELD]: '012345678' },
        { [NAME_FIELD]: 'ישראל ישראלי', [ID_FIELD]: '012345678' },
      ]),
    });
    assert.equal(result, null);
  });

  test('surfaces Airtable outages distinctly from a failed match', async () => {
    await assert.rejects(
      () => findEligibleParticipant({
        name: 'ישראל ישראלי',
        idNumber: '012345678',
        env: BASE_ENV,
        fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
      }),
      AirtableUnavailableError
    );
  });

  test('missing credentials raise a configuration error', async () => {
    await assert.rejects(
      () => findEligibleParticipant({
        name: 'x',
        idNumber: '1',
        env: { ...BASE_ENV, AIRTABLE_PAT: '' },
        fetchImpl: fakeAirtable(COHORT),
      }),
      AirtableUnavailableError
    );
  });
});

describe('rate limiting', () => {
  beforeEach(() => resetRateLimits());

  test('allows requests up to the limit then returns 429-worthy state', () => {
    const options = { limit: 3, windowMs: 60_000 };
    assert.equal(checkRateLimit('1.2.3.4', options).allowed, true);
    assert.equal(checkRateLimit('1.2.3.4', options).allowed, true);
    assert.equal(checkRateLimit('1.2.3.4', options).allowed, true);

    const blocked = checkRateLimit('1.2.3.4', options);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);
  });

  test('tracks callers independently', () => {
    const options = { limit: 1, windowMs: 60_000 };
    assert.equal(checkRateLimit('1.1.1.1', options).allowed, true);
    assert.equal(checkRateLimit('2.2.2.2', options).allowed, true);
    assert.equal(checkRateLimit('1.1.1.1', options).allowed, false);
  });

  test('resets after the window elapses', () => {
    const start = Date.now();
    const options = { limit: 1, windowMs: 1000 };
    assert.equal(checkRateLimit('9.9.9.9', { ...options, now: start }).allowed, true);
    assert.equal(checkRateLimit('9.9.9.9', { ...options, now: start + 500 }).allowed, false);
    assert.equal(checkRateLimit('9.9.9.9', { ...options, now: start + 1500 }).allowed, true);
  });
});

describe('caller identification for rate limiting', () => {
  const req = (headers = {}) => ({
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  });

  test('prefers the Netlify context IP', () => {
    const { key, source } = getClientIp(req(), { ip: '203.0.113.9' });
    assert.equal(key, '203.0.113.9');
    assert.equal(source, 'context');
  });

  test('falls back through the proxy headers', () => {
    assert.equal(getClientIp(req({ 'x-nf-client-connection-ip': '198.51.100.2' })).key, '198.51.100.2');
    assert.equal(getClientIp(req({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' })).key, '198.51.100.7');
  });

  test('REGRESSION: unidentifiable callers must not share one bucket', () => {
    // Previously this returned the constant 'unknown' for everyone, so a single
    // noisy client could rate-limit every other visitor on the site.
    const a = getClientIp(req({ 'user-agent': 'iPhone Safari', 'accept-language': 'he-IL' }));
    const b = getClientIp(req({ 'user-agent': 'Android Chrome', 'accept-language': 'en-US' }));

    assert.notEqual(a.key, b.key, 'distinct clients must get distinct keys');
    assert.equal(a.source, 'fingerprint');

    resetRateLimits();
    const options = { limit: 1, windowMs: 60_000 };
    assert.equal(checkRateLimit(a.key, options).allowed, true);
    // Exhausting client A must leave client B unaffected.
    assert.equal(checkRateLimit(a.key, options).allowed, false);
    assert.equal(checkRateLimit(b.key, options).allowed, true);
  });

  test('the same client is identified consistently', () => {
    const headers = { 'user-agent': 'iPhone Safari', 'accept-language': 'he-IL' };
    assert.equal(getClientIp(req(headers)).key, getClientIp(req(headers)).key);
  });
});

describe('filenames', () => {
  test('are ASCII-safe and transliterated from Hebrew', () => {
    const filename = buildFilename('ישראל ישראלי');
    assert.match(filename, /^certificate-[a-z0-9-]+\.pdf$/);
  });

  test('never contain the ID number', () => {
    assert.ok(!buildFilename('ישראל ישראלי').includes('012345678'));
  });

  test('cannot break out of the Content-Disposition header', () => {
    const filename = buildFilename('bad"name\r\nX-Injected: 1');
    assert.ok(!filename.includes('"'));
    assert.ok(!/[\r\n]/.test(filename));
  });

  test('fall back gracefully for unmappable input', () => {
    assert.equal(buildFilename(''), 'certificate.pdf');
    assert.equal(buildFilename('...'), 'certificate.pdf');
  });
});

describe('PDF generation', () => {
  let templateBytes;
  let regularFontBytes;
  let boldFontBytes;

  const load = async () => {
    templateBytes ??= await fs.readFile(path.join(root, 'templates/certificate-template.pdf'));
    regularFontBytes ??= await fs.readFile(path.join(root, 'templates/assistant-regular.ttf'));
    boldFontBytes ??= await fs.readFile(path.join(root, 'templates/assistant-semibold.ttf'));
    return { templateBytes, regularFontBytes, boldFontBytes };
  };

  test('produces a valid non-empty PDF preserving the template', async () => {
    const assets = await load();
    const bytes = await generateCertificate({
      ...assets,
      name: 'ישראל ישראלי',
      idNumber: '012345678',
    });

    assert.ok(bytes.length > 1000);
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
    // Should stay close to the original size: the font is subset, not embedded whole.
    assert.ok(bytes.length < assets.templateBytes.length * 2);
  });

  test('renders Hebrew for a long name without exceeding the design width', async () => {
    const assets = await load();
    const layout = getLayout({});
    const bytes = await generateCertificate({
      ...assets,
      name: 'הודיה סיון ברזילאי כהן-אברמוביץ מזרחי',
      idNumber: '012345678',
    });
    assert.ok(bytes.length > 1000);
    // Width enforcement is asserted structurally in scripts/verify-certificate.mjs,
    // which re-parses the output; here we assert the layout contract itself.
    assert.ok(layout.name.maxWidth > 0);
    assert.ok(layout.name.minFontSize < layout.name.fontSize);
  });

  test('accepts Latin names', async () => {
    const assets = await load();
    const bytes = await generateCertificate({
      ...assets,
      name: 'Yaffa Adler',
      idNumber: '987654321',
    });
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  });

  test('is deterministic for repeated generation', async () => {
    const assets = await load();
    const args = { ...assets, name: 'ישראל ישראלי', idNumber: '012345678' };
    const first = await generateCertificate(args);
    const second = await generateCertificate(args);
    // Duplicate issuance is explicitly allowed; output size must be stable.
    assert.equal(first.length, second.length);
  });

  test('layout is overridable via environment', () => {
    const layout = getLayout({ CERT_NAME_BASELINE_Y: '500', CERT_NAME_FONT_SIZE: '20' });
    assert.equal(layout.name.baselineY, 500);
    assert.equal(layout.name.fontSize, 20);
  });
});
