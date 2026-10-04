# Tests

The site itself has no dependencies — these packages are only for testing.

```bash
npm install     # installs PGlite (Postgres in WASM) and jsdom
npm test        # runs all four suites
```

| Suite | What it covers |
| --- | --- |
| `backends/supabase/test-schema.mjs` | Runs `backends/supabase/schema.sql` in a real PostgreSQL (PGlite) and exercises every `madv_*` function: username and password issuing, collision handling, sign-in, deduplication of visits and download events, daily and per-file counters, the admin gate, and the Row Level Security grants. |
| `tests/e2e.test.mjs` | Loads the real `index.html` in jsdom, points it at fake Supabase, Abacus and GitHub endpoints, and drives the actual page functions: shared registration, fail-closed offline behavior and safe retry, sign-in from a second "device", live admin roster refresh and delete/status reconciliation, shared counters, the password-free GitHub exporter, the **download policy** (an unregistered visitor is refused and told to register and log in; a signed-in student is sent to **My learning** and only counts the download from there), and the **per-student Abacus counters** that the admin register and the student profile read back. |
| `tests/upload.test.mjs` | Loads the real `index.html` in jsdom and checks the admin **upload page's "The file" step**: the **50 MB ceiling** (labels, settings clamp and the migration that moves devices off the retired 25 MB default), the size-check meter in the chosen-file panel, rejection of oversized files (which leaves the previously chosen file selected), and that the **admin sign-in modal and help modal never display default credentials**. |

| `tests/resilience.test.mjs` | Loads the real `index.html` in jsdom and drives the security and load-handling behaviour: the sign-in **brute-force lockout** (threshold, the 60s → 15min doubling, and the reset on success), the **admin inactivity sign-out** and its 1–480/0 clamp, the **tab-scoped admin session** (and the scrubbing of a legacy stored one), the **Content-Security-Policy**, **login retry with jittered backoff** (retried once on a transient failure, never on a refusal), the **download timeout, single retry, 3-at-a-time gate, shared in-flight fetch** and the **durable 10-minute cache** (revision keying, expiry, oldest-first eviction past the cap, and graceful failure when IndexedDB is unavailable), the **offline queue cooldown** (stops draining on a transient failure, 30s → 5min jittered, clears on success), the **global error shield** and **Diagnostics** panel, **isolated actions and renderers**, **toast flood control**, **hidden-tab render skipping**, and the fixed **"Signing in…"** button on a wrong password. |

`tests/fake-supabase.mjs` is the tiny PostgREST stand-in; the e2e test's in-memory Abacus map models `/get` and `/hit`; `tests/sql-split.mjs` splits a SQL script into statements without breaking `$tag$` function bodies.
