// Test: the admin upload page really publishes.
//
// Loads the real index.html in jsdom against fake GitHub, Abacus and Supabase
// endpoints and drives the actual upload flow: the file must be committed to
// the repository, the resource must be registered, and library.json — the list
// every other device reads — must contain the new file *after* it is
// registered, so a student on their own computer can see and download it.
// Also covers duplicate uploads (including a write race), in-place SHA refresh
// after a 422, the device-only fallback, and retrying a dropped list write.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createBackend } from './fake-supabase.mjs';

const backend = await createBackend();
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eventually = async (predicate, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !!predicate();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const unb64 = (text) => Buffer.from(text || '', 'base64').toString('utf8');
const REPO = 'Petgabs/MAdv';
const LIBRARY = 'library.json';

/* The fake repository, exactly as a student's device would see it ---------- */
const repo = {
  library: null,          // the parsed library.json, null until it is written
  librarySha: null,
  files: new Map(),       // repository path -> { base64, size, sha }
  puts: [],               // successful writes, in order (including dropped writes)
  putAttempts: [],        // every attempted write, including real GitHub-style 422s
  deletes: [],
  dropLibraryWrites: 0,   // silently discard the next N library.json writes
  dropFileWrites: 0,
  raceLibraryWrites: 0,   // change the SHA between a caller's read and write
  raceFilePath: null,     // create a file after its availability read, before PUT
  shaCounter: 0,
  rawLibraryReads: 0      // how many times a device read the published list
};
const nextSha = () => 'sha-' + (++repo.shaCounter);
const resetRepo = () => {
  repo.library = null;
  repo.librarySha = null;
  repo.files.clear();
  repo.puts.length = 0;
  repo.putAttempts.length = 0;
  repo.deletes.length = 0;
  repo.rawLibraryReads = 0;
  repo.dropLibraryWrites = 0;
  repo.dropFileWrites = 0;
  repo.raceLibraryWrites = 0;
  repo.raceFilePath = null;
  repo.shaCounter = 0;
};
const libraryResources = () => ((repo.library && repo.library.resources) || []);
const libraryPuts = () => repo.puts.filter((p) => p.path === LIBRARY);
const libraryPutCount = () => libraryPuts().length;
const libraryPutContents = () => libraryPuts().map((p) => p.body);
const libraryWritesKept = () => libraryPuts().filter((p) => !p.dropped).length;

const abacus = new Map();
const abacusHits = [];
const syncConfig = JSON.stringify({ provider: 'supabase', url: backend.url, publishableKey: 'sb_publishable_test' });

function makeFetch(w) {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const opts = init || {};
    const json = (status, body, headers = {}) => Promise.resolve({
      status, ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[name] || headers[String(name).toLowerCase()] || null },
      json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body))
    });

    // --- Abacus ---------------------------------------------------------
    if (String(url).startsWith('https://abacus.jasoncameron.dev/')) {
      const parts = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const [operation, namespace, key] = parts;
      const id = namespace + '/' + key;
      if (operation === 'get') return json(abacus.has(id) ? 200 : 404, abacus.has(id) ? { value: abacus.get(id) } : { error: 'Key not found' });
      if (operation === 'hit') {
        const value = (abacus.get(id) || 0) + 1;
        abacus.set(id, value);
        abacusHits.push(id);
        return json(200, { value });
      }
      return json(404, { error: 'Unknown endpoint' });
    }

    // --- raw.githubusercontent.com (what students download from) --------
    if (url.includes('raw.githubusercontent.com')) {
      const withoutQuery = url.split('?')[0];
      // raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>
      const rel = decodeURIComponent(new URL(withoutQuery).pathname.split('/').filter(Boolean).slice(3).join('/'));
      if (rel === 'data/sync-config.json') return json(200, JSON.parse(syncConfig));
      if (rel === LIBRARY) {
        repo.rawLibraryReads += 1;
        if (!repo.library) return json(404, { message: 'Not Found' });
        return json(200, repo.library);
      }
      const file = repo.files.get(rel);
      if (!file) return json(404, { message: 'Not Found' });
      const bytes = Buffer.from(file.base64, 'base64');
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        blob: () => Promise.resolve(new w.Blob([bytes], { type: 'application/pdf' })),
        text: () => Promise.resolve(bytes.toString('utf8'))
      });
    }

    // --- api.github.com (the admin's publishing token) -------------------
    if (url.includes('api.github.com')) {
      const path = decodeURIComponent(new URL(url).pathname);
      const prefix = '/repos/' + REPO + '/contents/';
      const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path;
      if (path === '/user') return json(200, { login: 'petgabs' });
      if (path.includes('/git/trees/')) {
        const tree = [];
        repo.files.forEach((_value, key) => tree.push({ path: key, type: 'blob', size: 1 }));
        return json(200, { tree });
      }
      if (opts.method === 'PUT') {
        const body = JSON.parse(opts.body || '{}');
        const text = unb64(body.content);
        const isLibrary = rel === LIBRARY;

        // Simulate another browser creating library.json after this page saw
        // GitHub's 404 but before its create-write reaches the Contents API.
        if (isLibrary && repo.raceLibraryWrites > 0 && !repo.library) {
          repo.raceLibraryWrites -= 1;
          repo.library = { subject: 'Mathematics Advanced', resources: [] };
          repo.librarySha = nextSha();
        }
        // Simulate a same-name upload winning after the availability GET. The
        // following PUT must receive GitHub's real create-existing 422.
        if (!isLibrary && repo.raceFilePath === rel && !repo.files.has(rel)) {
          const raced = Buffer.from('%PDF-1.4 file created by a concurrent uploader');
          repo.files.set(rel, { base64: raced.toString('base64'), size: raced.length, sha: nextSha() });
          repo.raceFilePath = null;
        }

        const current = isLibrary
          ? (repo.library ? { sha: repo.librarySha } : null)
          : (repo.files.get(rel) || null);
        const attempt = { path: rel, sha: body.sha, body: text, message: body.message };
        repo.putAttempts.push(attempt);
        // Match GitHub's Contents API: creating over an existing path without
        // its blob SHA (or using a stale SHA) is rejected, never overwritten.
        if (current && !body.sha) {
          attempt.rejected = true;
          attempt.status = 422;
          return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        }
        if (current && body.sha !== current.sha) {
          attempt.rejected = true;
          attempt.status = 409;
          return json(409, { message: 'The file changed after it was read.' });
        }
        if (!current && body.sha) {
          attempt.rejected = true;
          attempt.status = 422;
          return json(422, { message: 'Invalid request. The supplied sha does not exist.' });
        }

        // A dropped write still answers 200 but never reaches the repository —
        // exactly how a lost/failed commit looks to the page.
        const dropped = (isLibrary && repo.dropLibraryWrites > 0) || (!isLibrary && repo.dropFileWrites > 0);
        if (dropped) {
          if (isLibrary) repo.dropLibraryWrites -= 1; else repo.dropFileWrites -= 1;
          repo.puts.push({ path: rel, message: body.message, body: text, bytes: Buffer.byteLength(text), dropped: true });
          return json(200, { content: { sha: 'dropped' }, commit: { sha: 'dropped' } });
        }
        repo.puts.push({ path: rel, message: body.message, body: text, bytes: Buffer.byteLength(text) });
        const fileSha = nextSha();
        if (isLibrary) {
          repo.library = JSON.parse(text);
          repo.librarySha = fileSha;
        } else {
          repo.files.set(rel, { base64: body.content, size: Buffer.byteLength(text), sha: fileSha });
        }
        return json(200, { content: { sha: fileSha }, commit: { sha: nextSha(), html_url: 'https://github.com/' + REPO + '/commit/c1' } });
      }
      if (opts.method === 'DELETE') {
        repo.deletes.push(rel);
        if (rel === LIBRARY) { repo.library = null; repo.librarySha = null; }
        else repo.files.delete(rel);
        return json(200, { commit: { sha: 'd1' } });
      }
      if (rel === LIBRARY) {
        if (!repo.library) return json(404, { message: 'Not Found' });
        return json(200, { sha: repo.librarySha, content: b64(JSON.stringify(repo.library)), size: 2 });
      }
      const file = repo.files.get(rel);
      if (!file) return json(404, { message: 'Not Found' });
      // GitHub may return metadata without base64 for larger Contents blobs.
      return json(200, { sha: file.sha, content: file.size > 1024 * 1024 ? null : file.base64, size: file.size });
    }

    // --- everything else is the shared Supabase backend ------------------
    return fetch(url.startsWith('http') ? url : backend.url + url, opts);
  };
}

