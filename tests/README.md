# Tests

The site itself has no dependencies — these packages are only for testing.

```bash
npm install     # installs PGlite (Postgres in WASM) and jsdom
npm test        # runs both suites
```

| Suite | What it covers |
| --- | --- |
| `backends/supabase/test-schema.mjs` | Runs `backends/supabase/schema.sql` in a real PostgreSQL (PGlite) and exercises every `madv_*` function: username and password issuing, sign-in, deduplication of visits and download events, daily and per-file counters, the admin gate, and the Row Level Security grants. |
| `tests/e2e.test.mjs` | Loads the real `index.html` in jsdom, points it at a fake Supabase REST endpoint backed by the same database, and drives the actual page functions: registration, sign-in from a second "device", blocking, visitor and download counters, the admin roster pull, the repository mirror (and that it never contains passwords), offline queueing and config publishing. |

`tests/fake-supabase.mjs` is the tiny PostgREST stand-in; `tests/sql-split.mjs` splits a SQL script into statements without breaking `$tag$` function bodies.
