# Mathematics Advanced — Subject Cloud

**powered by Petgabs**

A single-file website (`index.html`) that works as the Mathematics Advanced
subject cloud for one teacher and their classes:

* the **teacher uploads** mini apps (HTML), PDFs, Word documents, Excel
  workbooks, PowerPoint decks and other classroom files;
* **students register** with a first name and year level, are given a username
  and password, then **download** homework, classroom worksheets, practice
  questions and revision papers;
* the **admin dashboard** shows every registered student, their username and
  password, last visit time, how many times they visited and exactly which
  files they downloaded — plus visitor and per-file download counters.

The student-facing front end remains a single **`index.html`** with no frontend
build step; its JavaScript, CSS and icons are inline. The optional shared
download counter is a separately deployed Cloudflare Worker + D1 service in
`cloudflare/`. Without that service, the page still works, but counters and
registrations are browser-local.

**Important static-site limitation:** GitHub Pages cannot accept anonymous writes.
Registrations and visitor activity created in a browser remain local. Shared
student accounts and global visitor tracking still require a suitable backend.
The admin's GitHub token stays in that admin browser; never commit it or hide it
in the admin page—every visitor can download and inspect the page.

---

## 1. Publishing the site (once)

1. Create (or use) a GitHub repository, e.g. `Petgabs/MAdv`.
2. Upload **`index.html`** — that single file is the whole website.
3. Repository **Settings → Pages → Deploy from a branch → `main` / `root`**.
4. Share the Pages URL with students, e.g.
   `https://petgabs.github.io/MAdv/`.

The site detects its own repository from the Pages address, so students'
devices automatically find the shared library.

## 2. First run for the teacher

| Step | What to do |
| --- | --- |
| 1 | Open the site and click **Admin**. Sign in with **`peter82`** / **`petgabs82`** (change these in Cloud settings → *Administrator sign-in*). |
| 2 | **Cloud settings → Access token**: create a GitHub *fine-grained personal access token* scoped to **only this repository** with the single permission **Contents: Read and write**, paste it and press **Save access token** (then **Test connection**). The token stays in that admin browser only; never copy it into GitHub files or the shared page. |
| 3 | **Cloud settings → Cloud location**: check the repository (`owner/name`), branch, upload folder (`resources`) and data folder (`data`). Press **Detect this repository** if the box is empty. |
| 4 | **Upload Resource**: choose the file, give it a name, then set **Year level**, **Topic** and **Resource type**. Press **Upload resource**. |
| 5 | Repeat for every resource. The library, `library.json` and student downloads update instantly. |

Uploads are committed to the repository, so any device that opens the site can
download them. **Without an access token** the app still works, but files are
stored only in the browser that uploaded them and are marked *This device only*.

## 3. What students do

1. Click **Student Login** (also available in the header and footer).
2. Choose **Register**, type their **first name** and pick their **year level**.
3. The system issues and displays their credentials:
   * **Username** = the student's first name (a number is added if the name is taken: `peter`, `peter2`, …)
   * **Password** = username + year level number (`peter` + `Year 11` → `peter11`)
4. They can use those details on the **Log in** tab in the same browser.

**Registrations are device-local in this static version.** A student who registers
on one phone/browser will not be able to sign in from another device. The admin
cannot remotely pull that registration: only data already present in the
admin's token-bearing browser can be pushed to GitHub. Shared accounts require
a server-side API. Students can be blocked, deleted or password-reset from the
admin page on the browser that has the register; blocked accounts see a message
asking them to speak to the teacher.

## 4. Classifying resources

**Year level**: Year 9 · Year 10 · Year 11 · Year 12 (editable in Cloud settings).

**Resource type**: Homework · Classroom worksheet · Practice questions ·
Revision questions · Past paper / Trial exam · Notes & theory.

**Topics** cover the Mathematics Advanced course (Algebraic techniques,
Functions, Trigonometry, Radians, Differentiation, Integration, Exponential and
logarithmic functions, Sequences & series, Financial mathematics, Probability,
Statistical analysis, Bivariate data, the normal distribution, mixed revision)
plus a free-text **Other** option. Both lists are plain JavaScript arrays at the
top of the file (`TOPICS`, `CATEGORIES`, `DEFAULT_YEARS`) — add a line to add an
option everywhere.

## 5. Admin dashboard

* **Student register** — searchable, sortable table with username, password
  (masked behind *Hide / Show passwords*), registered date, last visit, visit
  count, download count and status; **Details** expands a row to show that
  student's full download history, visit record and issued credentials.
* **Row actions** — open a student profile, copy sign-in details, reset the
  password to the standard rule, block/unblock, delete the record.
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

## 6. Counters and cloud sync

* **Visitor counter** (header + footer) — remains browser-local, with a
  per-device 30-minute anti-refresh window.
