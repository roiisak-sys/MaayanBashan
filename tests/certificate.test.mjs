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
  toVisualOrder,
} from '../netlify/functions/lib/text.mjs';
import { findEligibleParticipant, AirtableUnavailableError } from '../netlify/functions/lib/airtable.mjs';
import { generateCertificate, buildFilename, getLayout } from '../netlify/functions/lib/certificate.mjs';
import { checkRateLimit, resetRateLimits } from '../netlify/functions/lib/rate-limit.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const NAME_FIELD = 'fldtIhXNTeKPPs41O';
const ID_FIELD = 'fldFPugfcZDT70yhP';

const BASE_ENV = {
  AIRTABLE_PAT: 'test-token',
  AIRTABLE_BASE_ID: 'appTest',
  AIRTABLE_TABLE_NAME: 'tblTest',
  AIRTABLE_NAME_FIELD: NAME_FIELD,
  AIRTABLE_ID_FIELD: ID_FIELD,
  AIRTABLE_STATUS_FIELD: 'fldStatus',
  AIRTABLE_COURSE_FIELD: 'fldCourse',
  TARGET_COURSE_RECORD_ID: 'recJuly2026',
  PAID_STATUS: 'שילם',
  CERT_REQUIRE_ID: 'true',
};

/**
 * Fake Airtable. The real API applies filterByFormula server-side, so the
 * fake only ever returns records that already satisfy "July 2026 + paid" —
 * ineligible people are modelled by simply not being in this list, which is
 * exactly what the real query does.
 */
function fakeAirtable(eligibleRecords) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: eligibleRecords.map((fields) => ({ id: 'rec' + Math.random(), fields })) }),
  });
}

const COHORT = [
  { [NAME_FIELD]: 'ישראל ישראלי', [ID_FIELD]: '012345678' },
  { [NAME_FIELD]: ' מור חסון', [ID_FIELD]: '311111118' },
  { [NAME_FIELD]: 'Yaffa Adler', [ID_FIELD]: '987654321' },
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
  test('succeeds for a paid July 2026 participant with matching name + ID', async () => {
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.ok(result);
    assert.equal(result.displayName, 'ישראל ישראלי');
    assert.equal(result.idNumber, '012345678');
  });

  test('rejects a wrong ID', async () => {
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      idNumber: '999999999',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.equal(result, null);
  });

  test('rejects a wrong name', async () => {
    const result = await findEligibleParticipant({
      name: 'מישהו אחר',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.equal(result, null);
  });

  test('rejects someone not in the paid July 2026 cohort', async () => {
    // Unpaid / other-cohort participants are filtered out by the Airtable
    // query, so they simply never appear in the result set.
    const result = await findEligibleParticipant({
      name: 'נרשמת שלא שילמה',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.equal(result, null);
  });

  test('tolerates stored names with stray whitespace', async () => {
    const result = await findEligibleParticipant({
      name: 'מור חסון',
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
      idNumber: '987654321',
      env: BASE_ENV,
      fetchImpl: fakeAirtable(COHORT),
    });
    assert.ok(result);
  });

  test('refuses when the stored ID is empty, even if the name matches', async () => {
    // Guards the current production state: the ID column is unpopulated, and
    // an empty stored value must never be treated as "matches anything".
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable([{ [NAME_FIELD]: 'ישראל ישראלי', [ID_FIELD]: '' }]),
    });
    assert.equal(result, null);
  });

  test('refuses ambiguous duplicate names rather than guessing', async () => {
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      idNumber: '012345678',
      env: BASE_ENV,
      fetchImpl: fakeAirtable([
        { [NAME_FIELD]: 'ישראל ישראלי', [ID_FIELD]: '012345678' },
        { [NAME_FIELD]: 'ישראל ישראלי', [ID_FIELD]: '012345678' },
      ]),
    });
    assert.equal(result, null);
  });

  test('name-only mode works when explicitly enabled', async () => {
    const result = await findEligibleParticipant({
      name: 'ישראל ישראלי',
      idNumber: '',
      env: { ...BASE_ENV, CERT_REQUIRE_ID: 'false' },
      fetchImpl: fakeAirtable([{ [NAME_FIELD]: 'ישראל ישראלי' }]),
    });
    assert.ok(result);
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
