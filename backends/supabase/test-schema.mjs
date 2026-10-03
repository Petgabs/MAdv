import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { splitStatements } from '../../tests/sql-split.mjs';

const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

const db = await PGlite.create();
// Supabase pre-creates these roles; emulate them so the grant/revoke block runs.
await db.exec(`do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
for (const st of splitStatements(sql)) { await db.exec(st); }

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
async function rpc(name, params) {
  const res = await db.query(
    `select ${name}(${Object.keys(params).map((k, i) => '$' + (i + 1)).join(', ') || ''}) as result`,
    Object.values(params)
  );
  return res.rows[0].result;
}
async function fn(name, args, types = []) {
  const res = await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1) + (types[i] ? '::' + types[i] : '')).join(', ')}) as r`, args);
  return res.rows[0].r;
}

console.log('\n1. health + empty stats');
let h = await rpc('public.madv_health', {});
check('health ok', h.ok === true, h);
let s = await rpc('public.madv_stats', {});
check('stats start at zero', s.ok && s.visits === 0 && s.downloads === 0 && s.uniqueVisitors === 0, s);
check('stats daily is an object', s.daily && typeof s.daily === 'object', s.daily);

console.log('\n2. registration issues username + password');
let r1 = await rpc('public.madv_register', { a: 'Peter', b: 'Year 11', c: 'stu_aaaaaaaa' });
check('first peter → peter / peter11', r1.ok === true && r1.username === 'peter' && r1.password === 'peter11', r1);
check('first name title-cased', r1.firstName === 'Peter', r1);
let r2 = await rpc('public.madv_register', { a: 'Peter', b: 'Year 11', c: 'stu_bbbbbbbb' });
check('second peter → peter2 / peter211', r2.ok === true && r2.username === 'peter2' && r2.password === 'peter211', r2);
let r3 = await rpc('public.madv_register', { a: 'peter', b: 'Year 11', c: 'stu_aaaaaaaa' });
check('same device re-registering returns the same account', r3.ok === true && r3.username === 'peter' && r3.alreadyRegistered === true, r3);
let r4 = await rpc('public.madv_register', { a: 'Mary Jane', b: 'Year 12', c: 'stu_cccccccc' });
check('space collapsed to one username', r4.ok === true && r4.username === 'maryjane' && r4.password === 'maryjane12', r4);
let bad1 = await rpc('public.madv_register', { a: 'P', b: 'Year 11', c: 'stu_dddddddd' });
check('one-letter name rejected', bad1.ok === false, bad1);
let bad2 = await rpc('public.madv_register', { a: 'Peter9', b: 'Year 11', c: 'stu_eeeeeeee' });
check('digits in name rejected', bad2.ok === false, bad2);
let bad3 = await rpc('public.madv_register', { a: 'Peter', b: '', c: 'stu_ffffffff' });
check('missing year rejected', bad3.ok === false, bad3);

console.log('\n3. sign-in is verified server side');
let l1 = await rpc('public.madv_login', { a: 'peter', b: 'peter11' });
check('correct password signs in', l1.ok === true && l1.username === 'peter', l1);
check('sign in bumps visit count', l1.visitCount === 1, l1);
let l2 = await rpc('public.madv_login', { a: 'peter', b: 'wrong' });
check('wrong password rejected', l2.ok === false && /password does not match/.test(l2.error), l2);
let l3 = await rpc('public.madv_login', { a: 'nobody', b: 'x' });
check('unknown username rejected', l3.ok === false && /No student found/.test(l3.error), l3);
let l4 = await rpc('public.madv_login', { a: 'PETER', b: 'peter11' });
check('username is case-insensitive', l4.ok === true, l4);

