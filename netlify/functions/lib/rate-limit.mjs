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

/**
 * Best-effort client IP. Netlify populates x-nf-client-connection-ip; the
 * others are fallbacks for local dev and other hosts.
 */
export function getClientIp(request) {
  const headers = request.headers;
  const direct = headers.get('x-nf-client-connection-ip');
  if (direct) return direct;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();

  return headers.get('client-ip') || 'unknown';
}
