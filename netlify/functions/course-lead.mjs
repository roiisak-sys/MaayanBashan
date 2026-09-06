// Receives course registrations from the landing page and creates a lead
// in the Maayan Bashan CRM (Airtable), linked to the current course cohort.
//
// Requires the AIRTABLE_TOKEN environment variable (Personal Access Token
// with data.records:write scope on the CRM base). Set via:
//   netlify env:set AIRTABLE_TOKEN <token>

const BASE_ID = 'appiziy69WzC5SqDK'; // Maayan Bashan CRM
const LEADS_TABLE_ID = 'tbl3s3NLLL75Siqg3'; // לידים פרטי

const FIELD_NAME = 'fldtIhXNTeKPPs41O'; // שם
const FIELD_STATUS = 'fld9Smx5O2HTn4zus'; // סטטוס
const FIELD_PHONE = 'fldIaXr31RLDOZgUh'; // Phone
const FIELD_EMAIL = 'fldCawUjSTnaDDO9j'; // Email
const FIELD_SOURCE = 'fldfCp8fztIeriZDZ'; // מקור הגעה
const FIELD_PLATFORM = 'fld8h8I2b5TaaPEKA'; // Platform
const FIELD_PRODUCTS = 'fldy6DhZezw4gVZuq'; // מוצרים (linked records)
const FIELD_AD_NAME = 'fldGf8fiZdBxhvvzG'; // AD_Name
const FIELD_ADSET_NAME = 'fldONC5BO7X7CxPsU'; // AD_G_Name
const FIELD_CAMPAIGN = 'fldMFNgQMUKiYYsEH'; // Campaign_name
const FIELD_ASSIGNEE = 'fld2PKwdR07wokQaa'; // בטיפול של (חדש)

// Sales reps, in rotation order. The old Elementor page (through Make) handed
// every lead to the next rep in turn; the new page must not leave leads
// unassigned. Override with SALES_REPS="name1,name2" in the Netlify env.
const SALES_REPS = String(process.env.SALES_REPS || 'רוני מובשוביץ,קרן קציר')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Round-robin without a store: look at who got the most recent lead and hand
// this one to the next rep in the list. Any failure falls back to the first rep.
async function nextSalesRep(token) {
  if (SALES_REPS.length === 0) return '';
  try {
    const params = new URLSearchParams();
    params.set('maxRecords', '1');
    params.set('returnFieldsByFieldId', 'true');
    params.append('fields[]', FIELD_ASSIGNEE);
    params.append('sort[0][field]', 'Created');
    params.append('sort[0][direction]', 'desc');
    params.set('filterByFormula', `{בטיפול של (חדש)} != ''`);
    const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${LEADS_TABLE_ID}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return SALES_REPS[0];
    const data = await r.json();
    const last = data.records?.[0]?.fields?.[FIELD_ASSIGNEE] || '';
    const idx = SALES_REPS.indexOf(last);
    return SALES_REPS[(idx + 1) % SALES_REPS.length];
  } catch {
    return SALES_REPS[0];
  }
}

// The payment page comes from the Tal Bashan admin engine, so every division
// bills through one Cardcom terminal and every purchase is recorded in the
// CRM automatically. The engine returns a branded /pay page for Maayan.
// Needs ADMIN_INTERNAL_KEY (the engine's INTERNAL_API_KEY) in the Netlify env.
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://admin.talbashan.co.il';
const COURSE_PRICE = Number(process.env.COURSE_PRICE || 1600);
const COURSE_TITLE = process.env.COURSE_TITLE || 'קורס ניתוח גוף פתוח - מחזור אוקטובר 2026';
// Used only if the engine is unreachable, so a buyer is never left without
// a way to pay.
const FALLBACK_PAYMENT_URL = 'https://secure.cardcom.solutions/EA/EA5/4SwsNP9VJ0ueOlqA9OOBzg/PaymentSP';

