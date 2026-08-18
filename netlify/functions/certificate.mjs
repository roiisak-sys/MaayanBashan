// POST /api/certificate
//
// Verifies a participant against Airtable (July 2026 cohort, paid) and returns
// a personalised completion certificate PDF.
//
// Privacy rules enforced here:
//   - no Airtable record, stored name, stored ID or payment status is ever
//     returned to the browser
//   - failures are indistinguishable from one another, so the endpoint cannot
//     be used to probe who is enrolled or who has paid
//   - ID numbers and names are never written to logs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findEligibleParticipant, recordParticipantId, AirtableUnavailableError } from './lib/airtable.mjs';
import { generateCertificate, buildFilename } from './lib/certificate.mjs';
import { checkRateLimit, getClientIp } from './lib/rate-limit.mjs';
import { isValidIsraeliId, normalizePhone } from './lib/text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Resolve bundled assets. Netlify's esbuild bundler rewrites __dirname, so try
// the packaged location first and fall back to the repo layout for local dev.
async function readAsset(relativeName) {
  const candidates = [
    path.join(here, 'assets', relativeName),
    path.join(here, '../../templates', relativeName),
    path.join(process.cwd(), 'templates', relativeName),
  ];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate);
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Certificate asset not found: ${relativeName}`);
}

let assetsPromise;
function loadAssets(env) {
  assetsPromise ??= Promise.all([
    readAsset(env.CERTIFICATE_TEMPLATE_NAME || 'certificate-template.pdf'),
    readAsset(env.CERTIFICATE_FONT_NAME || 'assistant-regular.ttf'),
    readAsset(env.CERTIFICATE_FONT_BOLD_NAME || 'assistant-semibold.ttf'),
  ]);
  return assetsPromise;
}

function jsonError(error, status) {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** Structured log line. Never includes name or ID. */
function log(fields) {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  console.log(`certificate_verification ${parts.join(' ')}`);
}

export default async (request, context) => {
  const startedAt = Date.now();
  const requestId = Math.random().toString(36).slice(2, 10);
  const env = process.env;

  if (request.method !== 'POST') {
    return jsonError('METHOD_NOT_ALLOWED', 405);
  }

  const limit = Number(env.CERT_RATE_LIMIT || 20);
  const windowMs = Number(env.CERT_RATE_WINDOW_MS || 10 * 60 * 1000);
  // `source` records how the caller was identified (never the identity itself),
  // so a misconfigured host that silently degrades to fingerprinting is visible
  // in the logs instead of quietly throttling unrelated users.
  const { key: rateKey, source: rateSource } = getClientIp(request, context);
  const rate = checkRateLimit(rateKey, { limit, windowMs });
  if (!rate.allowed) {
    log({ success: false, reason: 'rate_limited', ipSource: rateSource, requestId, ms: Date.now() - startedAt });
    return new Response(JSON.stringify({ success: false, error: 'RATE_LIMITED' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(rate.retryAfterSeconds),
      },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonError('INVALID_REQUEST', 400);
  }

  const name = typeof payload?.name === 'string' ? payload.name : '';
  const phone = typeof payload?.phone === 'string' ? payload.phone : '';
  const idNumber = typeof payload?.idNumber === 'string' ? payload.idNumber : '';

  // Bound the input before it reaches any downstream processing.
  if (
    !name.trim() || !phone.trim() || !idNumber.trim() ||
    name.length > 120 || phone.length > 30 || idNumber.length > 40
  ) {
    log({ success: false, reason: 'invalid_input', requestId, ms: Date.now() - startedAt });
    return jsonError('INVALID_DETAILS', 401);
  }

  // Reject an unparseable phone up front. Like the ID check below, this is a
  // format complaint about the user's own input and reveals nothing about who
  // is enrolled, so a specific message is safe.
  if (!normalizePhone(phone)) {
    log({ success: false, reason: 'invalid_phone_format', requestId, ms: Date.now() - startedAt });
    return jsonError('INVALID_PHONE_FORMAT', 400);
  }

  // Reject malformed IDs before touching Airtable. Every real Israeli ID has a
  // valid check digit, so this catches typos, keeps invalid data out of the
  // CRM, and stops a wrong number being printed onto a certificate. It reveals
  // nothing about who is enrolled, so a specific message is safe here.
  if (!isValidIsraeliId(idNumber)) {
    log({ success: false, reason: 'invalid_id_format', requestId, ms: Date.now() - startedAt });
    return jsonError('INVALID_ID_FORMAT', 400);
  }

  let participant;
  try {
    participant = await findEligibleParticipant({ name, phone, idNumber, env });
  } catch (error) {
    if (error instanceof AirtableUnavailableError) {
      // Technical detail stays server-side.
      console.error(`certificate_verification airtable_error requestId=${requestId}: ${error.message}`);
      log({ success: false, reason: 'upstream_unavailable', requestId, ms: Date.now() - startedAt });
      return jsonError('SERVICE_UNAVAILABLE', 503);
    }
    console.error(`certificate_verification unexpected_error requestId=${requestId}: ${error.message}`);
    log({ success: false, reason: 'unexpected', requestId, ms: Date.now() - startedAt });
    return jsonError('SERVICE_UNAVAILABLE', 503);
  }

  if (!participant) {
    // Identical response for: unknown name, ID conflicting with one on file,
    // unpaid, wrong cohort.
    log({ success: false, reason: 'no_match', requestId, ms: Date.now() - startedAt });
    return jsonError('INVALID_DETAILS', 401);
  }

  // Backfill the ID onto the record when the field was blank. Deliberately
  // best-effort: the participant is already verified and entitled to the
  // certificate, so a write failure is logged but must not block the download.
  let idRecorded = false;
  if (participant.shouldRecordId) {
    try {
      await recordParticipantId({ recordId: participant.recordId, idNumber: participant.idNumber, env });
      idRecorded = true;
    } catch (error) {
      console.error(`certificate_verification id_write_failed requestId=${requestId}: ${error.message}`);
    }
  }

  let pdfBytes;
  try {
    const [templateBytes, regularFontBytes, boldFontBytes] = await loadAssets(env);
    pdfBytes = await generateCertificate({
      templateBytes,
      regularFontBytes,
      boldFontBytes,
      name: participant.displayName,
      idNumber: participant.idNumber,
      env,
    });
  } catch (error) {
    console.error(`certificate_verification pdf_error requestId=${requestId}: ${error.message}`);
    log({ success: false, reason: 'pdf_failed', requestId, ms: Date.now() - startedAt });
    return jsonError('PDF_FAILED', 500);
  }

  log({ success: true, idRecorded, requestId, ms: Date.now() - startedAt });

  // buildFilename yields ASCII only, so this header cannot be injected into.
  const filename = buildFilename(participant.displayName);

  return new Response(pdfBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(pdfBytes.length),
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
};

export const config = { path: '/api/certificate' };
