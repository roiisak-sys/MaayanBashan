// Registrations from the members landing page (/organizations-members/), the
// discounted offer for employees of organizations where Maayan has lectured.
//
// Same contract as course-lead.mjs: the lead goes to the Tal Bashan admin
// engine, which is the single writer into the unified CRM, and the engine
// returns the branded pay page. What differs is the source label, so this
// channel is countable in the CRM, and the discount.
//
// The discount can be configured two ways, and the function prefers the first:
//
//   MEMBERS_CYCLE_ID    an Airtable cycle carrying the member price. The engine
//                       resolves the price from it, so the CRM records what the
//                       buyer actually pays. This is the accurate route.
//   MEMBERS_PAYMENT_URL a dedicated Cardcom page at the member price. The lead
//                       is still created with full attribution, but the CRM
//                       keeps the regular cycle's price, so the row will read
//                       higher than the amount charged.
//
// With neither set the page falls through to the ordinary cycle at the regular
// price. That is deliberate: a landing page that promises a discount and then
// charges full price is worse than one that quietly charges the normal price
// while the offer is still being set up.

import { unifiedFallbackLead } from './lib/unified-lead.mjs';

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://admin.talbashan.co.il';
const SOURCE_LABEL = 'דף נחיתה - חברי ארגון';
const FALLBACK_PAYMENT_URL = 'https://secure.cardcom.solutions/EA/EA5/4SwsNP9VJ0ueOlqA9OOBzg/PaymentSP';

const COURSE_PRODUCT_ID = process.env.COURSE_PRODUCT_ID || 'recM5qlPShBRueS1t';
const LAST_KNOWN_COURSE_RECORD_ID = 'recjezzByzUmQ5VYo';

const MEMBERS_CYCLE_ID = process.env.MEMBERS_CYCLE_ID || '';
const MEMBERS_PAYMENT_URL = process.env.MEMBERS_PAYMENT_URL || '';

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

async function engineLead({ name, phone, email, cycleId, note, utm }) {
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
        offerId: cycleId,
        // The coupon and the organization ride along in the source, because
        // that is the field the CRM already shows on the lead row. Without it
        // nobody downstream can tell which lecture the registration came from.
        source: note ? `${SOURCE_LABEL} (${note})` : SOURCE_LABEL,
        utm_source: utm.source,
        utm_medium: utm.medium,
        utm_campaign: utm.campaign,
        utm_content: utm.content,
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

  const read = (key) => String(payload[key] ?? '').trim().slice(0, 250);
  const utm = {
    source: read('utm_source'),
    medium: read('utm_medium'),
    campaign: read('utm_campaign'),
    content: read('utm_content'),
    adId: read('ad_id'),
    fbclid: String(payload.fbclid ?? '').trim().slice(0, 300),
  };

  const organization = read('organization');
  const coupon = read('coupon').slice(0, 40);
  const note = [coupon, organization].filter(Boolean).join(' · ');

  // The member cycle wins when configured; otherwise the ordinary open cycle.
  const cycleId = MEMBERS_CYCLE_ID || (await activeCycleId());

  const payUrl = cycleId ? await engineLead({ name, phone, email, cycleId, note, utm }) : null;
  if (payUrl) {
    // A dedicated Cardcom page overrides the engine's pay page, but only when
    // no member cycle is configured: that route already prices correctly.
    const finalUrl = !MEMBERS_CYCLE_ID && MEMBERS_PAYMENT_URL ? MEMBERS_PAYMENT_URL : payUrl;
    return Response.json({ ok: true, payUrl: finalUrl });
  }

  const courseRecordId = cycleId || LAST_KNOWN_COURSE_RECORD_ID;
  const saved = await unifiedFallbackLead({
    name, phone, email, courseRecordId,
    source: note ? `${SOURCE_LABEL} (${note})` : SOURCE_LABEL,
    utm,
  });
  if (!saved) return Response.json({ ok: false, error: 'lead not saved' }, { status: 502 });
  return Response.json({
    ok: true,
    payUrl: MEMBERS_PAYMENT_URL || FALLBACK_PAYMENT_URL,
    degraded: true,
  });
};

export const config = { path: '/api/members-course-lead' };
