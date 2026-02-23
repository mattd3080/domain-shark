/**
 * Domain Shark — Cloudflare Worker Proxy
 * Premium domain lookup via Fastly Domain Research API (Domainr)
 *
 * Privacy: domain names are never logged. Only aggregate metrics are tracked.
 * Security: FASTLY_API_TOKEN lives in Cloudflare secrets, never in responses.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// Domain validation
// ---------------------------------------------------------------------------

function isValidDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  if (domain.length > 253) return false;
  const labels = domain.toLowerCase().split('.');
  if (labels.length < 2) return false;
  return labels.every(label => {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    return /^[a-z0-9-]+$/.test(label);
  });
}

// ---------------------------------------------------------------------------
// Domainr status mapping
// ---------------------------------------------------------------------------

/**
 * Maps Domainr space-separated status tokens to our simplified status string.
 *
 * Domainr returns status as a space-separated string of tokens, e.g.:
 *   "undelegated inactive", "active", "marketed", "priced", "parked"
 *
 * We split and check for key terms in priority order.
 */
function mapDomainrStatus(domainrStatusString) {
  if (!domainrStatusString || typeof domainrStatusString !== 'string') {
    return 'unknown';
  }

  const tokens = domainrStatusString.toLowerCase().split(/\s+/);

  // "marketed" or "for sale" → aftermarket listing
  if (tokens.includes('marketed') || tokens.includes('forsale') || domainrStatusString.toLowerCase().includes('for sale')) {
    return 'for_sale';
  }

  // "priced" → registry premium
  if (tokens.includes('priced')) {
    return 'premium';
  }

  // "parked" → registered but parked
  if (tokens.includes('parked')) {
    return 'parked';
  }

  // "active" present → domain is registered/taken
  if (tokens.includes('active')) {
    return 'taken';
  }

  // "inactive" → available for standard registration
  if (tokens.includes('inactive')) {
    return 'available';
  }

  return 'unknown';
}

/**
 * Parses the Domainr API response body and extracts our simplified status.
 * Domainr returns: { "status": [ { "domain": "...", "status": "...", ... } ] }
 */
function parseDomainrResponse(data, requestedDomain) {
  if (!data || !Array.isArray(data.status) || data.status.length === 0) {
    return 'unknown';
  }

  // Prefer the entry that matches our exact domain, fall back to first entry
  const normalizedRequest = requestedDomain.toLowerCase();
  const entry =
    data.status.find(s => s.domain && s.domain.toLowerCase() === normalizedRequest) ||
    data.status[0];

  return mapDomainrStatus(entry.status || entry.summary || '');
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: CORS_HEADERS,
  });
}

