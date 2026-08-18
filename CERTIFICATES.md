# Certificate Issuance System

Self-service completion certificates for graduates of the **July 2026** body
language course (`קורס שפת גוף  יולי 2026`).

A graduate opens a link (typically sent by WhatsApp), enters their full name and
Israeli ID number, and — if they are verified against Airtable as a paid
participant of that cohort — receives a personalised PDF certificate generated
from the original designed template.

- **Page:** `https://maayanbashan.co.il/certificate`
- **API:** `POST /api/certificate`

---

## ⚠️ Required before this can work in production

**The `ID` column in Airtable is currently empty for every record.**

At the time of building, all 92 paid July 2026 participants had a populated name
but **no ID number stored**. ID verification therefore cannot match anyone, and
every request will correctly return the generic failure message.

Choose one of these before launch:

1. **Populate the `ID` field** in the `לידים פרטי` table for the July 2026
   cohort. Nothing else needs changing — this is the intended, secure setup.
2. **Temporarily fall back to name-only verification** by setting
   `CERT_REQUIRE_ID=false`.
   This is materially less secure: anyone who knows a participant's name can
   download that participant's certificate. Only use it as a stopgap.

Everything else is complete and tested.

---

## How it works

```
Browser  ──POST {name, idNumber}──►  /api/certificate  (Netlify Function)
                                          │
                                          ├─ rate limit by IP
                                          ├─ normalize name + ID
                                          ├─ query Airtable (July 2026 + paid)
                                          ├─ match name + ID in memory
                                          ├─ load template PDF + Hebrew font
                                          ├─ stamp name + ID into the design
                                          ▼
Browser  ◄──── application/pdf ────────────┘
```

The browser never talks to Airtable and never receives any Airtable data —
only a PDF on success, or a generic error code on failure.

## Eligibility

A certificate is issued only when **all** of the following hold:

| Condition | Source |
|---|---|
| Name matches (normalized) | `שם` field |
| ID matches (normalized) | `ID` field |
| Course = July 2026 | linked record `recKv98sOFZmx3cOT` in `מוצרים` |
| Status = paid | `סטטוס` = `שילם` |

The course and status filters are applied by Airtable via `filterByFormula`; the
name and ID are compared server-side after normalization, because the stored data
contains names with stray whitespace and mixed casing that a raw formula match
would miss.

Ambiguity is treated as failure: if two eligible records share a normalized name,
no certificate is issued rather than guessing.

## Environment variables

Copy `.env.example` to `.env` for local work; set the same values in
**Netlify → Site configuration → Environment variables** for production.

| Variable | Purpose |
|---|---|
| `AIRTABLE_PAT` | **Required.** PAT with `data.records:read` on the CRM base |
| `AIRTABLE_BASE_ID` | Defaults to the Maayan Bashan CRM base |
| `AIRTABLE_TABLE_NAME` | Table ID for `לידים פרטי` |
| `AIRTABLE_NAME_FIELD` | Field ID of the name column |
| `AIRTABLE_ID_FIELD` | Field ID of the ID column |
| `AIRTABLE_STATUS_FIELD` | Field ID of the status column |
| `AIRTABLE_COURSE_FIELD` | Field ID of the linked-course column |
| `TARGET_COURSE_RECORD_ID` | Record ID of the target cohort |
| `PAID_STATUS` | Status value meaning paid (`שילם`) |
| `CERT_REQUIRE_ID` | `true` (default) requires the ID to match |
| `CERT_RATE_LIMIT` | Requests per window per IP (default 10) |
| `CERT_RATE_WINDOW_MS` | Window length in ms (default 600000) |
| `CERT_NAME_*` / `CERT_ID_*` | Optional PDF coordinate overrides |

**Field IDs, not names.** Airtable column names in this base are Hebrew;
renaming a column in the UI would silently break name-based lookups, so field
IDs are used instead. To find them, open the base's API documentation.

### Changing the cohort

To reuse this for a future course, change one value:

```env
TARGET_COURSE_RECORD_ID=rec...   # the new course's record ID in "קורסים"
```

Note the certificate template itself has the course name and date baked into the
design, so a new cohort also needs an updated `templates/certificate-template.pdf`.

## Assets

| File | Purpose |
|---|---|
| `templates/certificate-template.pdf` | The original designed certificate (A4 portrait, 595.92 × 841.92 pt) |
| `templates/assistant-regular.ttf` | Hebrew font for the ID number |
| `templates/assistant-semibold.ttf` | Hebrew font for the name |

These live **outside** `public/`, so they are never served to browsers. They are
bundled into the function via `included_files` in `netlify.toml`.

