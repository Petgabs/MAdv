# Counters setup prompts

Two paste-ready prompts for an AI coding agent (or a human). Copy everything
inside the chosen fence, including the headings.

| Prompt | Use it when |
| --- | --- |
| **A — Full build** | You want shared visitor and per-file download counters, backed by Supabase, on **any** static site, starting from nothing. |
| **B — Finish the Supabase switch** | You are working on **this repo** (`Petgabs/MAdv`). The Abacus visitor/download counters are built in; only the optional Supabase student backend and its configuration may be missing. |

> **Paths in this repo.** The schema is at `backends/supabase/schema.sql`. The
> public connection settings go in `data/sync-config.json` (fields `url` and
> `publishableKey`). The admin dashboard status line is `#backend-status-text`
> in `index.html`. Prompt B uses these real paths.

---

## Prompt A — Full build

````markdown
# Task: add shared visitor + download counters to this static site (Supabase)

You are working in a static website (no server, hosted on GitHub Pages or similar).
Add a **visitor counter**, a **total download counter** and a **per-file download
counter**. Every device must see the same numbers. Use a free Supabase project as
the only backend. Do not add a build step, a framework or a server.

## 1. Architecture
- Browser → `POST https://<project>.supabase.co/rest/v1/rpc/<fn>` using the
  **publishable/anon key**. That is the only network path.
- The database exposes exactly four functions to `anon`: `ctr_health`,
  `ctr_stats`, `ctr_visit`, `ctr_download`. All tables have Row Level Security
  on and **no policies**, and direct table privileges are revoked. The public key
  can only call those functions.
- Configuration lives in one public file, `config.js`
  (`window.COUNTERS_CONFIG = { url: '', anonKey: '' }`). Load it with a plain
  `<script src="config.js">` before the main script. If either value is empty,
  the counters run in **local mode** (localStorage only) and the site must still
  work.

