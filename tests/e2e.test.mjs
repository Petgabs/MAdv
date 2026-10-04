// End-to-end test: load the real index.html in jsdom, point its network calls
// at fake Supabase, Abacus and GitHub endpoints, then register, sign in, count
// every full-page Abacus visit and published resource access, and pull the admin register.
import { JSDOM } from 'jsdom';
import { createBackend } from './fake-supabase.mjs';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = await createBackend();
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
// page functions can throw synchronously for validation problems
const guard = (fn) => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eventually = async (predicate, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !!predicate();
};
const storageSnapshot = (w) => {
  const copy = (storage) => {
    const out = {};
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key) out[key] = storage.getItem(key);
    }
    return out;
  };
  return { local: copy(w.localStorage), session: copy(w.sessionStorage) };
};

const syncConfig = JSON.stringify({ provider: 'supabase', url: backend.url, publishableKey: 'sb_publishable_test' });
const githubState = { cloudData: null, syncConfig: null, library: { resources: [] }, files: {}, deleted: [] };
const abacusState = new Map();
const abacusFailOnce = new Set();
const abacusRateLimitOnce = new Set();
const abacusRequests = [];
function fakeAbacusFetch(url, json) {
  if (!String(url).startsWith('https://abacus.jasoncameron.dev/')) return null;
  const parts = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [operation, namespace, key] = parts;
  const id = namespace + '/' + key;
  abacusRequests.push({ operation, namespace, key, at: Date.now() });
  if (operation === 'get') {
    return json(abacusState.has(id) ? 200 : 404,
      abacusState.has(id) ? { value: abacusState.get(id) } : { error: 'Key not found' });
  }
  if (operation === 'hit') {
    if (abacusRateLimitOnce.has(id)) {
      abacusRateLimitOnce.delete(id);
      return json(429, { error: 'Too many requests. Try again in 1s' }, { 'Retry-After': '450' });
    }
    if (abacusFailOnce.has(id)) {
      abacusFailOnce.delete(id);
      return json(503, { error: 'temporarily unavailable' });
    }
    const value = (abacusState.get(id) || 0) + 1;
    abacusState.set(id, value);
    return json(200, { value });
  }
  return json(404, { error: 'Unknown endpoint' });
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://petgabs.github.io/MAdv/',
  pretendToBeVisual: true,
  beforeParse(window) {
    try { Object.defineProperty(window, 'crypto', { value: { randomUUID: () => require('node:crypto').randomUUID(), getRandomValues: (a) => require('node:crypto').randomFillSync(a) }, configurable: true }); } catch (e) {}
    window.scrollTo = () => {};
    window.URL.createObjectURL = () => '#test-blob';
    window.URL.revokeObjectURL = () => {};
    try { Object.defineProperty(window, 'TextEncoder', { value: TextEncoder, configurable: true }); Object.defineProperty(window, 'TextDecoder', { value: TextDecoder, configurable: true }); } catch (e) {}
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const opts = init || {};
      const json = (status, body, headers = {}) => Promise.resolve({
        status, ok: status >= 200 && status < 300,
        headers: { get: (name) => headers[name] || headers[String(name).toLowerCase()] || null },
        json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body))
      });
      const abacusResponse = fakeAbacusFetch(url, json);
      if (abacusResponse) return abacusResponse;
      // GitHub raw / api
      if (url.includes('raw.githubusercontent.com')) {
        if (url.includes('sync-config.json')) return json(githubState.syncConfig === null ? 404 : 200, githubState.syncConfig);
        if (url.includes('cloud-data.json')) return json(githubState.cloudData === null ? 404 : 200, githubState.cloudData);
        if (url.includes('library.json')) return json(200, githubState.library);
        if (/\.(?:pdf|html?)$/i.test(url.split('?')[0])) {
          const isHtml = /\.html?$/i.test(url.split('?')[0]);
          const body = isHtml ? '<!doctype html><title>Test mini app</title><p>ready</p>' : '%PDF-1.4 test';
          return Promise.resolve({
            ok: true, status: 200,
            blob: () => Promise.resolve(new window.Blob([body], { type: isHtml ? 'text/html' : 'application/pdf' })),
            text: () => Promise.resolve(body)
          });
        }
        return json(404, {});
      }
      if (url.includes('api.github.com')) {
        const path = new URL(url).pathname;
        if (opts.method === 'PUT') {
          const body = JSON.parse(opts.body || '{}');
          const decoded = Buffer.from(body.content || '', 'base64').toString() || '{}';
          if (path.includes('sync-config.json')) githubState.syncConfig = JSON.parse(decoded);
          if (path.includes('cloud-data.json')) githubState.cloudData = JSON.parse(decoded);
          if (path.includes('library.json')) githubState.library = JSON.parse(decoded);
          githubState.files[path] = { sha: 'sha1', content: body.content || '' };
          return json(200, { content: { sha: 'sha1' }, commit: { sha: 'abc' } });
        }
        if (opts.method === 'DELETE') {
          githubState.deleted.push(path);
          delete githubState.files[path];
          return json(200, { commit: {} });
        }
        return json(200, { sha: 'sha1', content: githubState.files[path] ? githubState.files[path].content : '' });
      }
      // everything else goes to the fake Supabase
      return fetch(url.startsWith('http') ? url : backend.url + url, opts);
    };
  }
});

