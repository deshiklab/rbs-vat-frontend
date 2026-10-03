/**
 * The in-process world shared with the compat bundle. Native modules own users, company, units, (R5.2) the
 * parties and items and (R5.3) the stock documents, the sales invoices, the purchases and the credit and debit
 * notes in PostgreSQL, and write every change
 * through to these globals, so unported handlers (which read them)
 * see the same data. One instance per database — the compat layer is single-writer by design until R5.5 removes it.
 */
import { createRequire } from "node:module"
import { join } from "node:path"
import type { Preferences, SavedView, User } from "@/lib/auth/roles"
import type { AuditEvent, Company, CreditNote, DebitNote, Item, MasterItem, Party, Purchase, Sale, StockDoc, StockDocKind, Unit } from "@/lib/types"

export type PartyKind = "customer" | "vendor"
/** The undo buffer: deleted documents (compat state), deleted parties (R5.2) and deleted sales and purchases
 *  (R5.3), the latter three rebuilt from their table's `deleted_at`. */
export interface TrashEntry { kind: PartyKind | "sale" | "purchase"; doc: Party | Sale | Purchase; at: string }

export type CompatModule = typeof import("./compat/entry")

interface UserStore {
  users: User[]; passwords: Record<string, string>; prefs: Record<string, Preferences>
  views: Record<string, Record<string, SavedView[]>>; failures: Record<string, { n: number; until: number }>
  notifRead: Record<string, { ids: string[]; allBefore?: string }>; revokedBefore: Record<string, number>
}
interface Globals {
  __dzDb?: Record<string, unknown> & {
    units: Unit[]; customers: Party[]; vendors: Party[]; items: Item[]; masterItems: MasterItem[]
    transfers: StockDoc[]; damages: StockDoc[]; sales: Sale[]; purchases: Purchase[]
    creditNotes: CreditNote[]; debitNotes: DebitNote[]; trash: TrashEntry[]
  }
  __dzUsers?: UserStore
  __dzAudit?: { events: AuditEvent[]; seq: number }
  __dzCompany?: Company
  __dzNoDelay?: boolean
}
export const G = globalThis as unknown as Globals

let mod: CompatModule | null = null
/** Requires dist/compat.js (next to dist/main.js). Call only after the globals are restored. */
export function loadCompat(): CompatModule {
  if (!mod) {
    G.__dzNoDelay = true // the mock's artificial latency is for the browser demo only
    mod = createRequire(__filename)(join(__dirname, "compat.js")) as CompatModule
  }
  return mod
}
export const compat = (): CompatModule => {
  if (!mod) throw new Error("compat bundle not loaded")
  return mod
}

/** Restores saved state before the compat bundle initialises (its stores use `globalThis.x ??= seed()`). */
export function restoreGlobals(s: {
  db: Record<string, unknown>; notifRead: UserStore["notifRead"]; users: User[]; prefs: Record<string, Preferences>; company: Company
  units: Unit[]; customers: Party[]; vendors: Party[]; partyTrash: TrashEntry[]; items: Item[]; masterItems: MasterItem[]
  transfers: StockDoc[]; damages: StockDoc[]; sales: Sale[]; saleTrash: TrashEntry[]
  purchases: Purchase[]; purchaseTrash: TrashEntry[]
  creditNotes: CreditNote[]; debitNotes: DebitNote[]; events: AuditEvent[]
}) {
  // documents only: an older snapshot's deleted parties, sales and purchases are rebuilt from their `deleted_at` rows
  const docsTrash = ((s.db as { trash?: TrashEntry[] }).trash ?? [])
    .filter((t) => t.kind !== "customer" && t.kind !== "vendor" && t.kind !== "sale" && t.kind !== "purchase")
  G.__dzDb = {
    ...s.db, units: s.units, customers: s.customers, vendors: s.vendors, items: s.items, masterItems: s.masterItems,
    transfers: s.transfers, damages: s.damages, sales: s.sales, purchases: s.purchases,
    creditNotes: s.creditNotes, debitNotes: s.debitNotes,
    trash: [...docsTrash, ...s.partyTrash, ...s.saleTrash, ...s.purchaseTrash],
  }
  G.__dzUsers = { users: s.users, passwords: {}, prefs: s.prefs, views: {}, failures: {}, notifRead: s.notifRead ?? {}, revokedBefore: {} }
  G.__dzAudit = { events: s.events, seq: s.events.reduce((m, e) => Math.max(m, Number(e.id.slice(1)) || 0), 0) }
  G.__dzCompany = s.company
}

