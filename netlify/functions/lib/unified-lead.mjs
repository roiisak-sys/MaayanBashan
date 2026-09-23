// Last-resort lead writer, used only when the admin engine did not answer.
//
// Since 16.09.2026 Maayan's division lives in the unified Tal Bashan base, so a
// lead is written there in the same shape the engine writes it: a contact
// (found by phone within Maayan's company, or created) and an opportunity on
// the course cycle, both stamped with Maayan's company, with the campaign
// attribution in the same fields the engine uses. Before this, the fallback
// wrote to the old Maayan base, where a lead only reached the CRM if an hourly
// bridge running on someone's machine happened to be up.
//
// Env: AIRTABLE_TOKEN, with read/write access to the unified base.

export const UNIFIED_BASE_ID = 'appnKmW94PJcSJX6M';
export const MAAYAN_COMPANY_ID = 'rec1t7fWlWNSkG0dF'; // שפת גוף מעיין בשן

const CONTACTS_TABLE_ID = 'tblqYz0a0fRBmTTnr'; // אנשי קשר
const OPPS_TABLE_ID = 'tblx2L0pp6Gu097Uh'; // הזדמנויות

const CONTACT = {
  firstName: 'fld6C8N4F4VkWYqk3',
  lastName: 'fldmil8JbLf5XwkeQ',
  phone: 'fldBWWx7DKXRHn2tV',
  email: 'fld2FX4Jcyiq1MM0r',
  source: 'fldVPfBcAntmzMSr7',
  status: 'fld2nOHrkIrAVb61T',
  company: 'fldXThxMzYCsZ2Sja',
};
const OPP = {
  contact: 'fldzzQDcQ0W5OznYB',
  status: 'fldkEJPUkrIb1EvZG',
  cycle: 'fld16M0Q5YwK0CKrQ',
  company: 'fldSz0yu8dKwM0Lzv',
  utmSource: 'fldeGRg9j7RIGOke8',
  utmMedium: 'fld8BFNSWt1eBNPjY',
  utmContent: 'fldXn7r1B17j9Cgmo',
  utmCampaign: 'fldVpWsTU5poYIvB0',
};
const NEW_STATUS = 'ליד מתעניין';
// Opportunities in these statuses are closed deals, so a new registration
// opens a new opportunity instead of reusing one (same rule as the engine).
const CLOSED_STATUSES = ['שילם', 'רכש', 'חינם'];

// Old Maayan course ids -> the cycle in the unified base (same map as the
// engine's maayan-id-map.json). An id not in the map is taken to be a cycle
// id in the unified base already.
const OLD_COURSE_TO_CYCLE = {
  recjezzByzUmQ5VYo: 'recUmeUfXaxtH0SVO', // קורס שפת גוף אוקטובר 2026
  recqLb5JoZHMR2peH: 'recmmoYbDcBkMRAPJ', // קורס שפת גוף מתקדמים ינואר 2027
};
export function toCycleId(courseRecordId) {
  return OLD_COURSE_TO_CYCLE[courseRecordId] || courseRecordId;
}

// Phone_Formula in the base is international digits (972...).
export function toIntlDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return '972' + digits.slice(1);
  return digits;
}

function toLocalPhone(phone) {
  const intl = toIntlDigits(phone);
  return intl.startsWith('972') ? '0' + intl.slice(3) : intl;
}

const linked = (value) => (Array.isArray(value) ? value : []);
const inMaayan = (fields, fieldId) => linked(fields[fieldId]).includes(MAAYAN_COMPANY_ID);

async function airtable(token, path, options = {}) {
  const response = await fetch(`https://api.airtable.com/v0/${UNIFIED_BASE_ID}/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Airtable ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// Formulas cannot filter a linked field by record id, so a few candidates are
// read by phone and the company is checked here, by id.
async function findByPhone(token, tableId, formulaField, digits) {
  const params = new URLSearchParams({
    returnFieldsByFieldId: 'true',
    pageSize: '20',
    filterByFormula: `{${formulaField}}='${digits}'`,
  });
  const data = await airtable(token, `${tableId}?${params}`);
  return data.records || [];
}

export async function unifiedFallbackLead({ name, phone, email, courseRecordId, source, utm = {} }) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    console.error('AIRTABLE_TOKEN is not configured - the lead could not be saved anywhere');
    return false;
  }
  const digits = toIntlDigits(phone);
  const cycleId = toCycleId(courseRecordId);
  try {
    // A registration that already has an open opportunity on this cycle (a
    // double tap, or a returning lead) is not opened twice.
    const opps = await findByPhone(token, OPPS_TABLE_ID, 'Phone_Formula (from Contact)', digits);
    const open = opps.find((r) => {
      const f = r.fields || {};
      return inMaayan(f, OPP.company) && linked(f[OPP.cycle]).includes(cycleId) &&
        !CLOSED_STATUSES.includes(f[OPP.status]);
    });
    if (open) return true;

    const contacts = await findByPhone(token, CONTACTS_TABLE_ID, 'Phone_Formula', digits);
    let contactId = contacts.find((r) => inMaayan(r.fields || {}, CONTACT.company))?.id;
    if (!contactId) {
      const parts = String(name).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      const fields = {
        [CONTACT.phone]: toLocalPhone(phone),
        [CONTACT.company]: [MAAYAN_COMPANY_ID],
        [CONTACT.source]: source,
        [CONTACT.status]: 'ליד',
      };
      if (parts.length) fields[CONTACT.firstName] = parts[0];
      if (parts.length > 1) fields[CONTACT.lastName] = parts.slice(1).join(' ');
      if (email) fields[CONTACT.email] = email;
      const created = await airtable(token, CONTACTS_TABLE_ID, {
        method: 'POST',
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
      });
      contactId = created.records[0].id;
    }

    // Attribution in the same fields and shape the engine writes.
    const fields = {
      [OPP.contact]: [contactId],
      [OPP.company]: [MAAYAN_COMPANY_ID],
      [OPP.status]: NEW_STATUS,
      [OPP.cycle]: [cycleId],
      [OPP.utmSource]: source,
    };
    if (utm.source) fields[OPP.utmMedium] = utm.source;
    const content = [utm.content, utm.medium].filter(Boolean).join(' | ');
    if (content) fields[OPP.utmContent] = content;
    if (utm.campaign) fields[OPP.utmCampaign] = utm.campaign;
    await airtable(token, OPPS_TABLE_ID, {
      method: 'POST',
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    });
    return true;
  } catch (error) {
    console.error('fallback lead write failed', error.message);
    return false;
  }
}
