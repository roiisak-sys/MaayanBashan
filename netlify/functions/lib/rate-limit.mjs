// Minimal fixed-window rate limiter.
//
// Deliberately in-memory: this endpoint runs on Netlify Functions and adding
// Redis/Upstash for a certificate page used by ~90 people would be more
// infrastructure than the problem warrants.
//
// Caveat, stated honestly: serverless instances are per-container, so a
// determined attacker spreading requests across cold starts gets a higher
// effective limit than the configured one. It still removes the practical
// ability to brute-force ID numbers from a single client, which is the actual
// threat here. If that ever stops being sufficient, swap this module for a
// shared store — the interface is one function.

const buckets = new Map();

/** Drop expired buckets so the map cannot grow without bound. */
function evictExpired(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * @param {string} key       caller identity (client IP)
 * @param {object} [options]
 * @param {number} [options.limit]       max requests per window
 * @param {number} [options.windowMs]    window length
 * @returns {{allowed: boolean, remaining: number, retryAfterSeconds: number}}
 */
export function checkRateLimit(key, { limit = 10, windowMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  evictExpired(now);

  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  bucket.count += 1;

  if (bucket.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  return { allowed: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
}

/** Test helper — not used in production paths. */
export function resetRateLimits() {
  buckets.clear();
}

/** FNV-1a — small, dependency-free, non-cryptographic. */
function hash(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Resolve a rate-limit key for the caller.
 *
 * Netlify Functions v2 exposes the client IP on the context argument; the
 * headers are fallbacks for other hosts and local dev.
 *
 * IMPORTANT: when no IP can be determined we must NOT fall back to a single
 * shared constant. Doing so puts every visitor into one bucket, so one noisy
 * client locks out everybody — which is exactly what happened in testing.
 * Instead we derive a coarse per-client fingerprint. It is weaker than an IP
 * (several users can collide), but it fails towards "limit the individual"
 * rather than "limit the whole world".
 *
 * @returns {{key: string, source: string}} source is safe to log; key is not.
 */
export function getClientIp(request, context) {
  if (context?.ip) return { key: context.ip, source: 'context' };

  const headers = request.headers;

  const direct = headers.get('x-nf-client-connection-ip');
  if (direct) return { key: direct, source: 'nf-header' };

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return { key: forwarded.split(',')[0].trim(), source: 'forwarded' };

  const clientIp = headers.get('client-ip');
  if (clientIp) return { key: clientIp, source: 'client-ip' };

  const fingerprint = [
    headers.get('user-agent') ?? '',
    headers.get('accept-language') ?? '',
    headers.get('sec-ch-ua') ?? '',
  ].join('|');

  return { key: `fp:${hash(fingerprint)}`, source: 'fingerprint' };
}
