/**
 * Boot: first start seeds PostgreSQL from the demo data set (the same one the mock and the Pages demo use);
 * later starts restore everything from PostgreSQL before the compat bundle initialises.
 */
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { gzip } from "node:zlib"
import { asc, eq, sql } from "drizzle-orm"
import { BACKUP_FORMAT, lastSlot } from "@/lib/backup-schedule"
import type { Preferences, User } from "@/lib/auth/roles"
import type { AuditEvent, CreditNote, Damage, DebitNote, Item, MasterItem, Party, Purchase, Sale, StockDoc, Transfer, Unit } from "@/lib/types"
import { hashPassword } from "./common/password"
import { db } from "./db/client"
import { auditEvents, backups, compatState, items, masterItems, meta, noteLines, notes, parties, purchaseLines, purchases, saleLines, saleRealisations, sales, stockDocumentLines, stockDocuments, tariffLines, units, users } from "./db/schema"
import { snapshot } from "./modules/backups"
import { chainValues, markPersisted, rawToEvent, sealUnchained } from "./modules/audit"
import { GENESIS_HASH } from "@/lib/integrity"
import { compatSnapshot, markSaved } from "./modules/compat"
import { toUser } from "./modules/identity"
import { itemValues, markItems, markMasters, masterValues, toItem, toMaster } from "./modules/items"
import { assembleNotes, markCreditNotes, markDebitNotes, noteLineValues, noteValues, type Note, type NoteKind } from "./modules/notes"
import { markParties, partyValues, toParty } from "./modules/parties"
import { assemblePurchases, markPurchases, purchaseLineValues, purchaseValues } from "./modules/purchases"
import { assembleSales, markSales, realisationValues, saleLineValues, saleValues } from "./modules/sales"
import { assembleStockDocs, markStockDocs, stockDocValues, stockLineValues } from "./modules/stock"
import { loadCompany, saveCompany } from "./modules/reference"
import { G, loadCompat, mirror, restoreGlobals, type TrashEntry } from "./state"
import { lockState, setEpoch } from "./common/state-guard"

export const SEED_VERSION = "r6.6"

/**
 * Demo instances re-seed when the code ships a newer demo data set (SEED_VERSION differs from the stored one) —
 * after taking a backup of everything, so the old data can still be downloaded from Settings → Backups.
 * Customer installations set DEMO_RESEED=off and keep their data across upgrades.
 */
const demoReseed = () => (process.env.DEMO_RESEED ?? "on") !== "off"

export async function bootState(log: (m: string) => void) {
  const [state] = await db.select().from(compatState).where(eq(compatState.key, "main"))
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users)
  if (state && n) {
    await sealUnchained(log) // R6: upgrade — chain the events written by R5.1
    const [v] = await db.select().from(meta).where(eq(meta.key, "seed_version"))
    if (v?.value !== SEED_VERSION && demoReseed()) {
      log(`demo data set ${v?.value ?? "?"} → ${SEED_VERSION}: backing up, then re-seeding (DEMO_RESEED=off keeps the data)`)
      await backupBeforeReseed(v?.value ?? "?", log)
      return seed(log)
    }
    return restore(state.data as { db: Record<string, unknown>; notifRead: Record<string, { ids: string[] }> }, log)
  }
  return seed(log)
}

