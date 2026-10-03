# Mathematics Advanced — Subject Cloud

**powered by Petgabs**

A single-file website (`index.html`) that works as the Mathematics Advanced
subject cloud for one teacher and their classes:

* the **teacher uploads** mini apps (HTML), PDFs, Word documents, Excel
  workbooks, PowerPoint decks and other classroom files;
* **students register** with a first name and year level, are given a username
  and password, then **download** homework, classroom worksheets, practice
  questions and revision papers — the same account works on any device;
* the **admin dashboard** shows every registered student, their username and
  password, last visit time, how many times they visited and exactly which
  files they downloaded — plus shared visitor and per-file download counters;
* a **GitHub Action** mirrors the shared register into
  `data/cloud-data.json`, so the repository itself always holds the class list
  and the totals.

The student-facing front end remains a single **`index.html`** with no frontend
build step; its JavaScript, CSS and icons are inline. Registrations, sign-ins
and the counters are shared through a free **Supabase** project (no Cloudflare,
no server to run) whose schema lives in `backends/supabase/schema.sql`. Without
that project the page still works, but registrations and counters are
browser-local.

**Why a backend is needed at all.** GitHub Pages is static, so a browser can
never write to the repository on its own — that would mean shipping a GitHub
write token inside public code. Instead every device talks to the Supabase
project using its **publishable** key, which is designed to be public because
Row Level Security blocks every direct table read and write and only the
`madv_*` functions are exposed. The teacher's GitHub token stays in the
teacher's browser; never commit it or hide it in the page.

---

## 1. Publishing the site (once)

1. Create (or use) a GitHub repository, e.g. `Petgabs/MAdv`.
2. Upload **`index.html`** — that single file is the whole website.
3. Repository **Settings → Pages → Deploy from a branch → `main` / `root`**.
4. Share the Pages URL with students, e.g.
   `https://petgabs.github.io/MAdv/`.

The site detects its own repository from the Pages address, so students'
devices automatically find the shared library.

## 2. Setting up the shared backend (once, ~10 minutes)

Do this to make registration, sign-in, the visitor counter and the download
counter shared across every device.

1. Create a free account at **supabase.com** and create one project (the free
   tier is plenty for a class).
2. Open **SQL Editor → New query**, paste the whole of
   **`backends/supabase/schema.sql`** and press **Run**. It creates the tables,
   the `madv_*` functions, the Row Level Security rules and the grants.
3. Go to **Project Settings → API keys** and copy:
   * the **Project URL** (`https://abcdefghijklmnop.supabase.co`),
   * the **publishable key** (`sb_publishable_…`, or the legacy `anon` JWT).
4. On the site, sign in as **Admin** (`peter82` / `petgabs82`) and open
   **Cloud settings → Shared cloud sync**. Paste the URL and the key and press
   **Save to GitHub**. That writes them to `data/sync-config.json` in the
   repository, so every device picks the backend up automatically.
5. Press **Test connection** — it should report how many students are
   registered. Then press **Sync now**.

**Use the publishable key only.** A secret key (`sb_secret_…` / `service_role`)
bypasses Row Level Security and must never be pasted into the page, the
repository or the workflow. The page refuses to save one.

> The free Supabase project pauses after about a week with no traffic and wakes
> up again on the next request. While it is paused the site keeps working and
> queues registrations, visits and downloads, then syncs them automatically.

### How a registration reaches the repository

```
student's phone  ──▶  Supabase (publishable key + Row Level Security)
                              │  madv_register / madv_login / madv_visit / madv_download
                              ▼
                 .github/workflows/cloud-sync.yml   (hourly, GitHub-hosted)
                              ▼
                 data/cloud-data.json  ──▶  every device reads it
```

1. The student registers. The browser calls `madv_register`; the database
   issues the username and password, so two students with the same first name
   can never collide.
2. Hourly, the GitHub Action calls `madv_admin_export` and commits the register
   and the counters to `data/cloud-data.json`. Passwords are never written.
3. Any browser loads the page, reads the counters and, for the admin, pulls the
   register into the dashboard.

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
| 4 | **Cloud settings → Shared cloud sync**: paste the Supabase URL and publishable key from section 2, press **Save to GitHub**, then **Test connection**. |
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

Students can be blocked, deleted or password-reset from the admin page;
blocked accounts are refused everywhere as soon as the change syncs. If a
device is offline when a student registers, the account is saved locally and
pushed to the shared register as soon as the connection returns.

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

