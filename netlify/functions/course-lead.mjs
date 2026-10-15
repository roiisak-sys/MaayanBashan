// Receives course registrations from the landing page and hands them to the
// Tal Bashan admin engine, which is the single writer into the unified CRM
// (Tal Bashan base, Maayan's division since 16.09.2026). The engine creates the
// lead with its campaign attribution and returns the branded /pay page in the
// same call.
//
// Why the engine and not a direct Airtable write: two writers on one table is
// what produced duplicate leads (the engine's own "does this lead exist"
// check ran against a three minute cache, so a row created here a second
// earlier was invisible to it). One writer, and the duplicate class is gone.
//
// A lead is never lost: if the engine is unreachable, this function falls
// back to writing the lead straight into the unified base, in the same shape
// the engine writes it (lib/unified-lead.mjs), and to the direct Cardcom link.
//
// Env: ADMIN_INTERNAL_KEY (the engine's INTERNAL_API_KEY) for the normal
// path, AIRTABLE_TOKEN for the fallback path only.

import { unifiedFallbackLead } from './lib/unified-lead.mjs';

// No rep is stamped on a new lead any more. A lead arrives unassigned and
// sticks to the first rep who acts on it, which is how the Tal side works.
// Rotating a rep onto a lead before anyone had seen it put reps on rows
// nobody had touched, including test rows.

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://admin.talbashan.co.il';
const SOURCE_LABEL = 'דף נחיתה - קורס שפת גוף';
// Used only if the engine is unreachable, so a buyer is never left without
// a way to pay.
const FALLBACK_PAYMENT_URL = 'https://secure.cardcom.solutions/EA/EA5/4SwsNP9VJ0ueOlqA9OOBzg/PaymentSP';

// The course product ("קורס שפת גוף") in the unified base. The engine resolves
// it to its next open cycle, so the date, price and title on the pay page
// always follow the active cycle in Airtable. A new cohort needs no edit here.
// Until 15.10.2026 the title and price were hardcoded in this file, and every
// pay link kept saying "מחזור אוקטובר" after the course moved to December.
const COURSE_PRODUCT_ID = process.env.COURSE_PRODUCT_ID || 'recM5qlPShBRueS1t';

// Only for the fallback path, when the engine cannot be reached at all and
// the active cycle is unknown: the lead still lands on the last known cycle.
const LAST_KNOWN_COURSE_RECORD_ID = 'recjezzByzUmQ5VYo';

// The product's next open cycle, from the same public endpoint the engine's
// own /buy page uses. Null if there is no open cycle or the engine is down.
async function activeCycleId() {
  try {
    const response = await fetch(`${ADMIN_BASE_URL}/public/offer/${COURSE_PRODUCT_ID}`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.cycleId) {
      console.error('active cycle lookup failed', response.status, JSON.stringify(data));
      return null;
    }
    return data.cycleId;
  } catch (error) {
    console.error('active cycle lookup unreachable', error.message);
    return null;
  }
}

// The engine creates (or updates) the lead and returns the branded pay page.
// It dedupes live against Airtable, so a repeat submission updates the same
// row instead of opening another one.
async function engineLead({ name, phone, email, cycleId, utm }) {
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
        // Price, title and cycle all come from this cycle's record in Airtable.
        offerId: cycleId,
        source: SOURCE_LABEL,
        // Ad attribution travels with the lead: the engine writes it to the
        // same four fields the reports already read.
        utm_source: utm.source,
        utm_medium: utm.medium,
        utm_campaign: utm.campaign,
        utm_content: utm.content,
        // Ad id and fbclid: the engine keeps them on the lead, so a lead can be
        // traced to its ad even after the ad is renamed.
        ad_id: utm.adId,
        fbclid: utm.fbclid,
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
    adId: read('ad_id'),
    fbclid: String(payload.fbclid ?? '').trim().slice(0, 300),
  };

  const cycleId = await activeCycleId();

  const payUrl = cycleId ? await engineLead({ name, phone, email, cycleId, utm }) : null;
  if (payUrl) return Response.json({ ok: true, payUrl });

  const courseRecordId = cycleId || LAST_KNOWN_COURSE_RECORD_ID;
  const saved = await unifiedFallbackLead({ name, phone, email, courseRecordId, source: SOURCE_LABEL, utm });
  if (!saved) return Response.json({ ok: false, error: 'lead not saved' }, { status: 502 });
  return Response.json({ ok: true, payUrl: FALLBACK_PAYMENT_URL, degraded: true });
};

export const config = { path: '/api/course-lead' };
