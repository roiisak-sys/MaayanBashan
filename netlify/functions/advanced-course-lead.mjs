// Receives registrations from the advanced course landing page and hands them
// to the Tal Bashan admin engine, which writes the lead into the unified CRM
// (Tal Bashan base, Maayan's division since 16.09.2026): contact + opportunity
// on the advanced course cycle, with campaign attribution, deduped live.
//
// If the engine is unreachable the lead is written straight into the unified
// base as a last resort, in the same shape the engine writes it
// (lib/unified-lead.mjs), so it is never lost.
//
// Env: none required for the normal path. AIRTABLE_TOKEN for the fallback only.

import { unifiedFallbackLead } from './lib/unified-lead.mjs';

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://admin.talbashan.co.il';
const SOURCE_LABEL = 'דף נחיתה - קורס שפת גוף מתקדמים';

// קורס שפת גוף מתקדמים ינואר 2027 (old Maayan course id; the engine resolves it
// to the cycle in the unified base). Override with ADVANCED_COURSE_RECORD_ID.
const DEFAULT_COURSE_RECORD_ID = 'recqLb5JoZHMR2peH';

async function engineLead({ name, phone, email, courseRecordId, utm }) {
  try {
    const response = await fetch(`${ADMIN_BASE_URL}/public/landing-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant: 'maayan',
        name,
        phone,
        email,
        cycleId: courseRecordId,
        source: SOURCE_LABEL,
        utm_source: utm.source,
        utm_medium: utm.medium,
        utm_campaign: utm.campaign,
        utm_content: utm.content,
      }),
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
  };
  const courseRecordId = process.env.ADVANCED_COURSE_RECORD_ID || DEFAULT_COURSE_RECORD_ID;

  if (await engineLead({ name, phone, email, courseRecordId, utm })) {
    return Response.json({ ok: true });
  }
  const saved = await unifiedFallbackLead({ name, phone, email, courseRecordId, source: SOURCE_LABEL, utm });
  if (!saved) return Response.json({ ok: false, error: 'lead not saved' }, { status: 502 });
  return Response.json({ ok: true, degraded: true });
};

export const config = { path: '/api/advanced-course-lead' };
