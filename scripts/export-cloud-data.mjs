#!/usr/bin/env node
/* =====================================================================
   Mirror the shared backend (Supabase) into data/cloud-data.json.

   Used by .github/workflows/cloud-sync.yml so the repository always holds
   the class register and the counters without anybody opening the admin
   page. It needs no dependencies — Node 18+ has fetch built in.

   Usage:
     node scripts/export-cloud-data.mjs [--config data/sync-config.json]
                                        [--out data/cloud-data.json]
                                        [--dry-run]

   Environment:
     ADMIN_USER / ADMIN_PASS   administrator sign-in (repository secrets;
                               defaults to the ones shipped in index.html)
     SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY  override the config file
   ===================================================================== */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const configPath = resolve(root, arg('config', 'data/sync-config.json'));
const outPath = resolve(root, arg('out', 'data/cloud-data.json'));
const dryRun = process.argv.includes('--dry-run');

function fail(message) {
  console.error('cloud-data export: ' + message);
  process.exit(1);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    fail('cannot read ' + path + ' (' + err.message + ')');
  }
}

const fileConfig = await readJson(configPath, {});
const url = (process.env.SUPABASE_URL || fileConfig.url || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_PUBLISHABLE_KEY || fileConfig.publishableKey || fileConfig.key || '').trim();
const adminUser = process.env.ADMIN_USER || 'peter82';
const adminPass = process.env.ADMIN_PASS || 'petgabs82';

if (!url || !key) {
  console.log('cloud-data export: no shared backend configured yet — nothing to do.');
  process.exit(0);
}
if (/^sb_secret_/i.test(key) || /service_role/i.test(key)) {
  fail('a secret key was configured; use the publishable key instead.');
}

const day = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.SITE_TIMEZONE || 'UTC',
  year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

let response;
try {
  response = await fetch(url + '/rest/v1/rpc/madv_admin_export', {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ p_admin_user: adminUser, p_admin_pass: adminPass, p_day: day }),
    signal: AbortSignal.timeout(30000)   // never leave a scheduled run hanging
  });
} catch (err) {
  fail('the shared backend could not be reached: ' + err.message);
}

const text = await response.text();
let snapshot = null;
try { snapshot = text ? JSON.parse(text) : null; } catch (err) { /* non-JSON error page */ }

if (!response.ok) {
  // A paused Supabase project answers 5xx; that must not break the workflow.
  fail('the shared backend returned HTTP ' + response.status +
    (snapshot && (snapshot.message || snapshot.error) ? ': ' + (snapshot.message || snapshot.error) : ''));
}
if (!snapshot || snapshot.ok !== true) {
  fail((snapshot && snapshot.error) || 'the shared backend refused the export (check ADMIN_USER / ADMIN_PASS).');
}

// The repository is public: names and usernames are fine, passwords are not.
const students = (snapshot.students || []).map((student) => {
  const copy = { ...student };
  delete copy.password;
  copy.passwordRule = 'username + year number (kept in the shared backend)';
  return copy;
});

const payload = {
  _comment: 'Mirror of the shared backend (Supabase), written automatically by .github/workflows/cloud-sync.yml. Public: holds names, usernames and counts, never passwords.',
  source: 'shared-backend',
  subject: 'Mathematics Advanced',
  updatedAt: snapshot.updatedAt || new Date().toISOString(),
  counters: snapshot.counters || {},
  students,
  logins: snapshot.logins || [],
  downloads: snapshot.downloads || [],
  visits: snapshot.visits || []
};

const next = JSON.stringify(payload, null, 2) + '\n';
let previous = null;
try { previous = await readFile(outPath, 'utf8'); } catch (err) { /* first run */ }

if (previous) {
  try {
    const a = JSON.parse(previous);
    const b = JSON.parse(next);
    delete a.updatedAt; delete b.updatedAt;
    if (JSON.stringify(a) === JSON.stringify(b)) {
      console.log('cloud-data export: no changes since the last run.');
      process.exit(0);
    }
  } catch (err) { /* unparseable previous file — overwrite it */ }
}

if (dryRun) {
  console.log('cloud-data export: dry run, ' + students.length + ' student(s), ' +
    (snapshot.counters && snapshot.counters.downloads || 0) + ' downloads.');
  process.exit(0);
}

await writeFile(outPath, next, 'utf8');
console.log('cloud-data export: wrote ' + outPath.replace(root + '/', '') +
  ' — ' + students.length + ' student(s), ' +
  ((snapshot.counters && snapshot.counters.visits) || 0) + ' visits, ' +
  ((snapshot.counters && snapshot.counters.downloads) || 0) + ' downloads.');
