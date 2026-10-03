# DiziVAT backend — R5 (NestJS + PostgreSQL)

Branch **`r5-nestjs`**. The `main` branch and its GitHub Pages demo (in-browser mock) are unchanged.

```
Browser ──▶ Next.js 15 (pages, middleware)  ──/api/v1/* rewrite──▶  NestJS 11 API  ──▶  PostgreSQL 16/17 (Neon in production)
            same UI, same typed client             127.0.0.1:4000       Drizzle ORM, migrations in api/drizzle
```

The frontend did not change: it still calls `/api/v1/…` via `src/lib/api/client.ts`. When it is built with
`API_UPSTREAM` set, Next.js proxies those calls to the API instead of running the in-process mock handlers. The
contract (`docs/API.md`, 176 endpoints) is the same, and **the whole existing test suite passes against the real
backend**, including 520 contract checks, every end-to-end suite, axe, and all 32 visual baselines pixel-identical.

## R5.1 — what runs where

The API is built in slices. R5.1 moves **identity, security and reference data** into real tables, R5.2 the
**master data** (customers and vendors, items and master items) and R5.3 the **first documents** (stock transfers and
damage entries, sales invoices, purchases, credit and debit notes). The other modules keep their exact mock
behaviour inside the API, and
their data is saved to PostgreSQL so nothing is lost on restart or redeploy.