const { window } = dom;
await new Promise((r) => window.addEventListener('load', r, { once: true }));
await new Promise((r) => setTimeout(r, 300));

const app = window;
// The page reads its configuration from the repository; publish it there.
app.state.settings.repo = 'Petgabs/MAdv';
app.state.settings.branch = 'main';
app.state.settings.adminUser = 'peter82';
app.state.settings.adminPass = 'petgabs82';
githubState.syncConfig = JSON.parse(syncConfig);

console.log('\n1. configuration discovery');
const loadedUrl = await app.loadSyncConfig(true);
check('config loaded from the repository', loadedUrl === backend.url, loadedUrl);
check('sync is ready', app.syncReady() === true);
check('sync is active', app.syncActive() === true);

console.log('\n2. a student registers and lands in the shared backend');
const reg = await guard(() => app.registerStudent('Ada', 'Year 12'));
check('registration reports shared', reg.shared === true, { shared: reg.shared, offline: reg.offline });
check('username issued', reg.student.username === 'ada', reg.student.username);
check('password follows the rule', reg.student.password === 'ada12', reg.student.password);
check('local record exists', app.state.students.length === 1);
check('session started', app.state.session && app.state.session.role === 'student');
const second = await guard(() => app.registerStudent('Ada', 'Year 11'));
check('second Ada gets ada2 / ada211', second.student.username === 'ada2' && second.student.password === 'ada211', second.student);
check('bad name is rejected', await guard(() => app.registerStudent('X', 'Year 11')).then(() => false, (e) => /at least 2 letters/.test(e.message)));
check('missing year is rejected', await guard(() => app.registerStudent('Grace', '')).then(() => false, (e) => /year level/.test(e.message)));

console.log('\n3. sign in works from a "different device" (fresh browser state)');
const dom2 = await secondBrowser();
const login = await guard(() => dom2.window.loginStudent('ada', 'ada12'));
check('sign in against the shared register', login && login.username === 'ada', login && login.username);
check('wrong password refused', await guard(() => dom2.window.loginStudent('ada', 'nope')).then(() => false, (e) => /does not match/.test(e.message)));
check('unknown user refused', await guard(() => dom2.window.loginStudent('nobody', 'x')).then(() => false, (e) => /No student found/.test(e.message)));
check('blocked student refused everywhere', await (async () => {
  await app.syncAdminStudent('upsert', Object.assign({}, reg.student, { status: 'blocked' }));
  const other = await guard(() => dom2.window.loginStudent('ada', 'ada12')).then(() => false, (e) => /blocked/.test(e.message));
  const same = await guard(() => app.loginStudent('ada', 'ada12')).then(() => false, (e) => /blocked/.test(e.message));
  return other && same;
})());
await app.syncAdminStudent('upsert', Object.assign({}, reg.student, { status: 'active' }));

console.log('\n4. a new visit or new login counts; a browser refresh does not');
app.state.students = app.state.students.filter((s) => s.id !== reg.student.id);
app.state.students.push(reg.student);
app.saveStudents();
app.state.session = { role: 'student', studentId: reg.student.id, at: new Date().toISOString() };
app.saveSession();
await new Promise((r) => setTimeout(r, 900));
const visitCounterId = app.ABACUS_NAMESPACE + '/visits';
const pageViewsBefore = abacusState.get(visitCounterId) || 0;
const guestPage = await secondBrowser({ noConfig: true });
const guestLoadCounted = await eventually(() => abacusState.get(visitCounterId) === pageViewsBefore + 1);
check('a guest first visit increments Abacus', guestLoadCounted, abacusState.get(visitCounterId));
const guestReload = await secondBrowser({ noConfig: true, storage: storageSnapshot(guestPage.window) });
const guestReloadCounted = await eventually(() => abacusState.get(visitCounterId) === pageViewsBefore + 1, 1500);
check('refreshing the same guest tab does not increment Abacus', guestReloadCounted && abacusState.get(visitCounterId) === pageViewsBefore + 1, abacusState.get(visitCounterId));
const newTabStorage = storageSnapshot(app);
if (newTabStorage.session) delete newTabStorage.session['madv.visit-session.v1'];
const registeredPage = await secondBrowser({ storage: newTabStorage });
const registeredLoadCounted = await eventually(() => abacusState.get(visitCounterId) === pageViewsBefore + 2);
check('a new tab visit as a signed-in student increments Abacus',
  registeredLoadCounted && registeredPage.window.currentStudent() && registeredPage.window.currentStudent().username === 'ada',
  { total: abacusState.get(visitCounterId), student: registeredPage.window.currentStudent() && registeredPage.window.currentStudent().username });
