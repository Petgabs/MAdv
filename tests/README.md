# Tests

The site itself has no dependencies — these packages are only for testing.

```bash
npm install     # installs PGlite (Postgres in WASM) and jsdom
npm test        # runs both suites
```

| Suite | What it covers |
| --- | --- |
| `backends/supabase/test-schema.mjs` | Runs `backends/supabase/schema.sql` in a real PostgreSQL (PGlite) and exercises every `madv_*` function: username and password issuing, collision handling, sign-in, deduplication of visits and download events, daily and per-file counters, the admin gate, and the Row Level Security grants. |
| `tests/e2e.test.mjs` | Loads the real `index.html` in jsdom, points it at fake Supabase, Abacus and GitHub endpoints, and drives the actual page functions: shared registration, fail-closed offline behavior and safe retry, sign-in from a second "device", live admin roster refresh and delete/status reconciliation, shared counters, and the password-free GitHub exporter. |

`tests/fake-supabase.mjs` is the tiny PostgREST stand-in; the e2e test's in-memory Abacus map models `/get` and `/hit`; `tests/sql-split.mjs` splits a SQL script into statements without breaking `$tag$` function bodies.