| Area | Endpoints | R5.1 |
| --- | --- | --- |
| Sign-in / sign-out / login-info | `auth/login`, `auth/logout`, `auth/login-info` | **native** — `users`, `sessions`, `login_failures` |
| Current user | `me`, `me/password`, `me/preferences`, `me/views` | **native** — `users.preferences`, `saved_views` |
| Users & roles | `users`, `users/{id}`, `users/{id}/reset-password` | **native** — `users`, `sessions` |
| Company & branches | `company` | **native** — `company`, `branches` |
| Units of measure | `units`, `units/{id}` | **native** — `units` |
| NBR tariff | `tariff` | **native** — `tariff_lines` (per fiscal year) |
| Audit trail | `audit` | **native** — `audit_events` (append-only) |
| Backups (R6.2) | `backups`, `backups/{id}`, `backups/{id}/verify` | **native** — `backups` (gzip snapshot + SHA-256), scheduler 02:00 / 14:00 Dhaka with catch-up |
| Customers & vendors (R5.2) | `customers`, `customers/{id}`, `customers/{id}/restore`, and the same three for `vendors` | **native** — `parties` (one table, `kind` tells them apart) |
| Items & master items (R5.2) | `items`, `items/{id}`, `master-items`, `master-items/{id}` | **native** — `items`, `master_items` (the counters an item's `remain` is derived from are columns) |
| Stock transfers & damage (R5.3) | `transfers`, `transfers/{id}`, `damage`, `damage/{id}` | **native** — `stock_documents` + `stock_document_lines` (one table for both kinds, `kind` tells them apart) |
| Sales invoices (R5.3) | `sales`, `sales/{id}`, `sales/{id}/creditable`, `sales/{id}/realisations`, `sales/{id}/restore`, `sales/bulk` | **native** — `sales` + `sale_lines` + `sale_realisations` |
| Purchases (R5.3) | `purchases`, `purchases/{id}`, `purchases/{id}/returnable`, `purchases/{id}/restore`, `purchases/bulk` | **native** — `purchases` + `purchase_lines` (the Bill of Entry and each import line's duty are columns) |
| Credit & debit notes (R5.3) | `credit-notes`, `credit-notes/{id}`, `debit-notes`, `debit-notes/{id}` | **native** — `notes` + `note_lines` (one table for both, `kind` tells them apart) |
| Health | `health` (public) | **native** — liveness + DB round-trip |
| Everything else: the stock ledger and branches' stock, production, accounting, VAT returns, notifications, dashboard, search… | 69 route modules | **compat** — the mock handlers run unchanged; state saved to `compat_state` (JSONB) after every write |

`api/scripts/gen-compat-routes.mjs` holds the native list and generates the compat route table
(`api/src/compat/routes.gen.ts`). CI fails if the table is stale.

### What is better than the mock now

- **Passwords** are scrypt hashes (`scrypt$N$r$p$salt$hash`), never stored in clear. Temporary passwords come from `crypto.randomInt`.
- **Server-side sessions**: the cookie keeps the same signed `body.sig` format (so the Next.js middleware still
  verifies it at the edge) but now carries a session id. The API honours it only while the `sessions` row is active, so:
  - **Sign-out is real.** A copied cookie stops working.
  - A **password change** signs out every other browser. This browser gets a fresh session.
  - An admin **reset** or **deactivation** signs the user out immediately.
  - A token that is validly signed but has no live session is rejected.
- **Lockout** (5 wrong passwords → 60 s) is stored in `login_failures`, so it survives restarts.
- **Audit trail**: rows in `audit_events`, which the app only ever inserts. Events recorded by compat handlers are forwarded in the same transaction as their data.
- **Persistence**: every record, preference, saved view, session and audit event survives API restarts and redeploys.
- **Lists in SQL** (users, audit, tariff): the search, date range, facet counts, sort and pagination match the mock
  exactly. Text sorts use an ICU collation (`"natural"`, numeric-aware) so the order is the same as the UI's `localeCompare`.

### How the compat layer works

1. **Boot**
   - Migrations run first.
   - **First start:** the demo data set is seeded into PostgreSQL (the same data the mock and the Pages demo use): 6 users with scrypt hashes, company, units, tariff, about 1,160 audit events, and the document state.
   - **Later starts:** everything is restored from PostgreSQL *before* the compat bundle loads.
2. **Per request**
   - Nest authenticates the request from the `sessions` table and runs the mock handler with that user (`api/src/compat/session-user.shim.ts`).
   - When the handler changes state, the JSONB snapshot and any new audit events are saved in one transaction.
   - A process-wide lock serialises compat requests.
3. **Write-through** (both directions)
   - Native modules own users, company, units, (R5.2) the parties, items and master items and (R5.3) the stock documents, the sales invoices, the purchases and both note families in PostgreSQL.
   - They update the in-memory copies the compat handlers read, so both sides always agree. For example, items validate their unit against the `units` table, and an invoice quotes a customer the `parties` table holds.
   - The other way round: when a compat handler writes a record a native module owns — the R6.2 bulk import creates
     customers, vendors and SKUs, approving a document moves an item's counters, a restored backup puts stock
     documents back — the request's persist step
     compares the in-memory rows with what was last saved and adopts the difference into the table
     (`api/src/common/writeback.ts`).

**Single instance by design** until R5.5 removes the compat layer: run one API process per database. Render's free
plan runs exactly one.

## R5.2 — customers and vendors on their own table

`api/src/modules/parties.ts` serves the six party endpoints from the **`parties`** table. The contract
(`docs/API.md`) is unchanged: same responses, same 422/404/409 codes, same audit events.

- **One table, two kinds.** `kind` is `customer` or `vendor`; `ord` (a serial) keeps each kind's insertion order, so
  sorted lists tie-break exactly as the in-memory arrays did.
- **The rules are shared, not copied.** `api/src/compat/entry.ts` re-exports the mock handlers' own functions
  (`partyRow`, `partyErrors`, `normaliseParty`, `buildParty`, `newPartyId`, `partySpec`, `partyCsvColumns`,
  `PARTY_FIELDS`) and the native module calls them through `compat()`. Aggregates, the duplicate and `modeLocked`
  checks, the stored shape and the id format therefore cannot drift between the PostgreSQL API, the Next.js mock and
  the GitHub Pages demo — all three run the same code.
- **The database enforces the duplicates too**: partial unique indexes on `(kind, lower(btrim(name)))` and
  `(kind, regexp_replace(bin, '^NID ', ''))`, both excluding the trash. A collision that slips past the application
  check is a 422, never a duplicate row — `uniqueViolation()` (`api/src/common/http.ts`) reads the PostgreSQL code
  from the driver error drizzle wraps it in, so every module translates it the same way.
- **Deleting is a `deleted_at` stamp.** The record stays in PostgreSQL — master data an NBR audit can ask about never
  leaves relational storage — and the undo trash is rebuilt from the table at boot. Only parties without documents
  can be deleted at all (409 `in-use:N` otherwise), exactly as before. The undo answers 200 with the party, as the
  mock did: a POST, but nothing is created. Because the indexes ignore the trash, a deleted party's name and BIN are
  free again — so an undo can collide with whatever took them, and answers that same 422 with the record left deleted.
- **Upgrading an existing database.** On the first boot after the migration, `boot.ts` moves the customers and
  vendors it finds inside `compat_state` (and the deleted ones in its undo buffer) into `parties`, then rewrites the
  snapshot without them — the items and master items below take the same path, in the same transaction. No re-seed: a customer installation keeps its data, and `SEED_VERSION` is unchanged.
  Restoring a pre-R5.2 backup into a fresh database adopts them the same way. `api_native.py` drills it in CI: it
  rewrites a live database into that older shape, restarts, and compares the registers row for row.
- **The list is not in SQL yet.** `runQuery` (the shared in-memory engine) still builds the register, because its
  aggregates, facets and totals come from *documents* — turnover and amount due per party — and those live in
  `compat_state` until R5.3. Units work the same way. When documents get their tables, this becomes a SQL join with
  `sqlList`.
- **Writes go through the state guard**, so during a deploy overlap an instance whose data set was replaced by
  another's re-seed refuses a party write (503) instead of resurrecting stale rows.

## R5.2 — items and master items on their own tables

`api/src/modules/items.ts` serves `items`, `items/{id}`, `master-items` and `master-items/{id}` from the **`items`**
and **`master_items`** tables, the same way: the contract is unchanged, and the rules are the mock's own
(`src/app/api/v1/_items.ts`, re-exported by `api/src/compat/entry.ts`), so the derived cost price, the duplicate-SKU
and unit checks, the master item's tax-override rules, its history and both registers' facets and CSV columns cannot
drift.

- **The movement counters are columns** (`opening`, `purchased`, `prod_receive`, `prod_issue`, `sold`, `damage`), so
  an item's `remain` — and the stock valuation the register totals — travels with its row. Items are never deleted:
  an unused SKU is deactivated, because its ledger must stay readable.
- **Unique by the database too**: `lower(sku)` on `items`, `lower(name)` on `master_items` — the checks the handlers
  run, with the unique violation translated to the same 422 (`{sku:["duplicate"]}`, `{name:["duplicate"]}`) on create,
  update and rename alike.
- **A master item's rename carries its SKUs along** in the same transaction (they reference it by name, as the legacy
  data does), and the mirror's copies move with them.
- **Ids stay the mock's**: `i<n>-<base36>` from the number of items, `m<n>` from the highest number the table has ever
  held — computed inside the locked transaction, so two creates in flight never share one.
- **Documents still move the counters.** Sales, purchases, debit notes, opening entries and production documents are
  compat state until R5.3–R5.4, so they write through the in-memory item and the write-back saves the new counters
  (and reads the stored row back, so a column type that rounds cannot leave the two copies apart). Since R5.3 a
  damage entry is native and writes `items.damage` itself, in the document's own transaction.
- **The stock ledger and branches' stock stay compat**: both are *derived* from documents (`items/{id}/ledger`,
  `stock`). R5.3 gives the first documents tables — a movement is a row now — but the derivation adds up *every*
  family, so it becomes SQL once the rest of them (sales, purchases, notes, production) are relational too.