const returningPage = await secondBrowser({ storage: storageSnapshot(registeredPage.window) });
const returningLoadCounted = await eventually(() => abacusState.get(visitCounterId) === pageViewsBefore + 2, 1500);
check('refreshing the signed-in tab does not increment Abacus',
  returningLoadCounted && returningPage.window.currentStudent() && returningPage.window.currentStudent().username === 'ada' && abacusState.get(visitCounterId) === pageViewsBefore + 2,
  { total: abacusState.get(visitCounterId), student: returningPage.window.currentStudent() && returningPage.window.currentStudent().username });
const loginBrowser = await secondBrowser();
const loginVisitBefore = abacusState.get(visitCounterId) || 0;
await guard(() => loginBrowser.window.loginStudent('ada', 'ada12'));
const loginCounted = await eventually(() => abacusState.get(visitCounterId) === loginVisitBefore + 1);
check('a new student login increments Abacus', loginCounted && loginBrowser.window.currentStudent(), abacusState.get(visitCounterId));

console.log('\n4b. visitor counter remains shared with the detailed backend');
const before = Number(app.state.counters.visits);
await app.syncVisit();
const stats = await app.syncStats();
check('backend counted at least one visit', stats.visits >= 1, stats.visits);
check('local counter adopted the shared total', app.state.counters.visits >= Math.max(before, stats.visits), { local: app.state.counters.visits, shared: stats.visits });
await app.syncVisit();           // rapid detailed-log repeat
const after = await app.syncStats();
check('the detailed Supabase visit log still de-duplicates a rapid repeat', after.visits === stats.visits, { first: stats.visits, second: after.visits });
const other = await secondBrowser();
await other.window.syncVisit();
const stats3 = await app.syncStats();
check('a different device adds a unique visitor', stats3.uniqueVisitors >= 2, stats3.uniqueVisitors);
await app.loadAbacusTotals(true);
check('Abacus stores the shared visit total', abacusState.get('petgabs-github-io-madv/visits') >= pageViewsBefore + 3, abacusState.get('petgabs-github-io-madv/visits'));
check('Abacus connection is visible to the app', app.state.abacus.status === 'ok', app.state.abacus.status);
await other.window.loadAbacusTotals(true);
check('a second browser reads the same Abacus total', other.window.state.counters.visits === abacusState.get('petgabs-github-io-madv/visits'), other.window.state.counters.visits);
check('visitor totals use the documented Abacus API host and namespace',
  app.ABACUS_BASE_URL === 'https://abacus.jasoncameron.dev' && app.ABACUS_NAMESPACE === 'petgabs-github-io-madv');
check('visitor increments are sent to Abacus /hit/namespace/visits',
  abacusRequests.some((request) => request.operation === 'hit' && request.namespace === app.ABACUS_NAMESPACE && request.key === 'visits'));

console.log('\n4c. Abacus rate-limit responses do not lose counter hits');
const rateLimitProbe = 'file-rate-limit-probe';
const rateLimitProbeId = app.ABACUS_NAMESPACE + '/' + rateLimitProbe;
abacusRateLimitOnce.add(rateLimitProbeId);
await app.abacusIncrementCounter(rateLimitProbe, 'file');
const rateLimitProbeHits = abacusRequests.filter((request) => request.operation === 'hit' && request.key === rateLimitProbe);
check('a 429 is retried safely and the Abacus counter increments once',
  abacusState.get(rateLimitProbeId) === 1 && rateLimitProbeHits.length === 2,
  { total: abacusState.get(rateLimitProbeId), attempts: rateLimitProbeHits.length });

console.log('\n5. Abacus total + per-file downloads and Supabase activity log');
const item = { id: 'res1', title: 'Practice', fileName: 'a.pdf', source: 'cloud', path: 'Year 12/a.pdf', category: 'Homework', topic: 'Functions', year: 'Year 12', downloads: 0 };
app.state.resources = [item];
await app.recordDownload(item, reg.student);  // the real successful-download path
await app.syncDownloadEvent(item, reg.student);
const d1 = await app.syncStats();
check('Supabase records the download for student activity', d1.downloads === 1 && d1.perFile['path:Year 12/a.pdf'].total === 1, d1);
check('Abacus total download counter increments', abacusState.get('petgabs-github-io-madv/downloads') === 1, abacusState.get('petgabs-github-io-madv/downloads'));
const abacusFileKey = app.abacusResourceCounterKey(item);
check('Abacus per-file counter increments', abacusState.get('petgabs-github-io-madv/' + abacusFileKey) === 1, abacusFileKey);
check('the published file has its own Abacus /hit counter key',
  abacusFileKey.startsWith('file-') && abacusRequests.some((request) => request.operation === 'hit' && request.key === abacusFileKey), abacusFileKey);
await app.recordDownload(item, reg.student);
await app.syncDownloadEvent(item, reg.student);
const d2 = await app.syncStats();
check('second download is reflected in Supabase activity', d2.downloads === 2 && d2.perFile['path:Year 12/a.pdf'].total === 2, d2);
check('Abacus total download counter increments again', abacusState.get('petgabs-github-io-madv/downloads') === 2, abacusState.get('petgabs-github-io-madv/downloads'));
check('Abacus per-file counter increments again', abacusState.get('petgabs-github-io-madv/' + abacusFileKey) === 2, abacusState.get('petgabs-github-io-madv/' + abacusFileKey));
check('per-file total mirrored onto the resource', item.downloads === 2, item.downloads);
check('student download tally grew', app.state.students.filter((s) => s.id === reg.student.id)[0].downloadCount >= 2, app.state.students[0].downloadCount);
const remoteItem = { id: 'res1', title: 'Practice', fileName: 'a.pdf', source: 'cloud', path: 'Year 12/a.pdf', downloads: 0 };
other.window.state.resources = [remoteItem];
await other.window.syncAbacusFileTotals(true);
check('another browser fetches the same per-file total', remoteItem.downloads === 2, remoteItem.downloads);

