// Receives leads from the short "call me back" course page
// (/body-language-course-call) and hands them to the Tal Bashan admin engine,
// the single writer into the unified CRM (Maayan's division). Name and phone
// only: no payment link is created, a sales rep calls the lead.
//
// The lead lands on the course product's next open cycle, so a new cohort
// needs no edit here. If the engine is unreachable the lead is written
// straight into the unified base (lib/unified-lead.mjs), so it is never lost.
//
// Env: none required for the normal path. AIRTABLE_TOKEN for the fallback only.

import { unifiedFallbackLead } from './lib/unified-lead.mjs';

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://admin.talbashan.co.il';
// The page name the CRM shows as the lead's origin. Its own label, so leads
// that asked for a call are told apart from registrations on the full page.
const SOURCE_LABEL = 'דף נחיתה - קורס שפת גוף - חזרה טלפונית';

// The course product ("קורס שפת גוף") in the unified base, same as course-lead.
const COURSE_PRODUCT_ID = process.env.COURSE_PRODUCT_ID || 'recM5qlPShBRueS1t';
// Fallback path only, when the engine cannot say which cycle is open.
const LAST_KNOWN_COURSE_RECORD_ID = 'recjezzByzUmQ5VYo';

async function engineLead({ name, phone, utm }) {
  try {
    const response = await fetch(`${ADMIN_BASE_URL}/public/landing-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant: 'maayan',
        name,
        phone,
        // The engine resolves the product to its next open cycle.
        productId: COURSE_PRODUCT_ID,
        source: SOURCE_LABEL,
        utm_source: utm.source,
        utm_medium: utm.medium,
        utm_campaign: utm.campaign,
        utm_content: utm.content,
        ad_id: utm.adId,
        fbclid: utm.fbclid,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      console.error('landing-lead failed', response.status, JSON.stringify(data));
      return false;
    }
    return true;
  } catch (error) {
    console.error('landing-lead unreachable', error.message);
    return false;
  }
}

async function activeCycleId() {
  try {
    const response = await fetch(`${ADMIN_BASE_URL}/public/offer/${COURSE_PRODUCT_ID}`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json().catch(() => ({}));
    return response.ok && data.cycleId ? data.cycleId : null;
  } catch {
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

  // Honeypot: bots fill the hidden field. Pretend it landed, write nothing.
  if (String(payload.company ?? '').trim()) return Response.json({ ok: true });

  const name = String(payload.name ?? '').trim().slice(0, 120);
  const phone = String(payload.phone ?? '').trim().slice(0, 30);
  if (!name || phone.replace(/\D/g, '').length < 9) {
    return Response.json({ ok: false, error: 'missing name or phone' }, { status: 400 });
  }

  const read = (key) => String(payload[key] ?? '').trim().slice(0, 250);
  const utm = {
    source: read('utm_source'),
    medium: read('utm_medium'),
    campaign: read('utm_campaign'),
    content: read('utm_content'),
    adId: read('ad_id'),
    fbclid: String(payload.fbclid ?? '').trim().slice(0, 300),
  };

  if (await engineLead({ name, phone, utm })) return Response.json({ ok: true });

  const courseRecordId = (await activeCycleId()) || LAST_KNOWN_COURSE_RECORD_ID;
  const saved = await unifiedFallbackLead({ name, phone, email: '', courseRecordId, source: SOURCE_LABEL, utm });
  if (!saved) return Response.json({ ok: false, error: 'lead not saved' }, { status: 502 });
  return Response.json({ ok: true, degraded: true });
};

export const config = { path: '/api/course-call-lead' };