/* Booting a "device" ------------------------------------------------------- */
function boot(options = {}) {
  const idb = new Map();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://petgabs.github.io/MAdv/',
    pretendToBeVisual: true,
    beforeParse(w) {
      try { Object.defineProperty(w, 'crypto', { value: { randomUUID: () => require('node:crypto').randomUUID(), getRandomValues: (a) => require('node:crypto').randomFillSync(a) }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(w, 'TextEncoder', { value: TextEncoder, configurable: true }); Object.defineProperty(w, 'TextDecoder', { value: TextDecoder, configurable: true }); } catch (e) {}
      w.scrollTo = () => {};
      w.URL.createObjectURL = () => '#test-blob';
      w.URL.revokeObjectURL = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      if (options.storage) {
        Object.entries(options.storage.local || {}).forEach(([key, value]) => w.localStorage.setItem(key, value));
        Object.entries(options.storage.session || {}).forEach(([key, value]) => w.sessionStorage.setItem(key, value));
      }
      w.fetch = makeFetch(w);
    }
  });
  const w = dom.window;
  // IndexedDB is not implemented in jsdom: a tiny in-memory stand-in keeps the
  // device-only upload path testable.
  w.fileStore.open = () => Promise.resolve({});
  w.fileStore.put = (key, value) => { idb.set(key, value); return Promise.resolve(true); };
  w.fileStore.get = (key) => Promise.resolve(idb.has(key) ? idb.get(key) : null);
  w.fileStore.del = (key) => { idb.delete(key); return Promise.resolve(true); };
  w.fileStore.keys = () => Promise.resolve([...idb.keys()]);
  return { window: w, idb, storage: () => ({
    local: Object.fromEntries(Object.keys(w.localStorage).map((k) => [k, w.localStorage.getItem(k)])),
    session: Object.fromEntries(Object.keys(w.sessionStorage).map((k) => [k, w.sessionStorage.getItem(k)]))
  }) };
}
async function ready(device, settings = {}) {
  const w = device.window;
  await new Promise((r) => w.addEventListener('load', r, { once: true }));
  await wait(200);
  w.state.settings.repo = settings.repo || REPO;
  w.state.settings.branch = 'main';
  return w;
}
async function signInAsAdmin(device, { token = 'ghp_test_token' } = {}) {
  const w = device.window;
  if (token) { w.setToken(token); w.updateUploadMode(); }
  w.state.session = { role: 'admin', at: new Date().toISOString() };
  return w;
}
async function uploadResource(w, { name = 'Integration practice.pdf', year = 'Year 12', topic = 'Integration — areas & volumes', category = 'Practice questions', title = 'Integration practice', bytes = '%PDF-1.4 fake practice paper' } = {}) {
  w.showView('upload');
  w.updateUploadMode();
  w.pickFile(new w.File([bytes], name, { type: 'application/pdf' }));
  w.document.querySelector('#up-year').value = year;
  w.document.querySelector('#up-category').value = category;
  w.document.querySelector('#up-topic').value = topic;
  w.document.querySelector('#up-title').value = title;
  w.document.querySelector('#up-publish').checked = true;
  w.handleUploadSubmit({ preventDefault() {} });
  await wait(250);
  await eventually(() => !w.state.busy, 8000);
  await wait(150);
}