console.log('\n5b. an unregistered visitor cannot download; students download from My learning');
app.state.session = null;
app.saveSession();
app.showView('library');
app.renderLibrary();
const guestCard = window.document.querySelector('#documents-list').textContent;
check('the library card asks visitors to sign in', /Sign in to download/.test(guestCard) && /Account required/.test(guestCard), guestCard.slice(0, 120));
check('the library explains the download policy', /Register and log in before you download/.test(window.document.querySelector('#download-policy').textContent));
const downloadsBeforeGate = app.state.counters.downloads;
const itemDownloadsBeforeGate = item.downloads;
app.downloadResource(item.id);
const gate = window.document.querySelector('[data-modal="download-gate"]');
check('the download click shows a register-and-login message', !!gate && /register and log in/i.test(gate.textContent), gate && gate.querySelector('#modal-title').textContent);
check('the gate offers register and log in', !!gate && /Register now/.test(gate.textContent) && /already have an account/.test(gate.textContent));
check('nothing was downloaded or counted', app.state.counters.downloads === downloadsBeforeGate && item.downloads === itemDownloadsBeforeGate, { counters: app.state.counters.downloads, item: item.downloads });
app.closeModal();

app.state.session = { role: 'student', studentId: reg.student.id, at: new Date().toISOString() };
app.saveSession();
app.renderLibrary();
app.showView('library');
app.downloadResource(item.id);
const pageGate = window.document.querySelector('[data-modal="download-gate"]');
check('a signed-in student is sent to My learning to download', !!pageGate && /Download from My learning/.test(pageGate.textContent), pageGate && pageGate.querySelector('#modal-title').textContent);
check('still nothing downloaded from the library view', app.state.counters.downloads === downloadsBeforeGate, app.state.counters.downloads);
const expectedStudentDownloads = (app.state.students.find((s) => s.id === reg.student.id).downloadCount || 0) + 1;
app.ACTIONS['gate-my-learning']({ dataset: { id: item.id } });
await new Promise((r) => setTimeout(r, 300));
check('the gate opens My learning and downloads there', app.state.view === 'my-learning', app.state.view);
check('the shared download total moved once', app.state.counters.downloads === downloadsBeforeGate + 1, app.state.counters.downloads);
check('the download is recorded against the student', app.state.students.find((s) => s.id === reg.student.id).downloadCount === expectedStudentDownloads, app.state.students.find((s) => s.id === reg.student.id).downloadCount);
check('the exact file is stored in the student record', app.state.students.find((s) => s.id === reg.student.id).downloads[0].title === 'Practice', app.state.students.find((s) => s.id === reg.student.id).downloads[0]);
check('My learning lists the file with its count', /Practice/.test(window.document.querySelector('#ml-history-body').textContent) && /\d/.test(window.document.querySelector('#ml-history-body').textContent), window.document.querySelector('#ml-history-body').textContent);
const studentKey = app.abacusStudentCounterKey(reg.student);
const studentFileKey = app.abacusStudentFileCounterKey(reg.student, item);
await eventually(() => abacusState.get('petgabs-github-io-madv/' + studentKey) === 3 &&
  abacusState.get('petgabs-github-io-madv/' + studentFileKey) === 3);
check('Abacus holds a counter for this student', abacusState.get('petgabs-github-io-madv/' + studentKey) === 3, abacusState.get('petgabs-github-io-madv/' + studentKey));
check('Abacus holds a counter for this student and file', abacusState.get('petgabs-github-io-madv/' + studentFileKey) === 3, abacusState.get('petgabs-github-io-madv/' + studentFileKey));
check('the student counter is stored locally for the dashboard', app.abacusStudentTotal(app.state.students.find((s) => s.id === reg.student.id)) === 3, app.abacusStudentTotal(app.state.students[0]));
check('the download policy cannot be switched off', app.state.settings.requireLogin === true);
const otherItem = { id: 'res2', title: 'Year 11 revision', fileName: 'b.pdf', source: 'cloud', path: 'Year 11/b.pdf', category: 'Revision questions', topic: 'Functions', year: 'Year 11', downloads: 0 };
app.state.resources.push(otherItem);
app.renderMyLearning();
check('My learning offers other year levels for download too', /Year 11 revision/.test(window.document.querySelector('#ml-all').textContent), window.document.querySelector('#ml-all').textContent.slice(0, 120));
app.downloadResource(otherItem.id);
await new Promise((r) => setTimeout(r, 250));
check('a file from another year level downloads from My learning', otherItem.downloads === 1 && /Year 11 revision/.test(window.document.querySelector('#ml-history-body').textContent), { downloads: otherItem.downloads });
const otherItemAbacusKey = app.abacusResourceCounterKey(otherItem);
await eventually(() => abacusState.get('petgabs-github-io-madv/' + otherItemAbacusKey) === 1);
check('each published file gets a separate Abacus counter',
  otherItemAbacusKey !== abacusFileKey && abacusState.get('petgabs-github-io-madv/' + otherItemAbacusKey) === 1 &&
  abacusState.get('petgabs-github-io-madv/' + abacusFileKey) === 3,
  { firstFile: abacusState.get('petgabs-github-io-madv/' + abacusFileKey), otherFile: abacusState.get('petgabs-github-io-madv/' + otherItemAbacusKey) });