async function seed(log: (m: string) => void) {
  const t0 = Date.now()
  const m = loadCompat() // fresh globals: demo users, company, documents, audit history
  const demoHash = await Promise.all(m.userStore.users.map(() => hashPassword(m.DEMO_PASSWORD)))
  const events = m.auditStore.events
  const snapshot = compatSnapshot()
  // R5.2: the master data goes into its own tables (`ord` keeps each collection's insertion order)
  const demoParties = [...m.db.customers, ...m.db.vendors].map((x) => partyValues(x))
  const demoItems = m.db.items.map(itemValues)
  const demoMasters = m.db.masterItems.map(masterValues)
  // R5.3: the documents — stock transfers and damage entries, the sales invoices and the purchases, each with its
  // lines. A draft the demo data set has in the undo buffer is seeded as a stamped row, so its number stays retired.
  const demoStock: StockDoc[] = [...m.db.transfers, ...m.db.damages]
  const demoStockLines = demoStock.flatMap(stockLineValues)
  const demoSaleTrash = m.db.trash.filter((t) => t.kind === "sale")
  const demoSales: Sale[] = [...m.db.sales, ...demoSaleTrash.map((t) => t.doc as Sale)]
  const demoSaleRows = [
    ...m.db.sales.map((x) => saleValues(x)),
    ...demoSaleTrash.map((t) => ({ ...saleValues(t.doc as Sale), deletedAt: new Date(t.at) })),
  ]
  const demoSaleLines = demoSales.flatMap(saleLineValues)
  const demoSaleReals = demoSales.flatMap(realisationValues)
  const demoPurchaseTrash = m.db.trash.filter((t) => t.kind === "purchase")
  const demoPurchases: Purchase[] = [...m.db.purchases, ...demoPurchaseTrash.map((t) => t.doc as Purchase)]
  const demoPurchaseRows = [
    ...m.db.purchases.map((x) => purchaseValues(x)),
    ...demoPurchaseTrash.map((t) => ({ ...purchaseValues(t.doc as Purchase), deletedAt: new Date(t.at) })),
  ]
  const demoPurchaseLines = demoPurchases.flatMap(purchaseLineValues)
  // the two note families share one table: a deleted draft the demo data set has is seeded as a stamped row, so its
  // id and its number stay retired
  const demoNotes: Note[] = [...m.db.creditNotes, ...m.db.debitNotes]
  const demoNoteRows = demoNotes.map((x) => noteValues(x))
  const demoNoteLines = demoNotes.flatMap(noteLineValues)
  const seededAt = new Date().toISOString()
  await db.transaction(async (tx) => {
    await lockState(tx, { checkEpoch: false }) // waits for any other instance's in-flight write (deploy overlap)
    // the append-only guard on audit_events lets this transaction (and only it) clear the table
    await tx.execute(sql`set local dizivat.reseed = 'on'`)
    for (const t of ["sessions", "saved_views", "login_failures", "users", "branches", "company", "units", "parties", "items", "master_items", "stock_documents", "stock_document_lines", "sales", "sale_lines", "sale_realisations", "purchases", "purchase_lines", "notes", "note_lines", "tariff_lines", "audit_events", "compat_state", "meta"])
      await tx.execute(sql.raw(`delete from ${t}`))
    await tx.insert(users).values(m.userStore.users.map((u, i) => ({
      id: u.id, username: u.username, name: u.name, designation: u.designation, initials: u.initials, email: u.email, role: u.role,
      mobile: u.mobile ?? null, department: u.department ?? null, active: u.active, mustChangePassword: !!u.mustChangePassword,
      accessUntil: u.role === "vatOfficer" ? u.accessUntil ?? null : null,
      passwordHash: demoHash[i], passwordIsDemo: true, preferences: {}, createdAt: new Date(u.createdAt),
      lastSignInAt: u.lastSignInAt ? new Date(u.lastSignInAt) : null,
    })))
    await saveCompany(tx, m.company)
    await tx.insert(units).values(m.db.units.map((u) => ({ id: u.id, code: u.code, name: u.name, decimals: u.decimals, active: u.active, createdAt: new Date(u.createdAt) })))
    for (let i = 0; i < demoParties.length; i += 500) await tx.insert(parties).values(demoParties.slice(i, i + 500))
    for (let i = 0; i < demoItems.length; i += 500) await tx.insert(items).values(demoItems.slice(i, i + 500))
    for (let i = 0; i < demoMasters.length; i += 500) await tx.insert(masterItems).values(demoMasters.slice(i, i + 500))
    for (let i = 0; i < demoStock.length; i += 500) await tx.insert(stockDocuments).values(demoStock.slice(i, i + 500).map(stockDocValues))
    for (let i = 0; i < demoStockLines.length; i += 500) await tx.insert(stockDocumentLines).values(demoStockLines.slice(i, i + 500))
    for (let i = 0; i < demoSaleRows.length; i += 500) await tx.insert(sales).values(demoSaleRows.slice(i, i + 500))
    for (let i = 0; i < demoSaleLines.length; i += 500) await tx.insert(saleLines).values(demoSaleLines.slice(i, i + 500))
    for (let i = 0; i < demoSaleReals.length; i += 500) await tx.insert(saleRealisations).values(demoSaleReals.slice(i, i + 500))
    for (let i = 0; i < demoPurchaseRows.length; i += 500) await tx.insert(purchases).values(demoPurchaseRows.slice(i, i + 500))
    for (let i = 0; i < demoPurchaseLines.length; i += 500) await tx.insert(purchaseLines).values(demoPurchaseLines.slice(i, i + 500))
    for (let i = 0; i < demoNoteRows.length; i += 500) await tx.insert(notes).values(demoNoteRows.slice(i, i + 500))
    for (let i = 0; i < demoNoteLines.length; i += 500) await tx.insert(noteLines).values(demoNoteLines.slice(i, i + 500))
    const unitSeq = (m.db.seq as Record<string, number>).unit
    await tx.execute(sql`select setval('unit_id_seq', ${unitSeq})`)
    for (let i = 0; i < m.tariff.length; i += 500)
      await tx.insert(tariffLines).values(m.tariff.slice(i, i + 500).map((t) => ({ fy: m.TARIFF_FY, ...t })))
    await tx.execute(sql`alter sequence audit_events_id_seq restart with 1`)
    let prev = GENESIS_HASH
    for (let i = 0; i < events.length; i += 500) {
      const chunk = events.slice(i, i + 500)
      const chained = chainValues(chunk.map((e) => ({
        at: new Date(e.at), day: e.day, actor: e.actor, actorId: e.actorId ?? null, entity: e.entity, entityId: e.entityId ?? null,
        ref: e.ref, action: e.action, changes: e.changes?.length ? e.changes : null, note: e.note ?? null,
      })), prev)
      prev = chained.head
      const ids = await tx.insert(auditEvents).values(chained.rows).returning({ id: auditEvents.id })
      ids.forEach((r, j) => { chunk[j].id = `a${r.id}` })
    }
    await tx.insert(compatState).values({ key: "main", data: JSON.parse(snapshot) as unknown })
    await tx.insert(meta).values([
      { key: "seed_version", value: SEED_VERSION }, { key: "seeded_at", value: seededAt }, { key: "tariff_fy", value: m.TARIFF_FY },
    ])
  })
  setEpoch(seededAt)
  markParties([...m.db.customers, ...m.db.vendors])
  markItems(m.db.items)
  markMasters(m.db.masterItems)
  markStockDocs(demoStock)
  markSales(m.db.sales)
  markPurchases(m.db.purchases)
  markCreditNotes(m.db.creditNotes)
  markDebitNotes(m.db.debitNotes)
  G.__dzAudit!.seq = events.reduce((mx, e) => Math.max(mx, Number(e.id.slice(1))), 0)
  markPersisted(events)
  markSaved(snapshot)
  log(`seeded demo data: ${m.userStore.users.length} users, ${m.db.units.length} units, ${demoParties.length} parties, ${demoItems.length} items, ${demoMasters.length} master items, ${demoStock.length} stock documents, ${m.db.sales.length} sales invoices, ${m.db.purchases.length} purchases, ${demoNotes.length} credit/debit notes, ${m.tariff.length} tariff lines, ${events.length} audit events (${Date.now() - t0} ms)`)
}

