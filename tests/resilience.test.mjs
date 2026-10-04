// Test: the security, durability and classroom-load hardening.
//
// Loads the real index.html in jsdom (like e2e.test.mjs and upload.test.mjs)
// and drives the actual page functions:
//   1. sign-in brute-force lockout, doubling and reset
//   2. admin inactivity sign-out and the tab-scoped admin session
//   3. the Content-Security-Policy
//   4. login retry with jittered backoff — and no retry on a refusal
//   5. download timeout, single retry, 3-at-a-time gate, shared in-flight fetch
//   6. the durable download cache (TTL, revision key, size cap)
//   7. the offline event queue cooling down instead of hammering the backend
//   8. the global error shield and the Diagnostics panel
//   9. isolated actions and renderers, toast flood control, hidden-tab renders
//  10. the fixed "Signing in…" button on a wrong password
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { randomUUID, randomFillSync } from 'node:crypto';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// jsdom has no Response constructor, so the fakes are plain response-shaped
// objects — the same approach e2e.test.mjs uses.
const jsonRes = (status, body) => Promise.resolve({
  status, ok: status >= 200 && status < 300,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body))
});
const bytesRes = (window, text, status = 200, delay = 0) => new Promise((resolve) => {
  setTimeout(() => resolve({
    status, ok: status >= 200 && status < 300,
    blob: () => Promise.resolve(new window.Blob([text], { type: 'application/pdf' })),
    text: () => Promise.resolve(text)
  }), delay);
});

function boot(options = {}) {
  const seed = options.seed || {};
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://petgabs.github.io/MAdv/',
    pretendToBeVisual: true,
    beforeParse(window) {
      try {
        Object.defineProperty(window, 'crypto', {
          value: { randomUUID, getRandomValues: (a) => randomFillSync(a) },
          configurable: true
        });
      } catch (e) {}
      window.scrollTo = () => {};
      window.URL.createObjectURL = () => '#test-blob';
      window.URL.revokeObjectURL = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const custom = options.fetch ? options.fetch(window, url, init || {}) : null;
        return custom || jsonRes(200, {});
      };
      Object.keys(seed).forEach((k) => window.localStorage.setItem(k, JSON.stringify(seed[k])));
      if (options.beforeParse) options.beforeParse(window);
    }
  });
  return dom;
}

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

// A student record the page treats as device-only (never synced).
function seedStudent(w) {
  w.state.students = [{
    id: 'stu_test', firstName: 'Ada', year: 'Year 11', username: 'ada11',
    password: 'ada1111', status: 'active', downloads: [], registeredAt: new Date().toISOString(),
    visitCount: 1, downloadCount: 0, device: 'test'
  }];
  w.saveStudents();
}

// --- 1. Sign-in brute-force lockout ---------------------------------------
console.log('1. sign-in brute-force lockout');
{
  const dom = boot();
  const w = dom.window;
  seedStudent(w);

  check('a fresh device is not locked', w.authLockRemaining() === 0);

  let lastError = '';
  for (let i = 0; i < 4; i++) {
    try { w.loginAdmin('peter82', 'wrong'); } catch (err) { lastError = err.message; }
  }
  check('4 failures do not lock the device', w.authLockRemaining() === 0);
  check('4th failure still reports a plain credential error',
    /Incorrect administrator/.test(lastError) && !/paused/.test(lastError), lastError);

  try { w.loginAdmin('peter82', 'wrong'); } catch (err) { lastError = err.message; }
  const first = w.authLockRemaining();
  check('the 5th failure locks the device', first > 0);
  check('the first lock is 60 seconds', first > 55000 && first <= 60000, first);
  check('the message explains the pause', /paused for 1 minute/.test(lastError), lastError);

  // While locked, even the correct password is refused.
  let lockedError = '';
  try { w.loginAdmin('peter82', 'petgabs82'); } catch (err) { lockedError = err.message; }
  check('the correct password is refused while locked', /Too many failed sign-in attempts/.test(lockedError), lockedError);
  check('a locked attempt did not sign anyone in', !w.currentAdmin());

  // Doubling: rewind the clock past the pause and fail five more times.
  const doubling = [];
  for (let round = 0; round < 5; round++) {
    const lock = w.store.get('madv.auth-lock.v1', null);
    w.store.set('madv.auth-lock.v1', Object.assign({}, lock, { until: 0, fails: 0 }));
    for (let i = 0; i < 5; i++) { try { w.loginAdmin('peter82', 'wrong'); } catch (e) {} }
    doubling.push(Math.round(w.authLockRemaining() / 1000));
  }
  check('each lock doubles the last', doubling.slice(0, 3).join(',') === '120,240,480', doubling);
  check('doubling stops at 15 minutes', doubling[3] === 900 && doubling[4] === 900, doubling);

  // A successful sign-in wipes the history.
  w.store.remove('madv.auth-lock.v1');
  for (let i = 0; i < 4; i++) { try { w.loginAdmin('peter82', 'wrong'); } catch (e) {} }
  w.loginAdmin('peter82', 'petgabs82');
  check('a successful sign-in resets the counter', w.store.get('madv.auth-lock.v1', null) === null);
  check('the admin is signed in', !!w.currentAdmin());
}