* **Student register** — searchable, sortable table with username, password
  (masked behind *Hide / Show passwords*), registered date, last visit, visit
  count, download count and status; **Details** expands a row to show that
  student's full download history, visit record and issued credentials.
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
  report; reset counters; clear logs; wipe this device.

## 7. Counters and cloud sync

* **Visitor counter** (header + footer) — shared. One visit is counted per
  device (and per student on a shared device) every 30 minutes, both in the
  browser and again in the database, so refreshing the page does not inflate
  it.
* **Download counter** — shared, counted after the file is fetched
  successfully. Each event carries a one-time id, so retries and double clicks
  never double count. Per-file totals are mirrored onto every resource row.
* **Offline** — every registration, visit and download that cannot be sent is
  queued in the browser and flushed automatically on the next page load or when
  the connection returns. The admin dashboard shows how many changes are
  waiting.
* The backend receives only a device id, a resource key, event ids and (when a
  student is signed in) their first name and year level. It never receives the
  GitHub token.
* Public counters are approximate: anyone can call a public endpoint, and the
  schema caps each day at 5 000 visits and 5 000 downloads
  (`max_visits_per_day` / `max_downloads_per_day` in `madv_config`).

## 8. Where things are stored

| Data | Location |
| --- | --- |
| Uploaded files (published) | The GitHub repository, folder `resources/<Year level>/…` |
| Resource list and fallback per-file totals | `library.json` in the repository |
| Student register, visits, downloads, counters | Supabase (`madv_students`, `madv_visits`, `madv_downloads`, `madv_counters`, `madv_daily`, `madv_file_totals`) — passwords included, needed to verify sign-in |
| Backend address (URL + publishable key, both public) | `data/sync-config.json` in the repository, and cached in each browser |
| Repository mirror of the register and counters | `data/cloud-data.json` — names, usernames and counts, **no passwords** |
| Local working copy: students, logs, counters, settings, offline queue | Each browser's `localStorage` |
| Files uploaded without a token | The uploading browser's IndexedDB (this device only) |
| Access token | Admin browser `localStorage` (or tab `sessionStorage` if *Forget when the tab closes* is ticked); never written to the HTML or repository |

### Security and privacy note

The current `Petgabs/MAdv` repository is **public**. Anyone can read
`data/cloud-data.json`. By default it holds student **first names, usernames
and activity counts**; it never holds passwords. Turn off *Let the repository
mirror keep student names and usernames* in Cloud settings → **Shared cloud
sync** to publish counters only.

* Passwords are the deterministic username-plus-year pattern, which is a
  convenience gate, not real authentication. They are compared inside the
  database (`madv_login`), so the roster is not downloadable and a wrong
  password cannot be matched against a leaked copy.
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
| Students can't see uploaded files | Check that the repository is public, Pages is deployed, and `library.json` lists the file. A token is needed only in the admin browser to publish it. |
| Student cannot log in from a second device | The shared backend is not connected (or was unreachable when the student registered). Check **Cloud settings → Shared cloud sync → Test connection**; the admin dashboard shows any pending changes. |
| "Please use letters only for the first name" for an ordinary name | Fixed in this version: the name check used to reject almost every real name. Reload the page to pick up the new `index.html`. |
| Registration says it was saved on this device | The backend was unreachable. The account is queued and syncs by itself; press **Sync now** once the connection is back. |
| Counters do not move | Press **Sync now**. If it reports HTTP 5xx, the free Supabase project is paused — open the Supabase dashboard once to wake it. |
| The repository mirror is empty or stale | Run the **Mirror the shared register** workflow manually (Actions → Run workflow) and check that `ADMIN_USER` / `ADMIN_PASS` match the site's administrator sign-in. |
| Token rejected (HTTP 401/403) | Create a new fine-grained token with **Contents: Read and write**, save it again. |
| File too large | Raise *Maximum upload size* in Cloud settings (keep files under ~95 MB; GitHub rejects files over 100 MB). |
| Wrong password after renaming | Use **Reset password** on the row — it restores the *username + year* rule. |

## 10. For developers

```bash
npm install     # PGlite (PostgreSQL in WASM) + jsdom, test-only
npm test        # 55 SQL/backend checks + 36 end-to-end browser checks
npm run sync:cloud-data   # write data/cloud-data.json from the shared backend now
```

See `tests/README.md` for what each suite covers. `scripts/export-cloud-data.mjs`
is the same script the hourly workflow runs; it has no dependencies and can be
pointed at any project with `--config` / `--out`.