async function restore(state: { db: Record<string, unknown>; notifRead: Record<string, { ids: string[] }> }, log: (m: string) => void) {
  const t0 = Date.now()
  const userRows = await db.select().from(users).orderBy(asc(users.ord))
  const prefs: Record<string, Preferences> = {}
  const list: User[] = userRows.map((r) => { prefs[r.id] = r.preferences as Preferences; return toUser(r) })
  const unitRows: Unit[] = (await db.select().from(units).orderBy(asc(units.ord))).map((r) => ({ id: r.id, code: r.code, name: r.name, decimals: r.decimals, active: r.active, createdAt: r.createdAt.toISOString() }))
  const adopted = await adoptCompatRows(state, log)
  const partyRows = await db.select().from(parties).orderBy(asc(parties.ord))
  const live = (kind: "customer" | "vendor"): Party[] => partyRows.filter((r) => r.kind === kind && !r.deletedAt).map(toParty)
  const customers = live("customer"), vendors = live("vendor")
  const partyTrash: TrashEntry[] = partyRows.filter((r) => r.deletedAt)
    .map((r) => ({ kind: r.kind as TrashEntry["kind"], doc: toParty(r), at: r.deletedAt!.toISOString() }))
    .sort((a, b) => a.at.localeCompare(b.at))
  const itemRows: Item[] = (await db.select().from(items).orderBy(asc(items.ord))).map(toItem)
  const masterRows: MasterItem[] = (await db.select().from(masterItems).orderBy(asc(masterItems.ord))).map(toMaster)
  const stockRows: StockDoc[] = await assembleStockDocs(await db.select().from(stockDocuments).orderBy(asc(stockDocuments.ord)))
  const transfers = stockRows.filter((d): d is Transfer => d.kind === "transfer")
  const damages = stockRows.filter((d): d is Damage => d.kind === "damage")
  const saleRows = await db.select().from(sales).orderBy(asc(sales.ord))
  const stamped = new Map(saleRows.filter((r) => r.deletedAt).map((r) => [r.id, r.deletedAt!.toISOString()]))
  const allSales: Sale[] = await assembleSales(saleRows)
  const liveSales = allSales.filter((x) => !stamped.has(x.id))
  const saleTrash: TrashEntry[] = allSales.filter((x) => stamped.has(x.id))
    .map((x) => ({ kind: "sale" as const, doc: x, at: stamped.get(x.id)! }))
    .sort((a, b) => a.at.localeCompare(b.at))
  const purchaseDbRows = await db.select().from(purchases).orderBy(asc(purchases.ord))
  const stampedPurchases = new Map(purchaseDbRows.filter((r) => r.deletedAt).map((r) => [r.id, r.deletedAt!.toISOString()]))
  const allPurchases: Purchase[] = await assemblePurchases(purchaseDbRows)
  const livePurchases = allPurchases.filter((x) => !stampedPurchases.has(x.id))
  const purchaseTrash: TrashEntry[] = allPurchases.filter((x) => stampedPurchases.has(x.id))
    .map((x) => ({ kind: "purchase" as const, doc: x, at: stampedPurchases.get(x.id)! }))
    .sort((a, b) => a.at.localeCompare(b.at))
  const noteRows = await db.select().from(notes).orderBy(asc(notes.ord))
  const allNotes = await assembleNotes(noteRows.filter((r) => !r.deletedAt))
  const creditNotes = allNotes.filter((n): n is CreditNote => "saleId" in n)
  const debitNotes = allNotes.filter((n): n is DebitNote => "purchaseId" in n)
  // a note deleted before this release left no trace but its number in the audit trail; the stamped rows now hold
  // the ids, so the counter the mock keeps in `db.seq` is never lower than the highest id the table has seen
  const seq = (state.db as { seq?: Record<string, number> }).seq ?? {}
  for (const [key, prefix, list] of [["creditNote", "cn", creditNotes], ["debitNote", "dn", debitNotes]] as const) {
    const highest = noteRows.filter((r) => r.kind === (prefix === "cn" ? "credit" : "debit"))
      .reduce((m, r) => Math.max(m, Number(r.id.slice(2)) || 0), 0)
    seq[key] = Math.max(seq[key] ?? list.length, highest)
  }
  const [ep] = await db.select().from(meta).where(eq(meta.key, "seeded_at"))
  setEpoch(ep?.value)
  const raw = await db.execute(sql`select * from audit_events order by id`)
  const events: AuditEvent[] = (raw.rows as Parameters<typeof rawToEvent>[0][]).map(rawToEvent)
  restoreGlobals({
    db: state.db as never, notifRead: state.notifRead, users: list, prefs, company: await loadCompany(), units: unitRows,
    customers, vendors, partyTrash, items: itemRows, masterItems: masterRows, transfers, damages,
    sales: liveSales, saleTrash, purchases: livePurchases, purchaseTrash, creditNotes, debitNotes, events,
  })
  loadCompat()
  markParties([...mirror.parties("customer"), ...mirror.parties("vendor")])
  markItems(mirror.items())
  markMasters(mirror.masterItems())
  markStockDocs(stockRows)
  markSales(liveSales)
  markPurchases(livePurchases)
  markCreditNotes(creditNotes)
  markDebitNotes(debitNotes)
  markPersisted(events)
  const json = compatSnapshot()
  // an adopted snapshot still carries the adopted collections — replace it with the one this version writes. Under
  // the state lock, and only while the stored row is still in the older shape: another instance may have served
  // writes during this boot (rolling deploy) and its newer snapshot must not be clobbered by this one.
  if (adopted) {
    await db.transaction(async (tx) => {
      await lockState(tx)
      const [row] = await tx.select().from(compatState).where(eq(compatState.key, "main"))
      const stored = row?.data as { db?: Record<string, unknown> } | undefined
      if (stored?.db && ADOPTED.some((k) => k in stored.db!))
        await tx.update(compatState).set({ data: JSON.parse(json) as unknown, updatedAt: new Date() }).where(eq(compatState.key, "main"))
    })
  }
  markSaved(json)
  log(`restored from PostgreSQL: ${list.length} users, ${customers.length + vendors.length} parties, ${itemRows.length} items, ${masterRows.length} master items, ${stockRows.length} stock documents, ${liveSales.length} sales invoices, ${livePurchases.length} purchases, ${allNotes.length} credit/debit notes, ${events.length} audit events (${Date.now() - t0} ms)`)
}