* **Download counter** — records after the file is fetched and can be shared
  across browsers through the optional Cloudflare Worker + D1 service below.
  Without that service configured, it remains browser-local. Per-student
  totals and student histories remain local.
* The download API receives only a stable resource key and a one-time event ID.
  It does not receive student names, passwords, or the GitHub token. A limited
  offline queue retries downloads when connectivity returns. Public counters
  are approximate and may be abused by automated requests.
* The old GitHub analytics option is separate and opt-in; it writes student
  details and plaintext passwords to the public repository. Leave it disabled
  for real student information.

### Configure the shared download counter (Cloudflare)

1. Install Node.js and Wrangler, then authenticate with your Cloudflare account
   locally using `npx wrangler login` (do not paste credentials into chat).
2. From the repository root, run `cd cloudflare` and
   `npx wrangler d1 create madv-download-counter`. Copy the returned database
   ID into `wrangler.toml` in that directory, replacing
   `REPLACE_WITH_D1_DATABASE_ID`. If your Pages site uses a custom domain, also
   update `ALLOWED_ORIGIN` there to that site's origin.
3. Apply the schema and create a private rate-limit secret:
   `npx wrangler d1 migrations apply madv-download-counter --remote`, then
   `npx wrangler secret put RATE_LIMIT_SECRET` and enter a random secret of at
   least 32 characters when prompted. Keep it out of Git.
4. Deploy with `npx wrangler deploy`. The command prints a public
   `workers.dev` URL; the URL is not a secret.
5. Publish the front-end changes to GitHub Pages. Sign in as admin, open
   **Cloud settings → Shared download counter**, enter the Worker URL and press
   **Save endpoint to GitHub**. That saves only the URL in
   `data/download-counter.json`; the GitHub token stays in the admin browser.
6. Press **Test / refresh shared totals**. After configuration, every browser
   pulls the same D1 totals and submits a counter event after a successful file
   fetch. No GitHub token is sent to the Worker.

The Worker rate-limits by a temporary HMAC of Cloudflare's connecting IP and
cleans up rate-limit/event IDs; it does not store raw IP addresses. The D1
aggregate totals persist. Shared student registration and visitor counts still
need their own backend and are not provided by this download-only API.

## 7. Where things are stored

| Data | Location |
| --- | --- |
| Uploaded files (published) | The GitHub repository, folder `resources/<Year level>/…` |
| Resource list and fallback per-file totals | `library.json` in the repository |
| Shared download totals (when configured) | Cloudflare D1, written through the Worker; no GitHub token is involved |
| Public counter API URL | `data/download-counter.json` in the repository; URL only, no secrets |
| Local counters, student register, logs and pending download retries | Each browser's `localStorage` |
| Optional pushed counters, student register and logs | `data/cloud-data.json` in the repository; only the browser holding the admin token can write it |
| Files uploaded without a token | The uploading browser's IndexedDB (this device only) |
| Access token | Admin browser `localStorage` (or tab `sessionStorage` if *Forget when the tab closes* is ticked); never written to the HTML or repository |

### Security and privacy note

The current `Petgabs/MAdv` repository is **public**. Anyone can read
`data/cloud-data.json`. If cloud analytics is enabled, that file includes
student names, usernames, plaintext passwords, and activity logs. The setting
is off by default to avoid publishing student credentials; do not enable it for
real student information. The deterministic username-plus-year passwords are
not secure authentication.

This is a static site: its admin login is a convenience gate, not server-side
access control. A GitHub Contents: Read and write token can modify or delete
repository contents. Hiding a token in an admin screen, encrypting it in
client-side JavaScript, or saving it in a public repo does not protect it—all
site visitors can inspect downloaded code/data. Keep the token only in the
admin browser for publishing, or use a backend/serverless function that stores
the token as a server-side secret and authenticates writes. Do not commit
personal or sensitive student information to this public repository.

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Students can't see uploaded files | Check that the repository is public, Pages is deployed, and `library.json` lists the file. A token is needed only in the admin browser to publish it. |
| Student cannot log in from a second browser/device | Expected for this static version: registration is stored in the registering browser. Add a backend for shared accounts. |
| Downloads do not share across browsers | Deploy the Cloudflare Worker/D1 service, save its HTTPS URL in **Cloud settings → Shared download counter**, and check the Worker health endpoint. Visitor counts and student registrations remain local. |
| "Cloud library could not be refreshed" | Check the repository name in Cloud settings; wait a minute after committing (raw GitHub caching); press **Try again**. |
| Token rejected (HTTP 401/403) | Create a new fine-grained token with **Contents: Read and write**, save it again. |
| File too large | Raise *Maximum upload size* in Cloud settings (keep files under ~95 MB; GitHub rejects files over 100 MB). |
| Wrong password after renaming | Use **Reset password** on the row — it restores the *username + year* rule. |