## R5.3 — stock documents on their own tables

`api/src/modules/stock.ts` serves `transfers`, `transfers/{id}`, `damage` and `damage/{id}` from **`stock_documents`**
and **`stock_document_lines`**, the same way: the contract is unchanged, and the rules are the mock's own
(`src/app/api/v1/_stock.ts`, re-exported by `api/src/compat/entry.ts`), so line validation and pricing, the monthly
document numbers, the branch-stock checks around approving and cancelling, the counters a write-off moves, the
register's facets and its CSV columns cannot drift. These are the first business documents in PostgreSQL — and both
sides were held against the same contract suite, the native routes and the mock handlers serving them, so the port is
behaviour for behaviour.

- **One table for both kinds** (`kind` tells a transfer from a damage entry), because that is how the registers and
  the branch-stock derivation read them. The branch a document consumes is `from_branch_id` for either kind — a
  transfer's origin, a damage entry's own branch — and only a transfer has a destination.
- **Lines are rows, not JSON.** `stock_document_lines` holds the item, the quantity and the unit cost at posting
  (`qty numeric(18,3)`, `cost`/`value numeric(18,2)`), so what a movement carries can be summed in SQL instead of
  walked in memory. Editing a draft replaces its lines in the same transaction; deleting a draft deletes them with it.
- **Numbers are unique in the database too** (`TR-MMYY####` / `DM-MMYY####`). The handlers already skip the numbers of
  deleted drafts — the audit trail keeps them — and a violation the application check missed (two requests at once) is
  a 409, not a 500.
- **Ids stay the mock's** (`t<n>` / `d<n>`), taken from the highest number the table has ever held for that kind inside
  the locked transaction, so a document is never renumbered and two creates in flight never share an id.
- **An approval writes what it moves.** A damage entry moves `items.damage`; the counter is written with the document,
  in its transaction, and taken back on cancellation. If the transaction fails, the in-memory counters are restored —
  the two copies cannot drift apart.
- **The derived stock still reads every document.** The branch split (`stock`) and an item's ledger
  (`items/{id}/ledger`) add up *all* movement documents — sales (their own rows since R5.3, but still read through the
  in-memory copy the module keeps in step), purchases, credit and debit notes, opening entries,
  production batches — so they stay derived in memory until every document family has a table (R5.3–R5.4). A document
  written natively reaches them at once (the module keeps the in-memory copy in step), and the write-back covers the
  other direction, so a compat handler writing through the mock's arrays cannot leave the table behind.
- **The upgrade is one boot.** A database written before this slice holds both collections inside `compat_state`; the
  first start moves every document and line into the tables and rewrites the snapshot without them. Restoring a
  pre-R5.3 backup into a fresh database adopts them the same way, and `api_native.py` drills it in CI.

## R5.3 — sales invoices on their own tables

`api/src/modules/sales.ts` serves `sales`, `sales/{id}`, `sales/{id}/creditable`, `sales/{id}/realisations`,
`sales/{id}/restore` and `sales/bulk` from **`sales`**, **`sale_lines`** and **`sale_realisations`**. The contract is
unchanged and the rules are the mock's own (`src/app/api/v1/_r3.ts`, `_r4.ts`, `_r66.ts`, re-exported by
`api/src/compat/entry.ts`): `parseSale`, the lot/shortfall checks, `creditable`, `customerCredit`, `saleIdentity`,
the period lock, the register's facets and its CSV columns cannot drift. As with the stock documents, both sides were
held against the same contract suite — the native routes and the mock handlers serving them — so the port is
behaviour for behaviour.

- **An invoice is three tables.** The header carries the money (`numeric(18,2)`), the quantities (`numeric(18,3)`)
  and its own history (JSONB); `sale_lines` holds the printed lines in order (primary key `(sale, position)`), so an
  edit replaces rows rather than a JSON array; `sale_realisations` holds the export proceeds recorded against it.
- **The shipping documents are columns, not JSON.** An export or deemed-export invoice (Mushak 4.1, zero-rated) keeps
  its LC, bill of export, customs house, country, currency, foreign-currency value and exchange rate
  (`numeric(18,6)`) on its own row, so what a bond register or a proceeds report needs is a `WHERE`, not a walk over
  every invoice. `export_deemed` is the presence marker — NULL means a domestic sale — and two check constraints keep
  the block coherent (an export always has an LC number; only the four invoice currencies are allowed).
