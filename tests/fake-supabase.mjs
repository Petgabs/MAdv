// A tiny stand-in for Supabase's PostgREST RPC endpoint, backed by a real
// Postgres (PGlite) running backends/supabase/schema.sql. Used to test the
// front-end sync layer and scripts/export-cloud-data.mjs without a cloud
// project.  POST /rest/v1/rpc/<name> with a JSON body of named parameters.
import { PGlite } from '@electric-sql/pglite';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { splitStatements } from './sql-split.mjs';

const schemaPath = process.env.SCHEMA || new URL('../backends/supabase/schema.sql', import.meta.url).pathname;

export async function createBackend() {
  const db = await PGlite.create();
  await db.exec(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  end $$;`);
  for (const statement of splitStatements(readFileSync(schemaPath, 'utf8'))) {
    await db.exec(statement);
  }

  async function signature(name) {
    const res = await db.query(
      `select p.proargnames, p.proargtypes, n.nspname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname = $1 and n.nspname = 'public'`, [name]);
    if (!res.rows.length) return null;
    const row = res.rows[0];
    const types = (row.proargtypes || '').toString().split(' ').filter(Boolean);
    const typeNames = [];
    for (const oid of types) {
      const t = await db.query('select format_type($1::oid, null) as name', [oid]);
      typeNames.push(t.rows[0].name);
    }
    return { names: row.proargnames || [], types: typeNames };
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
        return res.end();
      }
      const match = req.url.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)$/i);
      if (!match) return send(404, { message: 'no such endpoint' });
      const name = match[1];
      const params = body ? JSON.parse(body) : {};
      const sig = await signature(name);
      if (!sig) return send(404, { message: `function ${name} does not exist` });
      const values = [];
      const casts = [];
      sig.names.forEach((argName, i) => {
        const value = params[argName] !== undefined ? params[argName] : null;
        values.push(typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
        casts.push(`$${i + 1}::${sig.types[i] || 'text'}`);
      });
      try {
        const out = await db.query(`select public.${name}(${casts.join(', ')}) as result`, values);
        send(200, out.rows[0].result);
      } catch (err) {
        send(400, { message: err.message });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ db, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); return db.close(); } });
    });
  });
}
