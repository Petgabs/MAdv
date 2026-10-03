// End-to-end test: load the real index.html in jsdom, point its network calls
// at the fake Supabase (real Postgres) and at a fake GitHub, then register,
// sign in, count a visit and a download, and pull the admin register.
import { JSDOM } from 'jsdom';
import { createBackend } from './fake-supabase.mjs';
import { readFileSync } from 'node:fs';

const backend = await createBackend();
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
// page functions can throw synchronously for validation problems
const guard = (fn) => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

const syncConfig = JSON.stringify({ provider: 'supabase', url: backend.url, publishableKey: 'sb_publishable_test' });
const githubState = { cloudData: null, syncConfig: null, library: { resources: [] } };

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://petgabs.github.io/MAdv/',
  pretendToBeVisual: true,
  beforeParse(window) {
    try { Object.defineProperty(window, 'crypto', { value: { randomUUID: () => require('node:crypto').randomUUID(), getRandomValues: (a) => require('node:crypto').randomFillSync(a) }, configurable: true }); } catch (e) {}
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const opts = init || {};
      const json = (status, body) => Promise.resolve({
        status, ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body))
      });
      // GitHub raw / api
      if (url.includes('raw.githubusercontent.com')) {
        if (url.includes('sync-config.json')) return json(githubState.syncConfig === null ? 404 : 200, githubState.syncConfig);
        if (url.includes('cloud-data.json')) return json(githubState.cloudData === null ? 404 : 200, githubState.cloudData);
        if (url.includes('library.json')) return json(200, githubState.library);
        return json(404, {});
      }
      if (url.includes('api.github.com')) {
        const path = new URL(url).pathname;
        if (opts.method === 'PUT') {
          const body = JSON.parse(opts.body || '{}');
          if (path.includes('sync-config.json')) githubState.syncConfig = JSON.parse(Buffer.from(body.content || '', 'base64').toString() || '{}');
          if (path.includes('cloud-data.json')) githubState.cloudData = JSON.parse(Buffer.from(body.content || '', 'base64').toString() || '{}');
          return json(200, { content: { sha: 'sha1' }, commit: { sha: 'abc' } });
        }
        if (opts.method === 'DELETE') return json(200, { commit: {} });
        return json(200, { sha: 'sha1', content: '' });
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

console.log('\n4. visitor counter is shared');
app.state.students = app.state.students.filter((s) => s.id !== reg.student.id);
app.state.students.push(reg.student);
app.state.session = { role: 'student', studentId: reg.student.id, at: new Date().toISOString() };
const before = Number(app.state.counters.visits);
await app.syncVisit();
const stats = await app.syncStats();
check('backend counted at least one visit', stats.visits >= 1, stats.visits);
check('local counter adopted the shared total', app.state.counters.visits >= Math.max(before, stats.visits), { local: app.state.counters.visits, shared: stats.visits });
await app.syncVisit();           // immediate repeat
const after = await app.syncStats();
check('a refresh does not double count', after.visits === stats.visits, { first: stats.visits, second: after.visits });
const other = await secondBrowser();
await other.window.syncVisit();
const stats3 = await app.syncStats();
check('a different device adds a unique visitor', stats3.uniqueVisitors >= 2, stats3.uniqueVisitors);

console.log('\n5. download counter is shared and idempotent');
const item = { id: 'res1', title: 'Practice', fileName: 'a.pdf', source: 'cloud', path: 'Year 12/a.pdf', category: 'Homework', topic: 'Functions', year: 'Year 12', downloads: 0 };
app.state.resources = [item];
app.recordDownload(item, reg.student);        // the real download path
await app.syncDownloadEvent(item, reg.student);
const d1 = await app.syncStats();
check('download counted', d1.downloads === 1 && d1.perFile['path:Year 12/a.pdf'].total === 1, d1);
app.recordDownload(item, reg.student);
await app.syncDownloadEvent(item, reg.student);
const d2 = await app.syncStats();
check('second download of the same file', d2.downloads === 2 && d2.perFile['path:Year 12/a.pdf'].total === 2, d2);
check('per-file total mirrored onto the resource', item.downloads === 2, item.downloads);
check('student download tally grew', app.state.students.filter((s) => s.id === reg.student.id)[0].downloadCount >= 2, app.state.students[0].downloadCount);

console.log('\n6. admin pulls the shared register');
app.loginAdmin('peter82', 'petgabs82');
const added = await app.syncPullRoster();
check('roster pulled into the dashboard', typeof added === 'number' && app.state.students.length >= 2, { added, total: app.state.students.length });
check('students carry usernames from the backend', app.state.students.some((s) => s.username === 'ada2'));

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

console.log('\n8. offline behaviour');
const offline = await secondBrowser({ offline: true });
const queued = await guard(() => offline.window.registerStudent('Offline', 'Year 11'));
check('registers locally when offline', queued.shared === false && queued.offline === true, queued);
check('registration is queued for later', offline.window.syncQueue().length === 1, offline.window.syncQueue().length);
check('local login still works offline', (await guard(() => offline.window.loginStudent('offline', 'offline11'))).username === 'offline');

console.log('\n9. saving the configuration writes only public values');
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

console.log('\n11. a site with no backend still works (device-only mode)');
const plain = await secondBrowser({ noConfig: true });
const localReg = await guard(() => plain.window.registerStudent('Grace', 'Year 11'));
check('registers on the device', localReg.shared === false && localReg.student.username === 'grace', localReg.student && localReg.student.username);
check('nothing was queued without a backend', plain.window.syncQueue().length === 0);
check('local sign-in works', (await guard(() => plain.window.loginStudent('grace', 'grace11'))).username === 'grace');
check('sync status is not configured', plain.window.syncReady() === false);
plain.window.renderSettings();
check('status tag reads Not configured', plain.window.document.querySelector('#sync-status').textContent === 'Not configured', plain.window.document.querySelector('#sync-status').textContent);

console.log(`\n${pass} passed, ${fail} failed\n`);
await backend.close();
process.exit(fail ? 1 : 0);

async function secondBrowser(options = {}) {
  const d = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://petgabs.github.io/MAdv/',
    pretendToBeVisual: true,
    beforeParse(w) {
      try { Object.defineProperty(w, 'crypto', { value: { randomUUID: () => require('node:crypto').randomUUID(), getRandomValues: (a) => require('node:crypto').randomFillSync(a) }, configurable: true }); } catch (e) {}
      w.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const opts = init || {};
        const json = (status, body) => Promise.resolve({
          status, ok: status >= 200 && status < 300,
          json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body))
        });
        if (url.includes('raw.githubusercontent.com')) {
          if (options.noConfig) return json(404, {});
          if (url.includes('sync-config.json')) return json(githubState.syncConfig === null ? 404 : 200, githubState.syncConfig);
          if (url.includes('library.json')) return json(200, githubState.library);
          return json(404, {});
        }
        if (options.offline) return Promise.reject(new Error('offline'));
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