- **Numbers are unique in the database and stay retired** (`S-MMYY####` for goods and exports, `SS-MMYY####` for
  services). Deleting an invoice stamps `deleted_at` and keeps its lines, because the mock handed out the next number
  by counting the live array *and* the undo buffer: a deleted draft's number is never reused. A race that slips past
  the application check is a 409, not a 500.
- **Ids stay the mock's** (`s<n>`), from `saleIdentity` inside the locked transaction, so an invoice is never
  renumbered and two creates in flight never share an id.
- **An approval writes what it moves.** `items.sold` goes with the invoice, in its transaction, and is taken back on
  cancellation; if the transaction fails the in-memory counters are restored, so the two copies cannot drift apart.
- **Proceeds are rows of their own.** The PRC number is upper-cased as the mock did and unique *while it is on an
  invoice* — the R6.6 bank batches split one PRC over several invoices, so there is no global unique index — the BDT
  value is stored at the rate entered, and removing an entry frees the number again.
- **Bulk approve answers 200**, not the 201 a `POST` defaults to: nothing is created there, it reports
  `{done, skipped}` for the drafts it took and the ones a period lock, a shortfall or an approval rule refused.
- **What is still derived stays derived.** The credit a customer carries, what is returnable on an invoice, the credit
  and debit notes that quote one, and the branch split and ledger that add up *every* document family read the
  in-memory copies until the remaining families have tables (R5.3–R5.4). The module keeps those copies in step, and
  the write-back adopts whatever a compat handler writes — including a delete, which it reads as "this invoice is in
  the undo buffer now" and stamps exactly as the native delete does.
- **The upgrade is one boot.** A database written before this slice holds the invoices inside `compat_state`; the
  first start moves every invoice, line and proceeds entry into the tables and rewrites the snapshot without them.
  Restoring a pre-R5.3 backup into a fresh database adopts them the same way, and `api_native.py` drills it in CI.

## R5.3 — purchases on their own tables

`api/src/modules/purchases.ts` serves `purchases`, `purchases/{id}`, `purchases/{id}/returnable`,
`purchases/{id}/restore` and `purchases/bulk` from **`purchases`** and **`purchase_lines`**. The contract is
unchanged and the rules are the mock's own (`src/app/api/v1/_docs.ts`, `_r2.ts`, re-exported by
`api/src/compat/entry.ts`): `parsePurchase` — the vendor decides whether the body is a local, a service or an import
document — `buildPurchaseFields` (how the lines are priced and what duty an import line carries), `purchaseIdentity`,
`purchaseCategoryRule`, the debit notes and settlements that block a cancellation, `returnable`, the register's
facets and its CSV columns cannot drift. Both sides were held against the same contract suite again: 676 checks with
the routes served natively, 676 with the mock handlers serving them.

- **A purchase is two tables.** The header carries the money (`numeric(18,2)`), the quantities (`numeric(18,3)`) and
  the two totals only a purchase has — `tti`, the total tax incidence of an import, and `rebate`, the input tax
  credit claimable in Mushak 9.1 — plus its own history (JSONB); `purchase_lines` holds the printed lines in order
  (primary key `(document, position)`), with `rebateable` and `vds` per line.
- **The Bill of Entry is columns, not JSON.** An import purchase (a Foreign vendor) keeps its BoE number and date,
  LC number and date, customs house, origin, C&F firm, receive address, the bonded flag and the own UD number on the
  document's row — `boe_no` is the presence marker, NULL for a local or service purchase — and every import line
  keeps its duty breakdown as columns: the assessable value, CD, RD, AIT and AT with their rates. What the R6.4 bond
  register reports as duty foregone under an IM-7 bond, and what the R6.5 drawback claims read, is a `WHERE` and a
  `SUM` over those columns instead of a walk over every document in memory.
- **Numbers are unique in the database and stay retired** (`P-MMYY####` for goods and imports, `PS-MMYY####` for
  services), and deleting stamps `deleted_at` while keeping the lines, for the same reason an invoice does: the mock
  counted the live array *and* the undo buffer when it handed out the next number. A race is a 409, not a 500.
- **An approval writes what it moves.** `items.purchased` goes with the document, in its transaction, and is taken
  back on cancellation; a purchase only ever adds stock, so there is no shortfall check to refuse one.
- **A goods purchase cannot become a service one** (or the other way round) once issued — the shared
  `purchaseCategoryRule` answers 409, as the mock did.
- **What is still derived stays derived.** The debit notes that return against a purchase, the bond register, the
  drawback claims, the branch split and the ledger that add up *every* document family read the in-memory copies
  until the remaining families have tables (R5.3–R5.4). The module keeps those copies in step, and the write-back
  adopts whatever a compat handler writes — including a delete, which it reads as "this document is in the undo
  buffer now" and stamps exactly as the native delete does.
- **The upgrade is one boot**, as with the invoices: the first start moves every purchase and line out of
  `compat_state` and rewrites the snapshot without them, and `api_native.py` drills it in CI.

## R5.3 — credit and debit notes on their own tables

