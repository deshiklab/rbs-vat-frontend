/**
 * R5.3 — sales invoices on their own tables: the first revenue document out of the compat layer. A sale is a header
 * with priced lines; it moves stock only once approved, and a service sale moves nothing at all.
 *
 * As with the parties, the items and the stock documents, the rules are the mock's own (src/app/api/v1/_r3.ts and
 * _docs.ts, reused through the compat bundle): what a body may contain, how the lines are priced, the invoice and
 * challan numbers, the export / deemed-export checks, the stock and finished-goods-lot checks around approving and
 * cancelling, the notes and settlements that block a cancellation, the proceeds (PRC) entries an export invoice
 * takes, the register's spec and its CSV columns all come from the same code the Next.js mock and the static demo
 * run, so the responses, error codes and audit events cannot drift. What changed is underneath:
 *   - an invoice is a row in `sales` with its lines in `sale_lines` and its proceeds entries in
 *     `sale_realisations`, so a customer's turnover, an item's ledger and the branch split can be summed in SQL
 *     instead of walked in memory;
 *   - the export shipping documents are columns of the invoice, so an LC, a country or an FC value is queryable;
 *   - the invoice number is unique in the database as well, so two requests cannot share one;
 *   - a deleted draft is a row with `deleted_at` — its number stays retired and the undo restores the row;
 *   - the item counters an approval moves (`sold`) are written with the invoice, in the same transaction;
 *   - every write goes through the state guard, and the in-memory copies stay in step: the branch stock, the
 *     ledger, the credit notes, the settlements and the VAT returns still read *every* document, and the ones
 *     without tables yet (purchases, production, opening entries) are compat state until R5.3–R5.4 finish.
 */
