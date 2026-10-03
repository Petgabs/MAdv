const TOTAL_KEY = '__total__';
const MAX_BODY_BYTES = 2048;
const MAX_RESOURCE_KEY_LENGTH = 300;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{12,80}$/;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '*').split(',').map((item) => item.trim()).filter(Boolean);
  const wildcard = allowed.includes('*') || allowed.length === 0;
  const originAllowed = !origin || wildcard || allowed.includes(origin);
  const responseOrigin = wildcard ? '*' : (origin && allowed.includes(origin) ? origin : allowed[0]);
  return {
    originAllowed,
    headers: {
      'Access-Control-Allow-Origin': responseOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Vary': 'Origin'
    }
  };
}

function jsonResponse(request, env, body, status = 200, extraHeaders = {}) {
  const cors = corsHeaders(request, env);
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors.headers, ...extraHeaders }
  });
}

function validResourceKey(value) {
  return typeof value === 'string' &&
    value.length > 0 && value.length <= MAX_RESOURCE_KEY_LENGTH &&
    /^(path|id|file):/.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value !== TOTAL_KEY;
}

async function hmacIp(ip, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(ip));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function checkRateLimit(request, env, maximum = 120) {
  const secret = String(env.RATE_LIMIT_SECRET || '');
  if (secret.length < 32) throw new Error('RATE_LIMIT_SECRET is not configured.');
  if (!env.DB) throw new Error('The D1 database binding is not configured.');

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await hmacIp(ip, secret);
  const windowStart = Math.floor(Date.now() / 60000) * 60;
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits (ip_hash, window_start, request_count) VALUES (?, ?, 1) ' +
    'ON CONFLICT (ip_hash, window_start) DO UPDATE SET request_count = request_count + 1 ' +
    'RETURNING request_count'
  ).bind(ipHash, windowStart).first();
  return Number(row && row.request_count) <= maximum;
}

function safeTotal(value) {
  const total = Number(value);
  return Number.isSafeInteger(total) && total >= 0 ? total : 0;
}

async function getDownloadStats(env) {
  const result = await env.DB.prepare(
    'SELECT resource_key, total, last_download_at FROM download_totals ORDER BY resource_key LIMIT 5000'
  ).all();
  const rows = result && Array.isArray(result.results) ? result.results : [];
  const totalRow = rows.find((row) => row.resource_key === TOTAL_KEY);
  const perFile = Object.create(null);
  rows.forEach((row) => {
    if (row.resource_key === TOTAL_KEY) return;
    perFile[row.resource_key] = {
      total: safeTotal(row.total),
      lastDownloadAt: row.last_download_at || null
    };
  });
  return {
    ok: true,
    total: safeTotal(totalRow && totalRow.total),
    perFile,
    updatedAt: new Date().toISOString()
  };
}

async function handleDownload(request, env) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse(request, env, { ok: false, error: 'Request body is too large.' }, 413);
  }
  if (!String(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) {
    return jsonResponse(request, env, { ok: false, error: 'Expected application/json.' }, 415);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return jsonResponse(request, env, { ok: false, error: 'Request body is too large.' }, 413);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch (_error) {
    return jsonResponse(request, env, { ok: false, error: 'Invalid JSON.' }, 400);
  }

  const resourceKey = body && body.resourceKey;
  const eventId = body && body.eventId;
  if (!validResourceKey(resourceKey)) {
    return jsonResponse(request, env, { ok: false, error: 'Invalid resource key.' }, 400);
  }
  if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) {
    return jsonResponse(request, env, { ok: false, error: 'Invalid event ID.' }, 400);
  }

  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO download_events (event_id, resource_key, created_at) VALUES (?, ?, ?)'
  ).bind(eventId, resourceKey, Math.floor(Date.now() / 1000)).run();
  const accepted = Number(inserted && inserted.meta && inserted.meta.changes) === 1;

  // A retried event is idempotent. Return the original resource's current total
  // even if a malformed client reuses an event ID with a different key.
  let countedKey = resourceKey;
  if (!accepted) {
    const original = await env.DB.prepare(
      'SELECT resource_key FROM download_events WHERE event_id = ?'
    ).bind(eventId).first();
    if (original && original.resource_key) countedKey = original.resource_key;
  }

  const [globalRow, fileRow] = await Promise.all([
    env.DB.prepare('SELECT total FROM download_totals WHERE resource_key = ?').bind(TOTAL_KEY).first(),
    env.DB.prepare('SELECT total, last_download_at FROM download_totals WHERE resource_key = ?').bind(countedKey).first()
  ]);

  return jsonResponse(request, env, {
    ok: true,
    accepted,
    duplicate: !accepted,
    total: safeTotal(globalRow && globalRow.total),
    resourceKey: countedKey,
    resourceTotal: safeTotal(fileRow && fileRow.total),
    lastDownloadAt: fileRow && fileRow.last_download_at || null
  }, accepted ? 202 : 200);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (!cors.originAllowed) {
    return jsonResponse(request, env, { ok: false, error: 'Origin not allowed.' }, 403);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors.headers });
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    return jsonResponse(request, env, { ok: true, service: 'madv-download-counter', version: 1 });
  }
  if (url.pathname !== '/v1/stats' && url.pathname !== '/v1/download') {
    return jsonResponse(request, env, { ok: false, error: 'Not found.' }, 404);
  }
  if ((url.pathname === '/v1/stats' && request.method !== 'GET') ||
      (url.pathname === '/v1/download' && request.method !== 'POST')) {
    return jsonResponse(request, env, { ok: false, error: 'Method not allowed.' }, 405, { Allow: url.pathname === '/v1/stats' ? 'GET, OPTIONS' : 'POST, OPTIONS' });
  }

  try {
    const allowed = await checkRateLimit(request, env, 300);
    if (!allowed) {
      const retryAfter = 60 - Math.floor((Date.now() % 60000) / 1000);
      return jsonResponse(request, env, { ok: false, error: 'Rate limit exceeded. Try again shortly.' }, 429, { 'Retry-After': String(retryAfter) });
    }

    if (url.pathname === '/v1/stats') {
      return jsonResponse(request, env, await getDownloadStats(env));
    }
    return await handleDownload(request, env);
  } catch (error) {
    return jsonResponse(request, env, {
      ok: false,
      error: error && error.message ? error.message : 'Counter service failed.'
    }, 503);
  }
}

export default {
  fetch: handleRequest,
  scheduled(_controller, env, context) {
    const now = Math.floor(Date.now() / 1000);
    context.waitUntil(Promise.all([
      env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 86400).run(),
      env.DB.prepare('DELETE FROM download_events WHERE created_at < ?').bind(now - 2592000).run()
    ]));
  }
};