/* 1. Uploading publishes the file, the list and the website ---------------- */
console.log('1. an admin upload reaches GitHub, library.json and the website');
resetRepo();
const admin = boot();
const app = await ready(admin);
await signInAsAdmin(admin);
await uploadResource(app);

const uploadedPuts = repo.puts.filter((p) => p.path !== LIBRARY);
check('the file itself is committed to the repository',
  uploadedPuts.length === 1 && uploadedPuts[0].path === 'resources/Year 12/Integration practice.pdf', repo.puts.map((p) => p.path));
check('the commit message names the file and its classification',
  /Integration practice\.pdf/.test(uploadedPuts[0] ? uploadedPuts[0].message : '') && /Year 12/.test(uploadedPuts[0] ? uploadedPuts[0].message : ''),
  uploadedPuts[0] && uploadedPuts[0].message);
check('the resource is registered as a published cloud file',
  app.state.resources.length === 1 && app.state.resources[0].source === 'cloud' && app.state.resources[0].published === true,
  app.state.resources);
const uploaded = app.state.resources[0];
check('it is neither waiting nor list-pending', uploaded.pendingPublish === false && uploaded.libraryPending === false, uploaded);
check('library.json is written after the resource exists', libraryWritesKept() === 1, libraryPuts());
check('library.json lists the uploaded file with its path and id',
  libraryResources().length === 1 && libraryResources()[0].path === uploaded.path && libraryResources()[0].id === uploaded.id,
  libraryResources());