// A student hitting the same wall (no shared backend configured).
{
  const dom = boot();
  const w = dom.window;
  seedStudent(w);
  const run = async () => {
    for (let i = 0; i < 5; i++) {
      try { await w.loginStudent('ada11', 'nope'); } catch (e) { /* expected */ }
    }
    check('student failures lock the device too', w.authLockRemaining() > 0);
    let msg = '';
    try { await w.loginStudent('ada11', 'ada1111'); } catch (err) { msg = err.message; }
    check('a locked student sees the wait message', /Too many failed sign-in attempts/.test(msg), msg);
    check('the locked student is not signed in', !w.currentStudent());

    w.store.remove('madv.auth-lock.v1');
    const student = await w.loginStudent('ada11', 'ada1111');
    check('the right password still works once the pause ends', student && student.username === 'ada11');
    check('the successful student sign-in cleared the lock', w.store.get('madv.auth-lock.v1', null) === null);
  };
  await run();
}

// --- 2. Admin inactivity sign-out + tab-scoped admin session ---------------
console.log('2. admin inactivity sign-out');
{
  const dom = boot();
  const w = dom.window;
  check('default idle limit is 60 minutes', w.adminIdleMinutes() === 60);
  check('the settings field exists', !!dom.window.document.querySelector('#opt-admin-idle'));

  w.loginAdmin('peter82', 'petgabs82');
  check('signed in', !!w.currentAdmin());

  w.adminIdle.last = Date.now() - 59 * 60 * 1000;
  w.checkAdminIdle();
  check('59 idle minutes keeps the admin signed in', !!w.currentAdmin());

  w.adminIdle.last = Date.now() - 61 * 60 * 1000;
  w.checkAdminIdle();
  check('61 idle minutes signs the admin out', !w.currentAdmin());

  // Configurable, including 0 = never.
  w.loginAdmin('peter82', 'petgabs82');
  w.state.settings.adminIdleMinutes = 0;
  w.adminIdle.last = Date.now() - 48 * 60 * 60 * 1000;
  w.checkAdminIdle();
  check('0 means never sign out', !!w.currentAdmin());

  w.state.settings.adminIdleMinutes = 5;
  w.adminIdle.last = Date.now() - 6 * 60 * 1000;
  w.checkAdminIdle();
  check('a 5 minute limit is honoured', !w.currentAdmin());

  // The 1–480 clamp applied when the teacher saves the field.
  w.loginAdmin('peter82', 'petgabs82');
  const idleInput = dom.window.document.querySelector('#opt-admin-idle');
  idleInput.value = '9999';
  w.saveOptions();
  check('an over-large value clamps to 480', w.state.settings.adminIdleMinutes === 480, w.state.settings.adminIdleMinutes);
  idleInput.value = '-3';
  w.saveOptions();
  check('a negative value falls back to the default', w.state.settings.adminIdleMinutes === 60);
  idleInput.value = '0';
  w.saveOptions();
  check('0 is kept as "never"', w.state.settings.adminIdleMinutes === 0);
  idleInput.value = '45';
  w.saveOptions();
  check('a sensible value is kept', w.state.settings.adminIdleMinutes === 45);
}