The fonts are [Assistant](https://fonts.google.com/specimen/Assistant)
(SIL Open Font License) — the same family the website already uses.

## PDF coordinates

The template already reserves both slots, and the defaults were measured from
it directly:

| Slot | Position | Size | Colour |
|---|---|---|---|
| Name | centred at x=297.96, baseline y=497.67 | 27pt, shrinks to fit 259pt | `#f5f0e6` |
| ID | centred at x=261.2, baseline y=454.17 | 9.9pt | `#f5f0e6` |

Coordinates are PDF points with the origin at the **bottom-left** (pdf-lib
convention). The colour and 27pt size were taken from the empty placeholder the
designer left on the name line.

Long names shrink automatically (down to 14pt) so they stay inside the gold rule
instead of overflowing. To adjust placement without touching code, set the
`CERT_NAME_*` / `CERT_ID_*` variables listed in `.env.example`.

## Hebrew and RTL in the PDF

`pdf-lib` draws glyphs in the order given and performs no bidi reordering, so
text must be converted to visual order first. Simply reversing the string is
**not** correct — it corrupts embedded Latin words and digits, and the live data
contains both (`Yaffa Adler`, `אילנה מסר 7`).

`netlify/functions/lib/text.mjs` implements a reduced Unicode Bidi Algorithm:
it segments the string into directional runs, reverses the run order for an RTL
paragraph, and reverses characters only inside RTL runs. Latin and numeric runs
keep their natural direction.

```
'ישראל ישראלי'  → 'ילארשי לארשי'   (pure Hebrew: reversed)
'דוד Cohen'     → 'Cohen דוד'      (Latin stays forwards)
'Yaffa Adler'   → 'Yaffa Adler'    (LTR paragraph: untouched)
```

Fonts are embedded subset-only, keeping generated files at ~67KB.

## Running locally

```bash
npm install
npm run dev          # UI only, at http://localhost:4321/certificate
```

`npm run dev` serves the page but **not** the API (Astro's dev server does not
run Netlify Functions). For the full flow:

```bash
npm install -g netlify-cli
netlify dev          # serves the page and /api/certificate together
```

`netlify dev` needs `AIRTABLE_PAT` in your `.env`.

## Tests

```bash
npm test
```

38 tests covering: successful verification, wrong ID, wrong name, unpaid/other
cohort, leading-zero IDs, multi-space names, long Hebrew names, mixed
Hebrew/Latin bidi, empty stored IDs, duplicate names, Airtable outage, missing
credentials, rate-limit thresholds and windows, filename safety and header
injection, and PDF generation.

## Generating a test certificate

Without touching Airtable:

```bash
npm run test:certificate
npm run test:certificate -- "יעל סאקסטין יונה" 012345678
```

Output goes to `scripts/output/` (gitignored). Open the PDF to check placement.

Structural verification across a range of realistic names:

```bash
npm run verify:certificate
```

This checks glyph coverage, width limits, auto-shrink, centring and ID integrity
without needing any external PDF tooling.

## Deployment

The system deploys with the site — no separate service.

1. Set `AIRTABLE_PAT` in Netlify environment variables.
2. Push to `main`; Netlify builds and deploys the function automatically.
3. Confirm `https://maayanbashan.co.il/certificate` loads.
4. Distribute that URL by WhatsApp.

`netlify.toml` already bundles `templates/**` into the function.

## Security notes

- Airtable credentials are server-side only and never appear in the client bundle.
- The API returns only a PDF or a generic error code — never Airtable records,
  stored names, stored IDs, payment status, or internal record IDs.
- All failure modes (unknown name, wrong ID, unpaid, wrong cohort) return the
  identical `INVALID_DETAILS` response, so the endpoint cannot be used to probe
  who is enrolled or who has paid.
- ID numbers and names are never logged. Logs contain only timestamp, outcome,
  a random request ID, error category, and duration.
- The page is `noindex, nofollow` and excluded from the sitemap.
- Personal data is sent by POST, never in a URL.
- Certificates are generated in memory and never stored on the server.
- Download filenames are ASCII-only and cannot inject headers; the ID never
  appears in a filename.

### Known limitation: rate limiting

Rate limiting is in-memory and therefore **per serverless instance**. An attacker
spreading requests across cold starts gets a higher effective limit than the
configured one. This was a deliberate trade-off: adding a shared store (Redis /
Upstash) for a page used by ~90 people is more infrastructure than the problem
warrants, and the in-memory limiter still removes practical brute-forcing from a
single client. If stronger guarantees are needed, replace
`netlify/functions/lib/rate-limit.mjs` — the interface is a single function.