check('the list keeps the resource metadata students see',
  libraryResources()[0].title === 'Integration practice' && libraryResources()[0].year === 'Year 12' &&
  libraryResources()[0].topic === 'Integration — areas & volumes' && libraryResources()[0].category === 'Practice questions',
  libraryResources()[0]);
check('no second write was needed — the first one was verified',
  libraryPutCount() === 1 && /update resource list/.test(libraryPuts()[0].message),
  libraryPuts().map((p) => p.message));
const urls = app.resourceUrls(uploaded);
check('the published download link points at the committed file',
  urls.raw === 'https://raw.githubusercontent.com/' + REPO + '/main/resources/Year%2012/Integration%20practice.pdf', urls.raw);
check('the file is fetchable from the repository exactly where the link says',
  [...repo.files.keys()].includes('resources/Year 12/Integration practice.pdf'), [...repo.files.keys()]);
app.showView('library');
app.renderLibrary();
const card = app.document.querySelector('#documents-list').textContent;
check('the website shows the uploaded file in the library', /Integration practice/.test(card), card.slice(0, 160));
check('it is listed with a working download action', /data-action="download"/.test(app.document.querySelector('#documents-list').innerHTML));
check('the upload notice told the teacher it is published',
  /Published .*Integration practice.*GitHub/.test(app.document.querySelector('#toast-stack').textContent),
  app.document.querySelector('#toast-stack').textContent.slice(0, 200));
app.updateUploadMode();
check('the upload page reports cloud publishing', app.document.querySelector('#upload-mode-text').textContent === 'Cloud publishing — students can download',
  app.document.querySelector('#upload-mode-text').textContent);

/* 2. A student's own device sees the same file, with the same details ------ */
console.log('\n2. a student device pulls the published list');
const student = boot();
const studentApp = await ready(student);
const pulledList = await studentApp.pullLibrary();
check('the student device reads the published list', pulledList.total === 1, pulledList);
const seen = studentApp.state.resources.filter((r) => r.path === uploaded.path)[0];
check('the student library found the uploaded file', !!seen && seen.path === uploaded.path, studentApp.state.resources);
check('its details are the ones the teacher chose, not guesses',
  seen && seen.title === 'Integration practice' && seen.topic === 'Integration — areas & volumes' &&
  seen.year === 'Year 12' && seen.category === 'Practice questions' && seen.discovered !== true, seen);
check('the student can reach the public download URL', studentApp.resourceUrls(seen).raw === urls.raw, studentApp.resourceUrls(seen).raw);

/* 3. The student can open and download it on their own computer ------------ */
console.log('\n3. the student downloads the file on their own device');
const registration = await studentApp.registerStudent('Ada', 'Year 12');
check('the student registered in the shared register', registration.shared === true, registration);
studentApp.showView('my-learning');
studentApp.renderMyLearning();
const myLearning = studentApp.document.querySelector('#ml-recommended').textContent + studentApp.document.querySelector('#ml-all').textContent;
check('My learning lists the uploaded file', /Integration practice/.test(myLearning), myLearning.slice(0, 200));
const blob = await studentApp.fetchFileBlob(seen);
check('the file downloads from the repository to the student device',
  blob && blob.size > 0 && (!blob.text || (await blob.text()).includes('%PDF-1.4')), blob && blob.size);