import { Controller, Delete, Get, Inject, Injectable, Param, Patch, Post, Put, Req, Res } from "@nestjs/common"
import { asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm"
import type { Request, Response } from "express"
import { can, ROLE_PERMS, type Permission, type User } from "@/lib/auth/roles"
import { runQuery, toCSV } from "@/lib/mock/query"
import { cancelInput } from "@/lib/schemas"
import type { ExportInfo, Item, Line, Realisation, Sale } from "@/lib/types"
import { Authed, type AuthedRequest } from "../common/auth"
import { jsonBody, parse, Problem, searchParams, sendCsv, uniqueViolation } from "../common/http"
import { lockState } from "../common/state-guard"
import { WriteBack, type Delta } from "../common/writeback"
import { db, type Tx } from "../db/client"
import { items, saleLines, saleRealisations, sales } from "../db/schema"
import { compat, mirror } from "../state"
import { AuditService } from "./audit"
import { markItems, revertItemCounters } from "./items"

type SaleDb = typeof sales.$inferSelect
type LineDb = typeof saleLines.$inferSelect
type RealDb = typeof saleRealisations.$inferSelect
/** What a new invoice is given inside the state lock: its id and the two numbers it occupies. */
export type SaleIdentity = { id: string; invoiceNo: string; challanNo: string }
const today = () => new Date().toISOString().slice(0, 10)
const LABEL = "Sales invoice"
/** The mock's deny(): 403 naming the permission the role lacks — for the second permission a route needs. */
const deny = (user: User, perm: Permission) => {
  if (!can(ROLE_PERMS[user.role], perm)) throw new Problem(403, `Your role (${user.role}) is not allowed to do this (${perm}).`)
}

/* ── mappers ───────────────────────────────────────────────────────────── */

/** Row → invoice line (the contract shape). A NULL batch is a line that ships no finished-goods lot. */
export const toSaleLine = (r: LineDb): Line => {
  const l: Line = {
    itemId: r.itemId, name: r.name, hsCode: r.hsCode, uom: r.uom, qty: r.qty, price: r.price,
    sdRate: r.sdRate, vatRate: r.vatRate, subtotal: r.subtotal, sd: r.sd, vat: r.vat, total: r.total,
  }
  if (r.batchId != null) { l.batchId = r.batchId; l.batchNo = r.batchNo ?? undefined }
  return l
}

/** Row → proceeds entry. `note` and `batchId` stay out of the response when the entry has neither. */
export const toRealisation = (r: RealDb): Realisation => {
  const x: Realisation = {
    id: r.id, date: r.date, bank: r.bank, prcNo: r.prcNo, fcAmount: r.fcAmount, rate: r.rate, bdt: r.bdt,
    by: r.by, at: r.at.toISOString(),
  }
  if (r.note != null) x.note = r.note
  if (r.batchId != null) x.batchId = r.batchId
  return x
}

/**
 * The export / deemed-export block, from its own columns. `exportDeemed` is the presence marker: an invoice with
 * none has NULL there, and the key stays out of the response exactly as the mock leaves it out.
 */
function toExport(r: SaleDb, realisations: Realisation[]): ExportInfo {
  const e: ExportInfo = {
    deemed: r.exportDeemed!, lcNo: r.exportLcNo!, lcDate: r.exportLcDate!,
    customsHouse: r.exportCustomsHouse ?? "", country: r.exportCountry ?? "",
    billNo: r.exportBillNo ?? "", billDate: r.exportBillDate ?? "", shippingAddress: r.exportShippingAddress ?? "",
  }
  if (r.exportCnfFirm != null) e.cnfFirm = r.exportCnfFirm
  if (r.exportUdNo != null) e.udNo = r.exportUdNo
  if (r.exportUdDate != null) e.udDate = r.exportUdDate
  if (r.exportExpNo != null) e.expNo = r.exportExpNo
  if (r.exportCurrency != null) e.currency = r.exportCurrency
  if (r.exportFcValue != null) e.fcValue = r.exportFcValue
  if (r.exportExchangeRate != null) e.exchangeRate = r.exportExchangeRate
  if (r.exportExporterBond != null) e.exporterBond = r.exportExporterBond
  // the array is present once an invoice has taken a proceeds entry, even if the entry was removed again
  if (r.exportRealisations) e.realisations = realisations
  if (r.exportOwnUdNo != null) e.ownUdNo = r.exportOwnUdNo
  return e
}

/** Header row + its lines + its proceeds entries → contract shape. A NULL column is an absent optional field. */
export function toSale(r: SaleDb, lines: Line[], realisations: Realisation[]): Sale {
  const s: Sale = {
    id: r.id, createdAt: r.createdAt.toISOString(), issueDate: r.issueDate, process: r.process, method: r.method,
    subtotal: r.subtotal, sd: r.sd, vat: r.vat, discount: r.discount, netTotal: r.netTotal, paid: r.paid, due: r.due,
    lines, issuedBy: r.issuedBy, designation: r.designation, branchId: r.branchId, branchName: r.branchName,
    invoiceNo: r.invoiceNo, challanNo: r.challanNo, issueTime: r.issueTime,
    customerId: r.customerId, customerName: r.customerName, customerBin: r.customerBin,
    customerAddress: r.customerAddress, deliveryAddress: r.deliveryAddress, mode: r.mode, vds: r.vds,
  }
  if (r.category != null) s.category = r.category
  if (r.vehicle != null) s.vehicle = r.vehicle
  if (r.narration != null) s.narration = r.narration
  if (r.updatedAt) s.updatedAt = r.updatedAt.toISOString()
  if (r.cancelReason != null) s.cancelReason = r.cancelReason
  s.history = r.history ?? []
  if (r.exportDeemed != null) s.export = toExport(r, realisations)
  return s
}

/** Contract shape → header row values (`ord` and `deletedAt` are the table's own). */
export const saleValues = (s: Sale) => {
  const e = s.export
  return {
    id: s.id, invoiceNo: s.invoiceNo, challanNo: s.challanNo, issueDate: s.issueDate, issueTime: s.issueTime,
    process: s.process, category: s.category ?? null, branchId: s.branchId, branchName: s.branchName,
    customerId: s.customerId, customerName: s.customerName, customerBin: s.customerBin,
    customerAddress: s.customerAddress, deliveryAddress: s.deliveryAddress, vehicle: s.vehicle ?? null,
    mode: s.mode, method: s.method, vds: s.vds,
    subtotal: s.subtotal, sd: s.sd, vat: s.vat, discount: s.discount, netTotal: s.netTotal, paid: s.paid, due: s.due,
    issuedBy: s.issuedBy, designation: s.designation, narration: s.narration ?? null,
    createdAt: new Date(s.createdAt), updatedAt: s.updatedAt ? new Date(s.updatedAt) : null,
    cancelReason: s.cancelReason ?? null, history: s.history ?? null,
    exportDeemed: e ? e.deemed : null, exportLcNo: e ? e.lcNo : null, exportLcDate: e ? e.lcDate : null,
    exportCustomsHouse: e?.customsHouse ?? null, exportCountry: e?.country ?? null,
    exportBillNo: e?.billNo ?? null, exportBillDate: e?.billDate ?? null,
    exportShippingAddress: e?.shippingAddress ?? null, exportCnfFirm: e?.cnfFirm ?? null,
    exportUdNo: e?.udNo ?? null, exportUdDate: e?.udDate ?? null, exportExpNo: e?.expNo ?? null,
    exportCurrency: e?.currency ?? null, exportFcValue: e?.fcValue ?? null, exportExchangeRate: e?.exchangeRate ?? null,
    exportExporterBond: e?.exporterBond ?? null, exportOwnUdNo: e?.ownUdNo ?? null,
    exportRealisations: !!e?.realisations,
  }
}

/** The invoice's lines as child rows, in the order they are printed. */
export const saleLineValues = (s: Sale) => s.lines.map((l, i) => ({
  saleId: s.id, ord: i + 1, itemId: l.itemId, name: l.name, hsCode: l.hsCode, uom: l.uom, qty: l.qty, price: l.price,
  sdRate: l.sdRate, vatRate: l.vatRate, subtotal: l.subtotal, sd: l.sd, vat: l.vat, total: l.total,
  batchId: l.batchId ?? null, batchNo: l.batchNo ?? null,
}))

/** The invoice's proceeds entries as child rows, in the order they were posted. */
export const realisationValues = (s: Sale) => (s.export?.realisations ?? []).map((r, i) => ({
  id: r.id, saleId: s.id, ord: i + 1, date: r.date, bank: r.bank, prcNo: r.prcNo, fcAmount: r.fcAmount,
  rate: r.rate, bdt: r.bdt, note: r.note ?? null, by: r.by, at: new Date(r.at), batchId: r.batchId ?? null,
}))

/* ── write-back: what the unported handlers changed ─────────────────────── */

/**
 * The invoices are rows now, but the in-memory copies stay: the branch stock, an item's ledger, a customer's credit,
 * the credit notes, the settlements and every VAT return derive from all of them, together with the documents that
 * are still compat state. A compat handler that writes through the mock's array — a bank file posting proceeds
 * (R6.6), a restored backup — is written back here. See common/writeback.ts.
 */
const saleWb = new WriteBack<Sale>("sales", () => mirror.sales(), (s) => s.id)
export type SaleDelta = Delta<Sale>
export const markSales = (list: Sale[]) => saleWb.mark(list)
export const forgetSale = (id: string) => saleWb.forget(id)
export const saleDelta = () => saleWb.delta()
export const commitSaleDelta = (d: SaleDelta) => saleWb.commit(d)

/**
 * Applies a delta inside the persist transaction and reads the saved invoice back into memory, so a value a column
 * type rounded (money is numeric(18,2), quantities numeric(18,3)) is not rewritten on every request.
 *
 * An invoice that left the in-memory list was deleted by a handler that still runs the mock's code (a restored
 * backup, the demo runtime): it is in the undo buffer, so the row is stamped exactly as the native delete stamps
 * it, and the write-back forgets it — restoring it later counts as an insert again. Anything else that vanishes is
 * put back from its last persisted shape, because the table is authoritative.
 */
export async function applySaleDelta(tx: Tx, d: SaleDelta) {
  for (const sale of [...d.insert, ...d.update]) {
    // an invoice back in the live list is not deleted: an insert clears the stamp a compat delete may have set
    const values = d.insert.includes(sale) ? { ...saleValues(sale), deletedAt: null } : saleValues(sale)
    const [row] = await tx.insert(sales).values(values)
      .onConflictDoUpdate({ target: sales.id, set: values }).returning()
    mirror.putSale(await replaceChildren(tx, sale, row))
  }
  for (const id of d.missing) {
    const entry = mirror.trash().find((t) => t.kind === "sale" && t.doc.id === id)
    if (entry) {
      const sale = entry.doc as Sale
      await tx.update(sales).set({ ...saleValues(sale), deletedAt: new Date(entry.at) }).where(eq(sales.id, id))
      saleWb.forget(id)
      continue
    }
    const sale = saleWb.stored(id)
    if (!sale) continue
    mirror.putSale(sale)
    console.warn(`[sales] ${id} vanished from the in-memory state — restored from the table copy`)
  }
}

/** Replaces an invoice's lines and proceeds entries with the ones it carries now, and reads all three back. */
async function replaceChildren(tx: Tx, sale: Sale, row: SaleDb): Promise<Sale> {
  await tx.delete(saleLines).where(eq(saleLines.saleId, sale.id))
  await tx.delete(saleRealisations).where(eq(saleRealisations.saleId, sale.id))
  const lineRows = saleLineValues(sale)
  const lines = lineRows.length ? (await tx.insert(saleLines).values(lineRows).returning()).map(toSaleLine) : []
  const realRows = realisationValues(sale)
  const reals = realRows.length ? (await tx.insert(saleRealisations).values(realRows).returning()).map(toRealisation) : []
  return toSale(row, lines, reals)
}

/** Header rows + their lines and proceeds entries → invoices, in the rows' order (the service and boot share it). */
export async function assembleSales(rows: SaleDb[]): Promise<Sale[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const [lineRows, realRows] = await Promise.all([
    db.select().from(saleLines).where(inArray(saleLines.saleId, ids)).orderBy(asc(saleLines.saleId), asc(saleLines.ord)),
    db.select().from(saleRealisations).where(inArray(saleRealisations.saleId, ids))
      .orderBy(asc(saleRealisations.saleId), asc(saleRealisations.ord)),
  ])
  const lines = new Map<string, Line[]>()
  for (const l of lineRows) {
    const a = lines.get(l.saleId) ?? []
    a.push(toSaleLine(l))
    lines.set(l.saleId, a)
  }
  const reals = new Map<string, Realisation[]>()
  for (const r of realRows) {
    const a = reals.get(r.saleId) ?? []
    a.push(toRealisation(r))
    reals.set(r.saleId, a)
  }
  return rows.map((r) => toSale(r, lines.get(r.id) ?? [], reals.get(r.id) ?? []))
}

/** The SKUs an approval moves (`Item.sold`); service lines carry a code that is not a SKU, so they are skipped. */
const captureCounters = (s: Sale) => s.lines.map((l) => mirror.findItem(l.itemId)).filter((it): it is Item => !!it)
async function writeCounters(tx: Tx, list: Item[]) {
  for (const it of list) await tx.update(items).set({ sold: it.sold }).where(eq(items.id, it.id))
}

/* ── service ───────────────────────────────────────────────────────────── */

@Injectable()
export class SalesService {
  /** Every live invoice in insertion order — the order the mock's array had. */
  async all(): Promise<Sale[]> {
    return assembleSales(await db.select().from(sales).where(isNull(sales.deletedAt)).orderBy(asc(sales.ord)))
  }

  /** One invoice by id or by invoice number: the registers, the ledger and the audit trail link both. */
  find(idOrNo: string) {
    return this.first(sql`(${sales.id} = ${idOrNo} or ${sales.invoiceNo} = ${idOrNo}) and ${sales.deletedAt} is null`)
  }

  /** One live invoice by id only — what the proceeds entries and a delete match on. */
  byId(id: string) {
    return this.first(sql`${sales.id} = ${id} and ${sales.deletedAt} is null`)
  }

  /** A draft in the undo buffer, by id. */
  trashedById(id: string) {
    return this.first(sql`${sales.id} = ${id} and ${sales.deletedAt} is not null`)
  }

  private async first(match: SQL) {
    const rows = await db.select().from(sales).where(match)
    return rows.length ? (await assembleSales(rows))[0] : undefined
  }

  /**
   * Stores a new invoice with its lines. `make` builds it once the id and the numbers are known — inside the lock,
   * so two creates in flight cannot share an invoice number. The counters an approval moves are written with it.
   */
  async create(category: string, issueDate: string, make: (ident: SaleIdentity) => Sale): Promise<Sale> {
    let made: Sale | undefined
    let counters: Item[] = []
    try {
      const saved = await db.transaction(async (tx) => {
        await lockState(tx)
        made = make(compat().saleIdentity(category, issueDate))
        // claimed in memory first: a compat persist running mid-insert must not adopt the invoice twice
        mirror.putSale(made)
        counters = captureCounters(made)
        const [row] = await tx.insert(sales).values(saleValues(made)).returning()
        await writeCounters(tx, counters)
        return replaceChildren(tx, made, row)
      })
      mirror.putSale(saved)
      markSales([saved])
      markItems(counters)
      return saved
    } catch (e) {
      if (made) { mirror.removeSale(made.id); forgetSale(made.id) }
      await revertItemCounters(counters.map((it) => it.id))
      SalesService.noConflict(e)
    }
  }

  /** Replaces an invoice, its lines and its proceeds entries, and writes the counters in the same transaction. */
  async update(sale: Sale): Promise<Sale> {
    const counters = captureCounters(sale)
    try {
      const saved = await db.transaction(async (tx) => {
        await lockState(tx)
        const [row] = await tx.update(sales).set(saleValues(sale)).where(eq(sales.id, sale.id)).returning()
        if (!row) throw new Problem(404, `${LABEL} not found`)
        await writeCounters(tx, counters)
        return replaceChildren(tx, sale, row)
      })
      mirror.putSale(saved)
      markSales([saved])
      markItems(counters)
      return saved
    } catch (e) {
      await revertItemCounters(counters.map((it) => it.id))
      throw e as Error
    }
  }

  /**
   * Soft delete: the row and its lines stay (the number is retired, the audit trail quotes the invoice) and the
   * stamped copy becomes the undo buffer's entry, exactly as the mock's trash did.
   */
  async remove(sale: Sale, at: string) {
    await db.transaction(async (tx) => {
      await lockState(tx)
      await tx.update(sales).set({ ...saleValues(sale), deletedAt: new Date(at) }).where(eq(sales.id, sale.id))
    })
    mirror.removeSale(sale.id)
    mirror.trash().push({ kind: "sale", doc: sale, at })
    forgetSale(sale.id)
  }

  /** Clears the stamp: the draft is back in the register with its number, its lines and its history. */
  async restore(sale: Sale): Promise<Sale> {
    let row: SaleDb | undefined
    try {
      ;[row] = await db.transaction(async (tx) => {
        await lockState(tx)
        return tx.update(sales).set({ ...saleValues(sale), deletedAt: null }).where(eq(sales.id, sale.id)).returning()
      })
    } catch (e) {
      SalesService.noConflict(e)
    }
    if (!row) throw new Problem(404, `${LABEL} not found in trash`)
    const saved = (await assembleSales([row]))[0]
    const i = mirror.trash().findIndex((t) => t.kind === "sale" && t.doc.id === sale.id)
    if (i >= 0) mirror.trash().splice(i, 1)
    mirror.putSale(saved)
    markSales([saved])
    return saved
  }

  /** A duplicate invoice number the application check missed (two requests at once) is a 409, not a 500. */
  private static noConflict(e: unknown): never {
    if (uniqueViolation(e) !== null) throw new Problem(409, "That invoice number was just taken — please try again.")
    throw e as Error
  }
}

/* ── controller ────────────────────────────────────────────────────────── */

/**
 * The eleven sale endpoints. The behaviour is shared with the mock handlers (see the header); this class only adds
 * storage, the state guard and the audit trail.
 */
@Controller("api/v1/sales")
export class SalesController {
  constructor(
    @Inject(SalesService) private readonly svc: SalesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** The register: Page<Sale> with facets and customer labels, or CSV. Goods by default, `?category=` for the rest. */
  @Get() @Authed()
  async list(@Req() req: Request, @Res() res: Response) {
    const c = compat()
    const sp = searchParams(req)
    if (!sp.get("sort")) sp.set("sort", "createdAt.desc")
    const r = runQuery(c.saleCategory(sp, await this.svc.all()), sp, c.saleSpec)
    if (sp.get("format") === "csv") {
      sendCsv(res, toCSV(c.saleCsvRows(r.all, sp.get("ids")), c.saleCsvColumns), `sales-${today()}.csv`)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    res.json({ ...page, facetLabels: c.saleFacetLabels() })
  }

  /** Create a draft, or create and approve it in one step (which needs the approve permission and the stock). */
  @Post() @Authed("doc.create")
  async create(@Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const r = c.parseSale(jsonBody(req))
    if ("status" in r) throw new Problem(r.status, r.title, r.errors)
    const user = req.dz!.user
    const approving = r.data.process === "Approved"
    if (approving) {
      deny(user, "doc.approve")
      // before the invoice exists: a create that cannot be approved must not consume a number
      const short = c.saleStockRule(r.fields.lines, r.fields.branchId, undefined, 422)
      if (short) throw new Problem(short.status, short.title, short.errors)
    }
    const at = new Date().toISOString()
    const sale = await this.svc.create(r.data.category, r.data.issueDate, (ident) => {
      const s: Sale = { ...r.fields, ...ident, createdAt: at, process: "Created", history: [] }
      c.stampDocHistory(s, user.name, "created", undefined, at)
      if (approving) {
        s.process = "Approved"
        c.postStock("sale", s.lines, 1)
        c.stampDocHistory(s, user.name, "approved")
      }
      return s
    })
    await this.audit.record({ at, actor: user, entity: "sale", entityId: sale.id, ref: sale.invoiceNo, action: "created" })
    const approved = sale.history?.find((h) => h.action === "approved")
    if (approved) await this.audit.record({ at: approved.at, actor: user, entity: "sale", entityId: sale.id, ref: sale.invoiceNo, action: "approved" })
    res.status(201).json(sale)
  }

  /** Bulk approve — skips rows that are not drafts, sit in a locked period or lack stock, and reports them.
   *  Answers 200, not the 201 a POST defaults to: nothing is created here, the mock answered 200. */
  @Post("bulk") @Authed("doc.approve")
  async bulk(@Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const { ids, action } = jsonBody(req) as { ids?: string[]; action?: string }
    if (!ids?.length || action !== "approve") throw new Problem(400, "ids[] and action=approve required")
    const user = req.dz!.user
    const done: string[] = [], skipped: string[] = []
    for (const id of ids) {
      const d = await this.svc.byId(id)
      if (!d || d.process !== "Created" || c.periodLocked(d.issueDate) || c.approveRule("sale", d)) { skipped.push(id); continue }
      const at = new Date().toISOString()
      const next = structuredClone(d)
      next.process = "Approved"
      c.postStock("sale", next.lines, 1)
      c.stampDocHistory(next, user.name, "approved", undefined, at)
      const saved = await this.svc.update(next)
      await this.audit.record({ at, actor: user, entity: "sale", entityId: saved.id, ref: saved.invoiceNo, action: "approved" })
      done.push(id)
    }
    res.status(200).json({ done, skipped })
  }

  @Get(":id") @Authed()
  async one(@Param("id") id: string, @Res() res: Response) {
    const d = await this.svc.find(id)
    if (!d) throw new Problem(404, `${LABEL} not found`)
    res.json(d)
  }

  /** Edit a draft (full replacement). Optional approve-on-save. */
  @Put(":id") @Authed("doc.edit")
  async update(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const cur = await this.svc.find(id)
    if (!cur) throw new Problem(404, `${LABEL} not found`)
    const draft = c.editDraftRule(cur)
    if (draft) throw new Problem(draft.status, draft.title, draft.errors)
    const parsed = c.parseSale(jsonBody(req), cur)
    if ("status" in parsed) throw new Problem(parsed.status, parsed.title, parsed.errors)
    const user = req.dz!.user
    const approving = parsed.data.process === "Approved"
    if (approving) {
      deny(user, "doc.approve")
      const short = c.saleStockRule(parsed.fields.lines, parsed.fields.branchId, cur.id, 422)
      if (short) throw new Problem(short.status, short.title, short.errors)
    }
    const before = structuredClone(cur)
    const next: Sale = { ...cur, ...parsed.fields }
    if (!("export" in parsed.fields)) delete next.export
    const at = new Date().toISOString()
    c.stampDocHistory(next, user.name, "edited", undefined, at)
    const changes = c.docDiff(before, next)
    let approvedAt: string | undefined
    if (approving) {
      const rule = c.approveRule("sale", next)
      if (rule) throw new Problem(rule.status, rule.title, rule.errors)
      approvedAt = new Date().toISOString()
      next.process = "Approved"
      c.postStock("sale", next.lines, 1)
      c.stampDocHistory(next, user.name, "approved", undefined, approvedAt)
    }
    const saved = await this.svc.update(next)
    await this.audit.record({ at, actor: user, entity: "sale", entityId: saved.id, ref: saved.invoiceNo, action: "edited", changes })
    if (approvedAt) await this.audit.record({ at: approvedAt, actor: user, entity: "sale", entityId: saved.id, ref: saved.invoiceNo, action: "approved" })
    res.json(saved)
  }

  /** State transitions: approve (moves the stock out), or cancel with a mandatory reason (brings it back). */
  @Patch(":id") @Authed()
  async patch(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const cur = await this.svc.find(id)
    if (!cur) throw new Problem(404, `${LABEL} not found`)
    const body = jsonBody(req) as { process?: string; reason?: string }
    const user = req.dz!.user
    if (body.process === "Approved") {
      deny(user, "doc.approve")
      const rule = c.approveRule("sale", cur)
      if (rule) throw new Problem(rule.status, rule.title, rule.errors)
      const at = new Date().toISOString()
      const next = structuredClone(cur)
      next.process = "Approved"
      c.postStock("sale", next.lines, 1)
      c.stampDocHistory(next, user.name, "approved", undefined, at)
      const saved = await this.svc.update(next)
      await this.audit.record({ at, actor: user, entity: "sale", entityId: saved.id, ref: saved.invoiceNo, action: "approved" })
      res.json(saved)
      return
    }
    if (body.process === "Cancelled") {
      deny(user, "doc.cancel")
      const rule = c.cancelRule("sale", cur, body.reason ?? "")
      if (rule) throw new Problem(rule.status, rule.title, rule.errors)
      const reason = parse(cancelInput, { reason: body.reason ?? "" }).reason
      const at = new Date().toISOString()
      const next = structuredClone(cur)
      if (next.process === "Approved") c.postStock("sale", next.lines, -1)
      next.process = "Cancelled"
      next.cancelReason = reason
      c.stampDocHistory(next, user.name, "cancelled", reason, at)
      const saved = await this.svc.update(next)
      await this.audit.record({ at, actor: user, entity: "sale", entityId: saved.id, ref: saved.invoiceNo, action: "cancelled", note: reason })
      res.json(saved)
      return
    }
    throw new Problem(400, "process must be Approved or Cancelled")
  }

  /** Delete a draft: the row is stamped and becomes the undo buffer's entry, so it can be restored. */
  @Delete(":id") @Authed("doc.delete")
  async remove(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const cur = await this.svc.byId(id)
    if (!cur) throw new Problem(404, `${LABEL} not found`)
    const rule = c.deleteRule(cur)
    if (rule) throw new Problem(rule.status, rule.title, rule.errors)
    const at = new Date().toISOString()
    const next = structuredClone(cur)
    c.stampDocHistory(next, req.dz!.user.name, "deleted", undefined, at)
    await this.svc.remove(next, at)
    await this.audit.record({ at, actor: req.dz!.user, entity: "sale", entityId: cur.id, ref: cur.invoiceNo, action: "deleted" })
    res.json({ ok: true })
  }

  /** Undo a delete: the stamp is cleared and the draft is back in the register. */
  @Post(":id/restore") @Authed("doc.delete")
  async restore(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const cur = await this.svc.trashedById(id)
    if (!cur) throw new Problem(404, `${LABEL} not found in trash`)
    const at = new Date().toISOString()
    const next = structuredClone(cur)
    c.stampDocHistory(next, req.dz!.user.name, "restored", undefined, at)
    const saved = await this.svc.restore(next)
    await this.audit.record({ at, actor: req.dz!.user, entity: "sale", entityId: saved.id, ref: saved.invoiceNo, action: "restored" })
    res.status(200).json(saved)
  }

  /** Per line item: sold, already returned (non-cancelled credit notes) and still returnable. `?exclude=<cn id>`. */
  @Get(":id/creditable") @Authed()
  async creditable(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    const cur = await this.svc.find(id)
    if (!cur) throw new Problem(404, `${LABEL} not found`)
    const exclude = searchParams(req).get("exclude") ?? undefined
    res.json({
      sale: {
        id: cur.id, invoiceNo: cur.invoiceNo, process: cur.process, issueDate: cur.issueDate,
        customerName: cur.customerName, category: cur.category ?? "goods",
      },
      lines: compat().creditable(cur, exclude),
    })
  }

  /** R6.2 (RMG): post export proceeds realised through the bank (a PRC entry) against an approved export invoice. */
  @Post(":id/realisations") @Authed("doc.edit")
  async addRealisation(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const cur = await this.svc.byId(id)
    if (!cur) throw new Problem(404, "Sale not found")
    const allowed = c.realisableRule(cur)
    if (allowed) throw new Problem(allowed.status, allowed.title, allowed.errors)
    const parsed = c.parseRealisation(cur, jsonBody(req))
    if ("status" in parsed) throw new Problem(parsed.status, parsed.title, parsed.errors)
    const user = req.dz!.user
    const at = new Date().toISOString()
    const entry = c.buildRealisation(cur, parsed.data, parsed.prc, user.name, at)
    const notes = c.realisationNotes(cur.export!, entry)
    const next = structuredClone(cur)
    ;(next.export!.realisations ??= []).push(entry)
    ;(next.history ??= []).push({ at, by: user.name, action: "edited", note: notes.history })
    const saved = await this.svc.update(next)
    await this.audit.record({ at, actor: user, entity: "sale", entityId: saved.id, ref: saved.invoiceNo, action: "realised", note: notes.audit })
    res.status(201).json(saved)
  }

  /** DELETE ?rid= — remove a proceeds entry made by mistake (approvers / admin). */
  @Delete(":id/realisations") @Authed("doc.approve")
  async removeRealisation(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const cur = await this.svc.byId(id)
    const rid = searchParams(req).get("rid")
    const i = cur?.export?.realisations?.findIndex((r) => r.id === rid) ?? -1
    if (!cur || i < 0) throw new Problem(404, "Realisation not found")
    const next = structuredClone(cur)
    const [entry] = next.export!.realisations!.splice(i, 1)
    const at = new Date().toISOString()
    const notes = c.realisationRemovedNotes(next.export!, entry)
    ;(next.history ??= []).push({ at, by: req.dz!.user.name, action: "edited", note: notes.history })
    const saved = await this.svc.update(next)
    await this.audit.record({ at, actor: req.dz!.user, entity: "sale", entityId: saved.id, ref: saved.invoiceNo, action: "deleted", note: notes.audit })
    res.json(saved)
  }
}