`api/src/modules/notes.ts` serves `credit-notes`, `credit-notes/{id}`, `debit-notes` and `debit-notes/{id}` from
**`notes`** and **`note_lines`** — one table for both families, `kind` telling them apart, the same choice the stock
documents made: the two registers, the two "what is still returnable" answers and the input- and output-tax sides of
a VAT return read them the same way. The contract is unchanged and the rules are the mock's own
(`src/app/api/v1/_r2.ts`, `_r3.ts`, `_r4.ts`, `_docs.ts`, re-exported by `api/src/compat/entry.ts`): `buildCredit` /
`buildDebit` (the source document has to exist and still be approved, the note cannot predate it, the period has to
be open, every line has to be returnable and within what is left of it, and a returned line is priced pro rata),
`creditIdentity` / `debitIdentity`, `creditApproveRule` / `debitApproveRule`, `creditCancelRule` / `debitCancelRule`,
`debitStockRule`, `postCredit` / `postDebit`, the registers' specs, filters and CSV columns cannot drift. Both sides
were held against the same contract suite again: 676 checks with the routes served natively, 676 with the mock
handlers serving them.

- **The two shapes come out of one row.** The document a note was raised against is `source_id` (a sales invoice or a
  purchase) and the party is `party_id` (a customer or a vendor); the response names them by kind, as the mock's two
  shapes do. A debit note carries two totals a credit note does not — `tti` and the `rebate` (input tax credit) it
  reverses — so they are NULL on the credit side and a check constraint says so; the same goes for a line's
  `sold_qty` / `purchased_qty` and its debit-only `tti` and `rebate`.
- **A deleted draft keeps its row.** Notes have no undo, and the mock removed one from its array for good — but its
  id counter had moved on and its number lives on in the audit trail, so the row is stamped rather than dropped:
  that is what stops a later note taking the same id, and the next number still skips the deleted draft's.
- **Ids and numbers come from the mock's own counters.** `cn<n>` / `dn<n>` from the state's `db.seq`, claimed inside
  the locked transaction and separately from the identity, so a debit note refused for want of stock consumes no id;
  `CN-MMYY####` / `DN-MMYY####` from the live notes *and* the audit trail. A duplicate the application check missed
  is a 409, not a 500.
- **An approval writes what it moves.** A credit note takes `items.sold` down (the goods come back into the selling
  branch), a debit note takes `items.purchased` down (they leave again), each with the note, in its transaction, and
  reversed on cancellation. Approving a debit note needs the goods still on hand — 422 while saving, 409 when
  approving a draft — and cancelling a credit note needs them still on hand too, because they leave the branch again.
- **What is still derived stays derived:** what is returnable on an invoice or a purchase, a customer's credit, the
  branch split and the ledger read the in-memory copies, which the module keeps in step, and the write-back adopts
  whatever a compat handler writes — including a delete, which stamps the row exactly as the native delete does.
- **The upgrade is one boot**, as with the other families: the first start moves both collections and their lines out
  of `compat_state` and rewrites the snapshot without them, and `api_native.py` drills it in CI. A note deleted
  before the upgrade has no place in the older snapshot, so what the drill requires back is the *counter*: the next
  note takes a higher id and a new number.

## Tables

| Table | Purpose |
| --- | --- |
| `users` | accounts, role (incl. `vatOfficer`), status, scrypt hash, `password_is_demo`, preferences (JSONB); **R6.2** `access_until` for VAT officers |
| `sessions` | one row per sign-in; `revoked_at` + `revoke_reason` (signedOut, passwordChanged, passwordReset, deactivated) |
| `login_failures` | failures per username, `locked_until` |
| `saved_views` | list views per user and table |
| `company` (single row) + `branches` | company profile printed on Mushak forms |
| `units` | units of measure; ids from `unit_id_seq` |
| `tariff_lines` | NBR tariff per fiscal year (`numeric` rates) |
| `audit_events` | append-only audit trail (indexed by time, Dhaka day, record, record type). **R6:** every row is sealed with `prev_hash` + `hash` (SHA-256 chain); triggers refuse UPDATE / DELETE / TRUNCATE — see [NBR_ENLISTMENT.md](NBR_ENLISTMENT.md) |
| `backups` | **R6.2:** scheduled / manual snapshots (`bytea` gzip JSON, SHA-256, row counts); last 30 kept; one scheduled row per slot (partial unique index) |
| `parties` | **R5.2:** customers and vendors (`kind`), exporter details, seeded credit terms; `deleted_at` is the undo trash; unique per kind on name and BIN |
| `items` | **R5.2:** SKUs — prices and rates (`numeric`), the six movement counters `remain` is derived from, the master item's *name*; unique on `lower(sku)` |
| `master_items` | **R5.2:** HS-code products — flat tax profile like `tariff_lines`, override reason, own history (JSONB); unique on `lower(name)` |
| `stock_documents` | **R5.3:** stock transfers and damage entries (`kind`) — number (unique), process, branches, reason, totals (`numeric`), own history (JSONB) |
| `stock_document_lines` | **R5.3:** a document's lines — item, quantity and unit cost at posting; primary key (document, position) |
| `sales` | **R5.3:** sales invoices (Mushak 6.3) — number and challan (number unique), process, customer and branch as printed, money (`numeric`), the export / deemed-export shipping documents as their own columns, own history (JSONB); `deleted_at` is the undo trash, which keeps a deleted draft's number retired |
| `sale_lines` | **R5.3:** an invoice's printed lines — item, name, HS code, unit, quantity, price, SD/VAT rates and totals, batch; primary key (invoice, position) |
| `sale_realisations` | **R5.3:** export proceeds (PRC) recorded against an invoice — bank, PRC number, foreign-currency amount, rate and the BDT value at that rate, the R6.6 batch that posted it |
| `purchases` | **R5.3:** purchases (Mushak 6.1 input side) — number (unique), challan / BoE number and date, vendor as printed, mode, money (`numeric`), the two totals a purchase adds (`tti`, `rebate`), the Bill of Entry an import clears as its own columns, own history (JSONB); `deleted_at` is the undo trash |
| `purchase_lines` | **R5.3:** a purchase's lines — item, quantity, prices and rates, `rebateable` / `vds`, and an import line's duty breakdown (AV, CD, RD, AIT, AT and the rates) plus what a bonded entry left foregone; primary key (document, position) |
| `notes` | **R5.3:** credit notes (Mushak 6.7) and debit notes (6.8) — `kind` tells them apart; number (unique), the document each was raised against, the customer or vendor as printed, reason, money (`numeric`), the two totals only a debit note has (`tti`, `rebate`), own history (JSONB); `deleted_at` keeps a deleted draft's id and number retired |
| `note_lines` | **R5.3:** a note's lines — item, the quantity the source document had (`sold_qty` on a credit note, `purchased_qty` on a debit note), what came back, at the source document's price and rates; primary key (note, position) |
| `compat_state` | JSONB state of the modules not yet ported (no customers, vendors, items, master items or units since R5.2, no stock documents, sales invoices, purchases or notes since R5.3) |
| `meta` | seed version, tariff fiscal year |