/** The collections R5.2 and R5.3 moved out of `compat_state` into their own tables. */
const ADOPTED = ["customers", "vendors", "items", "masterItems", "transfers", "damages", "sales", "purchases",
  "creditNotes", "debitNotes"] as const

/**
 * Upgrade: a database written before these tables holds the collections inside `compat_state` (and deleted
 * parties in the undo buffer). Each is moved into its table once — customer data is never re-seeded — and the
 * snapshot is rewritten without them, so the tables are the only copy from then on. Also covers restoring an
 * older backup into a fresh database. R5.2 moved the master data, R5.3 the stock documents, the sales invoices and
 * the purchases (a deleted draft in the undo buffer becoming a `deleted_at` row).
 */
async function adoptCompatRows(state: { db: Record<string, unknown> }, log: (m: string) => void): Promise<boolean> {
  const s = state.db as {
    customers?: Party[]; vendors?: Party[]; items?: Item[]; masterItems?: MasterItem[]; transfers?: StockDoc[]
    damages?: StockDoc[]; sales?: Sale[]; purchases?: Purchase[]; creditNotes?: CreditNote[]; debitNotes?: DebitNote[]
    trash?: TrashEntry[]
  }
  if (!ADOPTED.some((k) => Array.isArray(s[k]))) return false
  const trashed = (Array.isArray(s.trash) ? s.trash : []).filter((t) => t.kind === "customer" || t.kind === "vendor")
  const partyRows = [
    ...(s.customers ?? []).map((x) => partyValues(x)),
    ...(s.vendors ?? []).map((x) => partyValues(x)),
    ...trashed.map((t) => ({ ...partyValues(t.doc as Party), deletedAt: new Date(t.at) })),
  ]
  const itemRows = (s.items ?? []).map(itemValues)
  const masterRows = (s.masterItems ?? []).map(masterValues)
  const stockDocs: StockDoc[] = [...(s.transfers ?? []), ...(s.damages ?? [])]
  const stockRows = stockDocs.map(stockDocValues)
  const stockLineRows = stockDocs.flatMap(stockLineValues)
  const trashedSales = (Array.isArray(s.trash) ? s.trash : []).filter((t) => t.kind === "sale")
  const saleDocs: Sale[] = [...(s.sales ?? []), ...trashedSales.map((t) => t.doc as Sale)]
  const saleRows = [
    ...(s.sales ?? []).map(saleValues),
    ...trashedSales.map((t) => ({ ...saleValues(t.doc as Sale), deletedAt: new Date(t.at) })),
  ]
  const saleLineRows = saleDocs.flatMap(saleLineValues)
  const saleRealRows = saleDocs.flatMap(realisationValues)
  const trashedPurchases = (Array.isArray(s.trash) ? s.trash : []).filter((t) => t.kind === "purchase")
  const purchaseDocs: Purchase[] = [...(s.purchases ?? []), ...trashedPurchases.map((t) => t.doc as Purchase)]
  const purchaseRows = [
    ...(s.purchases ?? []).map(purchaseValues),
    ...trashedPurchases.map((t) => ({ ...purchaseValues(t.doc as Purchase), deletedAt: new Date(t.at) })),
  ]
  const purchaseLineRows = purchaseDocs.flatMap(purchaseLineValues)
  const noteDocs: Note[] = [...(s.creditNotes ?? []), ...(s.debitNotes ?? [])]
  const noteRows = noteDocs.map(noteValues)
  const noteLineRows = noteDocs.flatMap(noteLineValues)
  const [{ n: haveParties }] = await db.select({ n: sql<number>`count(*)::int` }).from(parties)
  const [{ n: haveItems }] = await db.select({ n: sql<number>`count(*)::int` }).from(items)
  const [{ n: haveMasters }] = await db.select({ n: sql<number>`count(*)::int` }).from(masterItems)
  const [{ n: haveStock }] = await db.select({ n: sql<number>`count(*)::int` }).from(stockDocuments)
  const [{ n: haveSales }] = await db.select({ n: sql<number>`count(*)::int` }).from(sales)
  const [{ n: havePurchases }] = await db.select({ n: sql<number>`count(*)::int` }).from(purchases)
  const [{ n: haveNotes }] = await db.select({ n: sql<number>`count(*)::int` }).from(notes)
  const moved: string[] = [], movedDocs: string[] = []
  if ((!haveParties && partyRows.length) || (!haveItems && itemRows.length) || (!haveMasters && masterRows.length)
    || (!haveStock && stockRows.length) || (!haveSales && saleRows.length) || (!havePurchases && purchaseRows.length)
    || (!haveNotes && noteRows.length)) {
    await db.transaction(async (tx) => {
      await lockState(tx) // waits out any other instance's in-flight write; the epoch is not set yet
      if (!haveParties && partyRows.length) {
        for (let i = 0; i < partyRows.length; i += 500) await tx.insert(parties).values(partyRows.slice(i, i + 500))
        moved.push(`${partyRows.length - trashed.length} customers/vendors (+ ${trashed.length} deleted)`)
      }
      if (!haveItems && itemRows.length) {
        for (let i = 0; i < itemRows.length; i += 500) await tx.insert(items).values(itemRows.slice(i, i + 500))
        moved.push(`${itemRows.length} items`)
      }
      if (!haveMasters && masterRows.length) {
        for (let i = 0; i < masterRows.length; i += 500) await tx.insert(masterItems).values(masterRows.slice(i, i + 500))
        moved.push(`${masterRows.length} master items`)
      }
      if (!haveStock && stockRows.length) {
        for (let i = 0; i < stockRows.length; i += 500) await tx.insert(stockDocuments).values(stockRows.slice(i, i + 500))
        for (let i = 0; i < stockLineRows.length; i += 500) await tx.insert(stockDocumentLines).values(stockLineRows.slice(i, i + 500))
        movedDocs.push(`${stockRows.length} stock documents (${stockLineRows.length} lines)`)
      }
      if (!haveSales && saleRows.length) {
        for (let i = 0; i < saleRows.length; i += 500) await tx.insert(sales).values(saleRows.slice(i, i + 500))
        for (let i = 0; i < saleLineRows.length; i += 500) await tx.insert(saleLines).values(saleLineRows.slice(i, i + 500))
        for (let i = 0; i < saleRealRows.length; i += 500) await tx.insert(saleRealisations).values(saleRealRows.slice(i, i + 500))
        movedDocs.push(`${saleRows.length - trashedSales.length} sales invoices (+ ${trashedSales.length} deleted, ${saleLineRows.length} lines)`)
      }
      if (!havePurchases && purchaseRows.length) {
        for (let i = 0; i < purchaseRows.length; i += 500) await tx.insert(purchases).values(purchaseRows.slice(i, i + 500))
        for (let i = 0; i < purchaseLineRows.length; i += 500) await tx.insert(purchaseLines).values(purchaseLineRows.slice(i, i + 500))
        movedDocs.push(`${purchaseRows.length - trashedPurchases.length} purchases (+ ${trashedPurchases.length} deleted, ${purchaseLineRows.length} lines)`)
      }
      if (!haveNotes && noteRows.length) {
        for (let i = 0; i < noteRows.length; i += 500) await tx.insert(notes).values(noteRows.slice(i, i + 500))
        for (let i = 0; i < noteLineRows.length; i += 500) await tx.insert(noteLines).values(noteLineRows.slice(i, i + 500))
        const cn = (s.creditNotes ?? []).length
        movedDocs.push(`${cn} credit notes and ${(s.debitNotes ?? []).length} debit notes (${noteLineRows.length} lines)`)
      }
    })
    if (moved.length) log(`R5.2 upgrade: ${moved.join(", ")} moved out of compat_state into their own tables`)
    if (movedDocs.length) log(`R5.3 upgrade: ${movedDocs.join(", ")} moved out of compat_state into their own tables`)
  }
  return true
}

/** Pre-reseed safety net: one gzip snapshot of the database in the backups table (kept by the re-seed). */
async function backupBeforeReseed(from: string, log: (m: string) => void) {
  const { tables, counts } = await snapshot()
  const data = await promisify(gzip)(Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, at: new Date().toISOString(), storage: "postgres", reason: `before demo re-seed ${from} → ${SEED_VERSION}`, tables })))
  await db.insert(backups).values({
    kind: "manual", slot: lastSlot().slot, by: `System (before demo reset ${from} → ${SEED_VERSION})`,
    size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex"), tables: counts, data,
  })
  log(`pre-reseed backup: ${Math.round(data.byteLength / 1024)} KB`)
}