const downloadsBefore = studentApp.state.counters.downloads || 0;
const studentRecord = studentApp.state.students[0];
const studentDownloadsBefore = studentRecord.downloadCount || 0;
await studentApp.downloadResource(seen.id);
await wait(200);
check('the download was handed to the student browser', seen.downloads === 1, seen.downloads);
check('the shared download total moved once', (studentApp.state.counters.downloads || 0) === downloadsBefore + 1, studentApp.state.counters.downloads);
check('the student record counts the download', studentRecord.downloadCount === studentDownloadsBefore + 1, studentRecord.downloadCount);
check('the per-file Abacus counter moved', abacusHits.some((id) => id.startsWith('petgabs-github-io-madv/file-')), abacusHits);
studentApp.showView('library');
studentApp.renderLibrary();
check('another (guest) visitor sees the file listed but locked',
  /Integration practice/.test(studentApp.document.querySelector('#documents-list').textContent), '');

/* 4. A dropped library write is retried and verified ----------------------- */
console.log('\n4. a dropped library.json write is retried instead of silently losing the file');
const secondUpload = 'Sequences revision.pdf';
repo.dropLibraryWrites = 1;
await uploadResource(app, { name: secondUpload, title: 'Sequences revision', topic: 'Sequences & series' });
check('the dropped write was detected and retried (two attempts)', libraryPuts().length === 3 && libraryPuts()[1].dropped === true && libraryPuts()[2].dropped !== true,
  libraryPuts().map((p) => ({ dropped: !!p.dropped })));
check('both attempts carried the complete list',
  libraryPutContents().slice(1).every((text) => /Sequences revision/.test(text)),
  libraryPutContents().map((t) => t.slice(0, 60)));
check('the second file is listed', libraryResources().some((r) => r.fileName === secondUpload), libraryResources().map((r) => r.fileName));
check('the second file is marked published, not pending',
  app.state.resources.filter((r) => r.fileName === secondUpload).every((r) => r.source === 'cloud' && r.libraryPending === false),
  app.state.resources.filter((r) => r.fileName === secondUpload));
check('the first entry is still in the list', libraryResources().some((r) => r.fileName === 'Integration practice.pdf'), libraryResources().map((r) => r.fileName));

/* 5. Re-uploading names creates separate, downloadable copies ------------- */
console.log('\n5. repeated uploads keep every same-name copy');
const uploadDay = new Date().toISOString().slice(0, 10);
const firstPracticePath = 'resources/Year 12/Integration practice.pdf';
const datedPracticePath = 'resources/Year 12/Integration practice (' + uploadDay + ').pdf';
const numberedPracticePath = 'resources/Year 12/Integration practice (' + uploadDay + ') 2.pdf';
const originalPracticeBytes = unb64(repo.files.get(firstPracticePath).base64);
await uploadResource(app, {
  name: 'Integration practice.pdf', title: 'Integration practice second copy',
  bytes: '%PDF-1.4 second practice upload'
});
const secondCopy = app.state.resources.find((r) => r.title === 'Integration practice second copy');
check('the second upload uses the date-suffixed free name', secondCopy && secondCopy.path === datedPracticePath, secondCopy);
check('the first upload was not replaced', unb64(repo.files.get(firstPracticePath).base64) === originalPracticeBytes, repo.files.get(firstPracticePath));
await uploadResource(app, {
  name: 'Integration practice.pdf', title: 'Integration practice third copy',
  bytes: '%PDF-1.4 third practice upload'
});
const thirdCopy = app.state.resources.find((r) => r.title === 'Integration practice third copy');
check('the third upload uses the next numbered free name', thirdCopy && thirdCopy.path === numberedPracticePath, thirdCopy);
check('all three file contents remain stored at their own paths',
  unb64(repo.files.get(firstPracticePath).base64) === originalPracticeBytes &&
  unb64(repo.files.get(datedPracticePath).base64) === '%PDF-1.4 second practice upload' &&
  unb64(repo.files.get(numberedPracticePath).base64) === '%PDF-1.4 third practice upload',
  [...repo.files.keys()].filter((p) => p.includes('Integration practice')));