**Demo data upgrades (R6.2):** at start-up, if `meta.seed_version` differs from `SEED_VERSION` in `api/src/boot.ts`, the
API takes a backup of every table into `backups` and re-seeds the demo data set. Set `DEMO_RESEED=off` on a customer
installation to keep its data across upgrades. `BACKUPS=off` disables the scheduler (tests).
The scheduler checks every 5 minutes and once `BACKUP_FIRST_DELAY_MS` (default 20 s) after boot. It only takes the
*latest* slot (02:00 or 14:00 Dhaka) if that slot has no backup yet. So after a long Render sleep, one catch-up backup is
taken, not one per missed slot. A unique index on the scheduled slot stops two instances from both taking it.

The schema is in `api/src/db/schema.ts`. Migrations are generated with `npm --prefix api run db:generate` into `api/drizzle/` and applied automatically at start-up.

## Run locally

```bash
# PostgreSQL (any 14+; Debian: apt install postgresql)
sudo -u postgres psql -c "create role dizivat login password 'dizivat'" -c "create database dizivat owner dizivat"

export DATABASE_URL=postgres://dizivat:dizivat@127.0.0.1:5432/dizivat
export SESSION_SECRET=$(openssl rand -hex 32)      # web server and API must share it
export API_UPSTREAM=http://127.0.0.1:4000          # build- AND run-time

npm ci && npm --prefix api ci
npm --prefix api run build                          # → api/dist/main.js + api/dist/compat.js
node api/dist/main.js &                             # migrates, seeds on first start, listens on 127.0.0.1:4000
npm run build && npx next start -p 3000             # → http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `node api/dist/main.js --reset` | drop everything and re-seed the demo data |
| `node api/dist/main.js --migrate-only` | apply migrations and exit |
| `npm --prefix api run typecheck` | type-checks the API **and** the 69 compat route modules |

## Tests

The existing suites run unchanged against the backend (`BASE_URL=http://localhost:3000`). One suite is new:

```bash
API_RESTART_CMD=api/scripts/serve.sh API_LOG=/tmp/dizivat-api.log DATABASE_URL=… SESSION_SECRET=… \
  python3 scripts/api_native.py
```

It runs 306 checks: real sign-out, revocation on password change, reset and deactivation, forged tokens, lockout,
scrypt-only storage, audit rows and the append-only triggers, the R6.2 officer access window, the restore drill into a
fresh database, and that **records, preferences, views, sessions, revocations, lockouts, changed passwords and audit
ids survive an API restart**. Since R5.2 it also checks master data where it now lives — rows in `parties`, `items` and
`master_items`, none of those collections left in the snapshot, the database refusing a duplicate name, BIN or SKU that
slipped past the application checks, `delete` → `deleted_at` → undo → still deleted after a restart, a compat document's
counter and a compat import reaching `items` — and it **drills the upgrade**: `API_LOG` lets it count the adoption, and
the last section rewrites the live database back into the pre-R5.2 shape (the collections inside `compat_state`, the
deleted parties in its undo buffer, the three tables empty), restarts, and requires the same rows back, the snapshot
rewritten without them, the four registers served row for row as before, a second boot that adopts nothing again, and
writes that still land in the tables.

Since R5.3 it checks the stock documents the same way — a draft is a row with its lines and moves no stock, approving
it moves the branch split that the still-unported `stock` and ledger endpoints derive in memory, cancelling gives the
stock back, a damage write-off reaches `items.damage` and is taken back again, editing a draft replaces the line rows,
deleting one removes them and retires its number, a create that cannot be approved leaves no row, and the database
refuses a duplicate document number — and it **drills the second upgrade**: the live database is rewritten back into
the pre-R5.3 shape (both collections with their lines inside `compat_state`, the two tables empty), the API restarts,
and the same documents and lines must be back in the tables, the snapshot rewritten without them, both registers
served row for row as before, the derived stock unchanged, a second boot adopting nothing again.