// A stored admin session must not survive closing the tab.
{
  const dom = boot();
  const w = dom.window;
  w.loginAdmin('peter82', 'petgabs82');
  check('the admin session is not written to localStorage',
    w.localStorage.getItem('madv.session.v2') === null);
  check('the admin session lives in sessionStorage',
    JSON.parse(w.sessionStorage.getItem('madv.session.v2') || '{}').role === 'admin');

  // A student session, by contrast, is remembered on the device.
  seedStudent(w);
  w.state.session = { role: 'student', studentId: 'stu_test', at: new Date().toISOString() };
  w.saveSession();
  check('a student session is remembered on the device',
    JSON.parse(w.localStorage.getItem('madv.session.v2') || '{}').role === 'student');
}
{
  // Reopening the site (fresh sessionStorage) with a legacy admin session on disk.
  const dom = boot({ seed: { 'madv.session.v2': { role: 'admin', at: new Date().toISOString() } } });
  const w = dom.window;
  check('a legacy stored admin session is not honoured on a new tab', !w.currentAdmin());
  check('and it is scrubbed from disk', w.localStorage.getItem('madv.session.v2') === null);
}

// --- 3. Content-Security-Policy -------------------------------------------
console.log('3. content security policy');
{
  const dom = boot();
  const meta = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const csp = meta ? meta.getAttribute('content') : '';
  check('the CSP is present', !!csp);
  check('no plugins', /object-src 'none'/.test(csp));
  check('no base injection', /base-uri 'none'/.test(csp));
  check('no form posting', /form-action 'none'/.test(csp));
  check('no workers', /worker-src 'none'/.test(csp));
  check('connect-src is an allowlist, not a wildcard', /connect-src [^;]*supabase\.co/.test(csp) && !/connect-src [^;]*\*\s/.test(csp));
  check('default-src is self', /default-src 'self'/.test(csp));
}

// --- 4. Login retry with jittered backoff ----------------------------------
console.log('4. login retry with jittered backoff');
{
  // A transient failure (a 9:00 am rate limit) is retried exactly once.
  let calls = 0;
  const dom = boot({
    fetch: (w, url) => {
      if (String(url).includes('/rpc/madv_login')) {
        calls++;
        if (calls === 1) return Promise.reject(new Error('network blip'));
        return jsonRes(200, {
          ok: true, id: 'cloud1', username: 'ada11', firstName: 'Ada', year: 'Year 11',
          password: 'ada1111', status: 'active'
        });
      }
      return null;
    }
  });
  const w = dom.window;
  w.state.sync.url = 'https://example.supabase.co';
  w.state.sync.key = 'test-key';
  w.state.sync.loaded = true;
  w.state.settings.syncEnabled = true;

  const student = await w.loginStudent('ada11', 'ada1111');
  check('a transient backend failure is retried', calls === 2, calls);
  check('and the student is signed in after the retry', !!student && student.username === 'ada11');
}
{
  // A real refusal (wrong password) must never be retried.
  let calls = 0;
  const dom = boot({
    fetch: (w, url) => {
      if (String(url).includes('/rpc/madv_login')) {
        calls++;
        return jsonRes(200, { ok: false, error: 'Wrong password.' });
      }
      return null;
    }
  });
  const w = dom.window;
  w.state.sync.url = 'https://example.supabase.co';
  w.state.sync.key = 'test-key';
  w.state.sync.loaded = true;
  w.state.students = [{
    id: 'stu_test', firstName: 'Ada', year: 'Year 11', username: 'ada11', password: 'ada1111',
    status: 'active', downloads: [], registeredAt: new Date().toISOString(),
    syncedAt: new Date().toISOString(), visitCount: 0, downloadCount: 0
  }];
  let msg = '';
  try { await w.loginStudent('ada11', 'wrong'); } catch (err) { msg = err.message; }
  check('a refusal is not retried', calls === 1, calls);
  check('and the refusal reaches the student', /Wrong password/.test(msg), msg);
}
{
  const dom = boot();
  const w = dom.window;
  check('refusals are classed as final', w.isTransientError({ refused: true }) === false);
  check('fatal errors are classed as final', w.isTransientError({ fatal: true }) === false);
  check('a timeout is classed as transient', w.isTransientError(new Error('timeout')) === true);
  const spread = Array.from({ length: 40 }, () => w.jittered(1000));
  check('backoff is jittered, not fixed', new Set(spread).size > 20);
  check('jitter stays within half to one-and-a-half times the base',
    spread.every((v) => v >= 500 && v <= 1500));
}