function errorResponse(status, errorCode, message) {
  const body = { error: errorCode };
  if (message) body.message = message;
  return jsonResponse(body, status);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Returns current UTC month as "YYYY-MM". */
function getCurrentMonth() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** Returns the current UTC minute boundary as a Unix timestamp (truncated to the minute). */
function getCurrentMinuteTimestamp() {
  return Math.floor(Date.now() / 60000);
}

// ---------------------------------------------------------------------------
// Client IP extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the client IP from the Cloudflare-provided header.
 * Falls back to a safe sentinel if the header is absent (local dev).
 */
function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// ---------------------------------------------------------------------------
// IP quota tracking
// ---------------------------------------------------------------------------

/**
 * Reads the current quota for a client IP from KV.
 *
 * KV key: ip:{clientIP}:{YYYY-MM}
 * KV value: { "checksUsed": N }
 *
 * Returns { allowed: bool, checksUsed: number, remaining: number }.
 * Fails open if KV is unavailable (allows the request through).
 */
async function checkQuota(env, clientIP, freeChecksPerIP) {
  if (!env.QUOTA_KV) {
    // KV not configured — fail open
    return { allowed: true, checksUsed: 0, remaining: freeChecksPerIP };
  }

  try {
    const key = `ip:${clientIP}:${getCurrentMonth()}`;
    const raw = await env.QUOTA_KV.get(key);
    const checksUsed = raw ? (JSON.parse(raw).checksUsed || 0) : 0;
    const allowed = checksUsed < freeChecksPerIP;
    const remaining = Math.max(0, freeChecksPerIP - checksUsed);
    return { allowed, checksUsed, remaining };
  } catch {
    // KV read failure — fail open
    return { allowed: true, checksUsed: 0, remaining: freeChecksPerIP };
  }
}

/**
 * Increments the quota counter for a client IP in KV.
 * TTL: 60 days (5184000 seconds).
 * Silently swallows KV errors to avoid breaking the response path.
 */
async function incrementQuota(env, clientIP, checksUsed) {
  if (!env.QUOTA_KV) return;

  try {
    const key = `ip:${clientIP}:${getCurrentMonth()}`;
    const newValue = JSON.stringify({ checksUsed: checksUsed + 1 });
    await env.QUOTA_KV.put(key, newValue, { expirationTtl: 5184000 });
  } catch {
    // KV write failure — non-fatal, request already succeeded
  }
}

// ---------------------------------------------------------------------------
// Global circuit breaker (monthly)
// ---------------------------------------------------------------------------

/**
 * Checks whether the global monthly circuit breaker is open (tripped).
 *
 * KV key: circuit:monthly:{YYYY-MM}
 * KV value: { "requestCount": N }
 *
 * Trips when total monthly requests reach MONTHLY_QUOTA_LIMIT (default 8000).
 *
 * Returns { open: bool, requestCount: number }.
 * Fails open if KV is unavailable.
 */
async function checkCircuitBreaker(env, monthlyQuotaLimit) {
  if (!env.QUOTA_KV) {
    return { open: false, requestCount: 0 };
  }

  try {
    const key = `circuit:monthly:${getCurrentMonth()}`;
    const raw = await env.QUOTA_KV.get(key);
    const requestCount = raw ? (JSON.parse(raw).requestCount || 0) : 0;
    return { open: requestCount >= monthlyQuotaLimit, requestCount };
  } catch {
    // KV read failure — fail open
    return { open: false, requestCount: 0 };
  }
}

/**
 * Increments the global monthly request counter in KV.
 * TTL: 60 days (5184000 seconds) — covers the current month plus buffer.
 *
 * If the new count hits the monthly limit, fires a one-time webhook alert
 * (via ALERT_WEBHOOK env var) so the operator knows the breaker has tripped.
 */
async function incrementMonthlyCount(env, monthlyQuotaLimit) {
  if (!env.QUOTA_KV) return;

  try {
    const month = getCurrentMonth();
    const key = `circuit:monthly:${month}`;
    const raw = await env.QUOTA_KV.get(key);
    const requestCount = raw ? (JSON.parse(raw).requestCount || 0) : 0;
    const newCount = requestCount + 1;
    await env.QUOTA_KV.put(key, JSON.stringify({ requestCount: newCount }), { expirationTtl: 5184000 });

    // Fire alert webhook exactly once when the breaker trips
    if (newCount >= monthlyQuotaLimit && requestCount < monthlyQuotaLimit) {
      await sendBreakerAlert(env, month, newCount, monthlyQuotaLimit);
    }
  } catch {
    // KV write failure — non-fatal
  }
}

/**
 * Sends a one-time webhook alert when the circuit breaker trips.
 * Requires ALERT_WEBHOOK env var (e.g., Discord/Slack webhook URL).
 * Silently no-ops if ALERT_WEBHOOK is not configured.
 */
async function sendBreakerAlert(env, month, count, limit) {
  if (!env.ALERT_WEBHOOK) return;

  try {
    await fetch(env.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `Domain Shark circuit breaker tripped for ${month}. ${count}/${limit} requests used. Premium search is now disabled until next month.`,
        content: `Domain Shark circuit breaker tripped for ${month}. ${count}/${limit} requests used. Premium search is now disabled until next month.`,
      }),
    });
  } catch {
    // Alert delivery failure — non-fatal
  }
}

// ---------------------------------------------------------------------------
// IP rate limiting
// ---------------------------------------------------------------------------

/**
 * Checks whether the client IP has exceeded the per-minute burst limit (10 req/min).
 *
 * KV key: ratelimit:{clientIP}:{minuteTimestamp}
 * KV value: { "count": N }
 * TTL: 120 seconds
 *
 * Returns { limited: bool }.
 * Fails open if KV is unavailable.
 */
