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

Everything lives in **one `index.html`**. There is no build step, no `npm`, no
database and no server to keep running. JavaScript, CSS and icons are all
inline, so the page works offline and on locked-down school networks.

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
| 2 | **Cloud settings → Access token**: create a GitHub *fine-grained personal access token* scoped to **only this repository** with the single permission **Contents: Read and write**, paste it and press **Save access token** (then **Test connection**). |
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
4. They use those details on the **Log in** tab from then on, and download
   whatever the teacher has published.

Students can be blocked, deleted or password-reset from the admin page at any
time; blocked accounts see a message asking them to speak to the teacher.

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

## 6. Counters

* **Visitor counter** (header + footer) — total visits, unique devices and
  today's visits, tracked per device with a 30-minute anti-refresh window.
* **Download counter** — a global total, a per-file counter on every card and
  in the admin file table, plus per-student download totals.

When an access token is saved, counters and student records are also written to
`data/cloud-data.json` and merged back on other devices, so the numbers reflect
the whole class rather than a single browser.

## 7. Where things are stored

| Data | Location |
| --- | --- |
| Uploaded files (published) | the GitHub repository, folder `resources/<Year level>/…` |
| Resource list | `library.json` in the repository |
| Counters, student register, logs | `data/cloud-data.json` in the repository **and** each browser's `localStorage` |
| Files uploaded without a token | the browser's IndexedDB (this device only) |
| Access token | `localStorage` (or this tab's `sessionStorage` if *Forget when the tab closes* is ticked) — never written into the HTML file |

### Honest security note

This is a static site: it has no server, so login is a convenience gate rather
than hard access control. Anyone who can view the repository can read the files
and the issued passwords. Use a **public** repository for the shared library,
keep the publishing token to the *Contents: Read and write* permission of that
one repository, and never commit personal or sensitive student information.

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Students can't see uploaded files | Save the access token and re-upload; check that the repository is public and that Pages is deployed. |
| "Cloud library could not be refreshed" | Check the repository name in Cloud settings; wait a minute after committing (raw GitHub caching); press **Try again**. |
| Token rejected (HTTP 401/403) | Create a new fine-grained token with **Contents: Read and write**, save it again. |
| File too large | Raise *Maximum upload size* in Cloud settings (keep files under ~95 MB; GitHub rejects files over 100 MB). |
| Wrong password after renaming | Use **Reset password** on the row — it restores the *username + year* rule. |
