// The last-resort lead writer: when the admin engine is down, a lead must land
// in the unified base, on Maayan's company, in the shape the engine writes.
//   npm test

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  unifiedFallbackLead,
  toCycleId,
  toIntlDigits,
  UNIFIED_BASE_ID,
  MAAYAN_COMPANY_ID,
} from '../netlify/functions/lib/unified-lead.mjs';

const TAL_COMPANY_ID = 'recOVgtTKpfWvB7zp';
const OCT_CYCLE = 'recUmeUfXaxtH0SVO';
const CONTACTS = 'tblqYz0a0fRBmTTnr';
const OPPS = 'tblx2L0pp6Gu097Uh';

// A fake Airtable: answers phone lookups from the given rows and records writes.
function fakeAirtable({ opps = [], contacts = [], failWith = null } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    const [, , baseId, table] = u.pathname.split('/');
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ baseId, table, method, body, formula: u.searchParams.get('filterByFormula') });
    if (failWith) return new Response(failWith, { status: 403 });
    if (method === 'GET') {
      return Response.json({ records: table === OPPS ? opps : contacts });
    }
    const id = table === CONTACTS ? 'recNewContact0001' : 'recNewOpp00000001';
    return Response.json({ records: [{ id, fields: body.records[0].fields }] });
  };
  return calls;
}

const lead = {
  name: 'דנה ישראלי כהן',
  phone: '050-123-4567',
  email: 'dana@example.com',
  courseRecordId: 'recjezzByzUmQ5VYo',
  source: 'דף נחיתה - קורס שפת גוף',
  utm: { source: 'fb_feed', medium: 'adset_a', campaign: 'oct_course', content: 'video_1' },
};

