import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  first() { return Promise.resolve(this.db.first(this.sql, this.params)); }
  all() { return Promise.resolve(this.db.all(this.sql, this.params)); }
  run() { return Promise.resolve(this.db.run(this.sql, this.params)); }
}

class FakeD1 {
  constructor() {
    this.totals = new Map();
    this.events = new Map();
    this.limits = new Map();
  }
  prepare(sql) { return new FakeStatement(this, sql); }
  first(sql, params) {
    if (sql.startsWith('INSERT INTO rate_limits')) {
      const [ipHash, windowStart] = params;
      const key = ipHash + ':' + windowStart;
      const count = (this.limits.get(key) || 0) + 1;
      this.limits.set(key, count);
      return { request_count: count };
    }
    if (sql.includes('FROM download_events WHERE event_id')) {
      const event = this.events.get(params[0]);
      return event ? { resource_key: event.resource_key } : null;
    }
    if (sql.includes('FROM download_totals')) {
      const total = this.totals.get(params[0]);
      if (!total) return null;
      return sql.includes('last_download_at') ? { total: total.total, last_download_at: total.last_download_at } : { total: total.total };
    }
    throw new Error('Unhandled first query: ' + sql);
  }
  all(sql) {
    if (sql.includes('FROM download_totals')) {
      return { results: Array.from(this.totals, ([resource_key, row]) => ({
        resource_key, total: row.total, last_download_at: row.last_download_at
      })) };
    }
    throw new Error('Unhandled all query: ' + sql);
  }
  run(sql, params) {
    if (sql.startsWith('INSERT OR IGNORE INTO download_events')) {
      const [eventId, resourceKey] = params;
      if (this.events.has(eventId)) return { meta: { changes: 0 } };
      const timestamp = new Date().toISOString();
      this.events.set(eventId, { resource_key: resourceKey });
      for (const key of ['__total__', resourceKey]) {
        const current = this.totals.get(key) || { total: 0, last_download_at: null };
        this.totals.set(key, { total: current.total + 1, last_download_at: timestamp });
      }
      return { meta: { changes: 1 } };
    }
    throw new Error('Unhandled run query: ' + sql);
  }
}

function makeEnv() {
  return {
    DB: new FakeD1(),
    RATE_LIMIT_SECRET: 'test-only-secret-that-is-at-least-32-bytes',
    ALLOWED_ORIGIN: 'https://petgabs.github.io'
  };
}
function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Origin', 'https://petgabs.github.io');
  headers.set('CF-Connecting-IP', '192.0.2.4');
  return new Request('https://counter.example.workers.dev' + path, { ...options, headers });
}

test('health and preflight are reachable', async () => {
  const env = makeEnv();
  const health = await worker.fetch(request('/health'), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'madv-download-counter');
  const preflight = await worker.fetch(request('/v1/download', { method: 'OPTIONS' }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://petgabs.github.io');
});

test('download events increment global and per-file totals once, including retries', async () => {
  const env = makeEnv();
  const body = JSON.stringify({ eventId: 'evt_0123456789abcdef', resourceKey: 'path:resources/Year 12/test.pdf' });
  const first = await worker.fetch(request('/v1/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body
  }), env);
  assert.equal(first.status, 202);
  assert.equal((await first.json()).total, 1);

  const retry = await worker.fetch(request('/v1/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body
  }), env);
  assert.equal(retry.status, 200);
  const retryBody = await retry.json();
  assert.equal(retryBody.duplicate, true);
  assert.equal(retryBody.total, 1);
  assert.equal(retryBody.resourceTotal, 1);

  const statsResponse = await worker.fetch(request('/v1/stats'), env);
  const stats = await statsResponse.json();
  assert.equal(stats.total, 1);
  assert.equal(stats.perFile['path:resources/Year 12/test.pdf'].total, 1);
});

test('invalid events and foreign browser origins are rejected', async () => {
  const env = makeEnv();
  const bad = await worker.fetch(request('/v1/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: 'short', resourceKey: 'path:foo.pdf' })
  }), env);
  assert.equal(bad.status, 400);

  const foreign = new Request('https://counter.example.workers.dev/v1/stats', {
    headers: { Origin: 'https://attacker.example', 'CF-Connecting-IP': '192.0.2.4' }
  });
  assert.equal((await worker.fetch(foreign, env)).status, 403);
});