// --- 5 & 6. Downloads: timeout, retry, parallel cap, sharing, cache --------
console.log('5. download timeout, retry, parallel cap and sharing');
{
  const dom = boot();
  const w = dom.window;
  check('the parallel cap is 3', w.DOWNLOAD_MAX_PARALLEL === 3);
  check('the timeout is 30 seconds', w.DOWNLOAD_TIMEOUT_MS === 30000);
  check('the cache lives 10 minutes', w.DOWNLOAD_CACHE_TTL_MS === 10 * 60 * 1000);
  check('the cache is capped at ~120 MB', w.DOWNLOAD_CACHE_MAX_BYTES === 120 * 1024 * 1024);

  // The gate: 10 tasks, never more than 3 running, and all of them finish.
  let running = 0, peak = 0, done = 0;
  const releases = [];
  const jobs = Array.from({ length: 10 }, () => w.gateRun(() => new Promise((resolve) => {
    running++; peak = Math.max(peak, running);
    releases.push(() => { running--; done++; resolve('ok'); });
  })));
  await settle();
  check('only 3 fetches start at once', peak === 3, peak);
  check('the rest queue in order', releases.length === 3);
  while (releases.length) { releases.shift()(); await settle(2); }
  const results = await Promise.all(jobs);
  check('every queued fetch still completes', done === 10 && results.length === 10, { done });
  check('the gate empties afterwards', w.downloadGate.active === 0 && w.downloadGate.waiting.length === 0);
}
{
  // Concurrent clicks on the same file share one fetch; the cache then serves it.
  let fetches = 0;
  const dom = boot({
    fetch: (w, url) => {
      if (/\.pdf/.test(String(url))) {
        fetches++;
        return bytesRes(w, '%PDF-1.4 bytes', 200, 10);
      }
      return null;
    }
  });
  const w = dom.window;
  w.state.settings.repo = 'Petgabs/MAdv';
  const item = {
    id: 'res1', title: 'Trial paper', fileName: 'trial.pdf', ext: 'pdf', year: 'Year 12',
    path: 'resources/trial.pdf', source: 'cloud', sha: 'abc123', visible: true
  };
  const burst = await Promise.all([1, 2, 3, 4, 5].map(() => w.fetchFileBlob(item)));
  check('five concurrent clicks share a single fetch', fetches === 1, fetches);
  check('every caller still gets the file', burst.every((b) => b && b.size > 0));

  const again = await w.fetchFileBlob(item);
  check('a later click is served from the cache', fetches === 1 && again.size > 0, fetches);

  // A replaced file (new revision) is never served from the old copy.
  const replaced = Object.assign({}, item, { sha: 'def456' });
  check('the cache key carries the revision',
    w.downloadCacheKey(item) !== w.downloadCacheKey(replaced));
  await w.fetchFileBlob(replaced);
  check('a replaced file is re-fetched, not served stale', fetches === 2, fetches);

  // Past its ten minutes the entry is dropped rather than served.
  const key = w.downloadCacheKey(item);
  w.downloadCache.memory[key].at = Date.now() - 11 * 60 * 1000;
  const stale = await w.downloadCacheRead(key);
  check('an expired cache entry is not served', stale === null);
  check('and the stale copy is dropped from memory', !(key in w.downloadCache.memory));
  await w.fetchFileBlob(item);
  check('an expired file is fetched again', fetches === 3, fetches);
}
{
  // The durable tier: oldest-first eviction once the cache passes its cap.
  const dom = boot();
  const w = dom.window;
  const removed = [];
  w.fileStore.del = (k, store) => { removed.push(k + '@' + store); return Promise.resolve(true); };

  const now = Date.now();
  const sixty = 60 * 1024 * 1024;
  w.store.set('madv.download-cache.v1', {
    oldest: { at: now - 5000, bytes: sixty },
    middle: { at: now - 3000, bytes: sixty },
    newest: { at: now - 1000, bytes: sixty },
    expired: { at: now - 20 * 60 * 1000, bytes: 1024 }
  });
  const dropped = await w.downloadCachePrune();
  const left = Object.keys(w.downloadCacheIndex()).sort();
  check('an entry past its ten minutes is swept', !left.includes('expired'));
  check('the oldest entry goes first once past the cap', !left.includes('oldest'), left);
  check('entries within the cap are kept', left.join(',') === 'middle,newest', left);
  check('they are deleted from IndexedDB too',
    removed.includes('oldest@cache') && removed.includes('expired@cache'), removed);
  check('prune reports what it dropped', dropped === 2, dropped);
}
{
  // A cache that cannot be written (private mode, full disk) still serves the
  // lesson from memory and reports itself in Diagnostics instead of failing.
  const dom = boot();
  const w = dom.window;
  w.fileStore.put = () => Promise.reject(new Error('QuotaExceededError'));
  const blob = new w.Blob(['bytes'], { type: 'application/pdf' });
  const ok = await w.downloadCacheWrite('k1', blob);
  check('a failed cache write does not throw', ok === false);
  check('the memory copy still serves this lesson', !!w.downloadCache.memory.k1);
  check('the failure is recorded in diagnostics',
    w.diagnostics.list.some((e) => e.kind === 'cache'), w.diagnostics.list);
  check('and nothing is left dangling in the index', !('k1' in w.downloadCacheIndex()));
}
{
  // A failing fetch is retried once; a 404 is not retried at all.
  let attempts = 0;
  const dom = boot({
    fetch: (w, url) => {
      if (/\.pdf/.test(String(url))) {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error('connection reset'));
        return bytesRes(w, '%PDF-1.4 bytes');
      }
      return null;
    }
  });
  const w = dom.window;
  w.state.settings.repo = 'Petgabs/MAdv';
  const blob = await w.fetchFileBlob({
    id: 'r2', fileName: 'a.pdf', ext: 'pdf', path: 'resources/a.pdf', source: 'cloud', sha: 's1'
  });
  check('a dropped download is retried once', attempts === 2, attempts);
  check('and the retry delivers the file', blob.size > 0);
}
{
  let attempts = 0;
  const dom = boot({
    fetch: (w, url) => {
      if (/\.pdf/.test(String(url))) {
        attempts++;
        return bytesRes(w, 'missing', 404);
      }
      return null;
    }
  });
  const w = dom.window;
  w.state.settings.repo = 'Petgabs/MAdv';
  let msg = '';
  try {
    await w.fetchFileBlob({ id: 'r3', fileName: 'b.pdf', ext: 'pdf', path: 'resources/b.pdf', source: 'cloud', sha: 's2' });
  } catch (err) { msg = err.message; }
  check('a missing file is not retried', attempts === 1, attempts);
  check('and the error explains itself', /HTTP 404/.test(msg), msg);
}