console.log('\n4. visitor counter');
let v1 = await rpc('public.madv_visit', { a: 'dev_one', b: '2026-10-04', c: null, d: 'Visitor', e: '' });
check('first visit counted', v1.ok === true && v1.visits === 1 && v1.uniqueVisitors === 1, v1);
let v2 = await rpc('public.madv_visit', { a: 'dev_one', b: '2026-10-04', c: null, d: 'Visitor', e: '' });
check('refresh within 30 min is not double counted', v2.ok === true && v2.duplicate === true && v2.visits === 1, v2);
let v3 = await rpc('public.madv_visit', { a: 'dev_two', b: '2026-10-04', c: null, d: 'Visitor', e: '' });
check('second device counted', v3.ok === true && v3.visits === 2 && v3.uniqueVisitors === 2, v3);
let v4 = await rpc('public.madv_visit', { a: 'dev_one', b: '2026-10-04', c: 'stu_aaaaaaaa', d: 'Peter', e: 'Year 11' });
check('a student on a seen device still counts', v4.ok === true && v4.visits === 3, v4);
let v5 = await rpc('public.madv_visit', { a: '', b: '2026-10-04' });
check('blank device id rejected', v5.ok === false, v5);
let v6 = await rpc('public.madv_visit', { a: 'dev_three', b: 'not-a-day' });
check('bad day rejected', v6.ok === false, v6);

console.log('\n5. download counter');
let d1 = await rpc('public.madv_download', { a: 'evt_0001', b: 'path:Year 12/a.pdf', c: JSON.stringify({ day: '2026-10-04', studentId: 'stu_aaaaaaaa', studentName: 'Peter', fileName: 'a.pdf' }) });
check('download counted', d1.ok === true && d1.total === 1 && d1.resourceTotal === 1, d1);
let d2 = await rpc('public.madv_download', { a: 'evt_0001', b: 'path:Year 12/a.pdf', c: JSON.stringify({ day: '2026-10-04' }) });
check('retry with the same event id is idempotent', d2.ok === true && d2.duplicate === true && d2.total === 1, d2);
let d3 = await rpc('public.madv_download', { a: 'evt_0002', b: 'path:Year 12/a.pdf', c: JSON.stringify({ day: '2026-10-04' }) });
check('second download of the same file', d3.ok === true && d3.total === 2 && d3.resourceTotal === 2, d3);
let d4 = await rpc('public.madv_download', { a: 'evt_0003', b: 'path:Year 12/b.pdf', c: '{}' });
check('different file keeps its own total', d4.ok === true && d4.resourceTotal === 1, d4);

check('student download tally follows the log', (await rpc('public.madv_login', { a: 'peter', b: 'peter11' })).downloadCount === 1, await rpc('public.madv_login', { a: 'peter', b: 'peter11' }));

console.log('\n6. stats reflect the counters');
s = await rpc('public.madv_stats', {});
check('visits total', s.visits === 3, s.visits);
check('downloads total', s.downloads === 3, s.downloads);
check('unique visitors', s.uniqueVisitors === 2, s.uniqueVisitors);
check('per-file totals', s.perFile['path:Year 12/a.pdf'].total === 2 && s.perFile['path:Year 12/b.pdf'].total === 1, s.perFile);
check('daily bucket visits', s.daily['2026-10-04'].visits === 3, s.daily);
check('daily bucket downloads (one event fell back to the server day)', s.daily['2026-10-04'].downloads === 2 && s.daily['2026-10-03'].downloads === 1, s.daily);

console.log('\n7. admin export is gated');
let e0 = await rpc('public.madv_admin_export', { a: 'peter82', b: 'nope' });
check('wrong admin password rejected', e0.ok === false, e0);
let e1 = await rpc('public.madv_admin_export', { a: 'peter82', b: 'petgabs82' });
check('export ok', e1.ok === true, e1);
check('export has 3 students', Array.isArray(e1.students) && e1.students.length === 3, e1.students && e1.students.length);
check('export carries counters', e1.counters.visits === 3 && e1.counters.downloads === 3, e1.counters);
check('export has login log', Array.isArray(e1.logins) && e1.logins.length >= 5, e1.logins && e1.logins.length);
check('export has download log', Array.isArray(e1.downloads) && e1.downloads.length === 3, e1.downloads && e1.downloads.length);
let e2 = await rpc('public.madv_admin_export', { a: 'peter82', b: 'petgabs82', c: '2026-10-04' });
check('export honours the caller day', e2.counters.day === '2026-10-04' && e2.counters.visitsToday === 3 && e2.counters.downloadsToday === 2, e2.counters);
check('exported students never leak to a bad password', e0.students === undefined, e0);