/* ── write-through mirror (mutate in place: the compat modules hold references) ── */

const replaceObject = <T extends object>(target: T, next: T) => {
  for (const k of Object.keys(target)) delete (target as Record<string, unknown>)[k]
  Object.assign(target, next)
}

export const mirror = {
  users: (): User[] => G.__dzUsers!.users,
  findUser: (id: string) => G.__dzUsers!.users.find((u) => u.id === id),
  findUserByName: (name: string) => G.__dzUsers!.users.find((u) => u.name === name),
  putUser(u: User, prefs: Preferences) {
    const list = G.__dzUsers!.users
    const cur = list.find((x) => x.id === u.id)
    if (cur) replaceObject(cur, u)
    else list.push(u)
    G.__dzUsers!.prefs[u.id] = prefs
    return cur ?? u
  },
  company: (): Company => G.__dzCompany!,
  putCompany: (c: Company) => replaceObject(G.__dzCompany!, c),
  units: (): Unit[] => G.__dzDb!.units,
  putUnits(list: Unit[]) { const u = G.__dzDb!.units; u.splice(0, u.length, ...list) },
  /** R5.2: the live parties of one kind — the array the unported handlers read (mutated in place) */
  parties: (kind: PartyKind): Party[] => (kind === "customer" ? G.__dzDb!.customers : G.__dzDb!.vendors),
  putParties(kind: PartyKind, list: Party[]) { const a = mirror.parties(kind); a.splice(0, a.length, ...list) },
  findParty: (kind: PartyKind, id: string) => mirror.parties(kind).find((p) => p.id === id),
  putParty(p: Party) {
    const list = mirror.parties(p.kind)
    const cur = list.find((x) => x.id === p.id)
    if (cur) replaceObject(cur, p)
    else list.push(p)
    return cur ?? p
  },
  removeParty(kind: PartyKind, id: string) {
    const list = mirror.parties(kind)
    const i = list.findIndex((x) => x.id === id)
    return i < 0 ? undefined : list.splice(i, 1)[0]
  },
  /** R5.2: the SKUs — documents move their counters, the register lists them */
  items: (): Item[] => G.__dzDb!.items,
  putItems(list: Item[]) { const a = mirror.items(); a.splice(0, a.length, ...list) },
  findItem: (id: string) => mirror.items().find((i) => i.id === id),
  putItem(it: Item) {
    const list = mirror.items()
    const cur = list.find((x) => x.id === it.id)
    if (cur) replaceObject(cur, it)
    else list.push(it)
    return cur ?? it
  },
  removeItem(id: string) {
    const list = mirror.items()
    const i = list.findIndex((x) => x.id === id)
    return i < 0 ? undefined : list.splice(i, 1)[0]
  },
  /** R5.2: the HS-code master items (a SKU references one by name) */
  masterItems: (): MasterItem[] => G.__dzDb!.masterItems,
  putMasterItems(list: MasterItem[]) { const a = mirror.masterItems(); a.splice(0, a.length, ...list) },
  findMasterItem: (id: string) => mirror.masterItems().find((m) => m.id === id),
  putMasterItem(m: MasterItem) {
    const list = mirror.masterItems()
    const cur = list.find((x) => x.id === m.id)
    if (cur) replaceObject(cur, m)
    else list.push(m)
    return cur ?? m
  },
  /** R5.3: the live sales invoices — every register, the ledger, the branch stock and the VAT returns read them */
  sales: (): Sale[] => G.__dzDb!.sales,
  putSales(list: Sale[]) { const a = mirror.sales(); a.splice(0, a.length, ...list) },
  findSale: (idOrNo: string) => mirror.sales().find((s) => s.id === idOrNo || s.invoiceNo === idOrNo),
  putSale(sale: Sale) {
    const list = mirror.sales()
    const cur = list.find((x) => x.id === sale.id)
    if (cur) replaceObject(cur, sale)
    else list.push(sale)
    return cur ?? sale
  },
  removeSale(id: string) {
    const list = mirror.sales()
    const i = list.findIndex((x) => x.id === id)
    return i < 0 ? undefined : list.splice(i, 1)[0]
  },
  /** R5.3: the live purchases — the ledger, the branch stock, the debit notes and the bond register read them */
  purchases: (): Purchase[] => G.__dzDb!.purchases,
  putPurchases(list: Purchase[]) { const a = mirror.purchases(); a.splice(0, a.length, ...list) },
  findPurchase: (idOrNo: string) => mirror.purchases().find((p) => p.id === idOrNo || p.invoiceNo === idOrNo),
  putPurchase(p: Purchase) {
    const list = mirror.purchases()
    const cur = list.find((x) => x.id === p.id)
    if (cur) replaceObject(cur, p)
    else list.push(p)
    return cur ?? p
  },
  removePurchase(id: string) {
    const list = mirror.purchases()
    const i = list.findIndex((x) => x.id === id)
    return i < 0 ? undefined : list.splice(i, 1)[0]
  },
  /** R5.3: the credit notes — what is still returnable on an invoice, a customer's credit and the VAT return read them */
  creditNotes: (): CreditNote[] => G.__dzDb!.creditNotes,
  putCreditNotes(list: CreditNote[]) { const a = mirror.creditNotes(); a.splice(0, a.length, ...list) },
  findCreditNote: (idOrNo: string) => mirror.creditNotes().find((n) => n.id === idOrNo || n.no === idOrNo),
  putCreditNote(n: CreditNote) {
    const list = mirror.creditNotes()
    const cur = list.find((x) => x.id === n.id)
    if (cur) replaceObject(cur, n)
    else list.push(n)
    return cur ?? n
  },
  removeCreditNote(id: string) {
    const list = mirror.creditNotes()
    const i = list.findIndex((x) => x.id === id)
    return i < 0 ? undefined : list.splice(i, 1)[0]
  },
  /** R5.3: the debit notes — what is still returnable on a purchase and the input tax a period reverses */
  debitNotes: (): DebitNote[] => G.__dzDb!.debitNotes,
  putDebitNotes(list: DebitNote[]) { const a = mirror.debitNotes(); a.splice(0, a.length, ...list) },
  findDebitNote: (idOrNo: string) => mirror.debitNotes().find((n) => n.id === idOrNo || n.no === idOrNo),
  putDebitNote(n: DebitNote) {
    const list = mirror.debitNotes()
    const cur = list.find((x) => x.id === n.id)
    if (cur) replaceObject(cur, n)
    else list.push(n)
    return cur ?? n
  },
  removeDebitNote(id: string) {
    const list = mirror.debitNotes()
    const i = list.findIndex((x) => x.id === id)
    return i < 0 ? undefined : list.splice(i, 1)[0]
  },
  /** R5.3: the stock documents of one kind — the branch-stock split and an item's ledger derive from them */
  stockDocs: (kind: StockDocKind): StockDoc[] => (kind === "transfer" ? G.__dzDb!.transfers : G.__dzDb!.damages),
  putStockDocs(kind: StockDocKind, list: StockDoc[]) { const a = mirror.stockDocs(kind); a.splice(0, a.length, ...list) },
  findStockDoc: (kind: StockDocKind, id: string) => mirror.stockDocs(kind).find((d) => d.id === id || d.no === id),
  putStockDoc(d: StockDoc) {
    const list = mirror.stockDocs(d.kind)
    const cur = list.find((x) => x.id === d.id)
    if (cur) replaceObject(cur, d)
    else list.push(d)
    return cur ?? d
  },
  removeStockDoc(kind: StockDocKind, id: string) {
    const list = mirror.stockDocs(kind)
    const i = list.findIndex((x) => x.id === id)
    return i < 0 ? undefined : list.splice(i, 1)[0]
  },
  /** Deleted documents and parties (the 10-second undo); party entries mirror `parties.deleted_at`. */
  trash: (): TrashEntry[] => G.__dzDb!.trash,
  audit: () => G.__dzAudit!,
}