// --- 7. Offline event queue cooldown ---------------------------------------
console.log('6. offline queue cools down instead of hammering the backend');
{
  let rpcCalls = 0;
  const dom = boot({
    fetch: (w, url) => {
      if (String(url).includes('/rest/v1/rpc/madv_download')) {
        rpcCalls++;
        return jsonRes(503, { error: 'project paused' });   // transient
      }
      if (String(url).includes('/rest/v1/rpc/')) return jsonRes(503, { error: 'project paused' });
      return null;
    }
  });
  const w = dom.window;
  w.state.sync.url = 'https://example.supabase.co';
  w.state.sync.key = 'test-key';
  w.state.sync.loaded = true;
  w.state.settings.syncEnabled = true;

  // Thirty devices' worth of events queued while the room was offline.
  w.syncQueueSave([]);
  for (let i = 0; i < 30; i++) {
    w.syncQueueAdd({ name: 'madv_download', payload: { p_resource_key: 'path:r' + i } });
  }
  check('30 events are durably queued', w.syncQueue().length === 30);

  rpcCalls = 0;
  await w.syncQueueFlush();
  check('a transient failure stops the drain after one call', rpcCalls === 1, rpcCalls);
  const stillQueued = w.syncQueue().filter((e) => e.name === 'madv_download').length;
  check('the events are not thrown away', stillQueued === 30, stillQueued);
  check('a cooldown has started', w.syncCooldownActive());
  check('the first cooldown is 30 seconds', w.state.sync.cooldownMs === 30000, w.state.sync.cooldownMs);

  rpcCalls = 0;
  await w.syncQueueFlush();
  check('a flush during the cooldown makes no requests at all', rpcCalls === 0, rpcCalls);

  // Each further failure doubles the wait, to a 5 minute ceiling.
  const steps = [];
  for (let i = 0; i < 6; i++) {
    w.state.sync.cooldownUntil = 0;
    await w.syncQueueFlush();
    steps.push(w.state.sync.cooldownMs);
  }
  check('the cooldown doubles', steps.slice(0, 3).join(',') === '60000,120000,240000', steps);
  check('and stops at 5 minutes', steps[steps.length - 1] === 300000, steps);
  check('the cooldown is jittered, not a fixed deadline',
    w.state.sync.cooldownUntil - Date.now() < w.state.sync.cooldownMs);
}
{
  // Once the backend answers, the queue drains and the cooldown clears.
  const dom = boot({
    fetch: (w, url) => String(url).includes('/rest/v1/rpc/') ? jsonRes(200, { ok: true }) : null
  });
  const w = dom.window;
  w.state.sync.url = 'https://example.supabase.co';
  w.state.sync.key = 'test-key';
  w.state.sync.loaded = true;
  for (let i = 0; i < 5; i++) w.syncQueueAdd({ name: 'madv_download', payload: { p_resource_key: 'path:r' + i } });
  const sent = await w.syncQueueFlush();
  check('a healthy backend drains the whole queue', sent === 5 && w.syncQueue().length === 0, { sent });
  check('and the cooldown is cleared', !w.syncCooldownActive() && w.state.sync.cooldownMs === 0);
}