describe('unifiedFallbackLead', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { process.env.AIRTABLE_TOKEN = 'test-token'; });
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.AIRTABLE_TOKEN; });

  test('a new person gets a contact and an opportunity in the unified base, on Maayan\'s company', async () => {
    const calls = fakeAirtable();
    assert.equal(await unifiedFallbackLead(lead), true);

    assert.ok(calls.every((c) => c.baseId === UNIFIED_BASE_ID), 'never writes to the old Maayan base');
    assert.match(calls[0].formula, /\{Phone_Formula \(from Contact\)\}='972501234567'/);

    const contact = calls.find((c) => c.method === 'POST' && c.table === CONTACTS).body.records[0].fields;
    assert.deepEqual(contact.fldXThxMzYCsZ2Sja, [MAAYAN_COMPANY_ID]);
    assert.equal(contact.fld6C8N4F4VkWYqk3, 'דנה');
    assert.equal(contact.fldmil8JbLf5XwkeQ, 'ישראלי כהן');
    assert.equal(contact.fldBWWx7DKXRHn2tV, '0501234567');
    assert.equal(contact.fld2FX4Jcyiq1MM0r, 'dana@example.com');
    assert.equal(contact.fld2nOHrkIrAVb61T, 'ליד');

    const opp = calls.find((c) => c.method === 'POST' && c.table === OPPS).body.records[0].fields;
    assert.deepEqual(opp.fldzzQDcQ0W5OznYB, ['recNewContact0001']);
    assert.deepEqual(opp.fldSz0yu8dKwM0Lzv, [MAAYAN_COMPANY_ID]);
    assert.deepEqual(opp.fld16M0Q5YwK0CKrQ, [OCT_CYCLE], 'old course id is mapped to the unified cycle');
    assert.equal(opp.fldkEJPUkrIb1EvZG, 'ליד מתעניין');
    // same attribution shape as the engine's applyUtm
    assert.equal(opp.fldeGRg9j7RIGOke8, 'דף נחיתה - קורס שפת גוף');
    assert.equal(opp.fld8BFNSWt1eBNPjY, 'fb_feed');
    assert.equal(opp.fldXn7r1B17j9Cgmo, 'video_1 | adset_a');
    assert.equal(opp.fldVpWsTU5poYIvB0, 'oct_course');
  });

  test('reuses the person\'s Maayan contact and ignores a Tal contact on the same phone', async () => {
    const calls = fakeAirtable({
      contacts: [
        { id: 'recTalContact0001', fields: { fldXThxMzYCsZ2Sja: [TAL_COMPANY_ID] } },
        { id: 'recMaayanContact1', fields: { fldXThxMzYCsZ2Sja: [MAAYAN_COMPANY_ID] } },
      ],
    });
    assert.equal(await unifiedFallbackLead(lead), true);
    assert.equal(calls.filter((c) => c.method === 'POST' && c.table === CONTACTS).length, 0);
    const opp = calls.find((c) => c.method === 'POST' && c.table === OPPS).body.records[0].fields;
    assert.deepEqual(opp.fldzzQDcQ0W5OznYB, ['recMaayanContact1']);
  });

  test('an open opportunity on the same cycle is not opened twice', async () => {
    const calls = fakeAirtable({
      opps: [{ id: 'recOpenOpp0000001', fields: {
        fldSz0yu8dKwM0Lzv: [MAAYAN_COMPANY_ID], fld16M0Q5YwK0CKrQ: [OCT_CYCLE], fldkEJPUkrIb1EvZG: 'ליד מתעניין',
      } }],
    });
    assert.equal(await unifiedFallbackLead(lead), true);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });

  test('a paid opportunity, or one on Tal\'s company, does not block a new one', async () => {
    const calls = fakeAirtable({
      opps: [
        { id: 'recPaidOpp0000001', fields: {
          fldSz0yu8dKwM0Lzv: [MAAYAN_COMPANY_ID], fld16M0Q5YwK0CKrQ: [OCT_CYCLE], fldkEJPUkrIb1EvZG: 'שילם',
        } },
        { id: 'recTalOpp00000001', fields: {
          fldSz0yu8dKwM0Lzv: [TAL_COMPANY_ID], fld16M0Q5YwK0CKrQ: [OCT_CYCLE],
        } },
      ],
    });
    assert.equal(await unifiedFallbackLead(lead), true);
    assert.equal(calls.filter((c) => c.method === 'POST' && c.table === OPPS).length, 1);
  });

  test('no UTMs: only the source label is written', async () => {
    const calls = fakeAirtable();
    assert.equal(await unifiedFallbackLead({ ...lead, utm: {} }), true);
    const opp = calls.find((c) => c.method === 'POST' && c.table === OPPS).body.records[0].fields;
    assert.equal(opp.fldeGRg9j7RIGOke8, 'דף נחיתה - קורס שפת גוף');
    assert.equal(opp.fld8BFNSWt1eBNPjY, undefined);
    assert.equal(opp.fldXn7r1B17j9Cgmo, undefined);
    assert.equal(opp.fldVpWsTU5poYIvB0, undefined);
  });

  test('an Airtable error or a missing token reports failure instead of claiming success', async () => {
    fakeAirtable({ failWith: 'INVALID_PERMISSIONS' });
    assert.equal(await unifiedFallbackLead(lead), false);
    delete process.env.AIRTABLE_TOKEN;
    assert.equal(await unifiedFallbackLead(lead), false);
  });
});

describe('id and phone helpers', () => {
  test('old Maayan course ids map to unified cycles, others pass through', () => {
    assert.equal(toCycleId('recjezzByzUmQ5VYo'), OCT_CYCLE);
    assert.equal(toCycleId('recqLb5JoZHMR2peH'), 'recmmoYbDcBkMRAPJ');
    assert.equal(toCycleId('recSomeNewCycle01'), 'recSomeNewCycle01');
  });
  test('phones normalize to international digits', () => {
    assert.equal(toIntlDigits('050-123-4567'), '972501234567');
    assert.equal(toIntlDigits('+972 50 123 4567'), '972501234567');
  });
});
