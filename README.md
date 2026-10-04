# Mathematics Advanced — Subject Cloud

**powered by Petgabs**

A single-file website (`index.html`) that works as the Mathematics Advanced
subject cloud for one teacher and their classes:

* the **teacher uploads** mini apps (HTML), PDFs, Word documents, Excel
  workbooks, PowerPoint decks and other classroom files;
* **students register** with a first name and year level, are given a username
  and password, then **download** homework, classroom worksheets, practice
  questions and revision papers from their own **My learning** page — the same
  account works on any device. Downloads are locked for anyone who is not
  signed in: an unregistered visitor who presses *Download* is told to register
  and log in first, and a signed-in student is taken to **My learning**;
* the **admin dashboard** shows every registered student, their username and
  password, last visit time, how many times they visited and exactly which
  files they downloaded — every download also increments that student's own
  shared **Abacus counter**, which the register and the student profile display;
* an hourly **GitHub Action** mirrors a password-free student roster and
  activity snapshot into `data/cloud-data.json`; live site-wide counters remain
  in Abacus.

The student-facing front end remains a single **`index.html`** with no frontend
build step; its JavaScript, CSS and icons are inline. Site-wide visitor and
published-file download totals are shared through the free **Abacus counter
API** automatically; no key, account or server setup is needed. Online student
registration and cross-device sign-in require the **Supabase** shared backend
(`backends/supabase/schema.sql`). If it is unavailable or not configured, the
site does not issue a device-only account and falsely report that registration
succeeded. The admin dashboard reads the shared roster live; a GitHub Action
also mirrors a password-free snapshot to the repository.

**Why a backend is needed at all.** GitHub Pages is static, so a browser can
never write to the repository on its own — that would mean shipping a GitHub
write token inside public code. Abacus only receives anonymous counter keys and
increments; it never sees student details or repository credentials. Supabase,
when configured, uses its **publishable** key, which is designed to be public
because Row Level Security blocks direct table access and only the `madv_*`
functions are exposed. The teacher's GitHub token stays in the teacher's
browser; never commit it or hide it in the page.

---

## 1. Publishing the site (once)

1. Create (or use) a GitHub repository, e.g. `Petgabs/MAdv`.
2. Upload **`index.html`** — that single file is the whole website.
3. Repository **Settings → Pages → Deploy from a branch → `main` / `root`**.
4. Share the Pages URL with students, e.g.
   `https://petgabs.github.io/MAdv/`.

The site detects its own repository from the Pages address, so students'
devices automatically find the shared library.

## 2. Required for online student registration (once, ~10 minutes)

Abacus already shares the visitor counter, total file downloads and per-file
download counts; it is active automatically and needs no settings. Set up the
Supabase shared register before opening student self-registration. A student
account is only confirmed after the database has issued and stored its unique
username and password. A disconnected or offline request is rejected rather
than creating an account that exists only on one device.

1. Create a free account at **supabase.com** and create one project (the free
   tier is plenty for a class).
2. Open **SQL Editor → New query**, paste the whole of
   **`backends/supabase/schema.sql`** and press **Run**. It creates the tables,
   the `madv_*` functions, the Row Level Security rules and the grants.
3. Go to **Project Settings → API keys** and copy:
   * the **Project URL** (`https://abcdefghijklmnop.supabase.co`),
   * the **publishable key** (`sb_publishable_…`, or the legacy `anon` JWT).
4. On the site, sign in as **Admin** (`peter82` / `petgabs82`) and open
   **Cloud settings → Shared student register**. Paste the URL and key and press
   **Save to GitHub**. That writes them to `data/sync-config.json` in the
   repository, so every device picks the backend up automatically.
5. Press **Test connection** — it should report how many students are
   registered. Then press **Sync now**.

**Use the publishable key only.** A secret key (`sb_secret_…` / `service_role`)
bypasses Row Level Security and must never be pasted into the page, the
repository or the workflow. The page refuses to save one.

> The free Supabase project may pause after a period with no traffic and wake
> on the next request. While it is unavailable, registration does not show as
> complete or issue credentials; retrying the same name and year safely resumes
> the request. Some activity events can be queued locally. Abacus
> visitor/download counters work separately and do not depend on Supabase.

### How a registration reaches the repository