// --- 8. Global error shield and the Diagnostics panel ----------------------
console.log('7. error shield and diagnostics');
{
  const dom = boot();
  const w = dom.window, d = w.document;
  w.loginAdmin('peter82', 'petgabs82');
  w.showView('settings');
  w.clearDiagnostics();
  w.renderSettings();

  check('the Diagnostics panel exists', !!d.querySelector('#diagnostics-list'));
  check('it starts empty', /Nothing recorded/.test(d.querySelector('#diagnostics-list').textContent));

  // A script error anywhere on the page.
  w.dispatchEvent(new w.ErrorEvent('error', {
    message: 'x is not defined', filename: 'index.html', lineno: 42
  }));
  await settle();
  check('a script error is recorded', w.diagnostics.list.length === 1, w.diagnostics.list);
  check('the panel shows it', /x is not defined/.test(d.querySelector('#diagnostics-list').textContent));
  check('the tag counts it', /1 recorded/.test(d.querySelector('#diagnostics-tag').textContent));

  // An unhandled promise rejection.
  w.recordDiagnostic('promise', 'Supabase timed out', 'unhandled rejection');
  check('a rejection is recorded', w.diagnostics.list.length === 2);

  // Repeats collapse into a count instead of filling the list.
  for (let i = 0; i < 10; i++) w.recordDiagnostic('promise', 'Supabase timed out', 'unhandled rejection');
  check('repeats collapse into one entry', w.diagnostics.list.length === 2, w.diagnostics.list.length);
  check('with a count', w.diagnostics.list[1].count === 11, w.diagnostics.list[1].count);

  // Only the last 25 are kept.
  for (let i = 0; i < 60; i++) w.recordDiagnostic('script', 'problem number ' + i);
  check('only the last 25 are kept', w.diagnostics.list.length === 25, w.diagnostics.list.length);
  check('the newest is the last one recorded', w.diagnostics.list[24].message === 'problem number 59');

  check('diagnostics survive a reload (stored)', JSON.parse(w.localStorage.getItem('madv.diagnostics.v1')).length === 25);

  // One-click clear.
  d.querySelector('[data-action="clear-diagnostics"]').click();
  check('the clear button empties the list', w.diagnostics.list.length === 0);
  check('and the panel says so', /Nothing recorded/.test(d.querySelector('#diagnostics-list').textContent));
}