console.log('\n5c. opening a published Interactive HTML app follows the download tracking path');
await eventually(() => abacusState.get('petgabs-github-io-madv/' + studentKey) === 4);
const miniApp = {
  id: 'mini_app_1', title: 'Functions explorer', fileName: 'functions-explorer.html', ext: 'html', kind: 'app',
  source: 'cloud', path: 'Year 12/functions-explorer.html', category: 'Practice questions', topic: 'Functions', year: 'Year 12', downloads: 0
};
app.state.resources.push(miniApp);
const appFileKey = app.abacusResourceCounterKey(miniApp);
const downloadsBeforeAppOpen = abacusState.get('petgabs-github-io-madv/downloads') || 0;
const studentDownloadsBeforeAppOpen = abacusState.get('petgabs-github-io-madv/' + studentKey) || 0;
const originalOpen = window.open;
const openedApps = [];
window.open = (...args) => { openedApps.push(args); return {}; };
let openedMiniApp;
try {
  openedMiniApp = await app.openApp(miniApp.id);
} finally {
  window.open = originalOpen;
}
check('the published Interactive HTML app opens', openedMiniApp === miniApp && openedApps.length === 1, openedApps);
check('opening the app increments the shared Abacus download total',
  abacusState.get('petgabs-github-io-madv/downloads') === downloadsBeforeAppOpen + 1,
  abacusState.get('petgabs-github-io-madv/downloads'));
check('opening the app increments its own Abacus file counter',
  abacusState.get('petgabs-github-io-madv/' + appFileKey) === 1 && appFileKey.startsWith('file-'),
  { key: appFileKey, total: abacusState.get('petgabs-github-io-madv/' + appFileKey) });
check('the app open is logged through the same student download path',
  miniApp.downloads === 1 &&
  (app.state.students.find((s) => s.id === reg.student.id).downloads || [])[0].resourceId === miniApp.id &&
  app.state.logs.downloads[0].resourceId === miniApp.id &&
  abacusState.get('petgabs-github-io-madv/' + studentKey) === studentDownloadsBeforeAppOpen + 1,
  { item: miniApp.downloads, student: abacusState.get('petgabs-github-io-madv/' + studentKey), log: app.state.logs.downloads[0] });
const expectedAdaAbacusTotal = studentDownloadsBeforeAppOpen + 1;

console.log('\n5d. the published library merges download totals and last-download times');
const publishedRow = { id: 'res_pub', title: 'Mirror', fileName: 'mirror.pdf', source: 'cloud', path: 'Year 12/mirror.pdf', downloads: 0 };
app.state.resources.push(publishedRow);
const rowsBeforeMerge = app.state.resources.length;
const mergedAdded = app.mergeCloudResources([{ id: 'res_pub', fileName: 'mirror.pdf', path: 'Year 12/mirror.pdf', downloads: 9, lastDownloadAt: '2026-10-01T05:00:00Z' }]);
check('a merge into an existing row adds no duplicate', mergedAdded.added === 0 && app.state.resources.length === rowsBeforeMerge, { added: mergedAdded, rows: app.state.resources.length });
check('the published download total is merged', publishedRow.downloads === 9, publishedRow.downloads);
check('the published last-download time is merged', publishedRow.lastDownloadAt === '2026-10-01T05:00:00Z', publishedRow.lastDownloadAt);
const storedRows = JSON.parse(window.localStorage.getItem('madv.resources.v2'));
const storedRow = storedRows.filter((r) => r.id === 'res_pub')[0];
check('merged totals are persisted, not just kept in memory', !!storedRow && storedRow.downloads === 9 && storedRow.lastDownloadAt === '2026-10-01T05:00:00Z', storedRow);
publishedRow.lastDownloadAt = '2026-12-01T00:00:00Z';
app.mergeCloudResources([{ id: 'res_pub', fileName: 'mirror.pdf', path: 'Year 12/mirror.pdf', downloads: 9, lastDownloadAt: '2026-10-01T05:00:00Z' }]);
check('an older published timestamp never overwrites a newer local one', publishedRow.lastDownloadAt === '2026-12-01T00:00:00Z', publishedRow.lastDownloadAt);
app.state.resources = app.state.resources.filter((r) => r.id !== 'res_pub');
app.saveResources();

