// Receives course registrations from the landing page and hands them to the
// Tal Bashan admin engine, which is the single writer into the unified CRM
// (Tal Bashan base, Maayan's division since 16.09.2026). The engine creates the
// lead with its campaign attribution and returns the branded /pay page in the
// same call. The fallback below still writes to the old Maayan base; an hourly
// sync moves anything that lands there into the unified base.
//
// Why the engine and not a direct Airtable write: two writers on one table is
// what produced duplicate leads (the engine's own "does this lead exist"
// check ran against a three minute cache, so a row created here a second
// earlier was invisible to it). One writer, and the duplicate class is gone.
//
// A lead is never lost: if the engine is unreachable, this function falls
// back to writing the lead straight to Airtable and to the direct Cardcom
// link, exactly as it did before.
//
// Env: ADMIN_INTERNAL_KEY (the engine's INTERNAL_API_KEY) for the normal
// path, AIRTABLE_TOKEN for the fallback path only.

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

// No rep is stamped on a new lead any more. A lead arrives unassigned and
// sticks to the first rep who acts on it, which is how the Tal side works.
// Rotating a rep onto a lead before anyone had seen it put reps on rows
// nobody had touched, including test rows.

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://admin.talbashan.co.il';
const COURSE_PRICE = Number(process.env.COURSE_PRICE || 1600);
const COURSE_TITLE = process.env.COURSE_TITLE || 'קורס ניתוח גוף פתוח - מחזור אוקטובר 2026';
const SOURCE_LABEL = 'דף נחיתה - קורס שפת גוף';
// Used only if the engine is unreachable, so a buyer is never left without
// a way to pay.
const FALLBACK_PAYMENT_URL = 'https://secure.cardcom.solutions/EA/EA5/4SwsNP9VJ0ueOlqA9OOBzg/PaymentSP';

// קורס שפת גוף אוקטובר 2026 — for the next cohort, override with the
// COURSE_RECORD_ID environment variable instead of editing this file.
const DEFAULT_COURSE_RECORD_ID = 'recjezzByzUmQ5VYo';

// The engine creates (or updates) the lead and returns the branded pay page.
// It dedupes live against Airtable, so a repeat submission updates the same
// row instead of opening another one.
async function engineLead({ name, phone, email, courseRecordId, utm }) {
  const key = process.env.ADMIN_INTERNAL_KEY;
  if (!key) {
    console.error('ADMIN_INTERNAL_KEY is not configured - falling back to a direct Airtable write');
    return null;
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
        // the engine maps an old Maayan course id to its cycle in the unified base
        cycleId: courseRecordId,
        source: SOURCE_LABEL,
        // Ad attribution travels with the lead: the engine writes it to the
        // same four fields the reports already read.
        utm_source: utm.source,
        utm_medium: utm.medium,
        utm_campaign: utm.campaign,
        utm_content: utm.content,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) {
      console.error('payment-request failed', response.status, JSON.stringify(data));
      return null;
    }
    return data.url;
  } catch (error) {
    console.error('payment-request unreachable', error.message);
    return null;
  }
}

// Fallback only. Runs when the engine did not answer, so that a registration
// is never lost. Keeps the ten minute dedupe guard against double taps.
async function airtableFallbackLead({ name, phone, email, courseRecordId, utm }) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    console.error('AIRTABLE_TOKEN is not configured - the lead could not be saved anywhere');
    return false;
  }
  const normalizedPhone = phone.replace(/\D/g, '');
  if (normalizedPhone) {
    try {
      const formula = `AND(REGEX_REPLACE({Phone}, "[^0-9]", "") = "${normalizedPhone}", DATETIME_DIFF(NOW(), CREATED_TIME(), "minutes") < 10)`;
      const url = `https://api.airtable.com/v0/${BASE_ID}/${LEADS_TABLE_ID}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const d = await r.json();
        if (d.records?.length > 0) return true; // already saved a moment ago
      }
    } catch (error) {
      console.error('fallback dedupe check failed', error.message);
      // fall through: a failed check must not block a genuine registration
    }
  }
  const response = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${LEADS_TABLE_ID}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      records: [
        {
          fields: {
            [FIELD_NAME]: name,
            [FIELD_STATUS]: 'חדש',
            [FIELD_PHONE]: phone,
            [FIELD_EMAIL]: email,
            [FIELD_SOURCE]: SOURCE_LABEL,
            [FIELD_PLATFORM]: utm.source || 'Website',
            [FIELD_PRODUCTS]: [courseRecordId],
            ...(utm.content ? { [FIELD_AD_NAME]: utm.content } : {}),
            ...(utm.medium ? { [FIELD_ADSET_NAME]: utm.medium } : {}),
            ...(utm.campaign ? { [FIELD_CAMPAIGN]: utm.campaign } : {}),
          },
        },
      ],
      typecast: true,
    }),
  });
  if (!response.ok) {
    console.error('fallback Airtable create failed', response.status, await response.text());
    return false;
  }
  return true;
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
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
  const read = (key) => String(payload[key] ?? '').trim().slice(0, 250);
  const utm = {
    source: read('utm_source'),
    medium: read('utm_medium'),
    campaign: read('utm_campaign'),
    content: read('utm_content'),
  };

  const courseRecordId = process.env.COURSE_RECORD_ID || DEFAULT_COURSE_RECORD_ID;

  const payUrl = await engineLead({ name, phone, email, courseRecordId, utm });
  if (payUrl) return Response.json({ ok: true, payUrl });

  const saved = await airtableFallbackLead({ name, phone, email, courseRecordId, utm });
  if (!saved) return Response.json({ ok: false, error: 'lead not saved' }, { status: 502 });
  return Response.json({ ok: true, payUrl: FALLBACK_PAYMENT_URL, degraded: true });
};

export const config = { path: '/api/course-lead' };