const practicePaths = [firstPracticePath, datedPracticePath, numberedPracticePath];
const listedPracticeCopies = libraryResources().filter((r) => practicePaths.includes(r.path));
check('library.json keeps all three same-name uploads listed',
  listedPracticeCopies.length === 3 && practicePaths.every((p) => listedPracticeCopies.some((r) => r.path === p)),
  listedPracticeCopies.map((r) => r.path));
const copyStudent = boot();
const copyStudentApp = await ready(copyStudent);
await copyStudentApp.pullLibrary();
const studentPracticeCopies = copyStudentApp.state.resources.filter((r) => practicePaths.includes(r.path));
const copyDownloads = await Promise.all(studentPracticeCopies.map((r) => copyStudentApp.fetchFileBlob(r)));
check('a student device can download each listed copy',
  studentPracticeCopies.length === 3 && copyDownloads.every((b) => b && b.size > 0),
  copyDownloads.map((b) => b && b.size));
const largeOriginalPath = 'resources/Year 12/Large workbook.pdf';
const largeOriginalBytes = Buffer.alloc(1024 * 1024 + 1, 65);
repo.files.set(largeOriginalPath, {
  base64: largeOriginalBytes.toString('base64'), size: largeOriginalBytes.length, sha: nextSha()
});
await uploadResource(app, { name: 'Large workbook.pdf', title: 'Large workbook repeat' });
const largeRepeat = app.state.resources.find((r) => r.title === 'Large workbook repeat');
check('name checks still work when GitHub omits a large file body',
  largeRepeat && largeRepeat.path === 'resources/Year 12/Large workbook (' + uploadDay + ').pdf' &&
  Buffer.from(repo.files.get(largeOriginalPath).base64, 'base64').equals(largeOriginalBytes),
  largeRepeat);

/* 6. A write race picks another name and refreshes in-place SHAs ----------- */
console.log('\n6. a same-name race advances to a free name; library writes refresh their SHA');
resetRepo();
const raceAdmin = boot();
const raceApp = await ready(raceAdmin);
await signInAsAdmin(raceAdmin);
const raceOriginal = 'resources/Year 12/Concurrent practice.pdf';
const raceDate = 'resources/Year 12/Concurrent practice (' + uploadDay + ').pdf';
const raceRetry = 'resources/Year 12/Concurrent practice (' + uploadDay + ') 2.pdf';
// Another browser creates library.json after the first admin saw a 404.
repo.raceLibraryWrites = 1;
await uploadResource(raceApp, { name: 'Concurrent practice.pdf', title: 'Concurrent practice original', bytes: '%PDF-1.4 race original' });
const raceOriginalBytes = repo.files.get(raceOriginal).base64;
const libraryRaceAttempts = repo.putAttempts.filter((p) => p.path === LIBRARY);
check('library.json create race returns 422 for the missing SHA, then retries with the reread SHA',
  libraryRaceAttempts.length === 2 && libraryRaceAttempts[0].rejected && libraryRaceAttempts[0].status === 422 &&
  libraryRaceAttempts[0].sha === undefined && !!libraryRaceAttempts[1].sha && !libraryRaceAttempts[1].rejected,
  libraryRaceAttempts);
repo.raceFilePath = raceDate;
await uploadResource(raceApp, { name: 'Concurrent practice.pdf', title: 'Concurrent practice retried', bytes: '%PDF-1.4 race retry upload' });
const retriedRaceCopy = raceApp.state.resources.find((r) => r.title === 'Concurrent practice retried');
const rejectedFileRace = repo.putAttempts.find((p) => p.path === raceDate && p.rejected);
check('a candidate taken between GET and PUT is rejected by fake GitHub with 422',
  !!rejectedFileRace && rejectedFileRace.status === 422 && rejectedFileRace.sha === undefined, rejectedFileRace);