It checks the sales invoices the same way — a draft is a row in `sales` with its line in `sale_lines` and moves no
stock, approving it moves the branch split and `items.sold` and is quoted by the ledger that still adds up every
document, cancelling gives both back and stores the reason on the row, the invoice's own history travels with it,
editing a draft replaces the line rows in the order they are printed, deleting one stamps the row and keeps its lines
so the next invoice takes a new number and the undo clears the stamp again, an export invoice keeps its LC, country
and foreign-currency value as columns of its own row, the proceeds recorded against it are rows with the PRC number
upper-cased and the BDT value at the rate entered (a PRC already on an invoice, or more than the invoice's outstanding
foreign-currency value, is a 422, and removing an entry frees the number again), what is still returnable is served
from those rows, a service sale is numbered in its own series and moves no stock, bulk approve takes the drafts and
reports the ones it skipped, an invoice that cannot be approved leaves no row behind, the snapshot carries no sales
collection at all, and the database refuses a duplicate invoice number — and it **drills the third upgrade**: the live
database is rewritten back into its pre-R5.3 shape (the invoices with their lines and proceeds entries inside
`compat_state`, the deleted drafts back in its undo buffer, the three tables empty), the API restarts, and the same
invoices, lines, export headers and proceeds entries must be back in the tables, the snapshot rewritten without them,
the three registers served row for row as before, an invoice deleted before the upgrade still in the undo buffer and
still undoable, the derived stock unchanged, a second boot adopting nothing again, and writes landing in the tables.

It checks the purchases the same way — a draft is a row in `purchases` with its line in `purchase_lines` and moves
no stock, approving moves the branch split and `items.purchased` and is quoted by the ledger, cancelling takes the
stock back out and stores the reason on the row, the history travels with the row, editing replaces the line rows in
the order they are printed, deleting stamps the row and keeps its lines so the next document takes a new number and
the undo clears the stamp, a goods purchase refuses to become a service one, an import purchase keeps its Bill of
Entry as columns of its own row and every line's duty (AV, CD, RD, AIT, AT) as columns of its line — the totals the
R6.4 bond register and the R6.5 drawback claims read — the bonded demo entries kept their duty foregone, a service
purchase is numbered in its own series and moves no stock, bulk approve reports what it skipped, what a debit note
may still return is served from those rows (and a service purchase has nothing to return), the snapshot carries no
purchases collection, and the database refuses a duplicate document number — and it **drills the fourth upgrade**:
the live database is rewritten back into its pre-R5.3 shape (the documents with their lines, Bills of Entry and duty
breakdowns inside `compat_state`, the deleted drafts back in its undo buffer, the two tables empty), the API
restarts, and the same documents, lines, three registers row for row, BoEs, duty columns and derived stock are
required back, with a document deleted before the upgrade still undoable and a second boot adopting nothing again.

It checks the notes the same way — a credit note is raised against an approved invoice and priced pro rata, a draft
moves no stock, approving brings the goods back and takes `items.sold` down with the branch split and the ledger that
still derive from every document, what is returnable on the invoice follows, cancelling sends the goods out again and
stores the reason on the row, a second cancellation is a 409, editing a draft replaces the line rows, a note cannot
move to another invoice, returning more than the document sold or bought is a 422, a note against a draft invoice is
a 422, deleting a draft stamps the row and keeps its lines so the next note takes a new id and a new number; and on
the debit side the two totals only a debit note has are columns of its row, returning more than the branch holds is a
409, approving takes `items.purchased` down, a service purchase has no goods to return, and cancelling puts them back
— plus the snapshot carrying neither collection, the demo notes seeded into their tables, the database refusing a
duplicate note number, and a **fifth upgrade drill**: the live database is rewritten back into its pre-R5.3 shape
(both collections with their lines inside `compat_state`, the two tables empty), the API restarts, and the same notes,
lines and registers row for row are required back, with a note deleted before the upgrade staying deleted while its
id and number stay retired, the derived stock unchanged, a second boot adopting nothing again, and writes landing in
the tables.

CI (`.github/workflows/backend.yml`, on every push to `r5-nestjs`):

1. Starts a PostgreSQL 16 service, runs the full suite plus `api_native.py`, and checks that the migrations and the compat table are current.
2. Builds the Docker image, pushes it to `ghcr.io/deshiklab/dizivat:<branch>`, and smoke-tests it against a fresh PostgreSQL
   (including that `/api/v1/health` reports the commit baked into the image).
3. On `r5-nestjs` only: deploys to production (see *Continuous deployment* below).

## Deploy: Render + Neon (free)

