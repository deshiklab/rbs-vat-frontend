# DiziVAT — VAT management system (Sprints 1–4 + R2–R4 + Knowledge base + R5 backend + R6 enlistment & RMG + R6.2 + R6.3 + R6.4 + R6.5 + R6.6)

> **Branch `r5-nestjs`:** the same app on a real backend: **NestJS 11 + PostgreSQL** (Drizzle ORM), deployable to
> **Render + Neon**. See [docs/BACKEND.md](docs/BACKEND.md).
> **CI/CD:** every push to `r5-nestjs` that passes the full PostgreSQL suite, the Docker smoke test and CI is deployed to Render
> automatically, verified by commit and smoke-tested live ([docs/BACKEND.md › Continuous deployment](docs/BACKEND.md#continuous-deployment-github-actions--render)).
> [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/deshiklab/dizivat/tree/r5-nestjs)
> The `main` branch keeps the in-browser mock demo on GitHub Pages: https://deshiklab.github.io/dizivat/en/
>
> **Branch `r6-enlistment-rmg` (v0.15.0, R6.6):** readiness for **NBR VAT-software enlistment** and features for the **RMG
> (garments)** segment — see [docs/NBR_ENLISTMENT.md](docs/NBR_ENLISTMENT.md) and [docs/RMG.md](docs/RMG.md). Tags `v0.14.0` (R6.5), `v0.13.1` (R6.4), `v0.12.0` (R6.3), `v0.11.0` (R6.2), `v0.10.0` (R6.1) and `v0.9.1` are the earlier states.

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind v4 · shadcn/ui (Base UI) · next-intl (EN/বাংলা) · TanStack Query + Table · React Hook Form + Zod · Recharts.

**DiziVAT** (formerly *RBS VAT*) is the **strangler** frontend for a VAT system. Since R6.3 the demo company is **KANCHANJHARA APPAREL COMPOSITE LTD**, a fictional knit + woven garment maker in Gazipur (RMG is the main customer segment).

- **Sprint 1:** app shell, design system, Dashboard, Sales invoices (Mushak 6.3), Purchases and Items.
- **Sprint 2:** sign-in with roles and permissions, customers and vendors CRUD, draft edit, cancel with a reason, undo, the item stock ledger, preferences and saved views stored on the server, and CI quality gates.
- **Sprint 3:** users & roles administration (invite with a one-time password, forced password change, reset, deactivate), company profile, NBR tariff with HS lookup in the item sheet, audit-trail viewer, server-driven notifications, an API contract suite (`docs/API.md`), performance budgets and visual regression for dark, mobile and Bangla screens.
- **Sprint 4:** branches on documents (sales ship from and purchases arrive at a branch; Mushak 6.3 prints the issuing branch), a Units-of-measure master, stock transfers between branches (Mushak 6.5 data), damage & wastage write-offs, finished goods by branch with a per-branch stock ledger, a History tab on every record (sales, purchases, transfers, damage, items, parties, users, units) backed by the audit trail, and dashboard charts loaded after first paint (first-load JS 207 kB).
- **R2 — Inventory + Purchase (v0.5.0):** import purchases with a Bill of Entry (LC, customs house, origin) and per-line customs duties (CD, RD, SD, VAT, AIT, AT → assessable value, total tax incidence, rebatable VAT + AT, landed cost) pre-filled from the NBR tariff; service purchases (VDS) with their own list; purchase returns / debit notes (Mushak 6.8) capped at the returnable quantity, which reverse stock and input tax on approval; opening stock entries; a master-items wizard (HS lookup → tariff rates, overrides need a reason, renames flow to linked SKUs); and the Mushak 6.1 purchase book and 6.2 sales book per item, with drill-down to source documents and a CSV export. It also fixes the legacy typos (Catehory, Attch, Comapny, Orgin, Debite).
- **R3 — Sales + Production (v0.6.0):** export invoices (direct export to a foreign buyer with LC, customs house, destination and Bill of Export; deemed export to a local buyer against a back-to-back LC — both zero-rated) with their own list; service sales (`SS-`, service codes, VDS, no stock); inline customer credit (receivable, overdue, credit limit) and batch (lot) availability on the sale form, with lots enforced on approval; credit notes (Mushak 6.7) capped at the returnable quantity, which restore stock and reduce output VAT; price declarations (Mushak 4.3) with versions, amendment reasons, version compare and supersede-on-approve; work orders with progress; production batches — in-house, contractual with the contractor's return (Mushak 6.4) and from a work order — that consume inputs at the BOM coefficients (or actual quantities) and receive finished goods at BOM unit cost; production opening; and the production config (direct stock or work order; standard or actual consumption). The legacy screen typos ("Opeining", "Requsition", "Purachse", "Comapny", "In-Houe") are fixed.
- **R4 — NBR VAT + Accounting (v0.7.0):** bank, mobile-wallet and cash accounts with running balances; customer receipts and supplier payments (cash, bank transfer, cheque with cheque details, mobile with transaction ID) allocated to open invoices, so invoice due amounts update on approval and return on cancel, with a printable money receipt / payment voucher and books closed up to a date; party statements (ledger, ageing, open invoices) that reconcile with the invoice registers; the accounting config. NBR VAT: a compliance centre (period status, shortfall, deposits, VDS to issue and awaited, a sorted and de-duplicated tax-period list, every Mushak report in one place); the Mushak 9.1 return builder with all notes computed live from approved documents, a drill-down sub-form behind every note, manual notes, submission in order only after the period ends and once note 58 covers note 50, and the period lock that follows (no new, edited, approved or cancelled documents in a submitted period); treasury deposits with the TR Form 6 challan and economic codes pre-filled from the 9.1 shortfall; VDS for purchases and sales with Mushak 6.6 certificates from a pending list; VAT adjustments (notes 27, 32, 38, 39); Mushak 6.10 (invoices above Tk 2 lakh); NBR settings with an explicit edit mode; live dashboard deadlines. Closes the legacy defects D-04 (9.1 sub-form HTTP 500), D-05 (6.10 "totalPurchase"), D-10 (accounting screens showing bank setup), D-15 (unsorted, duplicated tax months) and D-16 (blocking report loader), and the typos "Treasuary", "Rerturn" and "Purchhase". Prints use print CSS in place of server-side PDF until the Symfony API exists.
- **Knowledge base (v0.8.0):** the app is renamed **DiziVAT**, and a built-in user guide sits under **Help & documentation** (`/help`): 34 articles (44 since R6.4) in 9 topics (getting started, sales, purchase, inventory, production, accounting, NBR VAT, master data & admin, reference with a VAT glossary and FAQ), fully written in English **and** Bangla and following the language switch. The help centre has a topic filter and instant search over titles, keywords and headings (Bangla and Latin digits match, so `৯.১` finds 9.1). Each article has a table of contents, the screens it covers, related articles and prev/next. It can be **printed** or saved as **PDF** as a clean A4 document without the app chrome, **shared** (copy link, email, WhatsApp or the device share sheet) and **downloaded** as a standalone HTML page or Markdown, with links back to the app. The **whole manual** downloads or prints the same way. The top-bar help menu offers **Help for this page** on every screen, and ⌘K finds the knowledge base. Article text is rendered on the server and never ships in the page JavaScript; the exporter loads on first use. `npm run kb:lint` checks English/Bangla parity, cross-article links and app routes. The stale 9.1 note numbers in three form hints were corrected, and *Keep me signed in* now lasts 7 days.
- **Mushak 4.3 register and credits (v0.8.1):** **NBR VAT › Mushak 4.3** (`/vat/mushak-4-3`) lists every input–output coefficient declaration (current, drafts or all versions, with search) beside the official form, ready to print or save as PDF; **Open in Bill of materials** goes back to amend or approve it. The compliance centre's 4.3 card opens it, the production entry reads *Bill of materials (4.3)*, and ⌘K matches Bangla and Latin digits (`4.3` finds `মূসক ৪.৩`). The help article and FAQ explain where to find it. The copyright line **© BITSCOL (www.bitscol.com), Email: sales@bitscol.com, Mobile: +8801711853769** appears in the status footer, on the sign-in page, in the phone navigation drawer and at the end of every exported/printed help document (HTML and Markdown).

- **R5.1 — Backend: NestJS + PostgreSQL (v0.9.0, branch `r5-nestjs`):** an API in `api/` (NestJS 11, Drizzle ORM, PostgreSQL 16/17) behind the unchanged frontend. Next.js proxies `/api/v1` to it when built with `API_UPSTREAM`.
  - **Native modules:** identity, users, company and branches, units, the tariff and the audit trail, on real tables.
    - Passwords are stored as scrypt hashes.
    - Server-side sessions make sign-out real; password changes, resets and deactivations revoke sessions immediately.
    - Lockouts survive restarts.
    - The audit table is append-only.
    - Lists are filtered, faceted and sorted in SQL.
  - **Compat layer:** the other 70 route modules run unchanged inside Nest, with their state saved to PostgreSQL after every write.
  - **Tests:** the full existing suite passes against it (520 contract checks, every E2E suite, axe, 32/32 visual baselines). `scripts/api_native.py` adds 39 backend checks, including persistence across API restarts.
  - **Deployment:** one Docker image runs both processes, via `render.yaml` for Render with Neon Postgres. The roadmap R5.2–R5.5 moves each business module to relational tables.
- **PDF download of the statutory forms (v0.9.1):** every printable form has a **PDF** button next to **Print**: Mushak 6.3 invoices, 6.7 credit and 6.8 debit notes, 6.6 VDS certificates, TR-6 challans, money receipts and payment vouchers, 6.4 batches, 4.3 declarations (sheet and register), the 6.10 report, the 9.1 return, party statements, purchases, and the 6.1/6.2 books (landscape). It replaces the old *“Server-side PDF (Gotenberg) is wired in R3”* notice.
  - **How it works:** the PDF is made **in the browser** from the same A4 template that is printed (`src/lib/pdf/export.ts`, lazy-loaded on click), so Bangla shaping and fonts are identical to Print. It needs no server memory and also works on the static demo.
  - **Layout:** the form is laid out in an off-screen A4-wide frame (paper-width breakpoints, always the light print look, even in dark mode), paginated between table rows, rasterised at about 240 dpi and written as a multi-page A4 PDF named after the form and document (e.g. `Mushak-6.3_S-09260012.pdf`).
  - **Trade-off:** the pages are images, so the text can't be selected; Print → *Save as PDF* still gives a text PDF.
  - **Also fixed:** the Mushak 6.1/6.2 books printed a blank page (they weren't marked as a print area).
- **R6.1 — NBR enlistment readiness + RMG (v0.10.0, branch `r6-enlistment-rmg`):**
  - **Tamper-evident audit trail:** every event is sealed in a SHA-256 hash chain (`prev_hash` → `hash`). PostgreSQL
    triggers refuse UPDATE, DELETE and TRUNCATE on `audit_events`, and earlier rows are sealed once on upgrade.
    `GET /audit/verify` and a card on **Audit trail** recompute the chain and name the first altered or deleted
    record.
  - **Rules engine** (`src/lib/rules.ts`): effective-dated statutory parameters, each with its legal reference.
    - Return due date: 15 days, or 20 for the extended category, moved to the next working day. Fri/Sat, the fixed
      national days and company-defined gazetted holidays are skipped.
    - Mushak 6.6 due 3 working days after the return (VDS Guidelines 2025).
    - Advance tax on imports at **2 %** for manufacturers / **7.5 %** for commercial importers (Finance Ordinance
      2025), pre-filled on import lines.
    - 6-period credit windows.
  - **Business profile** (VAT settings): segment (RMG direct / deemed / composite …), 100 % export-oriented
    (Rule 21 note on Mushak 4.3), importer class, deadline category, bond licence with expiry warning, trade-body
    membership and extra holidays. All changes are audited field by field.
  - **RMG:**
    - customer exporter profile (exporter type, bond licence, BGMEA / BKMEA / BGAPMEA no.);
    - UD / UP, EXP no., currency, FC value and exchange rate on export and deemed-export invoices, with a live
      checklist of the **five NBR deemed-export conditions** (clarification of 09-10-2025) or the direct-export
      documents;
    - the same checklist on the sale detail;
    - **NBR VAT › Export register** (`/vat/export-compliance`): totals for direct, deemed and *zero-rating at risk*,
      filters, CSV, PDF and print.
  - **Tests:** `e2e_r6.py` (31 checks); `api_native.py` +8 (append-only database, sealed rows, chain verifies and
    survives restarts); contract 526 checks / 178 endpoints; axe 0 violations / 224 runs. All earlier suites pass
    unchanged, and 6 visual baselines were updated for the new sidebar entry.

- **R6.2 — RMG depth + enlistment gaps (v0.11.0):**
  - **UD / bond register** (`/vat/ud-register`): the exporter's UD / UP with item lines; every deemed-export invoice
    quoting the UD is checked against it (items on the UD, validity on the invoice date, quantity left), adding a
    sixth check to the zero-rating checklist. Used UDs are locked (number/exporter change 422, delete 409). A *Bond
    licences* tab warns 90 days before expiry.
  - **Export proceeds (PRC):** record bank realisation on approved foreign-currency exports (0.5 % tolerance, unique
    PRC numbers); the export register filters *Overdue* (120 days) / *Outstanding*; removal by approvers only, audited.
  - **Subcontracting register (Mushak 6.4)** (`/production/subcontract`): issued, returned, wasted and pending
    quantities per contractual batch with an *out more than N days* filter and process type (printing, embroidery,
    washing …).
  - **Mushak 6.2.1** purchase-sales book for traders (`/vat/mushak-6-2-1`).
  - **Backups** (`/master/backups`): automatic at 02:00 and 14:00 Dhaka (GO 16/Mushak/2019 asks for at least two a
    day), the last 30 kept, manual *Back up now*, SHA-256 verify and gzip download (no password hashes). On Render a
    missed slot is caught up when the service wakes.
  - **Bulk import** (`/master/import`): items, customers and vendors from .xlsx / .csv with a preview, row-level
    validation using the entry-form rules, all-or-nothing commit; plus a 31-item RMG starter catalogue.
  - **VAT officer role:** read-only, time-limited (at most 90 days) login for an NBR official; every page they open
    is written to the audit trail as *Access · viewed*. Sessions stop at the end date.
  - **Demo data:** the R6 seed (AURORA KNIT COMPOSITE LTD with three UDs, overdue export proceeds). The live service
    takes a backup and reseeds once on upgrade (`DEMO_RESEED=off` disables it).
  - The footer shows the real version and the data mode (mock / PostgreSQL). Four new bilingual help articles
    (38 in total).
  - **Tests:** `e2e_r62.py` (27 checks); contract 563 checks / 194 endpoints (16 new); `api_native.py` 65 checks (+18:
    officer limits and expiry, backups, backups survive a restart); axe 0 violations / 244 runs (10 new pages). Visual
    baselines re-captured for the new footer.

- **R6.3 — RMG demo company + compliance depth (v0.12.0):**
  - **Demo company:** KANCHANJHARA APPAREL COMPOSITE LTD (fictional; knit + woven composite, Konabari, Gazipur; BIN
    `004937518-0102`; factory, Gulshan head office, Ashulia FG store). Items, BOMs, production, subcontracting, stock,
    sales and purchases are re-seeded as a garment factory; parties and buyers are fictional. The live demo data is
    reset once on upgrade (`SEED_VERSION` r6.3).
  - **SD on exported inputs (Mushak 9.1 note 40):** six-month register of SD-paid purchase lines on *VAT adjustments*
    and a linked claim (purchase line + direct export, pro-rata amount, window / over-claim rules); note 40 reduces
    note 36. See [docs/RMG.md](docs/RMG.md) §5.
  - **UD amendments + back-to-back LC values:** amendment history with reason (required once used), line values and
    export LC value, BB-LC usage per UD (within / near / above).
  - **Interest & penalty calculator** on the compliance centre: §127 interest (1 %/month, ≤ 24 months) on unpaid VAT
    and SD (notes 41 / 42), late-return penalty (note 43), what-if inputs, TR-6 links, and exposure across periods.
  - **Restore drill:** `api/dist/restore.js` restores a backup into an empty database, verifies counts, documents and
    the audit chain and boots the app on it; the result shows on *Backups*. CI runs a drill on every push. See
    [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).
  - Four new bilingual help articles (42 in total).
  - **Tests:** `e2e_r63.py` (26 checks); contract 573 checks / 196 endpoints; `api_native.py` 73 checks
    (+ restore drill); axe 0 violations / 254 runs (126 pages).

- **R6.4 — RMG bond consumption register + duty drawback (v0.13.0 / v0.13.1):**
  - **Bonded imports:** *Imported under bond (IM-7)* on the import form — duties assessed and kept as *duty foregone*,
    nothing payable or creditable, Mushak 9.1 note 11. Go-live bonded stock is carried forward on the opening stock.
  - **Bond consumption register** (`/vat/bond-consumption`, Customs Act s.114): bonded receipts vs export consumption
    through the BOM coefficient (FIFO by Bill of Entry), book balance vs stock on hand → shortfall and duty at risk;
    own bond licence; date range; CSV.
  - **Bills of Entry** aged against the 24-month bonding period (+ 6-month extension): expiring / in extension / overdue.
  - **Duty drawback:** CD + RD on duty-paid inputs consumed by each export, six-month claim window (DEDO, Mushak-22).
  - Demo data reset once on upgrade (`SEED_VERSION` r6.4.1). Two new bilingual help articles (44 in total). See
    [docs/RMG.md](docs/RMG.md) §6.
  - **v0.13.1 — deploy-overlap guard (backend):** during a Render deploy the old and the new instance briefly share
    the database. Every re-seed, audit-chain append and compat-state save now starts with a PostgreSQL advisory lock
    (`pg_advisory_xact_lock`), and an instance whose data set was re-seeded by another instance since it booted
    (`meta.seeded_at`) refuses to write (503) instead of chaining to a replaced head or saving stale state over the
    fresh data (`api/src/common/state-guard.ts`).
  - **Tests:** `e2e_r64.py` (10 checks); contract 579 checks / 197 endpoints; `api_native.py` 83 checks (incl. the
    deploy-overlap scenario); axe 0 violations / 260 runs (129 pages).

- **R6.5 — RMG UD bond settlement + duty-drawback claims (v0.14.0):**
  - **Own UDs / UPs** (`/vat/bond-consumption?tab=uds`): bonded imports and exports link to the UD of their export
    order; per-UD statement — brought forward, imported, consumed via the BOM coefficient, from other stock, balance,
    excess import, duty on the balance; states in progress / ready / settled with warnings.
  - **Settlement:** Bond Commissionerate reference; every balance cleared on duty and / or carried forward to another
    open UD; statement frozen; cleared quantity leaves the bond register. Printable settlement statement (PDF).
  - **Drawback claims** (`?tab=claims`): tick open exports → draft claim (CD + RD frozen) → filed with DEDO inside the
    six-month window → sanctioned (reason when less) → refunded; rejected claims free their exports. Printable claim
    statement for Mushak-22 (PDF).
  - Demo data reset once on upgrade (`SEED_VERSION` r6.5): five own UDs (one settled, one ready) and seven claims.
    Two new bilingual help articles (46 in total). See [docs/RMG.md](docs/RMG.md) §7.
  - **Tests:** `e2e_r65.py` (12 sections); contract 610 checks / 207 endpoints; `api_native.py` 88 checks;
    axe 0 violations / 268 runs (133 pages).

- **R6.6 — export proceeds from the bank's PRC file + Mushak 9.3 / 9.4 (v0.15.0):**
  - **Export proceeds** (`/vat/proceeds`): outstanding / overdue (120 days from shipment) / due-soon tiles, ageing and
    the open list (CSV). **Import the bank's PRC file** (CSV / XLSX, template, demonstration file): rows matched by EXP →
    invoice → LC → exact amount, LC credits spread oldest first, suggestions for unmatched rows, duplicates flagged;
    allocations editable, then posted as a batch of realisations (`PB-…`, re-validated on the server). Approvers can
    reverse a batch. Own UDs and drawback claims show each export's PRCs and warn while proceeds are unrealised.
  - **Mushak 9.3** (late-return application, s.65): within 7 days of the period end, at most one month past the due date;
    file → approve / reject, deemed approved after 7 days. Inside the extension the late-return penalty is waived, interest
    still runs (penalty calculator + compliance centre). Printable form (PDF).
  - **Mushak 9.4** (amendment application, s.66): corrected 9.1 source notes within 4 years, no audit declaration;
    increases paid with interest (challan checked), decreases (30-day deemed approval) taken as a decreasing adjustment
    in a later open period; files the amended return (9.1 type C). Printable form (PDF).
  - Demo data reset once on upgrade (`SEED_VERSION` r6.6). Three new bilingual help articles (49 in total). See
    [docs/RMG.md](docs/RMG.md) §8.
  - **Tests:** `e2e_r66.py` (8 sections); contract 676 checks / 226 endpoints; `api_native.py` 95 checks;
    axe 0 violations / 288 runs (143 pages).

- **R5.2 — Backend: the master data on real tables (branch `r5-nestjs`):** customers, vendors, items and master items
  leave the compat layer and get their own PostgreSQL tables. See
  [docs/BACKEND.md › R5.2](docs/BACKEND.md#r52--customers-and-vendors-on-their-own-table) (parties) and
  [› items](docs/BACKEND.md#r52--items-and-master-items-on-their-own-table).
  - **`parties`:** customers and vendors in one table (`kind` tells them apart), `ord` keeping each kind's insertion
    order so lists tie-break exactly as they did in memory. The duplicate rules are enforced by the database too
    (partial unique indexes per kind on the name and on the BIN with its `NID ` prefix ignored), and a race that slips
    past the application check is still a 422.
  - **Deleting is a `deleted_at` stamp**, so master data never leaves relational storage: the 10-second undo trash is
    rebuilt from the table at boot, a deleted customer is still a row, and it is still in every backup.
  - **`items` and `master_items`:** SKUs and the HS-code products they belong to, with the six movement counters an
    item's `remain` is derived from as columns — so stock travels with its row. Unique by the database as well
    (`lower(sku)`, `lower(name)`), a master item's rename carries its SKUs along in the same transaction (they quote
    its name), and its tax profile is stored flat, like the tariff's own columns, so the two can be compared in SQL.
  - **Documents still move those counters** (a sale approved, an opening entry, a damage note), so the write-back
    saves what a compat handler changed and reads the stored row back into memory — a column type that rounds cannot
    leave the two copies apart. The same path adopts a SKU the R6.2 bulk import creates.
  - **The rules are shared, not copied:** the native handlers call the mock handlers' own functions (`partyRow`,
    `partyErrors`, `normaliseParty`, `newPartyId`, `buildItem`, `masterErrors`, `masterRow` …) through the compat
    bundle — the item and master-item rules were gathered into `src/app/api/v1/_items.ts` for exactly that, and the
    mock's answers are byte-identical to before (58 request cases compared against the pre-refactor handlers). So the
    PostgreSQL API, the Next.js mock and the GitHub Pages demo cannot drift: same responses, same 422/404/409 codes,
    same audit events — and the party register's aggregates still come from the documents, which stay in
    `compat_state` until R5.3.
  - **Write-through both ways:** the in-memory copies the 88 unported route modules read are kept in step, and what a
    compat handler writes — a party or SKU the R6.2 bulk import creates, a counter a document moves — is adopted into
    the tables after its request.
  - **Upgrading keeps the data:** the first boot after the migration moves the customers, vendors, items and master
    items out of `compat_state` into their tables and rewrites the snapshot without them — no re-seed
    (`SEED_VERSION` unchanged), so a customer installation and a restored pre-R5.2 backup both carry their records
    over.
  - **Tests:** `api_native.py` 147 checks (+52: rows in `parties`, `items` and `master_items`, none of those
    collections left in the snapshot, the database refusing a duplicate party name and SKU, delete → `deleted_at` →
    undo → still deleted after a restart, an undo whose name was taken again answering 422 instead of a 500 from the
    unique index, a rename that reaches the SKU in the table, a compat document's counter and a compat import landing
    in `items`, stock surviving a restart, a stale instance refusing native party and SKU writes during a deploy
    overlap — and an **upgrade drill**: the database is rewritten into its pre-R5.2 shape, the API restarted, and the
    same rows, the same four registers and a snapshot without the collections are required back). Contract unchanged:
    676 checks / 226 endpoints.
  - **Left for R5.3:** the stock ledger and branches' stock, which are *derived* from documents, become relational
    with the documents themselves — R5.3 gives the first documents tables, and the derivation follows once every
    movement family has one.

- **R5.3 — Backend: the first documents on real tables (branch `r5-nestjs`):** stock transfers and damage entries
  leave the compat layer for `stock_documents` + `stock_document_lines`, the sales invoices (Mushak 6.3) for
  `sales` + `sale_lines` + `sale_realisations`, the purchases (local, service and import) for `purchases` +
  `purchase_lines`, and the credit and debit notes (Mushak 6.7/6.8) for `notes` + `note_lines`. See
  [docs/BACKEND.md › R5.3](docs/BACKEND.md#r53--stock-documents-on-their-own-tables) (stock documents),
  [docs/BACKEND.md › R5.3](docs/BACKEND.md#r53--sales-invoices-on-their-own-tables) (sales invoices) and
  [docs/BACKEND.md › R5.3](docs/BACKEND.md#r53--purchases-on-their-own-tables) (purchases) and
  [docs/BACKEND.md › R5.3](docs/BACKEND.md#r53--credit-and-debit-notes-on-their-own-tables) (the notes).
  - **One table for both kinds** (`kind` tells a transfer from a damage entry), because that is how the registers and
    the branch-stock derivation read them. The branch a document consumes is `from_branch_id` for either kind — a
    transfer's origin, a damage entry's own branch — and only a transfer has a destination. `ord` keeps the insertion
    order the lists tie-break on, exactly as the in-memory arrays did.
  - **Lines are rows, not JSON:** each carries its item, quantity and the unit cost at posting (`numeric(18,3)` /
    `numeric(18,2)`), so what a movement carries can be summed in SQL instead of walked in memory. Editing a draft
    replaces its lines in the same transaction, deleting a draft deletes them with it, and the document number
    (`TR-MMYY####` / `DM-MMYY####`) is unique in the database as well — a race that slips past the application check
    is a 409, not a 500.
  - **An approval writes what it moves:** a damage entry's `items.damage` counter goes with the document, in its
    transaction, and is taken back on cancellation; if the transaction fails, the in-memory counters are restored, so
    the two copies cannot drift apart.
  - **The rules are shared, not copied:** the native handlers call the mock handlers' own functions (`buildStock`,
    `nextStockNo`, `approveDoc`, `cancelDoc`, `stockDocDiff`, `stockSpec`, `stockCsvColumns` …) through the compat
    bundle — the stock rules were gathered into `src/app/api/v1/_stock.ts` for exactly that, and now return data
    (field errors, a document's fields, a rejection's status and title) rather than a Web `Response`, so each side
    makes its own response out of the same rules. Both sides were held against the same contract suite: 676 checks
    with the routes served natively, and 676 again with the mock handlers serving them, so the port is behaviour for
    behaviour and the Next.js mock and the GitHub Pages demo cannot drift.
  - **The derived stock still reads every document:** the branch split (`stock`) and an item's ledger
    (`items/{id}/ledger`) add up sales, purchases, credit and debit notes, opening entries and production batches as
    well, so they stay derived in memory until those have tables too (R5.3–R5.4). A document written natively reaches
    them at once — the module keeps the in-memory copies in step, and the write-back adopts whatever a compat handler
    writes through the mock's arrays.
  - **Upgrading keeps the data:** the first boot after each migration moves the stock documents out of
    `compat_state` into their tables, and then the invoices with their lines and proceeds entries into theirs, and
    rewrites the snapshot without them — no re-seed (`SEED_VERSION` unchanged), so a customer installation and a
    restored pre-R5.3 backup both carry their documents over.
  - **An invoice is three tables:** the header carries the money (`numeric(18,2)`), the quantities (`numeric(18,3)`)
    and its own history (JSONB); `sale_lines` holds the printed lines in order (primary key `(sale, position)`), so an
    edit replaces rows rather than a JSON array; `sale_realisations` holds the export proceeds recorded against it —
    bank, PRC number, foreign-currency amount, rate and the BDT value at that rate, plus the R6.6 batch that posted
    it. The PRC number is upper-cased as the mock did and unique *while it is on an invoice* (the bank batches split
    one PRC over several invoices, so there is no global unique index), and removing an entry frees it again.
  - **The shipping documents are columns, not JSON:** an export or deemed-export invoice (Mushak 4.1, zero-rated)
    keeps its LC, bill of export, customs house, country, currency, foreign-currency value and exchange rate
    (`numeric(18,6)`) on its own row, so what a bond register or a proceeds report needs is a `WHERE`, not a walk over
    every invoice. `export_deemed` is the presence marker — NULL means a domestic sale — and two check constraints
    keep the block coherent.
  - **A deleted invoice keeps its number:** deleting stamps `deleted_at` and keeps the lines, because the mock handed
    out the next number by counting the live array *and* the undo buffer. The number is unique in the database as
    well (`S-MMYY####` for goods and exports, `SS-MMYY####` for services), so a race that slips past the application
    check is a 409, not a 500; ids stay the mock's (`s<n>`), taken from `saleIdentity` inside the locked transaction.
    An approval writes what it moves — `items.sold` goes with the invoice, in its transaction, and is taken back on
    cancellation — and bulk approve answers 200 with `{done, skipped}`, not the 201 a `POST` defaults to, because
    nothing is created there.
  - **The rules are shared here too:** the native handlers call the mock's own `parseSale`, `lots`, `lotShortfall`,
    `creditable`, `customerCredit`, `saleIdentity`, `periodLocked` and the register's facets and CSV columns through
    the compat bundle, and both sides were held against the same contract suite — 676 checks with the routes served
    natively, 676 again with the mock handlers serving them (which also proves the write-back: a draft, an approval,
    an export header, a proceeds entry, a delete and an undo made through the mock's code all reached the tables).
  - **What is still derived stays derived:** the credit a customer carries, what is returnable on an invoice, the
    credit and debit notes that quote one, and the branch split and ledger that add up *every* document family read
    the in-memory copies until the remaining families have tables (R5.3–R5.4). The module keeps those copies in step,
    and the write-back adopts whatever a compat handler writes — including a delete, which it reads as "this invoice
    is in the undo buffer now" and stamps exactly as the native delete does.
  - **A purchase is two tables, and an import is queryable:** the header carries the money, the two totals only a
    purchase has (`tti`, the total tax incidence, and `rebate`, the input tax credit claimable in Mushak 9.1) and its
    own history; `purchase_lines` holds the printed lines in order with `rebateable` and `vds` per line. The Bill of
    Entry an import clears — its number and date, LC, customs house, origin, C&F firm, the bonded flag and the own UD
    number — is columns of the document's row (`boe_no` is the presence marker), and every import line keeps its duty
    breakdown as columns: the assessable value, CD, RD, AIT and AT with their rates, plus what a bonded (IM-7) entry
    left foregone. What the R6.4 bond register and the R6.5 drawback claims report is a `WHERE` and a `SUM` over
    those columns, not a walk over every document in memory.
  - **The same discipline as the invoices:** numbers unique in the database as well (`P-MMYY####`, `PS-MMYY####` for
    services), deleting stamps `deleted_at` and keeps the lines so a deleted draft's number stays retired, ids from
    `purchaseIdentity` inside the locked transaction, `items.purchased` written with an approval and taken back on
    cancellation, bulk approve answering 200 with `{done, skipped}`, and a goods purchase that cannot become a
    service one (409). The rules are the mock's own (`parsePurchase` — the vendor decides between the local, the
    service and the import schema — `buildPurchaseFields`, `purchaseCategoryRule`, `returnable`, the register's
    facets and CSV columns) through the compat bundle, and both sides were held against the same contract suite:
    676 checks natively, 676 again with the mock handlers serving them (which also proved the write-back for an
    import: a compat-created BoE reached the table with its duty columns and the header's `tti` and `rebate`).
  - **Both note families are one table:** `kind` tells a credit note (goods a customer returns against a sales
    invoice — the sold quantity and the output VAT come down) from a debit note (goods returned to a vendor against a
    purchase — the purchased quantity comes down and the input tax credit is reversed), because the two registers,
    the two "what is still returnable" answers and the two sides of a VAT return read them the same way. The document
    a note was raised against is `source_id` and the party is `party_id`; the response names them by kind, as the
    mock's two shapes do. The two totals only a debit note has (`tti`, `rebate`), a line's `sold_qty` /
    `purchased_qty` and its debit-only totals are NULL on the other side, and check constraints say so.
  - **A deleted draft keeps its row:** notes have no undo and the mock removed one from its array for good, but its
    id counter had moved on and its number lives on in the audit trail — so the row is stamped rather than dropped,
    which is what stops a later note taking the same id, while the next number still skips the deleted draft's. Ids
    come from the state's own counter, claimed inside the locked transaction and separately from the identity, so a
    debit note refused for want of stock consumes no id.
  - **An approval writes what it moves:** a credit note takes `items.sold` down, a debit note `items.purchased`, each
    with the note, in its transaction, and reversed on cancellation. Approving a debit note needs the goods still on
    hand (422 while saving, 409 when approving a draft), and cancelling a credit note needs them still on hand too,
    because they leave the branch again. The rules are the mock's own (`buildCredit` / `buildDebit` — the source
    document has to exist and still be approved, the note cannot predate it, the period has to be open, every line
    has to be returnable and priced pro rata — plus the identities, the approve / cancel / stock / delete rules and
    both registers' specs and CSV columns) through the compat bundle, and both sides were held against the same
    contract suite: 676 checks natively, 676 again with the mock handlers serving them (which also proved the
    write-back: a compat-raised note reached the table with its kind, its source, its party and its lines, its
    approval moved `items.sold`, and its delete stamped the row while the next note took a higher id).
  - **Tests:** `api_native.py` 306 checks (+159 over the pre-R5.3 147: a stock draft is a row with its lines and moves no stock, approving it moves
    the branch split the still-unported endpoints derive in memory, cancelling gives the stock back, a write-off
    reaches `items.damage` and is taken back, editing a draft replaces the line rows, deleting one removes them and
    retires its number, a create that cannot be approved leaves no row, the database refusing a duplicate document
    number, a stale instance refusing a native document write during a deploy overlap — and a **second upgrade drill**: the database is rewritten into its pre-R5.3 shape, the API restarted, and
    the same documents, lines, registers and derived stock are required back; then the sales invoices the same way — a
    draft is a row with its line and moves no stock, approving moves the branch split, `items.sold` and the ledger
    that still adds up every document, cancelling gives both back and stores the reason on the row, the history
    travels with the row, editing replaces the line rows in the order they are printed, deleting stamps the row and
    keeps its lines so the next invoice takes a new number and the undo clears the stamp, an export invoice keeps its
    LC, country and FC value as columns, its proceeds are rows with the PRC upper-cased and the BDT at the rate
    entered (a duplicate PRC or more than the outstanding FC value is a 422, removing one frees the number), a service
    sale is numbered in its own series and moves no stock, bulk approve reports what it skipped, the snapshot carries
    no sales collection, the database refuses a duplicate invoice number — and a **third upgrade drill**: the database
    is rewritten into its pre-R5.3 shape (invoices, lines and proceeds entries inside `compat_state`, the deleted
    drafts back in its undo buffer, the three tables empty), the API restarted, and the same rows, registers, export
    headers, proceeds entries and derived stock are required back, with an invoice deleted before the upgrade still
    undoable afterwards; then the purchases the same way — a draft is a row with its line and moves no stock,
    approving moves the branch split, `items.purchased` and the ledger, cancelling takes the stock back out and
    stores the reason, editing replaces the line rows in order, deleting stamps the row and keeps its lines so the
    next document takes a new number and the undo clears the stamp, a goods purchase refuses to become a service one,
    an import keeps its Bill of Entry and every line's duty as columns (with the bonded demo entries keeping their
    duty foregone), a service purchase is numbered in its own series and moves no stock, bulk approve reports what it
    skipped, what a debit note may still return is served from those rows, the snapshot carries no purchases
    collection, the database refuses a duplicate document number — and a **fourth upgrade drill**: the database is
    rewritten into its pre-R5.3 shape (documents, lines, Bills of Entry and duty breakdowns inside `compat_state`,
    the deleted drafts back in its undo buffer, the two tables empty), the API restarted, and the same rows, three
    registers row for row, BoEs, duty columns and derived stock are required back, with a document deleted before
    the upgrade still undoable afterwards; then the notes the same way — a credit note is raised against an approved
    invoice and priced pro rata, a draft moves no stock, approving brings the goods back and takes `items.sold` down
    with the branch split, the ledger and the invoice's returnable quantity following, cancelling sends the goods out
    again and stores the reason, editing replaces the line rows, a note cannot move to another invoice, returning more
    than the document sold or bought is a 422, a note against a draft invoice is a 422, deleting stamps the row and
    keeps its lines so the next note takes a new id and a new number; and on the debit side `tti` and `rebate` are
    columns of its row, a return the branch no longer holds is a 409, approving takes `items.purchased` down, a
    service purchase has no goods to return, the snapshot carries neither collection, the database refuses a duplicate
    note number — and a **fifth upgrade drill**: both collections with their lines back inside `compat_state`, the two
    tables empty, the API restarted, and the same notes, lines and registers row for row required back, with a note
    deleted before the upgrade staying deleted while its id and number stay retired). Contract unchanged: 676 checks /
    226 endpoints.
  - **Next:** the remaining document families (production — BOMs, work orders, batches — and opening entries), and
    then the derived stock itself, the branch split and the ledger, which become relational once every document is a
    row (R5.4).

Every menu entry of the plan is now live; unknown URLs still open a *Planned* page that links back to the legacy RBS VAT screen.

All data is **realistic mock data**, served from `src/app/api/v1/*` (Next route handlers) through a typed client (`src/lib/api/client.ts`). ESLint stops components from importing the mock directly. On this branch the same `/api/v1` contract is also served by the **NestJS + PostgreSQL** API in `api/`: build and run with `API_UPSTREAM=http://127.0.0.1:4000` and no component changes are needed (see *Backend (R5)* below).

## Run

```bash
npm install
npm run build
npx next start -H 0.0.0.0 -p 3000      # → http://localhost:3000  (redirects to /en/login)
# or for development:
npm run dev
```

Sign in with a demo account (the login page lists them; the password is `demo1234` for all):

| User | Role | Can |
|---|---|---|
| `arif`, `farzana` | Approver | everything except user management and company settings |
| `kamal` | Operator | create, edit and delete drafts, export. Cannot approve or cancel |
| `auditor` | Viewer | read, export and the audit trail |
| `admin` | Administrator | everything, incl. users & roles and the company profile |
| `jewel` | Operator | deactivated — sign-in is refused |

The mock database, sessions and login-attempt counters live in memory and reset whenever the server restarts.

> On a machine with ≤ 2 GB RAM the lint step inside `next build` can run out of memory. Run `npm run lint` on its own, then `npx next build --no-lint` (CI runners are unaffected).

> Start the server only after `npm run build` has finished writing `.next/BUILD_ID`. A server started mid-build serves mixed chunk hashes, which shows up as "Loading chunk … failed".

## Backend (R5) — NestJS + PostgreSQL

```bash
export DATABASE_URL=postgres://dizivat:dizivat@127.0.0.1:5432/dizivat SESSION_SECRET=$(openssl rand -hex 32) API_UPSTREAM=http://127.0.0.1:4000
npm --prefix api ci && npm --prefix api run build
node api/dist/main.js &            # migrations + first-start seed, then http://127.0.0.1:4000/api/v1/health
npm run build && npx next start -p 3000
API_RESTART_CMD=api/scripts/serve.sh python3 scripts/api_native.py   # backend checks (sessions, revocation, persistence)
```

`docker build -t dizivat .` produces the deployable image (Next.js on `$PORT` + API inside). Architecture, tables,
the compat layer, Render + Neon steps and the roadmap are in [docs/BACKEND.md](docs/BACKEND.md).

## Quality checks

```bash
npm run typecheck                 # tsc --noEmit
npm run lint                      # ESLint incl. project guard-rails (see below)

pip install -r scripts/requirements.txt
python -m playwright install --with-deps chromium
npm run test:e2e                  # server must be running on a fresh seed
```

`test:e2e` runs the same steps as CI, in this order:

| Script | What it checks |
|---|---|
| `capture.py` | 32 reference screens (14 light desktop + 4 R2 screens: import form, debit notes, master items, Mushak 6.1 + 4 R4 screens: 9.1 return, compliance centre, receipts, TR-6 print + 3 knowledge-base screens: help centre, an article, a Bangla article + the Mushak 4.3 register — plus dark, 390 px mobile and a Bangla form). The browser clock is frozen at 25 Sep 2026 10:30 Dhaka so screens do not depend on when CI runs. Fails on any console or page error |
| `visual.py` | Compares those screens with `tests/visual/baseline/` and fails if more than 20 pixels change. Diffs go to `$SHOT_DIR/diff/`. Accept intended changes with `python visual.py --update` |
| `e2e.py` | 12 Sprint 1 flows (create, approve, stock guard, bulk approve, palette, shortcuts, URL filters, language switch, preferences) |
| `e2e_s2.py` | 33 Sprint 2 flows (sign-in, roles, edit, cancel, undo, customers, vendors, ledger, saved views, expired session, i18n completeness) |
| `contract.py` | API contract: 226 endpoints × (anonymous → 401, role without the permission → 403 naming it, 200 JSON, `Page<T>` shape, CSV content type) + 172 specific 404/409/422 cases — 676 checks. Non-destructive (R6.2 takes one backup if none exists); runs before `e2e_s3.py` (which deactivates `auditor`). `--doc` regenerates `docs/API.md`; CI fails if it is out of date |
| `e2e_s3.py` | 39 Sprint 3 flows (invite → one-time password → forced change, operator locked out of admin pages, self-edit guard, reset revokes sessions, deactivation blocks sign-in, company validation + read-only for non-admins, tariff search, HS lookup, audit filters/detail/CSV, notifications, Bangla) |
| `e2e_s4.py` | 32 Sprint 4 flows (units CRUD with in-use guards, transfer form → draft leaves stock alone → approve moves it and keeps the company total, over-stock blocks approval, branch ledger shows transfer in, damage with the 'lost' note rule, finished goods by branch, branch selects on sale/purchase, History tabs + no-access message, Mushak 6.3 branch address, audit links, deferred charts, Bangla) |
| `e2e_r2.py` | 32 R2 flows (import form: tariff pre-fill, live duty summary, LC-after-BoE rejected, approve → BoE panel, duties stored to 2 dp, stock in; service purchase: no branch, VAT and VDS from the service code, PS- draft; debit note: pre-selected purchase, capped at the remaining quantity, approve reverses stock and input tax, Mushak 6.8 print, blocks cancelling the purchase; opening stock; master-item wizard with the HS requirement, tariff defaults and override reason; Mushak 6.1/6.2 books: closing balance = stock on hand, item-type and date-range checks; operator can draft but not approve; Bangla) |
| `e2e_r3.py` | 52 R3 checks (export invoice: foreign buyer shows the export card and zero-rates VAT, missing LC rejected, approve stores LC / Bill of Export and moves stock; export rules — foreign needs export documents, no services to foreign buyers, direct export foreign-only, deemed local-only; service sale: SS- draft at the service rate, listed under services only; customer credit card and lot picker, selling beyond a lot rejected, lot sold quantity tracked; credit note: pre-selected invoice, capped at the remaining quantity, approve restores stock and reverses VAT, Mushak 6.7 print, blocks cancelling the invoice, appears in Mushak 6.2; 4.3: version compare, print, gross coefficients and price maths, amendment reason, one draft per item, approve supersedes; work order → batch: pre-filled lines, over-receipt rejected, approve consumes inputs at the BOM and adds finished goods, work order completes and cannot be cancelled; contractual receipt + Mushak 6.4; production opening; config gating and the work-order procedure; operator/viewer gating; Bangla; legacy typos gone) |
| `e2e_r4.py` | 52 R4 checks (accounts page; wallet number and service-charge rules, operator cannot add accounts; receipt from the invoice with the due pre-allocated, approve settles it (D-10), money receipt print; cash-into-bank, closed books, over-allocation and missing cheque details rejected; payment settles the bill and cancelling restores it; operator drafts but cannot approve, viewer read-only; customer and supplier statements reconcile with the registers; TR-6 pre-filled from the 9.1 shortfall, approve lands in note 58, bilingual TR Form 6; VDS from the pending list, over-withholding blocked, Mushak 6.6, sales VDS needs the certificate no.; adjustment reason rule, approved adjustment flows to note 27; 9.1 formulas, sub-form totals, parts 3–11, note drill-down, sub-form selector (D-04), sorted de-duplicated periods (D-15), early and repeat submission rejected; period lock: adjustments and invoices in a submitted period rejected, cancel → 409, lock note without a Cancel button; compliance centre; Mushak 6.10 API + page (D-05); NBR settings edit mode, accounting config, settings.manage gating; dashboard deadlines follow the return; Bangla; legacy typos gone; no console errors) |
| `e2e_kb.py` | 24 knowledge-base checks (help centre with 49 articles in 9 topics and the topic filter; search ranking, no-results and Clear, Bangla search, Bangla/Latin digits; article TOC anchors, related, screens covered, help: and in-app links, prev/next and breadcrumb; Print and PDF open a standalone print document; Share → Copy link; article HTML and Markdown downloads with absolute links; full-manual Markdown and HTML with in-document links, Print full manual; top-bar Help for this page (longest route match), shortcuts, sidebar link and ⌘K; Bangla article, downloads and print font; all 76 article pages, 404 for unknown articles, operator and viewer access; no console errors). Read-only |
| `e2e_m43.py` | 13 checks for the Mushak 4.3 register and the copyright line (sidebar entry and the (4.3) BOM label, compliance-centre card, ⌘K in English and Bangla with Latin digits; active list and official form, selection in the URL, search, all versions with the superseded note, Print, Open in Bill of materials, Help for this page, Bangla page; copyright in the status footer (English and Bangla labels, web/e-mail/phone links), on the sign-in page, in the phone drawer and at the end of HTML and Markdown exports; no console errors). Read-only |
| `e2e_pdf.py` | 9 checks for the **PDF** buttons. Each download is parsed and checked (xref offsets, A4 media boxes, page count, JPEG pages, Bangla title) and must contain no blank pages. Covers: Mushak 6.3 in English, Bangla and dark mode (still a light page), no Gotenberg placeholder, the exporter is lazy-loaded; 8 side-sheet forms (6.7, 6.8, 6.6, TR-6, receipt, voucher, 6.4, 4.3) from any tab, named by document number; 9.1, statement, 6.10, 4.3 register and purchase paginated; the 6.1 book in landscape with no blank pages; Print still opens the print dialog. Read-only |
| `e2e_r6.py` | 31 R6 checks (return due 15 Oct and Mushak 6.6 due 20 Oct for Sep 2026; business profile card: segment, AT 2 % → 7.5 % for a commercial importer, a company holiday moves the due date live and in the compliance centre, invalid dates rejected, Rule 21 note on 4.3, audited per field, bond licence required for an export-oriented RMG unit, `settings.manage` gating; customer RMG section and expired-bond warning; sale form deemed-export checklist going from 3 missing to complete, FC → taka, direct-export EXP field; UD / FC saved, unsupported currency rejected; sale-detail checklist; export register API, risk filter, sidebar + compliance-centre entry, URL filters, CSV, links, Bangla, phone; audit chain verifies and moves with every event, integrity card for the auditor, operators blocked; no console errors). Creates one draft invoice |
| `e2e_r62.py` | 27 R6.2 checks (UD register: states, exporter filter, CSV, fit on the deemed-export checklist, 422 on bad dates / duplicates / non-exporters, viewer cannot delete, used UD locked 422 / 409; export proceeds: overdue filter, over-tolerance / future / duplicate PRC 422, two PRCs realise an invoice, operator 403 / approver removes, unapproved 409, audited; subcontracting register, 422 on a bad range, CSV; Mushak 6.2.1 and 6.5; bulk import normalisation, in-file duplicates, all-or-nothing, DB duplicates skipped, invalid BIN; backups: scheduled slot, manual, SHA-256 verify, download without secrets, approver 403; VAT officer: access date rules, read-only, every read audited, forced password change, no Record PRC; UI flows for each screen; Bangla with no missing messages). Creates test records |
| `e2e_r63.py` | 26 R6.3 checks (RMG demo company; SD register: lapsed / ends-soon states, drafts reserve quantity, `exclude`; claim: pro-rata amount, 422 sdExceeds / sdDirectExportOnly / sdWindow / sdClaimLapsed / no SD, note 40 and its sub-form, cancel frees it; UD BB-LC usage, amendment reason required, below-use 422, amendment history; penalty exposure, quote, on-time, 24-month cap; restore drill on `/backups`, operator 403; UI: register + claim form, UD sheet, calculator + TR-6 link, drill panel; Bangla). Creates, then cancels / deletes, one claim; amends one UD |
| `e2e_r64.py` | 10 R6.4 checks (bond register: own licence, go-live BoE expiring / in extension, cleared lot; maths — closing = opening + receipts − used, lots sum to the book, jeans exports × coefficient, shortfall × duty per unit; drawback CD + RD, 6-month deadlines and states, totals; range: bonded opening carried forward, past end date drops the stock comparison, 422 on bad dates, three CSVs; bonded import: no duty / VAT / credit, duty foregone kept, enters the register on approval, note 11, leaves on cancel; page tabs, drill-down and CSV link; range form; import-form switch and purchase badge; sidebar, compliance-centre tile, help; Bangla). Creates and cancels one import |
| `e2e_r65.py` | 12 R6.5 sections (own UDs: statement maths, settled UD with carry-forward + duty paid, effect on the bond register, settle validation / permissions, settle in the UI, create / edit / links from imports; drawback claims: seeded history, claim status on the drawback view, create-claim validation, tick → draft → file in the UI, sanction / refund / reject lifecycle, draft delete; PDFs, CSVs, Bangla, read-only auditor) |
| `e2e_r66.py` | 8 R6.6 sections (proceeds overview: tiles = open list = ageing, 120-day states, seeded batches; bank-file matching by EXP / invoice / LC / amount with review, duplicate and invalid rows, nothing saved; import in the UI with an over-allocation hint and a manual pick, post → batch page, realisations on the invoice, UD and drawback-claim proceeds; re-import duplicates, server re-validation, reversal (operator 403, reason required) restores the open amounts; Mushak 9.3: duplicate / submitted periods refused, reject with reason, operator creates + files, approver approves a shorter extension, penalty waived inside it but interest kept, return-page banner, PDF; Mushak 9.4: seeded decrease approved → amended with a decreasing adjustment, increase via the UI with the declaration, deposit below difference + interest refused, note 41, PDF; CSVs, Bangla, read-only auditor). Creates test records |
| `a11y.py` | axe-core WCAG 2.2 AA on 143 pages + sign-in × light/dark (288 runs; admin pages as `admin`). Fails on any violation |
| `perf.py` | Cold-cache load of 14 key pages with 4× CPU throttling and a 9 Mbps / 40 ms network: LCP < 2.5 s, CLS < 0.1, initial JS < 400 KB compressed (chunks the server HTML references — the critical path) and total JS < 500 KB (including chunks fetched after first paint, such as the dashboard charts). Writes `/tmp/perf.json` |

Environment variables: `BASE_URL` (default `http://localhost:3000`) and `SHOT_DIR` (where screenshots are written).

**CI:** `.github/workflows/ci.yml`. The first job runs typecheck, lint, the knowledge-base lint and build and uploads `.next`. The second job starts that build and runs the scripts above, uploading screenshots, diffs and the server log.

## Layout

| Path | What |
|---|---|
| `src/middleware.ts` | Locale routing and session guard (redirects to `/{locale}/login?next=…`) |
| `src/app/[locale]/login` | Sign-in page |
| `src/app/[locale]/(app)/…` | Pages: `/`, sales and purchases (list, `new`, `[id]`, `[id]/edit`), `sales/services`, `sales/exports`, `sales/credit-notes`, `purchases/services`, `purchases/debit-notes`, `purchases/opening`, `production/bom`, `production/work-orders`, `production/batches`, `production/opening`, `production/config`, `accounting/{receipts,payments,bank-accounts,statements,config}`, `vat/{mushak,return-9-1,tr-6,vds,adjustments,mushak-6-10,settings}`, `inventory/items`, `inventory/finished-goods`, `inventory/transfers`, `inventory/damage`, `master/units`, `master/customers`, `master/vendors`, `master/users`, `master/company`, `master/audit`, `vat/tariff`, `help` and `help/[slug]` (knowledge base, pre-rendered in both languages), `[...slug]` in-shell 404 for unknown URLs (`page.server.tsx`: server build only) |
| `src/app/api/v1/…` | Mock REST API: auth (`login`, `logout`, `me`, `me/preferences`, `me/views`), documents (list/filter/sort/page, CSV, bulk approve, edit, approve, cancel, delete + restore), customers and vendors, items + ledger, dashboard, search, users (invite, reset password), company, tariff, audit, notifications, `me/password`, `stock` (by branch), `transfers`, `damage`, `units`, `debit-notes`, `opening-stock`, `master-items`, `mushak/6.1|6.2`, `sale-services`, `credit-notes`, `sales/{id}/creditable`, `production/{boms,work-orders,batches,config,lots}`, `accounting/{accounts,receipts,payments,open-invoices,statement,config}`, `vat/{periods,compliance,returns (+ notes),treasury,vds (+ eligible),adjustments,settings}`, `mushak/6.10`. Errors are problem+json — see `docs/API.md` |
| `src/lib/auth` | Roles → permissions, signed session tokens, server helpers |
| `src/components/auth` | `MeProvider`, `useMe()`, `useCan()`, `<Can>`, `<RequirePerm>` |
| `src/components/ui` | shadcn primitives (do not edit casually) |
| `src/components/shell` | Sidebar, top bar, ⌘K palette, user menu, notifications, shortcuts, mobile nav, status footer |
| `src/components/data-table` | One table for every list: URL state, facets, date presets, columns, server-saved views, bulk bar, CSV, mobile cards |
| `src/components/common` | Page header, status badge, money, field (+ unsaved-changes guard), combobox, confirm and cancel-reason dialogs, empty state |
| `src/features/*` | Screens by module: dashboard, sales, purchases, docs (shared document actions), items (+ HS lookup), stock (transfers, damage, finished goods), debit and credit notes, production (BOM / Mushak 4.3, work orders, batches / Mushak 6.4, config), money (receipts, payments), accounts, statements, VAT (Mushak 4.3 register, 9.1 return, sub-forms, TR-6, VDS / Mushak 6.6, adjustments, 6.10, compliance centre, settings), units, parties, users, company, tariff, audit (+ per-record history), auth |
| `src/content/help` | Knowledge base: `registry.ts` (order, topics, screens covered, related), `en/` and `bn/` article text (typed blocks with light inline markup), `blocks.ts` helpers |
| `src/features/help` | Help centre and search, article body, print / PDF / share / download actions, the lazy exporter (`src/lib/help/export.ts` builds the HTML and Markdown) |
| `src/lib` | Types, VAT maths (`vat.ts`), formatting (`format.ts`), client-side PDF export of the printable forms (`pdf/export.ts`), navigation registry (`nav.ts`), Zod schemas, API client, mock DB |
| `src/messages/{en,bn}.json` | UI strings (2,751 keys; every key exists in both files) |
| `tests/visual/baseline` | Visual-regression reference screens (32) |
| `docs/API.md` | API reference generated from the contract-test table: conventions, 176 endpoints with permissions, roles matrix |

## Conventions (enforced by ESLint in `src/components` and `src/features`)

- **Data only through `@/lib/api/client`.** No imports from `lib/mock` or server-only auth modules.
- **No hex colours.** Use the tokens in `globals.css` (`bg-primary`, `text-success`, `bg-warning-soft`, `bg-swatch-*`…).
- **No hard-coded English.** JSX text and `placeholder` / `title` / `aria-label` / `alt` go through `useTranslations`. Acronyms (VAT, BIN, CSV) are allowed. The NBR-prescribed Mushak 6.3 form is exempt. Numbers, money and dates go through `lib/format.ts` (en-IN lakh/crore grouping, Bengali digits in `bn`).
- **Locale-aware navigation.** Use `Link` / `useRouter` / `usePathname` from `@/i18n/navigation`, not `next/link` or `next/navigation`.
- **No native dialogs.** Use `useConfirm()`, the cancel-reason dialog or a toast; never `confirm()`, `alert()` or `prompt()`.
- **Base UI primitives only** from `@/components/ui`, never `@radix-ui/*`.
- **Disable Base UI controls explicitly.** `<fieldset disabled>` only reaches native inputs; Select, RadioGroup, Switch and Checkbox render spans and need their own `disabled` prop.

These are conventions without a lint rule:

- List state (filters, sort, page, search) lives in the URL, so every view can be shared with **Copy link**.
- Permissions are checked on the server. The UI uses `useCan()` to hide actions the role can't perform — in the sidebar, module tabs, ⌘K palette, buttons and row menus alike.
- Reversible deletes show a 10-second **Undo** toast (the record is restored from the server trash).
- Money is rounded with `round2`. Line maths: SD on value; VAT on value + SD.

## Static demo on GitHub Pages

Every push to `main` also publishes a **static demo** (`.github/workflows/pages.yml`) at
`https://<owner>.github.io/<repo>/`. GitHub Pages only serves files, so the demo build:

- pre-renders every page (`next build` with `output: "export"`, into `out/`);
- runs the same mock API route handlers **inside the browser** (`src/lib/demo`): `fetch("/api/v1/…")` is answered locally
  and the data plus the session live in `localStorage`, so each visitor has a private copy (use **Reset demo data** on the
  sign-in page);
- has no middleware: the session check happens in the browser (`DemoGate`), and `/` picks English or Bengali in the browser.

```bash
NEXT_PUBLIC_BASE_PATH=/dizivat npm run build:pages      # → out/
mkdir -p /tmp/site && ln -s "$PWD/out" /tmp/site/dizivat && (cd /tmp/site && python3 -m http.server 8080 &)
PAGES_URL=http://localhost:8080/dizivat python3 scripts/pages_smoke.py
```

Documents created in the demo get sequential ids (`s215`, `s216` …). Pages exist for the seeded documents plus 50 new ones
of each type per browser. The server build is unaffected, but both builds use `.next`: run `npm run build` again
before `npm start` if you built the demo locally.

## Credits

© BITSCOL ([www.bitscol.com](https://www.bitscol.com)), Email: [sales@bitscol.com](mailto:sales@bitscol.com), Mobile: [+8801711853769](tel:+8801711853769)
