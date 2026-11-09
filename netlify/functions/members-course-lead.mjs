// Registrations from the members landing page (/organizations-members/), the
// discounted offer for employees of organizations where Maayan has lectured.
//
// Same contract as course-lead.mjs: the lead goes to the Tal Bashan admin
// engine, which is the single writer into the unified CRM, and the engine
// returns the branded pay page. What differs is the source label, so this
// channel is countable in the CRM, and the discount.
//
// The discount is a coupon on the engine's own pay page, not a separate cycle
// or a separate Cardcom link: same cohort, same page, one price list. The page
// accepts ?coupon= and renders with the discount already applied, so the buyer
// lands on the member price without having to remember to type anything. The
// engine validates the code against the product, so a code that does not apply
// simply does not discount.

import { unifiedFallbackLead } from './lib/unified-lead.mjs';

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://admin.talbashan.co.il';
const SOURCE_LABEL = 'דף נחיתה - חברי ארגון';
const FALLBACK_PAYMENT_URL = 'https://secure.cardcom.solutions/EA/EA5/4SwsNP9VJ0ueOlqA9OOBzg/PaymentSP';

const COURSE_PRODUCT_ID = process.env.COURSE_PRODUCT_ID || 'recM5qlPShBRueS1t';
const LAST_KNOWN_COURSE_RECORD_ID = 'recjezzByzUmQ5VYo';


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

/** Carry the coupon onto the pay page, which applies it on load. Appended
 *  rather than replaced, because the engine's URL already carries its own
 *  query string and dropping it would lose the lead's attribution. */
function withCoupon(url, coupon) {
  if (!coupon) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('coupon', coupon);
    return u.toString();
  } catch {
    return url;
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

  const cycleId = await activeCycleId();

  const payUrl = cycleId ? await engineLead({ name, phone, email, cycleId, note, utm }) : null;
  if (payUrl) {
    return Response.json({ ok: true, payUrl: withCoupon(payUrl, coupon) });
  }

  const courseRecordId = cycleId || LAST_KNOWN_COURSE_RECORD_ID;
  const saved = await unifiedFallbackLead({
    name, phone, email, courseRecordId,
    source: note ? `${SOURCE_LABEL} (${note})` : SOURCE_LABEL,
    utm,
  });
  if (!saved) return Response.json({ ok: false, error: 'lead not saved' }, { status: 502 });
  // The Cardcom fallback has no coupon field, so a degraded checkout is at the
  // list price. Flagged so the caller can say so rather than quietly overcharge.
  return Response.json({ ok: true, payUrl: FALLBACK_PAYMENT_URL, degraded: true });
};

export const config = { path: '/api/members-course-lead' };