// --- 9. Isolation, toast flood control, hidden tabs ------------------------
console.log('8. isolation, toasts and hidden tabs');
{
  const dom = boot();
  const w = dom.window, d = w.document;
  await settle();                      // let start-up wire the click dispatcher

  // A broken action reports itself and leaves the page standing.
  w.ACTIONS['test-explode'] = () => { throw new Error('deliberate action failure'); };
  const btn = d.createElement('button');
  btn.setAttribute('data-action', 'test-explode');
  d.body.appendChild(btn);
  const before = w.diagnostics.list.length;
  btn.click();
  check('a broken button action does not escape', w.diagnostics.list.length === before + 1);
  check('it is recorded as an action', w.diagnostics.list[w.diagnostics.list.length - 1].kind === 'action');
  check('the page is still rendered', !!d.querySelector('#view-library'));

  // A broken renderer cannot blank the page.
  const good = w.renderMyLearning;
  w.renderMyLearning = () => { throw new Error('deliberate render failure'); };
  w.ACTIONS['test-explode'] = undefined;
  let threw = false;
  try { w.renderAll(); } catch (e) { threw = true; }
  check('renderAll survives a broken section', threw === false);
  check('the library is still on the page',
    !!d.querySelector('#view-library') && !!d.querySelector('#library-search'));
  w.renderMyLearning = good;

  // Toast flood control.
  const stack = d.querySelector('#toast-stack');
  stack.innerHTML = '';
  w.toastLive.length = 0;
  for (let i = 0; i < 12; i++) w.toast('Download failed', 'error');
  check('a repeated toast collapses to one', stack.children.length === 1, stack.children.length);
  check('with a repeat counter', stack.querySelector('.toast__count').textContent === '×12',
    stack.querySelector('.toast__count').textContent);
  ['one', 'two', 'three', 'four', 'five', 'six'].forEach((m) => w.toast(m, 'info'));
  check('the stack is capped', stack.children.length <= w.TOAST_MAX, stack.children.length);
  check('the newest message is kept', stack.textContent.includes('six'));
}
{
  // Hidden tabs skip re-rendering but keep their data fresh.
  const dom = boot();
  const w = dom.window, d = w.document;
  await settle();
  w.loginAdmin('peter82', 'petgabs82');
  w.showView('dashboard');

  let painted = 0;
  const realFeeds = w.renderFeeds;
  w.renderFeeds = function () { painted++; return realFeeds.apply(this, arguments); };

  Object.defineProperty(d, 'hidden', { value: true, configurable: true });
  w.refreshRelativeTimes();
  check('a hidden tab does not repaint', painted === 0, painted);
  check('but it remembers that it owes a repaint', w.state.renderPending === true);

  Object.defineProperty(d, 'hidden', { value: false, configurable: true });
  w.refreshRelativeTimes();
  check('a visible tab repaints', painted === 1, painted);
  w.renderFeeds = realFeeds;

  // Coming back to the tab catches up on the skipped render.
  w.state.renderPending = true;
  d.dispatchEvent(new w.Event('visibilitychange'));
  check('returning to the tab clears the backlog', w.state.renderPending === false);
}

// --- 10. The fixed "Signing in…" button ------------------------------------
console.log('9. the stuck "Signing in…" button is fixed');
{
  const dom = boot();
  const w = dom.window, d = w.document;
  await settle();
  seedStudent(w);                      // device-only account, no shared backend
  w.openStudentAuth();
  const form = d.querySelector('#student-login-form');
  check('the sign-in form opened', !!form);
  d.querySelector('#sa-user').value = 'ada11';
  d.querySelector('#sa-pass').value = 'definitely-wrong';

  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(10);

  const button = d.querySelector('#student-login-form button[type="submit"]');
  check('the button is re-enabled after a wrong password', button && button.disabled === false);
  check('it no longer reads "Signing in…"', button && !/Signing in/.test(button.textContent), button && button.textContent.trim());
  check('the error is shown to the student', /password does not match|Too many failed/.test(
    d.querySelector('#student-login-form').parentElement.textContent));
  check('nobody was signed in', !w.currentStudent());

  // And the right password still works from the same form.
  w.store.remove('madv.auth-lock.v1');
  d.querySelector('#sa-user').value = 'ada11';
  d.querySelector('#sa-pass').value = 'ada1111';
  d.querySelector('#student-login-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(10);
  check('the correct password signs the student in', !!w.currentStudent());
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