console.log('\n6. admin pulls the shared register live');
app.loginAdmin('peter82', 'petgabs82');
const added = await app.syncPullRoster();
check('roster pulled into the dashboard', typeof added === 'number' && app.state.students.length >= 2, { added, total: app.state.students.length });
check('students carry usernames from the backend', app.state.students.some((s) => s.username === 'ada2'));
const liveAdmin = await secondBrowser();
liveAdmin.window.loginAdmin('peter82', 'petgabs82');
const openedDashboard = await liveAdmin.window.openAdminDashboard(true);
check('opening the admin dashboard pulls registrations from the live backend', openedDashboard && liveAdmin.window.state.students.length >= 2, { refreshed: openedDashboard, total: liveAdmin.window.state.students.length });
const liveRegistration = await guard(() => app.registerStudent('Grace', 'Year 10'));
await liveAdmin.window.refreshAdminData(true);
check('a registration from another browser appears after the dashboard refresh', liveAdmin.window.state.students.some((s) => s.username === liveRegistration.student.username && s.year === 'Year 10'), liveAdmin.window.state.students.map((s) => s.username));
check('a live roster refresh updates a changed status and removes deleted shared rows', await (async () => {
  const row = liveAdmin.window.state.students.find((s) => s.username === 'ada');
  await app.syncAdminStudent('upsert', Object.assign({}, row, { status: 'blocked' }));
  await app.syncAdminStudent('delete', liveRegistration.student);
  await liveAdmin.window.refreshAdminData(true);
  app.state.students = app.state.students.filter((s) => s.id !== liveRegistration.student.id);
  app.saveStudents();
  return liveAdmin.window.state.students.find((s) => s.username === 'ada').status === 'blocked' &&
    !liveAdmin.window.state.students.some((s) => s.username === liveRegistration.student.username);
})());

console.log('\n6b. the admin register shows each student\'s Abacus counter and the files they took');
app.loginAdmin('peter82', 'petgabs82');
const ada = app.state.students.find((s) => s.username === 'ada');
const readTotal = await app.loadAbacusStudentTotal(ada, true);
check('the per-student Abacus counter reads back', readTotal === expectedAdaAbacusTotal, readTotal);
const scanned = await app.refreshAbacusStudentTotals([ada]);
check('the register button reads counters for listed students', scanned === 1 && app.abacusStudentTotal(ada) === expectedAdaAbacusTotal, { scanned, total: app.abacusStudentTotal(ada) });
app.showView('dashboard');
app.renderDashboard();
const registerText = window.document.querySelector('#students-body').textContent;
check('the student register shows the Abacus counter beside the downloads', new RegExp('Abacus ' + expectedAdaAbacusTotal).test(registerText), registerText.slice(0, 200));
check('the register panel reports the counters it read', /Abacus counters read for 2 of 2 listed students/.test(window.document.querySelector('#student-abacus-note').textContent), window.document.querySelector('#student-abacus-note').textContent);
app.openStudentProfile(ada.id);
await new Promise((r) => setTimeout(r, 600));
const profile = window.document.querySelector('[data-modal="student-profile"]');
check('the student profile lists the exact file downloaded', /Practice/.test(profile.textContent) && /a\.pdf/.test(profile.textContent), profile.textContent.slice(0, 160));
check('the student profile names the Abacus counter',
  /Abacus counter/.test(profile.textContent) && new RegExp(expectedAdaAbacusTotal + ' downloads').test(profile.textContent),
  profile.textContent.slice(0, 200));
const fileRows = Array.from(profile.querySelectorAll('tr')).filter((tr) => tr.querySelector('[data-profile-file]'));
const practiceRow = fileRows.find((tr) => /a\.pdf/.test(tr.textContent));
const revisionRow = fileRows.find((tr) => /b\.pdf/.test(tr.textContent));
check('the student profile shows a per-file Abacus counter for every file taken',
  !!practiceRow && /^3$/.test(practiceRow.querySelector('[data-profile-file]').textContent.trim()) &&
  !!revisionRow && /^1$/.test(revisionRow.querySelector('[data-profile-file]').textContent.trim()),
  { practice: practiceRow && practiceRow.querySelector('[data-profile-file]').textContent, revision: revisionRow && revisionRow.querySelector('[data-profile-file]').textContent });
app.closeModal();

console.log('\n6c. admin delete removes the file from GitHub, library.json and the website');
const doomed = {
  id: 'res-delete-me', title: 'Doomed worksheet', fileName: 'doomed.pdf', path: 'resources/Year 11/doomed.pdf',
  source: 'cloud', year: 'Year 11', category: 'Worksheet', topic: 'Algebra', visible: true, ext: 'pdf', kind: 'document'
};
app.state.resources.push(doomed);
githubState.library.resources = [{ id: doomed.id, fileName: doomed.fileName, path: doomed.path, title: doomed.title, year: doomed.year }];
app.setToken('ghp_test_token');
const deleted = await app.deleteFromCloud(doomed);
check('cloud delete reports success', deleted === true);
check('the file is removed from the in-memory website library', !app.state.resources.some((r) => r.id === 'res-delete-me'));
check('GitHub Contents API deleted the blob', githubState.deleted.some((p) => p.includes('doomed.pdf')), githubState.deleted);
check('library.json no longer lists the file', !(githubState.library.resources || []).some((r) => r.id === 'res-delete-me' || r.fileName === 'doomed.pdf'), githubState.library);