```
student's phone ──▶ Supabase (required for online accounts; publishable key + Row Level Security)
                         │ madv_register / madv_login / student activity log
                         ▼
             .github/workflows/cloud-sync.yml (hourly, GitHub-hosted)
                         ▼
             data/cloud-data.json ──▶ admin roster mirror

all visitors ──▶ Abacus (anonymous /get and /hit requests)
                         └──▶ shared visits + total downloads + per-file totals
```

1. The student registers. The browser calls `madv_register`; the database
   issues the username and password, so two students with the same first name
   can never collide.
2. Hourly, the GitHub Action calls `madv_admin_export` and commits the register
   and an activity snapshot to `data/cloud-data.json`. Passwords are never
   written.
3. The administrator dashboard reads the live student register from Supabase
   when it opens, when it returns to focus and when **Refresh live data** is
   pressed. The GitHub file is a backup/public mirror, not the live source of
   truth. Site-wide counters are read directly from Abacus.

If you change the administrator sign-in on the site, add matching
**Settings → Secrets and variables → Actions** secrets named `ADMIN_USER` and
`ADMIN_PASS` (or repository variables) so the workflow can still read the
register. Enable **Settings → Actions → General → Workflow permissions → Read
and write** so the job can commit.

## 3. First run for the teacher

| Step | What to do |
| --- | --- |
| 1 | Open the site and click **Admin**. Sign in with **`peter82`** / **`petgabs82`** (change these in Cloud settings → *Administrator sign-in*). |
| 2 | **Cloud settings → Access token**: create a GitHub *fine-grained personal access token* scoped to **only this repository** with the single permission **Contents: Read and write**, paste it and press **Save access token** (then **Test connection**). The token stays in that admin browser only; never copy it into GitHub files or the shared page. |
| 3 | **Cloud settings → Cloud location**: check the repository (`owner/name`), branch, upload folder (`resources`) and data folder (`data`). Press **Detect this repository** if the box is empty. |
| 4 | **Required for student registration**: in **Cloud settings → Shared student register**, paste the Supabase URL and publishable key from section 2, press **Save to GitHub**, then **Test connection**. Student registration stays disabled until the shared backend is available. Abacus counters need no setup. |
| 5 | **Upload Resource**: choose the file, give it a name, then set **Year level**, **Topic** and **Resource type**. Press **Upload resource**. |
| 6 | Repeat for every resource. The library, `library.json` and student downloads update instantly. |

Uploads are committed to the repository, so any device that opens the site can
download them. **Without an access token** the app still works, but files are
stored only in the browser that uploaded them and are marked *This device only*.

## 4. What students do

1. Click **Student Login** (also available in the header and footer).
2. Choose **Register**, type their **first name** and pick their **year level**.
3. The system issues and displays their credentials:
   * **Username** = the student's first name (a number is added if the name is taken: `peter`, `peter2`, …)
   * **Password** = username + year level number (`peter` + `Year 11` → `peter11`)
4. They can use those details on the **Log in** tab — on this device or any
   other, because the register is shared.
5. **Downloading needs the account.** If a visitor who is not signed in presses
   **Download**, the site does not fetch the file: it explains that they must
   register and log in to their own account first, with buttons for *Register
   now* and *I already have an account*. Downloads themselves happen on the
   student's **My learning** page — a signed-in student who presses Download in
   the library is offered *Go to My learning and download*, which opens that
   page and starts the download. **My learning** lists the student's year-level
   files plus every other resource on the cloud, so other year levels stay
   reachable.
6. Every download is recorded for the teacher (student, file and time), added to
   the student's own Abacus download counter — and to a counter for that student
   and that exact file — and listed in the admin register and student profile.

Students can be blocked, deleted or password-reset from the admin page;
blocked accounts are refused everywhere as soon as the change syncs. A
registration attempted while offline or while the shared backend is unavailable
is not completed: no credentials or local-only account are issued, and the
student can retry when the connection returns. This prevents a false success
message and avoids an account that is missing from the online admin roster.

## 5. Classifying resources

**Year level**: Year 9 · Year 10 · Year 11 · Year 12 (editable in Cloud settings).

**Resource type**: Homework · Classroom worksheet · Practice questions ·
Revision questions · Past paper / Trial exam · Notes & theory.