async function checkRateLimit(env, clientIP) {
  if (!env.QUOTA_KV) {
    return { limited: false };
  }

  const RATE_LIMIT = 10;

  try {
    const minute = getCurrentMinuteTimestamp();
    const key = `ratelimit:${clientIP}:${minute}`;
    const raw = await env.QUOTA_KV.get(key);
    const count = raw ? (JSON.parse(raw).count || 0) : 0;

    if (count >= RATE_LIMIT) {
      return { limited: true };
    }

    // Increment the counter for this minute window
    const newValue = JSON.stringify({ count: count + 1 });
    await env.QUOTA_KV.put(key, newValue, { expirationTtl: 120 });
    return { limited: false };
  } catch {
    // KV failure — fail open
    return { limited: false };
  }
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handlePremiumCheck(request, env) {
  const freeChecksPerIP = parseInt(env.FREE_CHECKS_PER_IP, 10) || 5;
  const monthlyQuotaLimit = parseInt(env.MONTHLY_QUOTA_LIMIT, 10) || 8000;

  // Extract client IP first — needed for quota and rate limit checks
  const clientIP = getClientIP(request);

  // --- Rate limit check ---
  const { limited } = await checkRateLimit(env, clientIP);
  if (limited) {
    return jsonResponse(
      { error: 'rate_limited', message: 'Rate limit exceeded. Please try again later.' },
      429
    );
  }

  // --- Global circuit breaker check ---
  const { open } = await checkCircuitBreaker(env, monthlyQuotaLimit);
  if (open) {
    return errorResponse(503, 'service_unavailable');
  }

  // --- IP quota check ---
  const { allowed, checksUsed, remaining } = await checkQuota(env, clientIP, freeChecksPerIP);
  if (!allowed) {
    return jsonResponse({ error: 'quota_exceeded', remainingChecks: 0 }, 429);
  }

  // Enforce Content-Type
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return errorResponse(400, 'bad_request', 'Content-Type must be application/json');
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'bad_request', 'Request body is not valid JSON');
  }

  const { domain } = body;

  // Validate domain field
  if (!domain) {
    return errorResponse(400, 'bad_request', 'Missing required field: domain');
  }
  if (typeof domain !== 'string') {
    return errorResponse(400, 'bad_request', 'Field "domain" must be a string');
  }
  if (!isValidDomain(domain)) {
    return errorResponse(400, 'bad_request', 'Invalid domain format');
  }

  // Guard: FASTLY_API_TOKEN must be configured
  if (!env.FASTLY_API_TOKEN) {
    return errorResponse(503, 'service_unavailable');
  }

  // Forward to Fastly Domain Research API (Domainr)
  let domainrResponse;
  try {
    domainrResponse = await fetch(
      `https://api.domainr.com/v2/status?domain=${encodeURIComponent(domain)}`,
      {
        headers: {
          'Fastly-Key': env.FASTLY_API_TOKEN,
        },
      }
    );
  } catch {
    // Network-level failure reaching the upstream API
    return errorResponse(503, 'service_unavailable');
  }

  // Handle upstream quota errors
  if (domainrResponse.status === 429) {
    return jsonResponse({ error: 'quota_exceeded', remainingChecks: 0 }, 429);
  }

  // Handle other upstream errors
  if (!domainrResponse.ok) {
    return errorResponse(503, 'service_unavailable');
  }

  // Parse upstream response
  let domainrData;
  try {
    domainrData = await domainrResponse.json();
  } catch {
    return errorResponse(503, 'service_unavailable');
  }

  // Map status — domain name is used only for matching, never logged
  const status = parseDomainrResponse(domainrData, domain);

  // API call succeeded — increment quota and global monthly counter
  await Promise.all([
    incrementQuota(env, clientIP, checksUsed),
    incrementMonthlyCount(env, monthlyQuotaLimit),
  ]);

  return jsonResponse({
    status,
    data: domainrData,
    remainingChecks: Math.max(0, freeChecksPerIP - (checksUsed + 1)),
  });
}

// ---------------------------------------------------------------------------
// Worker entry point (ES module syntax)
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight for all routes
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // Route: POST /v1/premium-check
      if (request.method === 'POST' && url.pathname === '/v1/premium-check') {
        return await handlePremiumCheck(request, env);
      }

      // All other routes → 404
      return errorResponse(404, 'not_found', 'Endpoint not found');
    } catch {
      // Catch-all: never expose internals
      return errorResponse(500, 'internal_error');
    }
  },
};