console.log('\n7. the repository mirror never receives passwords');
const payloadText = JSON.stringify(app.cloudDataPayload());
check('no password field in the snapshot', !/"password"\s*:/.test(payloadText));
check('names and usernames are mirrored', payloadText.includes('\"username\":\"ada\"'));
app.state.settings.syncRosterInRepo = false;
check('roster switch removes students', JSON.stringify(app.cloudDataPayload()).includes('\"students\":[]'));
app.state.settings.syncRosterInRepo = true;
app.setToken('ghp_test_token');
await app.pushCloudData(true);
check('snapshot committed to the repository', githubState.cloudData && githubState.cloudData.students.length >= 2, githubState.cloudData && githubState.cloudData.students && githubState.cloudData.students.length);
check('committed snapshot has no passwords', !JSON.stringify(githubState.cloudData).includes('"password"'));

console.log('\n8. online registration fails closed while offline, then retries safely');
const offline = await secondBrowser({ offline: true });
const offlineRegistration = await guard(() => offline.window.registerStudent('Offline', 'Year 11'))
  .then(() => null, (err) => err);
check('does not report an offline registration as complete', !!offlineRegistration && /No credentials were issued/.test(offlineRegistration.message), offlineRegistration && offlineRegistration.message);
check('does not create the offline student locally or queue a registration', !offline.window.state.students.some((s) => s.username === 'offline') && offline.window.syncQueue().length === 0, { usernames: offline.window.state.students.map((s) => s.username), queued: offline.window.syncQueue().length });
check('Abacus visit is queued while the browser is offline', offline.window.abacusQueue().some((entry) => entry.key === 'visits'), offline.window.abacusQueue());
const visitsBeforeFlush = abacusState.get('petgabs-github-io-madv/visits') || 0;
offline.window.__setOffline(false);
await offline.window.abacusFlushQueue();
check('offline Abacus hit flushes once on reconnect', abacusState.get('petgabs-github-io-madv/visits') === visitsBeforeFlush + 1, abacusState.get('petgabs-github-io-madv/visits'));
const retriedRegistration = await guard(() => offline.window.registerStudent('Offline', 'Year 11'));
check('retry after reconnect creates a shared account', retriedRegistration.shared === true && retriedRegistration.student.username === 'offline', retriedRegistration);
check('retry reuses the same idempotency key and leaves no queued registration', offline.window.syncQueue().length === 0 && !!retriedRegistration.student.syncedAt, offline.window.syncQueue().length);
offline.window.abacusQueueSave([
  { key: 'visits', kind: 'visits' },
  { key: 'downloads', kind: 'downloads' }
]);
abacusFailOnce.add('petgabs-github-io-madv/visits');
await offline.window.abacusFlushQueue();
check('an uncertain failed hit is not retried and later queued hits are preserved',
  offline.window.abacusQueue().length === 1 && offline.window.abacusQueue()[0].key === 'downloads', offline.window.abacusQueue());

console.log('\n9. saving the configuration writes only public values');
app.loginAdmin('peter82', 'petgabs82');
app.state.settings.dataDir = 'data';
const urlInput = window.document.querySelector('#sync-url');
const keyInput = window.document.querySelector('#sync-key');
check('settings fields exist', !!urlInput && !!keyInput);
urlInput.value = backend.url;
keyInput.value = 'sb_publishable_test';
app.saveSyncConfig();
await new Promise((r) => setTimeout(r, 400));
check('config published to the repository', githubState.syncConfig && githubState.syncConfig.url === backend.url, githubState.syncConfig);
check('config holds no secret key', JSON.stringify(githubState.syncConfig).indexOf('sb_secret_') === -1);

console.log('\n10. the settings screen reflects the backend');
app.showView('settings');
app.renderSettings();
const statusTag = window.document.querySelector('#sync-status');
check('status tag shows the connection', /Connected|Syncing/.test(statusTag.textContent), statusTag.textContent);
check('project URL field is prefilled', window.document.querySelector('#sync-url').value === backend.url);
check('publishable key field is prefilled', window.document.querySelector('#sync-key').value.length > 0);
check('shared sync switch is on', window.document.querySelector('#opt-sync-enabled').checked === true);
check('hint mentions the repository mirror', /GitHub Action/.test(window.document.querySelector('#sync-hint').innerHTML));
check('action handlers are wired', typeof app.syncNow === 'function' && typeof app.testSyncConnection === 'function' && typeof app.saveSyncConfig === 'function');
window.document.querySelector('#opt-sync-roster').checked = false;
app.saveOptions();
check('roster switch is saved', app.state.settings.syncRosterInRepo === false);
app.state.settings.syncRosterInRepo = true;
app.saveOptions();