**Topics** cover the Mathematics Advanced course (Algebraic techniques,
Functions, Trigonometry, Radians, Differentiation, Integration, Exponential and
logarithmic functions, Sequences & series, Financial mathematics, Probability,
Statistical analysis, Bivariate data, the normal distribution, mixed revision)
plus a free-text **Other** option. Both lists are plain JavaScript arrays at
the top of the file (`TOPICS`, `CATEGORIES`, `DEFAULT_YEARS`) — add a line to
add an option everywhere.

## 6. Admin dashboard

* **Student register & monitoring** — searchable, sortable table with username,
  password (masked behind *Hide / Show passwords*), registered date, last visit,
  visit count, download count **and each student's Abacus download counter**,
  and status; **Details** expands a row to show the files that student
  downloaded (with a count per file), their visit record, Abacus counter and
  issued credentials. The panel's **Abacus counters** button reads every listed
  student's counter from Abacus (one request at a time) and reports how many
  were read.
* **Student profile** — the full record for one student: issued credentials,
  visits, downloads recorded, their **Abacus counter**, the last download, and
  a table of **every file they downloaded** — file, type/topic, how many times,
  when last, and the Abacus counter for that student and that exact file.
  **Refresh Abacus counters** re-reads the live values.
* **Row actions** — open a student profile, copy sign-in details, reset the
  password to the standard rule, block/unblock, delete the record. Blocking,
  unblocking, password resets and deletions are written to the shared register
  straight away, so they apply on every device.
* **Live activity** — recent sign-ins (including failed attempts) and a
  filterable download log showing who downloaded what, when.
* **Engagement analytics** — 14-day visit sparkline, plus downloads broken down
  by year level, resource type and topic, and a top-downloads ranking.
* **File management** — every uploaded file with its download counter, last
  download time, publishing status, and actions to edit details, copy the
  public link, hide/show or delete (deleting also removes it from GitHub).
* **Reporting** — export the student register, download log, login log and file
  list as CSV; download or restore a full JSON backup; print a monitoring
  report; reset local daily charts; clear logs; wipe this device. Shared Abacus
  totals are read-only from the public page.

## 7. Counters and cloud sync