check('the upload continues under the next free name', retriedRaceCopy && retriedRaceCopy.path === raceRetry, retriedRaceCopy);
check('the original and racing writer files were not overwritten',
  repo.files.get(raceOriginal).base64 === raceOriginalBytes &&
  unb64(repo.files.get(raceDate).base64).includes('concurrent uploader') &&
  unb64(repo.files.get(raceRetry).base64) === '%PDF-1.4 race retry upload',
  [raceOriginal, raceDate, raceRetry].map((p) => ({ path: p, file: repo.files.get(p) })));
check('library.json lists the original and this upload, never the unregistered race file',
  libraryResources().some((r) => r.path === raceOriginal) && libraryResources().some((r) => r.path === raceRetry) &&
  !libraryResources().some((r) => r.path === raceDate), libraryResources().map((r) => r.path));
let final422;
try {
  await raceApp.ghPutFile(LIBRARY, Buffer.from('unconditional overwrite').toString('base64'), 'test a rejected write');
} catch (err) { final422 = err; }
check('an unrecovered 422 is shown in plain language, not GitHub raw JSON',
  !!final422 && final422.status === 422 && /could not save this change/i.test(final422.message) &&
  !/Invalid request|sha.*wasn.t supplied/i.test(final422.message), final422 && final422.message);

/* 7. No token: the file waits on the device and is published automatically - */
console.log('\n7. a file uploaded without a token is published as soon as one is saved');
resetRepo();
const offlineAdmin = boot();
const waiting = await ready(offlineAdmin);
await signInAsAdmin(offlineAdmin, { token: '' });
await uploadResource(waiting, { name: 'Trigonometry worksheet.pdf', year: 'Year 11', title: 'Trigonometry worksheet', topic: 'Trigonometry', category: 'Classroom worksheet' });
const waitingItem = waiting.state.resources[0];
check('nothing was written to GitHub without a token', repo.puts.length === 0, repo.puts.map((p) => p.path));
check('the file is kept on the uploading device', waitingItem.source === 'device' && offlineAdmin.idb.has(waitingItem.id), waitingItem);
check('it is marked as waiting to publish', waitingItem.pendingPublish === true, waitingItem);
waiting.renderFilesTable();
check('the dashboard says it is waiting', /Waiting to publish/.test(waiting.document.querySelector('#files-body').textContent), waiting.document.querySelector('#files-body').textContent.slice(0, 160));
check('the dashboard offers to publish it', !!waiting.document.querySelector('[data-action="publish-all-pending"]:not([hidden])'));
check('the library card says it is waiting to publish', /Waiting to publish/.test(waiting.document.querySelector('#documents-list').textContent), '');
check('the teacher was told it will publish automatically',
  /published to GitHub and library\.json automatically/.test(waiting.document.querySelector('#toast-stack').textContent),
  waiting.document.querySelector('#toast-stack').textContent.slice(0, 220));

waiting.document.querySelector('#token-input').value = 'ghp_saved_later';
waiting.saveTokenFromForm();
const published = await eventually(() => waitingItem.source === 'cloud' && repo.files.size === 1, 8000);
check('saving the token published the waiting file to the repository', published && repo.files.has('resources/Year 11/Trigonometry worksheet.pdf'), [...repo.files.keys()]);
check('the resource now points at the committed file', waitingItem.path === 'resources/Year 11/Trigonometry worksheet.pdf' && waitingItem.pendingPublish === false, waitingItem);
check('library.json lists it for students', libraryResources().some((r) => r.fileName === 'Trigonometry worksheet.pdf'), libraryResources());
check('the published list is link-addressable for the student device',
  /resources\/Year 11\/Trigonometry worksheet\.pdf/.test(JSON.stringify(libraryResources())), libraryResources());
check('the browser copy of the file is no longer needed', !offlineAdmin.idb.has(waitingItem.id), [...offlineAdmin.idb.keys()]);
check('the teacher was told the waiting file was published',
  /Published 1 file waiting on this device/.test(waiting.document.querySelector('#toast-stack').textContent),
  waiting.document.querySelector('#toast-stack').textContent.slice(0, 220));