One Docker container runs both processes (`Dockerfile`, `docker/start.sh`): Next.js on `$PORT` and the API on
`127.0.0.1:4000`. The database is Neon, whose free plan does not expire (unlike Render's free Postgres, which is deleted after 30 days).

1. **Neon** → project → *Connect* → copy the connection string (`postgresql://…neon.tech/neondb?sslmode=require…`).
   Prefer the **direct** host (drop `-pooler` from the host name), since migrations run at start-up. `sslmode=require` and
   `channel_binding=require` are handled (upgraded to full certificate verification plus channel binding).
2. **Render** → [Deploy to Render](https://render.com/deploy?repo=https://github.com/deshiklab/dizivat/tree/r5-nestjs)
   (reads `render.yaml`: free web service, branch `r5-nestjs`, health check `/api/v1/health`). Paste the Neon string as
   `DATABASE_URL`. `SESSION_SECRET` is generated for you. Keep Render and Neon in the same region: `render.yaml` uses
   **Ohio** for a Neon project in AWS us-east-2 (pick Singapore for ap-southeast-1, and so on).
3. The first deploy builds the image, migrates and seeds Neon, then serves `https://dizivat-r5.onrender.com` (or the name Render assigns).

Free-plan notes:
- The service sleeps after 15 minutes idle; the first request then takes about a minute.
- Data lives in Neon, so it survives sleeps and redeploys.
- If a build ever runs out of memory, set the service to deploy the prebuilt image `ghcr.io/deshiklab/dizivat:r5-nestjs` instead (the package must be public: GitHub → Packages → dizivat → Package settings → Change visibility).

## Continuous deployment (GitHub Actions → Render)

Every push to **`r5-nestjs`** (the branch the Render service tracks) goes live automatically once it is proven good:

```
push r5-nestjs ─▶ Backend workflow: full browser suite on NestJS + PostgreSQL ─▶ Docker image → GHCR + smoke test
                                                                                        │
                  CI workflow (lint, types, mock E2E, visual, a11y, perf) ── green? ────┤  deploy job waits for it
                                                                                        ▼
                     still the branch head? ─▶ Render deploy hook ─▶ wait until live /api/v1/health reports this commit
                                                                                        ▼
                     smoke tests on https://dizivat-r5.onrender.com ─▶ GitHub "production" environment shows the deploy
```

- **Gates:** nothing deploys unless the Backend run (all E2E suites against PostgreSQL, the backend checks and the
  image smoke test) **and** the CI workflow for the same commit pass. A red run never reaches production.
- **Newest wins:** the hook builds the branch head, so a run whose commit is no longer the head skips the deploy;
  the newer commit's own run deploys after its tests. Deploys never overlap (`concurrency: render-production`).
- **Proof it is live:** `/api/v1/health` returns `commit` (Render's `RENDER_GIT_COMMIT`; the GHCR image bakes
  `GIT_COMMIT`). The job waits up to 40 minutes for the live service to report the tested commit, then runs
  `scripts/deploy_render.py smoke`. That script checks health and the database, the login page, sign-in, `/me`, the
  dashboard with the session (catches a `SESSION_SECRET` mismatch), the audit hash chain, the export register,
  the compliance centre and sign-out.
- **Render side:** `render.yaml` sets `autoDeployTrigger: "off"`, so untested commits are never auto-deployed.
  A Blueprint-managed service picks that up on the next sync. For a service set up by hand, set
  *Settings → Build & Deploy → Auto-Deploy* to **Off**.

**One-time setup** (repository → Settings → Secrets and variables → Actions):

| Secret | Required | Where |
|---|---|---|
| `RENDER_DEPLOY_HOOK_URL` | yes | Render → dizivat-r5 → Settings → **Deploy Hook** (`https://api.render.com/deploy/srv-…?key=…`) |
| `RENDER_API_KEY` | optional | Render → Account settings → API Keys. With it the job follows the Render build and fails fast on `build_failed` |

Without `RENDER_DEPLOY_HOOK_URL`, the *Deploy gate* job prints a warning and nothing is deployed. The tests still run.

**Release / redeploy:**
- Release a tested branch: `git push origin r6-enlistment-rmg:r5-nestjs` (fast-forward).
- Redeploy the current head with full tests: Actions → *Backend (NestJS + PostgreSQL)* → **Run workflow** on `r5-nestjs`.
- Check the live site by hand: `python3 scripts/deploy_render.py smoke --base https://dizivat-r5.onrender.com`.
- Roll back: push the earlier commit as a new commit (`git revert`), never force-push. You can also use
  Render → Deploys → **Rollback** for an immediate switch, then revert in Git so the next deploy keeps the fix.

## Roadmap (compat → relational, one module per slice)

| Slice | Moves to its own tables |
| --- | --- |
| R5.2 | **done** — customers and vendors (`parties`), items and master items (`items`, `master_items`). The stock ledger and branches' stock are *derived* from documents (there is no stored movement table), so they become relational with the documents in R5.3 |
| R5.3 | **in progress** — transfers and damage are done (`stock_documents` + `stock_document_lines`). Next: sales (6.3), purchases incl. imports/services, credit & debit notes (6.7/6.8). The stock ledger and branches' stock derive from *every* movement document, so they become relational once the rest — including R5.4's production batches — have tables |
| R5.4 | production: BOM/4.3 versions, work orders, batches (6.4), production config |
| R5.5 | accounting (accounts, receipts/payments, allocations), VAT: 9.1 returns, period lock, treasury/TR-6, VDS/6.6, adjustments — then `compat_state` and the lock are removed and the API can scale out |

Money columns will be `numeric(18,2)` (as `parties.credit_limit`, the `items` prices and `tariff_lines` already are),
quantities `numeric(18,3)` (the units allow up to three decimals), with row-level
period-lock checks in the database, plus server-side PDF (R4 used print CSS) and the NBR tariff import.