console.log('\n11. a site with no backend does not issue a local-only registration');
const plain = await secondBrowser({ noConfig: true });
const localRegistration = await guard(() => plain.window.registerStudent('Grace', 'Year 11')).then(() => null, (err) => err);
check('registration fails with a setup message', !!localRegistration && /not configured/.test(localRegistration.message), localRegistration && localRegistration.message);
check('no account, credentials, or queued registration is created', plain.window.state.students.length === 0 && plain.window.syncQueue().length === 0, { students: plain.window.state.students.length, queued: plain.window.syncQueue().length });
plain.window.openStudentAuth('register');
check('student registration UI explains the shared backend requirement', /Online registration is not ready/.test(plain.window.document.querySelector('#modal-body').textContent), plain.window.document.querySelector('#modal-body').textContent);
check('student registration form is not shown without the backend', !plain.window.document.querySelector('#student-register-form'));
check('sync status is not configured', plain.window.syncReady() === false);
plain.window.renderSettings();
check('status tag reads Not configured', plain.window.document.querySelector('#sync-status').textContent === 'Not configured', plain.window.document.querySelector('#sync-status').textContent);

console.log('\n12. the GitHub mirror exporter copies the shared roster without passwords');
const tempDir = await mkdtemp(join(tmpdir(), 'madv-cloud-export-'));
const exportPath = join(tempDir, 'cloud-data.json');
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const exporterResult = await run(process.execPath, [join(repoRoot, 'scripts/export-cloud-data.mjs'), '--out', exportPath], {
  cwd: repoRoot,
  env: Object.assign({}, process.env, {
    SUPABASE_URL: backend.url,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    ADMIN_USER: 'peter82',
    ADMIN_PASS: 'petgabs82',
    SITE_TIMEZONE: 'UTC'
  })
});
const exportedSnapshot = JSON.parse(await readFile(exportPath, 'utf8'));
check('exporter wrote the repository snapshot', /wrote .*cloud-data\.json/.test(exporterResult.stdout), exporterResult.stdout);
check('exported snapshot includes the current shared roster', exportedSnapshot.source === 'shared-backend' && exportedSnapshot.students.length >= 3, exportedSnapshot.students.length);
check('exported snapshot contains no password values', !/"password"\s*:/.test(JSON.stringify(exportedSnapshot)) && !JSON.stringify(exportedSnapshot).includes('ada12'));
await rm(tempDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
await backend.close();
process.exit(fail ? 1 : 0);

async function secondBrowser(options = {}) {
  let simulatedOffline = !!options.offline;
  const d = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://petgabs.github.io/MAdv/',
    pretendToBeVisual: true,
    beforeParse(w) {
      try { Object.defineProperty(w, 'crypto', { value: { randomUUID: () => require('node:crypto').randomUUID(), getRandomValues: (a) => require('node:crypto').randomFillSync(a) }, configurable: true }); } catch (e) {}
      if (options.storage) {
        Object.entries(options.storage.local || {}).forEach(([key, value]) => w.localStorage.setItem(key, value));
        Object.entries(options.storage.session || {}).forEach(([key, value]) => w.sessionStorage.setItem(key, value));
      }
      w.scrollTo = () => {};
      try { Object.defineProperty(w, 'TextEncoder', { value: TextEncoder, configurable: true }); Object.defineProperty(w, 'TextDecoder', { value: TextDecoder, configurable: true }); } catch (e) {}
      try { Object.defineProperty(w.navigator, 'onLine', { get: () => !simulatedOffline, configurable: true }); } catch (e) {}
      w.__setOffline = (value) => { simulatedOffline = !!value; };
      w.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const opts = init || {};
        const json = (status, body, headers = {}) => Promise.resolve({
          status, ok: status >= 200 && status < 300,
          headers: { get: (name) => headers[name] || headers[String(name).toLowerCase()] || null },
          json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body))
        });
        if (simulatedOffline && String(url).startsWith('https://abacus.jasoncameron.dev/')) return Promise.reject(new Error('offline'));
        const abacusResponse = fakeAbacusFetch(url, json);
        if (abacusResponse) return abacusResponse;
        if (url.includes('raw.githubusercontent.com')) {
          if (options.noConfig) return json(404, {});
          if (url.includes('sync-config.json')) return json(githubState.syncConfig === null ? 404 : 200, githubState.syncConfig);
          if (url.includes('library.json')) return json(200, githubState.library);
          if (/\.(?:pdf|html?)$/i.test(url.split('?')[0])) {
            const isHtml = /\.html?$/i.test(url.split('?')[0]);
            const body = isHtml ? '<!doctype html><title>Test mini app</title><p>ready</p>' : '%PDF-1.4 test';
            return Promise.resolve({
              ok: true, status: 200,
              blob: () => Promise.resolve(new w.Blob([body], { type: isHtml ? 'text/html' : 'application/pdf' })),
              text: () => Promise.resolve(body)
            });
          }
          return json(404, {});
        }
        if (simulatedOffline) return Promise.reject(new Error('offline'));
        return fetch(url.startsWith('http') ? url : backend.url + url, opts);
      };
    }
  });
  await new Promise((r) => d.window.addEventListener('load', r, { once: true }));
  await new Promise((r) => setTimeout(r, 200));
  d.window.state.settings.repo = 'Petgabs/MAdv';
  await d.window.loadSyncConfig();
  return d;
}
