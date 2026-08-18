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
import { findEligibleParticipant, AirtableUnavailableError } from './lib/airtable.mjs';
import { generateCertificate, buildFilename } from './lib/certificate.mjs';
import { checkRateLimit, getClientIp } from './lib/rate-limit.mjs';

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

export default async (request) => {
  const startedAt = Date.now();
  const requestId = Math.random().toString(36).slice(2, 10);
  const env = process.env;

  if (request.method !== 'POST') {
    return jsonError('METHOD_NOT_ALLOWED', 405);
  }

  const limit = Number(env.CERT_RATE_LIMIT || 10);
  const windowMs = Number(env.CERT_RATE_WINDOW_MS || 10 * 60 * 1000);
  const rate = checkRateLimit(getClientIp(request), { limit, windowMs });
  if (!rate.allowed) {
    log({ success: false, reason: 'rate_limited', requestId, ms: Date.now() - startedAt });
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
  const idNumber = typeof payload?.idNumber === 'string' ? payload.idNumber : '';

  // Bound the input before it reaches any downstream processing.
  if (!name.trim() || !idNumber.trim() || name.length > 120 || idNumber.length > 40) {
    log({ success: false, reason: 'invalid_input', requestId, ms: Date.now() - startedAt });
    return jsonError('INVALID_DETAILS', 401);
  }

  let participant;
  try {
    participant = await findEligibleParticipant({ name, idNumber, env });
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
    // Identical response for: unknown name, wrong ID, unpaid, wrong cohort.
    log({ success: false, reason: 'no_match', requestId, ms: Date.now() - startedAt });
    return jsonError('INVALID_DETAILS', 401);
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

  log({ success: true, requestId, ms: Date.now() - startedAt });

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