* **Visitor counter** (header + footer) — shared through the [Abacus counter API](https://v2.jasoncameron.dev/abacus/). The site counts
  at most one visit per browser/device every 30 minutes; reloading immediately
  does not add another hit. Abacus stores the shared all-time total.
* **Download counter** — shared through Abacus after a published file has been
  fetched successfully. The header shows all downloads; each published resource
  has its own counter. Files stored only on the uploading device are never sent
  to Abacus.
* **Per-student download counters** — every successful student download also
  increments two anonymous counters: one for the student (derived from the
  shared username, so every device reads the same number) and one for that
  student and that exact file. The admin register shows each student's counter
  beside their download count, and the student profile reads the per-file
  counters on demand. The keys are hashes: Abacus never receives a name, a
  username or a filename. Students also see their own counter on **My
  learning**.
* **Stable file keys** — the counter key is derived from the repository path
  (or a stable resource id when there is no path). It is hashed into a short,
  URL-safe key; display titles and student details are not sent. Moving a file
  to a new path starts a new per-file counter.
* **Offline and rate limits** — a visit/download made while the browser already
  knows it is offline is queued locally and sent once when the connection
  returns. Hits in one tab are spaced out to avoid bursts. Abacus HTTP 429
  rate-limit rejections are retried using `Retry-After` (and safely re-queued if
  the limit persists); a timeout or dropped connection is not retried because
  Abacus may already have counted it. The admin dashboard shows queued changes
  and connection status.
* **Detailed and daily analytics** — Abacus stores only integer totals; it has
  no timestamps, device identities or event log. Supabase, when configured,
  separately keeps student activity and daily analytics. Without Supabase,
  detailed logs and charts remain local to each browser.
* **Privacy and accuracy** — Abacus receives only this site's namespace and a
  counter key. Its public `/hit` endpoint can be called by anyone and is rate
  limited, so totals are approximate and should not be used as security or
  billing data. Supabase, when configured, separately keeps detailed student
  activity for the teacher.

## 8. Where things are stored

| Data | Location |
| --- | --- |
| Uploaded files (published) | The GitHub repository, folder `resources/<Year level>/…` |
| Resource list and cached per-file totals | `library.json` in the repository; live per-file totals are read from Abacus |
| Shared site-wide visitor/download totals, and the per-student and per-student-file download counters | Abacus counter API (`petgabs-github-io-madv` namespace; no key required — keys are hashes, never names or filenames) |
| Live student register and detailed activity | Supabase (`madv_students`, `madv_visits`, `madv_downloads`, etc.) — required for online self-registration and cross-device sign-in; passwords stay here, never in GitHub's public mirror |
| Supabase address (URL + publishable key, both public) | `data/sync-config.json` in the repository, and cached in each browser |
| Repository mirror of the register and activity snapshot | `data/cloud-data.json` — names, usernames and counts, **no passwords**; not authoritative for Abacus totals |
| Local working copy: students, logs, cached counters, settings, offline queues | Each browser's `localStorage` |
| Student sign-in session | Each browser's `localStorage` (remembered between lessons) |
| **Administrator sign-in session** | Tab `sessionStorage` only — closing the tab ends admin access |
| Files uploaded without a token | The uploading browser's IndexedDB (this device only) |
| Downloaded files, cached for 10 minutes | The browser's IndexedDB (`madv-files` → `cache`), ~120 MB oldest-first cap |
| Sign-in lockout counter and diagnostics | Each browser's `localStorage` (this device only) |
| Access token | Admin browser `localStorage` (or tab `sessionStorage` if *Forget when the tab closes* is ticked); never written to the HTML or repository |

### Hardening for classroom load

The site is built for a whole class arriving at once — thirty sign-ins at 9:00,
thirty clicks on the same past paper, thirty tabs reconnecting after the Wi-Fi
drops.

**Sign-in protection**

* **Brute-force lockout.** Five failed sign-ins (student *or* administrator)
  pause sign-in on that device for 60 seconds. Each further group of five
  doubles the pause — 2, 4, 8 minutes — up to a 15 minute ceiling. Any
  successful sign-in clears the history. The pause is per device, so one
  student guessing cannot lock the class out.
* **Admin inactivity sign-out.** The admin area signs itself out after a
  period of inactivity — 60 minutes by default, set anywhere from 1 to 480
  minutes, or **0 to never**, in *Cloud settings → Behaviour & defaults*.
* **Admin sessions are tab-scoped.** An admin session is no longer written to
  `localStorage`; closing the tab (or leaving the laptop overnight) ends it.
  Student sessions are still remembered between lessons.
* **Content-Security-Policy.** A host allowlist with `object-src`, `base-uri`,
  `worker-src` and `form-action` all set to `'none'`.

**Speed and stability under load**

* **Login retry with jittered backoff.** A transient backend failure (a rate
  limit at 9:00, a timeout, a dropped connection) is retried once
  automatically, after a randomised delay so thirty devices do not land on the
  same second. A real refusal — wrong password, blocked account — is never
  retried.
* **Downloads** have a 30 second timeout and one retry, run at most **three at
  a time per device** with the rest queued in order, and concurrent clicks on
  the *same* file share a single fetch.
* **Durable download cache.** Files are cached for 10 minutes in memory and in
  IndexedDB (oldest-first eviction past roughly 120 MB), so a class downloading
  the same paper gets it instantly and keeps working if the file host slows
  down. The cache key carries the file's revision, so a replaced file is never
  served stale.
* **Backend friendliness.** The offline event queue stops draining after a
  transient failure and cools down — 30 seconds, doubling to 5 minutes, with
  jitter — instead of hammering Supabase when thirty devices reconnect at
  once. Nothing is discarded: events stay durably queued.

**Crash resistance**

* **Global error shield.** Script errors and unhandled promise rejections are
  caught; the page keeps working and the event is recorded in *Cloud settings →
  **Diagnostics*** (last 25, with a one-click clear).
* Every button action and every renderer runs in isolation, so one broken piece
  can never blank the page.
* Toast notifications are flood controlled (repeats collapse into a counter,
  the stack is capped) and a hidden tab skips re-rendering while its data keeps
  refreshing.

### Security and privacy note

The current `Petgabs/MAdv` repository is **public**. Anyone can read
`data/cloud-data.json`. By default it holds student **first names, usernames
and activity counts**; it never holds passwords. Turn off *Let the repository
mirror keep student names and usernames* in Cloud settings → **Shared cloud
sync** to publish counters only.

* Passwords follow the deterministic username-plus-year pattern. This is a
  convenience gate, not private authentication: the rule is visible in the
  public website code, and anyone who can read a mirrored username/year can
  derive the password. The snapshot omits the password field, but this pattern
  should not be treated as a secret. Turn off the repository roster mirror if
  publishing student names and usernames is not acceptable; do not use these
  accounts to protect sensitive material.
* The shared backend is protected by Row Level Security: the direct tables have
  no policies and their privileges are revoked, so the publishable key can only
  call the `madv_*` functions, which validate their input.
* The administrator sign-in (`peter82` / `petgabs82` by default) is a
  convenience gate on the static page, not server-side access control, and it
  also gates `madv_admin_export`. Change it in Cloud settings and store the new
  values as `ADMIN_USER` / `ADMIN_PASS` secrets for the workflow.
* A GitHub **Contents: Read and write** token can modify or delete repository
  contents. Keep it only in the admin browser for publishing. Do not commit
  personal or sensitive student information to this public repository.

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| A visitor says the Download button does nothing | That is the policy: downloads need a student account. Pressing **Download** explains how to register or log in, and the file is taken from **My learning**. |
| The Abacus counter for a student reads 0 | The shared counter only moves after a signed-in student downloads from **My learning** on a device that can reach Abacus. Press **Abacus counters** in the register panel to re-read it. |
| Students can't see uploaded files | Check that the repository is public, Pages is deployed, and `library.json` lists the file. A token is needed only in the admin browser to publish it. |
| Student cannot log in from a second device | Check **Cloud settings → Shared student register → Test connection**. Online registration is only confirmed after the shared backend accepts it; the admin dashboard refreshes the live roster when opened and on return to focus. |
| Online registration is not ready | Configure the Supabase URL and publishable key in **Cloud settings → Shared student register**, then run `backends/supabase/schema.sql`. Registration is intentionally not completed on a single browser when this backend is unavailable. |
| "Please use letters only for the first name" for an ordinary name | Fixed in this version: the name check used to reject almost every real name. Reload the page to pick up the new `index.html`. |
| Abacus counters do not move | Check the Abacus status in the admin dashboard and make sure the browser can reach the Abacus API at `https://abacus.jasoncameron.dev` (the linked v2 page is documentation). HTTP 429 rate-limit responses are retried and queued; cached/local counts remain visible while Abacus recovers. Supabase **Sync now** refreshes student activity, not the Abacus totals. |
| The repository mirror is empty or stale | Run the **Mirror the shared register** workflow manually (Actions → Run workflow) and check that `ADMIN_USER` / `ADMIN_PASS` match the site's administrator sign-in. |
| Token rejected (HTTP 401/403) | Create a new fine-grained token with **Contents: Read and write**, save it again. |
| File too large | The maximum upload is **50 MB per file** (adjustable down to 1 MB in *Cloud settings → Maximum upload size*). Compress the file, split it, or bundle several files into a ZIP. |
| Wrong password after renaming | Use **Reset password** on the row — it restores the *username + year* rule. |
| "Too many failed sign-in attempts" | The device paused sign-in after five wrong passwords. Wait for the stated time; any successful sign-in clears it. It is per device, not per account. |
| The admin area signed itself out | That is the inactivity timeout (60 minutes by default). Change it, or set it to 0 for never, in *Cloud settings → Behaviour & defaults*. Admin sessions also end when the tab is closed. |
| Something on the page misbehaved | Open *Cloud settings → **Diagnostics***. Script errors and failed background tasks are recorded there instead of breaking the page. |
| A download is slow with the whole class clicking | Downloads are capped at three at a time per device and cached for 10 minutes, so later clicks on the same file are instant. Wait for the queue rather than reloading. |

## 10. For developers

```bash
npm install     # PGlite (PostgreSQL in WASM) + jsdom, test-only
npm test        # SQL/backend tests + end-to-end browser and exporter tests
npm run sync:cloud-data   # write data/cloud-data.json from the shared backend now
```

See `tests/README.md` for what each suite covers. `scripts/export-cloud-data.mjs`
is the same script the hourly workflow runs; it has no dependencies and can be
pointed at any project with `--config` / `--out`.