async function brandedPaymentUrl({ name, phone, email, courseRecordId }) {
  const key = process.env.ADMIN_INTERNAL_KEY;
  if (!key) {
    console.error('ADMIN_INTERNAL_KEY is not configured - falling back to the direct Cardcom link');
    return FALLBACK_PAYMENT_URL;
  }
  try {
    const response = await fetch(`${ADMIN_BASE_URL}/api/internal/payment-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
      body: JSON.stringify({
        tenant: 'maayan',
        name,
        phone,
        email,
        amount: COURSE_PRICE,
        description: COURSE_TITLE,
        productId: courseRecordId,
        source: 'דף נחיתה - קורס שפת גוף',
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) {
      console.error('payment-request failed', response.status, JSON.stringify(data));
      return FALLBACK_PAYMENT_URL;
    }
    return data.url;
  } catch (error) {
    console.error('payment-request unreachable', error.message);
    return FALLBACK_PAYMENT_URL;
  }
}

// קורס שפת גוף אוקטובר 2026 — for the next cohort, override with the
// COURSE_RECORD_ID environment variable instead of editing this file.
const DEFAULT_COURSE_RECORD_ID = 'recjezzByzUmQ5VYo';

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    console.error('AIRTABLE_TOKEN is not configured');
    return Response.json({ ok: false, error: 'not configured' }, { status: 500 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const name = String(payload.name ?? '').trim();
  const email = String(payload.email ?? '').trim();
  const phone = String(payload.phone ?? '').trim();
  if (!name || !phone) {
    return Response.json({ ok: false, error: 'missing name or phone' }, { status: 400 });
  }

  // Ad attribution, carried from the URL by the form. The CRM reads these
  // four fields, so a lead can always be traced back to the ad that made it.
  const utm = (key) => String(payload[key] ?? '').trim().slice(0, 250);
  const utmSource = utm('utm_source');
  const utmMedium = utm('utm_medium');
  const utmContent = utm('utm_content');
  const utmCampaign = utm('utm_campaign');

  const courseRecordId = process.env.COURSE_RECORD_ID || DEFAULT_COURSE_RECORD_ID;

  // Dedupe guard: if this phone number already submitted in the last 10
  // minutes (double-click, double-tap, or a retried request), don't create
  // a second lead — just acknowledge success.
  const normalizedPhone = phone.replace(/\D/g, '');
  if (normalizedPhone) {
    const dedupeFormula = `AND(REGEX_REPLACE({Phone}, "[^0-9]", "") = "${normalizedPhone}", DATETIME_DIFF(NOW(), CREATED_TIME(), "minutes") < 10)`;
    const dedupeUrl = `https://api.airtable.com/v0/${BASE_ID}/${LEADS_TABLE_ID}?maxRecords=1&filterByFormula=${encodeURIComponent(dedupeFormula)}`;
    const dedupeResponse = await fetch(dedupeUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (dedupeResponse.ok) {
      const dedupeData = await dedupeResponse.json();
      if (dedupeData.records?.length > 0) {
        // Already registered a moment ago: no second lead, but still hand
        // back a payment link so the buyer can continue.
        const payUrl = await brandedPaymentUrl({ name, phone, email, courseRecordId });
        return Response.json({ ok: true, duplicate: true, payUrl });
      }
    } else {
      console.error('Airtable dedupe check failed', dedupeResponse.status, await dedupeResponse.text());
      // Fall through and create the lead — a failed dedupe check should
      // never block a genuine registration.
    }
  }

  const assignee = await nextSalesRep(token);

  const airtableResponse = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/${LEADS_TABLE_ID}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        records: [
          {
            fields: {
              [FIELD_NAME]: name,
              [FIELD_STATUS]: 'חדש',
              [FIELD_PHONE]: phone,
              [FIELD_EMAIL]: email,
              [FIELD_SOURCE]: 'דף נחיתה - קורס שפת גוף',
              [FIELD_PLATFORM]: utmSource || 'Website',
              [FIELD_PRODUCTS]: [courseRecordId],
              ...(assignee ? { [FIELD_ASSIGNEE]: assignee } : {}),
              ...(utmContent ? { [FIELD_AD_NAME]: utmContent } : {}),
              ...(utmMedium ? { [FIELD_ADSET_NAME]: utmMedium } : {}),
              ...(utmCampaign ? { [FIELD_CAMPAIGN]: utmCampaign } : {}),
            },
          },
        ],
        typecast: true,
      }),
    }
  );

  if (!airtableResponse.ok) {
    const detail = await airtableResponse.text();
    console.error('Airtable create failed', airtableResponse.status, detail);
    return Response.json({ ok: false, error: 'airtable error' }, { status: 502 });
  }

  const payUrl = await brandedPaymentUrl({ name, phone, email, courseRecordId });
  return Response.json({ ok: true, payUrl });
};

export const config = { path: '/api/course-lead' };