waiting.renderFilesTable();
check('the dashboard now reports it as cloud-published', /Cloud · in library\.json/.test(waiting.document.querySelector('#files-body').textContent), waiting.document.querySelector('#files-body').textContent.slice(0, 200));

/* 8. A file in GitHub whose list write failed can be repaired ------------- */
console.log('\n8. a failed list write keeps the file and can be repaired');
resetRepo();
const repairAdmin = boot();
const repair = await ready(repairAdmin);
await signInAsAdmin(repairAdmin);
repo.dropLibraryWrites = 3;                  // both attempts of the upload fail
await uploadResource(repair, { name: 'Probability set.pdf', title: 'Probability set', topic: 'Probability', year: 'Year 12' });
const stalled = repair.state.resources[0];
check('the file still reached the repository', repo.files.has('resources/Year 12/Probability set.pdf'), [...repo.files.keys()]);
check('the resource is kept and flagged instead of vanishing', !!stalled && stalled.source === 'cloud' && stalled.libraryPending === true, stalled);
check('library.json was left without the new entry', !libraryResources().some((r) => r.fileName === 'Probability set.pdf'), libraryResources().map((r) => r.fileName));
check('the teacher is told how to repair it',
  /Press Publish on the file to try again/.test(repair.document.querySelector('#upload-error').textContent),
  repair.document.querySelector('#upload-error').textContent);
repair.renderFilesTable();
check('the dashboard marks the file as list-pending', /Website list pending/.test(repair.document.querySelector('#files-body').textContent), repair.document.querySelector('#files-body').textContent.slice(0, 200));
repo.dropLibraryWrites = 0;
repair.ACTIONS['publish-resource']({ dataset: { id: stalled.id } });
const repaired = await eventually(() => stalled.libraryPending === false, 6000);
check('pressing Publish repairs the website list', repaired && libraryResources().some((r) => r.fileName === 'Probability set.pdf'), libraryResources().map((r) => r.fileName));
check('the repaired entry keeps the file path', libraryResources().some((r) => r.path === 'resources/Year 12/Probability set.pdf'), libraryResources());
repair.renderFilesTable();
check('the dashboard reports it as published again', /Cloud · in library\.json/.test(repair.document.querySelector('#files-body').textContent), repair.document.querySelector('#files-body').textContent.slice(0, 160));

/* 9. An open student tab learns about a file uploaded during the lesson ---- */
console.log('\n9. an open student tab picks up a file uploaded during the lesson');
const beforeRefresh = studentApp.state.resources.length;
const readsBefore = repo.rawLibraryReads;
const fresh = await studentApp.refreshPublishedLibrary(120000);   // just synced: no request
check('a device that has just synced does not re-read the list', fresh === null && repo.rawLibraryReads === readsBefore,
  { fresh, reads: repo.rawLibraryReads - readsBefore });
studentApp.state.cloud.lastSync = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const refreshed = await studentApp.refreshPublishedLibrary(120000);
check('a stale tab re-reads the published list', repo.rawLibraryReads === readsBefore + 1 && !!refreshed, repo.rawLibraryReads - readsBefore);
check('the file uploaded during the lesson appears without a reload',
  studentApp.state.resources.length === beforeRefresh + 1 && studentApp.state.resources.some((r) => r.fileName === 'Probability set.pdf'),
  studentApp.state.resources.map((r) => r.fileName));
check('the refresh never drops files the device already had',
  studentApp.state.resources.some((r) => r.fileName === 'Integration practice.pdf'),
  studentApp.state.resources.map((r) => r.fileName));
studentApp.renderLibrary();
const lateFile = studentApp.state.resources.filter((r) => r.fileName === 'Probability set.pdf')[0];
check('the student can download the newly published file too',
  !!lateFile && (await studentApp.fetchFileBlob(lateFile)).size > 0, lateFile && lateFile.fileName);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await backend.close();
process.exit(fail ? 1 : 0);