console.log('\n8. admin can block and edit a student');
let b1 = await rpc('public.madv_admin_student', { a: 'upsert', b: JSON.stringify({ clientId: 'stu_aaaaaaaa', status: 'blocked' }), c: 'peter82', d: 'petgabs82' });
check('blocked ok', b1.ok === true && b1.status === 'blocked', b1);
let bl = await rpc('public.madv_login', { a: 'peter', b: 'peter11' });
check('blocked student cannot sign in', bl.ok === false && /blocked/.test(bl.error), bl);
let b2 = await rpc('public.madv_admin_student', { a: 'upsert', b: JSON.stringify({ clientId: 'stu_aaaaaaaa', status: 'active', password: 'reset99' }), c: 'peter82', d: 'petgabs82' });
check('password reset syncs', b2.ok === true && b2.password === 'reset99', b2);
let b3 = await rpc('public.madv_admin_student', { a: 'upsert', b: JSON.stringify({ clientId: 'stu_missing' }), c: 'peter82', d: 'petgabs82' });
check('unknown student reported', b3.ok === false, b3);
let b4 = await rpc('public.madv_admin_student', { a: 'delete', b: JSON.stringify({ clientId: 'stu_bbbbbbbb' }), c: 'peter82', d: 'petgabs82' });
check('delete works', b4.ok === true && b4.deleted === true, b4);
let b5 = await rpc('public.madv_admin_student', { a: 'upsert', b: JSON.stringify({ clientId: 'stu_aaaaaaaa' }), c: 'peter82', d: 'wrong' });
check('admin gate enforced on edits', b5.ok === false, b5);

console.log('\n9. admin config');
let c1 = await rpc('public.madv_admin_config', { a: JSON.stringify({ open_registration: 'false' }), b: 'peter82', c: 'petgabs82' });
check('config updated', c1.ok === true && c1.updated === 1, c1);
let c2 = await rpc('public.madv_register', { a: 'Closed', b: 'Year 11', c: 'stu_gggggggg' });
check('closed registration blocks new students', c2.ok === false && /closed/i.test(c2.error), c2);
let c3 = await rpc('public.madv_admin_config', { a: JSON.stringify({ open_registration: 'true', sneaky: 'x' }), b: 'peter82', c: 'petgabs82' });
check('unknown config keys ignored', c3.ok === true && c3.updated === 1, c3);

console.log('\n10. helpers');
check('year digits', (await fn('madv_year_digits', ['Year 11'])) === '11', await fn('madv_year_digits', ['Year 11']));
check('title case', (await fn('madv_titlecase', ['mary  jane'])) === 'Mary Jane', await fn('madv_titlecase', ['mary  jane']));

console.log('\n11. direct table access is revoked for anon');
const grants = await db.query(`select has_table_privilege('anon', 'public.madv_students', 'SELECT') as sel,
                                      has_table_privilege('anon', 'public.madv_students', 'INSERT') as ins`);
check('anon cannot select students', grants.rows[0].sel === false, grants.rows[0]);
check('anon cannot insert students', grants.rows[0].ins === false, grants.rows[0]);
const execGrant = await db.query(`select has_function_privilege('anon', 'public.madv_login(text,text)', 'EXECUTE') as ex`);
check('anon can execute madv_login', execGrant.rows[0].ex === true, execGrant.rows[0]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