## 2. Key-slug rules (per-file counter key)
Work out one stable `resource_key` per downloadable file:
1. Repo-relative path (doesn't start with `http`) → `path:<path>` (e.g. `path:files/algebra/week3.pdf`).
2. Otherwise, a stable id → `id:<id>`.
3. Otherwise → `file:<fileName>`.
4. Files that exist only on this device (not published) get **no** key and are never sent.
5. If the key is longer than 300 characters, skip it (the server rejects it too).
Never use the display title as the key, because titles get edited. Renaming the path starts a new counter. That is intended.

## 3. Counting semantics
- **Visit:** call `ctr_visit` once per page load. The server counts at most **one
  visit per device per 30 minutes**, so refreshing doesn't inflate the count.
  It returns `duplicate: true` when it skipped a visit.
- **Device id:** random id (`dev-` + 12+ random chars), created once and stored in
  localStorage. Length 4–60. Unique visitors = number of distinct device ids.
- **Day:** `YYYY-MM-DD` in **UTC** (`new Date().toISOString().slice(0,10)`).
- **Download:** call `ctr_download` for each real download click. Generate a fresh
  `event_id` (`evt-` + random, 6–80 chars) **per click**, and reuse that same id on
  every retry of that click. The server ignores event ids it has already seen,
  so a retry never counts twice.
- **Offline / failure:** if the network fails or a 5xx response comes back, queue
  `{fn, payload}` in localStorage. Flush the queue in order on the next load and
  on the `online` event. If the server answers `ok:false` or 4xx, **drop** the item
  and don't retry it. Show the queue length in the dashboard.
- **Display:** after any successful call, use the totals the server returned.
  On load, call `ctr_stats` and draw the numbers from that. Never add local and
  remote counts together.

## 4. SQL schema (run verbatim in Supabase → SQL Editor → New query → Run)
```sql
-- Counters backend — run once in Supabase: SQL Editor → New query → Run.
-- Safe to re-run. Every table has RLS on and no policies; the browser can
-- only call the four ctr_* functions granted to anon at the bottom.

create table if not exists public.ctr_counters (
  key        text primary key,            -- 'visits' | 'downloads'
  value      bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.ctr_counters (key, value) values ('visits', 0), ('downloads', 0)
on conflict (key) do nothing;

create table if not exists public.ctr_daily (
  day        text primary key,            -- 'YYYY-MM-DD' (UTC)
  visits     bigint not null default 0,
  downloads  bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.ctr_file_totals (
  resource_key     text primary key,      -- see key-slug rules
  total            bigint not null default 0,
  last_download_at timestamptz
);

create table if not exists public.ctr_devices (
  device_id  text primary key,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  visits     bigint not null default 0
);

create table if not exists public.ctr_visits (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  day       text not null,
  device_id text not null
);
create index if not exists ctr_visits_device_at_idx on public.ctr_visits (device_id, at desc);

create table if not exists public.ctr_download_events (
  event_id     text primary key,          -- client-generated, makes retries idempotent
  resource_key text not null,
  created_at   timestamptz not null default now()
);

create or replace function public.ctr_bump(p_key text, p_delta bigint)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_value bigint;
begin
  insert into public.ctr_counters (key, value)
  values (p_key, greatest(p_delta, 0))
  on conflict (key) do update
    set value = ctr_counters.value + greatest(p_delta, 0), updated_at = now()
  returning value into v_value;
  return coalesce(v_value, 0);
end;
$$;

create or replace function public.ctr_health()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('ok', true, 'provider', 'supabase',
    'time', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
$$;

create or replace function public.ctr_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_visits    bigint;
  v_downloads bigint;
  v_unique    bigint;
  v_daily     jsonb;
  v_files     jsonb;
begin
  select coalesce(value, 0) into v_visits    from public.ctr_counters where key = 'visits';
  select coalesce(value, 0) into v_downloads from public.ctr_counters where key = 'downloads';
  select count(*) into v_unique from public.ctr_devices;

  select coalesce(jsonb_object_agg(day, jsonb_build_object('visits', visits, 'downloads', downloads)), '{}'::jsonb)
    into v_daily
    from (select day, visits, downloads from public.ctr_daily order by day desc limit 60) d;

  select coalesce(jsonb_object_agg(resource_key, jsonb_build_object('total', total,
           'lastDownloadAt', to_char(last_download_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))), '{}'::jsonb)
    into v_files
    from public.ctr_file_totals;

  return jsonb_build_object('ok', true,
    'visits', coalesce(v_visits, 0), 'downloads', coalesce(v_downloads, 0),
    'uniqueVisitors', coalesce(v_unique, 0),
    'day', to_char(now() at time zone 'utc', 'YYYY-MM-DD'),
    'daily', v_daily, 'perFile', v_files);
end;
$$;

create or replace function public.ctr_visit(p_device_id text, p_day text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_visits bigint;
  v_unique bigint;
begin
  if p_device_id is null or length(p_device_id) < 4 or length(p_device_id) > 60 then
    return jsonb_build_object('ok', false, 'error', 'A valid device id is required.');
  end if;
  if p_day is null or p_day !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('ok', false, 'error', 'A valid day (YYYY-MM-DD) is required.');
  end if;

  -- Anti-refresh: at most one counted visit per device per 30 minutes.
  if exists (select 1 from public.ctr_visits
              where device_id = p_device_id and at > now() - interval '30 minutes') then
    select coalesce(value, 0) into v_visits from public.ctr_counters where key = 'visits';
    select count(*) into v_unique from public.ctr_devices;
    return jsonb_build_object('ok', true, 'duplicate', true,
      'visits', coalesce(v_visits, 0), 'uniqueVisitors', v_unique);
  end if;

  insert into public.ctr_visits (day, device_id) values (p_day, p_device_id);
  insert into public.ctr_devices (device_id, visits) values (p_device_id, 1)
  on conflict (device_id) do update set last_seen = now(), visits = ctr_devices.visits + 1;

  v_visits := public.ctr_bump('visits', 1);
  insert into public.ctr_daily (day, visits) values (p_day, 1)
  on conflict (day) do update set visits = ctr_daily.visits + 1, updated_at = now();

  select count(*) into v_unique from public.ctr_devices;
  delete from public.ctr_visits where at < now() - interval '180 days';
  return jsonb_build_object('ok', true, 'visits', v_visits, 'uniqueVisitors', v_unique);
end;
$$;

create or replace function public.ctr_download(p_event_id text, p_resource_key text, p_day text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day   text;
  v_total bigint;
  v_file  bigint;
  v_last  timestamptz;
begin
  if p_event_id is null or length(p_event_id) < 6 or length(p_event_id) > 80 then
    return jsonb_build_object('ok', false, 'error', 'A valid event id is required.');
  end if;
  if p_resource_key is null or length(p_resource_key) = 0 or length(p_resource_key) > 300 then
    return jsonb_build_object('ok', false, 'error', 'A valid resource key is required.');
  end if;

  -- Retries / double clicks with the same event id never double count.
  if exists (select 1 from public.ctr_download_events where event_id = p_event_id) then
    select total, last_download_at into v_file, v_last from public.ctr_file_totals where resource_key = p_resource_key;
    select coalesce(value, 0) into v_total from public.ctr_counters where key = 'downloads';
    return jsonb_build_object('ok', true, 'duplicate', true, 'total', coalesce(v_total, 0),
      'resourceKey', p_resource_key, 'resourceTotal', coalesce(v_file, 0));
  end if;

  v_day := coalesce(nullif(p_day, ''), to_char(now() at time zone 'utc', 'YYYY-MM-DD'));
  if v_day !~ '^\d{4}-\d{2}-\d{2}$' then
    v_day := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  end if;

  insert into public.ctr_download_events (event_id, resource_key) values (p_event_id, p_resource_key);
  v_total := public.ctr_bump('downloads', 1);
  insert into public.ctr_daily (day, downloads) values (v_day, 1)
  on conflict (day) do update set downloads = ctr_daily.downloads + 1, updated_at = now();
  insert into public.ctr_file_totals (resource_key, total, last_download_at) values (p_resource_key, 1, now())
  on conflict (resource_key) do update set total = ctr_file_totals.total + 1, last_download_at = now()
  returning total, last_download_at into v_file, v_last;

  delete from public.ctr_download_events where created_at < now() - interval '180 days';
  return jsonb_build_object('ok', true, 'total', v_total, 'resourceKey', p_resource_key,
    'resourceTotal', coalesce(v_file, 0),
    'lastDownloadAt', to_char(v_last at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end;
$$;

alter table public.ctr_counters        enable row level security;
alter table public.ctr_daily           enable row level security;
alter table public.ctr_file_totals     enable row level security;
alter table public.ctr_devices         enable row level security;
alter table public.ctr_visits          enable row level security;
alter table public.ctr_download_events enable row level security;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on function public.ctr_bump(text, bigint) from public, anon, authenticated;

grant usage on schema public to anon;
grant execute on function public.ctr_health()                   to anon;
grant execute on function public.ctr_stats()                    to anon;
grant execute on function public.ctr_visit(text, text)          to anon;
grant execute on function public.ctr_download(text, text, text) to anon;

notify pgrst, 'reload schema';
```

## 5. Supabase REST calls
Every call:
```
POST {url}/rest/v1/rpc/{fn}
apikey: {anonKey}
Authorization: Bearer {anonKey}
Content-Type: application/json
Accept: application/json
cache: 'no-store', 8-second AbortController timeout
```
| fn | body | returns |
| --- | --- | --- |
| `ctr_health` | `{}` | `{ok, provider, time}` |
| `ctr_stats` | `{}` | `{ok, visits, downloads, uniqueVisitors, day, daily:{day:{visits,downloads}}, perFile:{key:{total,lastDownloadAt}}}` |
| `ctr_visit` | `{"p_device_id":"dev-…","p_day":"2026-10-04"}` | `{ok, visits, uniqueVisitors, duplicate?}` |
| `ctr_download` | `{"p_event_id":"evt-…","p_resource_key":"path:…","p_day":"2026-10-04"}` | `{ok, total, resourceKey, resourceTotal, lastDownloadAt, duplicate?}` |

Parameter names must match exactly (PostgREST matches by name). If you get a 404
`PGRST202` for a new function, run `notify pgrst, 'reload schema';`.

## 6. Security constraints (all required)
- **CSP:** if the page has a `Content-Security-Policy` (meta or header), add
  `https://*.supabase.co` to **`connect-src`**. This is easy to miss. Without it,
  every call fails with a CSP error in the console and the counters quietly stay
  in local mode.
- Use only the publishable key (`sb_publishable_…` or the legacy `anon` JWT).
  **Refuse to save** any key that matches `/^sb_secret_/i` or contains
  `service_role`, and show an error.
- Never commit a secret key or GitHub token. `config.js` holds public values only.
- Don't grant table privileges or add RLS policies for `anon`. Leave `ctr_bump`
  un-granted.
- Insert numbers with `textContent`, never `innerHTML`, and escape any keys/titles you display.
- Don't send personal data. Counters are anonymous (device id + resource key only).

## 7. UI requirements
- Header pills: "N visits" and "N downloads" (use thousands separators).
- A per-file download count next to each file in lists/cards, plus "last downloaded …" (relative time).
- Admin/dashboard status line:
  - configured and reachable → "Counters: **the managed database** (Supabase) · synced <relative time>"
  - not configured → "Counters: **this browser only** — add the Supabase URL and key to config.js"
  - configured but failing → also show the error and "N change(s) waiting to sync".
- A "Test connection" button that calls `ctr_health` and reports the result.
- Optional: a 14-day visits/downloads sparkline built from `daily`.

## 8. Acceptance checklist
- [ ] Running the SQL twice gives no errors.
- [ ] As `anon`, `select * from ctr_counters` is denied and `ctr_bump` can't be called.
- [ ] Loading the page from two browsers → visits = 2, uniqueVisitors = 2. Refreshing within 30 min → unchanged.
- [ ] Downloading a file → total and that file's count both go up by 1 on every device after reload.
- [ ] Replaying the same `ctr_download` request (same event id) → `duplicate:true`, no increment.
- [ ] Downloading while offline queues the call; going back online flushes it and the count goes up by exactly 1.
- [ ] No CSP errors in the console. The `connect-src` list includes `https://*.supabase.co`.
- [ ] A `sb_secret_…` key is rejected by the settings UI.
- [ ] With an empty `config.js` the site still works and the status line says "this browser only".
- [ ] The dashboard status line says "the managed database".
````

---

## Prompt B — Finish the Supabase switch (this repo)

````markdown
# Task: connect Petgabs/MAdv to its Supabase project

The code is already done. Do only the configuration below. Don't rewrite the
schema or the sync code.

1. **Create the project.** At supabase.com, create a new free project
   (any name, e.g. `madv`, in the region nearest the school). Wait until it is healthy.
2. **Run the schema.** Open SQL Editor → New query, paste the whole of
   `backends/supabase/schema.sql`, and press Run. It should finish without errors
   (it is safe to re-run). Check:
   `select public.madv_health();` → `{"ok": true, "provider": "supabase", ...}`.
3. **Copy the public credentials** from Project Settings → API keys:
   the Project URL (`https://<ref>.supabase.co`) and the **publishable** key
   (`sb_publishable_…`, or the legacy `anon` JWT). Never use `sb_secret_…` /
   `service_role`.
4. **Paste them into the config.** Either:
   - edit `data/sync-config.json` and set `"url"` and `"publishableKey"`
     (leave `_comment` and `"provider": "supabase"` as they are), then commit; **or**
   - on the live site, sign in as Admin → Cloud settings → Shared cloud sync,
     paste both values and press **Save to GitHub** (this writes the same file).
5. **Check the CSP.** In `index.html`, the `Content-Security-Policy` meta's
   `connect-src` must contain `https://*.supabase.co` (it does now; don't remove it).
6. **Verify.**
   - Cloud settings → **Test connection** reports the registered student count.
   - Open the Admin dashboard. The status line (`#backend-status-text`) should
     report Abacus visitor/download counters separately from the Supabase
     student backend. Connecting Supabase changes student registration and
     activity status; Abacus totals are shared regardless of Supabase config.
   - Open the site in a second browser. A visit and a published-file download
     should update the shared Abacus totals after the next response/reload.
   - The browser console shows no CSP or 401/404 errors.
   - Optional: run `npm test` locally (schema + e2e tests should pass).
7. Report the project ref (not the key) and the before/after status text.
````
