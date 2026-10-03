/**
 * R5.3 — purchases on their own tables: the documents the factory buys with. A purchase is a header with priced
 * lines; it moves stock in only once approved, and a service purchase moves nothing at all. An import purchase
 * (a Foreign vendor) carries a Bill of Entry and a duty breakdown per line.
 *
 * As with the parties, the items, the stock documents and the sales invoices, the rules are the mock's own
 * (src/app/api/v1/_r2.ts, _r4.ts and _docs.ts, reused through the compat bundle): what a body may contain — the
 * vendor decides between the local, the service and the import schema — how the lines are priced and what duty an
 * import line carries, the bill numbers, the BoE and bonded-UD checks, the debit notes and settlements that block a
 * cancellation, the register's spec and its CSV columns all come from the same code the Next.js mock and the static
 * demo run, so the responses, error codes and audit events cannot drift. What changed is underneath:
 *   - a purchase is a row in `purchases` with its lines in `purchase_lines`, so a vendor's turnover, an item's
 *     ledger, the input tax a period claims and the duty a BoE cleared can be summed in SQL instead of walked in
 *     memory;
 *   - the Bill of Entry and each import line's duty breakdown are columns, so the R6.4 bond register (duty foregone
 *     under bond) and the R6.5 drawback claims read them with a WHERE;
 *   - the bill number is unique in the database as well, so two requests cannot share one;
 *   - a deleted draft is a row with `deleted_at` — its number stays retired and the undo restores the row;
 *   - the item counter an approval moves (`purchased`) is written with the document, in the same transaction;
 *   - every write goes through the state guard, and the in-memory copies stay in step: the branch stock, the
 *     ledger, the debit notes, the bond register and the VAT returns still read *every* document, and the ones
 *     without tables yet (credit and debit notes, production, opening entries) are compat state until R5.3–R5.4
 *     finish.
 */
import { Controller, Delete, Get, Inject, Injectable, Param, Patch, Post, Put, Req, Res } from "@nestjs/common"
import { asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm"
import type { Request, Response } from "express"
import { can, ROLE_PERMS, type Permission, type User } from "@/lib/auth/roles"
import { runQuery, toCSV } from "@/lib/mock/query"
import { cancelInput } from "@/lib/schemas"
import type { BillOfEntry, ImportDuty, Item, Line, Purchase } from "@/lib/types"
import { Authed, type AuthedRequest } from "../common/auth"
import { jsonBody, parse, Problem, searchParams, sendCsv, uniqueViolation } from "../common/http"
import { lockState } from "../common/state-guard"
import { WriteBack, type Delta } from "../common/writeback"
import { db, type Tx } from "../db/client"
import { items, purchaseLines, purchases } from "../db/schema"
import { compat, mirror } from "../state"
import { AuditService } from "./audit"
import { markItems, revertItemCounters } from "./items"

type PurchaseDb = typeof purchases.$inferSelect
type LineDb = typeof purchaseLines.$inferSelect
/** What a new purchase is given inside the state lock: its id and the bill number it occupies. */
export type PurchaseIdentity = { id: string; invoiceNo: string }
const today = () => new Date().toISOString().slice(0, 10)
const LABEL = "Purchase"
/** The mock's deny(): 403 naming the permission the role lacks — for the second permission a route needs. */
const deny = (user: User, perm: Permission) => {
  if (!can(ROLE_PERMS[user.role], perm)) throw new Problem(403, `Your role (${user.role}) is not allowed to do this (${perm}).`)
}

/* ── mappers ───────────────────────────────────────────────────────────── */

/**
 * Row → purchase line (the contract shape). A NULL column is an absent optional field: `rebateable` and `vds` are
 * purchase-only, `tti` and the duty breakdown import-only, and the duty foregone belongs to a bonded entry alone.
 */
export const toPurchaseLine = (r: LineDb): Line => {
  const l: Line = {
    itemId: r.itemId, name: r.name, hsCode: r.hsCode, uom: r.uom, qty: r.qty, price: r.price,
    sdRate: r.sdRate, vatRate: r.vatRate, subtotal: r.subtotal, sd: r.sd, vat: r.vat, total: r.total,
  }
  if (r.rebateable != null) l.rebateable = r.rebateable
  if (r.vds != null) l.vds = r.vds
  if (r.tti != null) l.tti = r.tti
  if (r.dutyAv != null) {
    const duty: ImportDuty = {
      usd: r.dutyUsd!, usdRate: r.dutyUsdRate!, av: r.dutyAv, cdRate: r.dutyCdRate!, cd: r.dutyCd!,
      rdRate: r.dutyRdRate!, rd: r.dutyRd!, aitRate: r.dutyAitRate!, ait: r.dutyAit!, atRate: r.dutyAtRate!, at: r.dutyAt!,
    }
    // a bonded (IM-7) entry: the duty stack that was suspended under bond, which the register reports as foregone
    if (r.foregoneTotal != null) {
      duty.foregone = {
        cd: r.foregoneCd!, rd: r.foregoneRd!, sd: r.foregoneSd!, vat: r.foregoneVat!,
        ait: r.foregoneAit!, at: r.foregoneAt!, total: r.foregoneTotal,
      }
    }
    l.duty = duty
  }
  return l
}

/**
 * The Bill of Entry, from its own columns. `boeNo` is the presence marker: a local or service purchase has NULL
 * there, and the key stays out of the response exactly as the mock leaves it out.
 */
function toBoe(r: PurchaseDb): BillOfEntry {
  const b: BillOfEntry = {
    no: r.boeNo!, date: r.boeDate!, lcNo: r.boeLcNo!, lcDate: r.boeLcDate!,
    customsHouse: r.boeCustomsHouse ?? "", origin: r.boeOrigin ?? "",
  }
  if (r.boeCnfFirm != null) b.cnfFirm = r.boeCnfFirm
  if (r.boeReceiveAddress != null) b.receiveAddress = r.boeReceiveAddress
  if (r.boeBonded != null) b.bonded = r.boeBonded
  if (r.boeUdNo != null) b.udNo = r.boeUdNo
  return b
}

/** Header row + its lines → contract shape. A NULL column is an absent optional field. */
export function toPurchase(r: PurchaseDb, lines: Line[]): Purchase {
  const p: Purchase = {
    id: r.id, createdAt: r.createdAt.toISOString(), issueDate: r.issueDate, process: r.process, method: r.method,
    subtotal: r.subtotal, sd: r.sd, vat: r.vat, discount: r.discount, netTotal: r.netTotal, paid: r.paid, due: r.due,
    lines, issuedBy: r.issuedBy, designation: r.designation, branchId: r.branchId, branchName: r.branchName,
    invoiceNo: r.invoiceNo, challanNo: r.challanNo, challanDate: r.challanDate,
    vendorId: r.vendorId, vendorName: r.vendorName, vendorBin: r.vendorBin, vendorAddress: r.vendorAddress,
    mode: r.mode, tti: r.tti, rebate: r.rebate,
  }
  if (r.category != null) p.category = r.category
  if (r.narration != null) p.narration = r.narration
  if (r.updatedAt) p.updatedAt = r.updatedAt.toISOString()
  if (r.cancelReason != null) p.cancelReason = r.cancelReason
  p.history = r.history ?? []
  if (r.boeNo != null) p.boe = toBoe(r)
  return p
}

/** Contract shape → header row values (`ord` and `deletedAt` are the table's own). */
export const purchaseValues = (p: Purchase) => {
  const b = p.boe
  return {
    id: p.id, invoiceNo: p.invoiceNo, challanNo: p.challanNo, challanDate: p.challanDate, issueDate: p.issueDate,
    process: p.process, category: p.category ?? null, branchId: p.branchId, branchName: p.branchName,
    vendorId: p.vendorId, vendorName: p.vendorName, vendorBin: p.vendorBin, vendorAddress: p.vendorAddress,
    mode: p.mode, method: p.method,
    subtotal: p.subtotal, sd: p.sd, vat: p.vat, discount: p.discount, netTotal: p.netTotal, paid: p.paid, due: p.due,
    tti: p.tti, rebate: p.rebate,
    issuedBy: p.issuedBy, designation: p.designation, narration: p.narration ?? null,
    createdAt: new Date(p.createdAt), updatedAt: p.updatedAt ? new Date(p.updatedAt) : null,
    cancelReason: p.cancelReason ?? null, history: p.history ?? null,
    boeNo: b?.no ?? null, boeDate: b?.date ?? null, boeLcNo: b?.lcNo ?? null, boeLcDate: b?.lcDate ?? null,
    boeCustomsHouse: b?.customsHouse ?? null, boeOrigin: b?.origin ?? null, boeCnfFirm: b?.cnfFirm ?? null,
    boeReceiveAddress: b?.receiveAddress ?? null, boeBonded: b?.bonded ?? null, boeUdNo: b?.udNo ?? null,
  }
}

/** The document's lines as child rows, in the order they are printed. */
export const purchaseLineValues = (p: Purchase) => p.lines.map((l, i) => {
  const d = l.duty
  const f = d?.foregone
  return {
    purchaseId: p.id, ord: i + 1, itemId: l.itemId, name: l.name, hsCode: l.hsCode, uom: l.uom, qty: l.qty,
    price: l.price, sdRate: l.sdRate, vatRate: l.vatRate, subtotal: l.subtotal, sd: l.sd, vat: l.vat, total: l.total,
    rebateable: l.rebateable ?? null, vds: l.vds ?? null, tti: l.tti ?? null,
    dutyUsd: d?.usd ?? null, dutyUsdRate: d?.usdRate ?? null, dutyAv: d?.av ?? null,
    dutyCdRate: d?.cdRate ?? null, dutyCd: d?.cd ?? null, dutyRdRate: d?.rdRate ?? null, dutyRd: d?.rd ?? null,
    dutyAitRate: d?.aitRate ?? null, dutyAit: d?.ait ?? null, dutyAtRate: d?.atRate ?? null, dutyAt: d?.at ?? null,
    foregoneCd: f?.cd ?? null, foregoneRd: f?.rd ?? null, foregoneSd: f?.sd ?? null, foregoneVat: f?.vat ?? null,
    foregoneAit: f?.ait ?? null, foregoneAt: f?.at ?? null, foregoneTotal: f?.total ?? null,
  }
})

/* ── write-back: what the unported handlers changed ─────────────────────── */

/**
 * The purchases are rows now, but the in-memory copies stay: the branch stock, an item's ledger, the debit notes
 * that return against a purchase, the bond register, the drawback claims and every VAT return derive from all of
 * them, together with the documents that are still compat state. A compat handler that writes through the mock's
 * array — a restored backup, the demo runtime — is written back here. See common/writeback.ts.
 */
const purchaseWb = new WriteBack<Purchase>("purchases", () => mirror.purchases(), (p) => p.id)
export type PurchaseDelta = Delta<Purchase>
export const markPurchases = (list: Purchase[]) => purchaseWb.mark(list)
export const forgetPurchase = (id: string) => purchaseWb.forget(id)
export const purchaseDelta = () => purchaseWb.delta()
export const commitPurchaseDelta = (d: PurchaseDelta) => purchaseWb.commit(d)

/**
 * Applies a delta inside the persist transaction and reads the saved document back into memory, so a value a
 * column type rounded (money is numeric(18,2), quantities numeric(18,3)) is not rewritten on every request.
 *
 * A purchase that left the in-memory list was deleted by a handler that still runs the mock's code (a restored
 * backup, the demo runtime): it is in the undo buffer, so the row is stamped exactly as the native delete stamps
 * it, and the write-back forgets it — restoring it later counts as an insert again. Anything else that vanishes is
 * put back from its last persisted shape, because the table is authoritative.
 */
export async function applyPurchaseDelta(tx: Tx, d: PurchaseDelta) {
  for (const p of [...d.insert, ...d.update]) {
    // a document back in the live list is not deleted: an insert clears the stamp a compat delete may have set
    const values = d.insert.includes(p) ? { ...purchaseValues(p), deletedAt: null } : purchaseValues(p)
    const [row] = await tx.insert(purchases).values(values)
      .onConflictDoUpdate({ target: purchases.id, set: values }).returning()
    mirror.putPurchase(await replaceChildren(tx, p, row))
  }
  for (const id of d.missing) {
    const entry = mirror.trash().find((t) => t.kind === "purchase" && t.doc.id === id)
    if (entry) {
      const p = entry.doc as Purchase
      await tx.update(purchases).set({ ...purchaseValues(p), deletedAt: new Date(entry.at) }).where(eq(purchases.id, id))
      purchaseWb.forget(id)
      continue
    }
    const p = purchaseWb.stored(id)
    if (!p) continue
    mirror.putPurchase(p)
    console.warn(`[purchases] ${id} vanished from the in-memory state — restored from the table copy`)
  }
}

/** Replaces a document's lines with the ones it carries now, and reads both back. */
async function replaceChildren(tx: Tx, p: Purchase, row: PurchaseDb): Promise<Purchase> {
  await tx.delete(purchaseLines).where(eq(purchaseLines.purchaseId, p.id))
  const lineRows = purchaseLineValues(p)
  const lines = lineRows.length ? (await tx.insert(purchaseLines).values(lineRows).returning()).map(toPurchaseLine) : []
  return toPurchase(row, lines)
}

/** Header rows + their lines → purchases, in the rows' order (the service and boot share it). */
export async function assemblePurchases(rows: PurchaseDb[]): Promise<Purchase[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const lineRows = await db.select().from(purchaseLines).where(inArray(purchaseLines.purchaseId, ids))
    .orderBy(asc(purchaseLines.purchaseId), asc(purchaseLines.ord))
  const lines = new Map<string, Line[]>()
  for (const l of lineRows) {
    const a = lines.get(l.purchaseId) ?? []
    a.push(toPurchaseLine(l))
    lines.set(l.purchaseId, a)
  }
  return rows.map((r) => toPurchase(r, lines.get(r.id) ?? []))
}

/** The SKUs an approval moves (`Item.purchased`); service lines carry a code that is not a SKU, so they are skipped. */
const captureCounters = (p: Purchase) => p.lines.map((l) => mirror.findItem(l.itemId)).filter((it): it is Item => !!it)
async function writeCounters(tx: Tx, list: Item[]) {
  for (const it of list) await tx.update(items).set({ purchased: it.purchased }).where(eq(items.id, it.id))
}

/* ── service ───────────────────────────────────────────────────────────── */

@Injectable()
export class PurchasesService {
  /** Every live purchase in insertion order — the order the mock's array had. */
  async all(): Promise<Purchase[]> {
    return assemblePurchases(await db.select().from(purchases).where(isNull(purchases.deletedAt)).orderBy(asc(purchases.ord)))
  }

  /** One purchase by id or by bill number: the registers, the ledger and the audit trail link both. */
  find(idOrNo: string) {
    return this.first(sql`(${purchases.id} = ${idOrNo} or ${purchases.invoiceNo} = ${idOrNo}) and ${purchases.deletedAt} is null`)
  }

  /** One live purchase by id only — what a delete matches on. */
  byId(id: string) {
    return this.first(sql`${purchases.id} = ${id} and ${purchases.deletedAt} is null`)
  }

  /** A draft in the undo buffer, by id. */
  trashedById(id: string) {
    return this.first(sql`${purchases.id} = ${id} and ${purchases.deletedAt} is not null`)
  }

  private async first(match: SQL) {
    const rows = await db.select().from(purchases).where(match)
    return rows.length ? (await assemblePurchases(rows))[0] : undefined
  }

  /**
   * Stores a new purchase with its lines. `make` builds it once the id and the number are known — inside the lock,
   * so two creates in flight cannot share a bill number. The counter an approval moves is written with it.
   */
  async create(category: string, issueDate: string, make: (ident: PurchaseIdentity) => Purchase): Promise<Purchase> {
    let made: Purchase | undefined
    let counters: Item[] = []
    try {
      const saved = await db.transaction(async (tx) => {
        await lockState(tx)
        made = make(compat().purchaseIdentity(category, issueDate))
        // claimed in memory first: a compat persist running mid-insert must not adopt the document twice
        mirror.putPurchase(made)
        counters = captureCounters(made)
        const [row] = await tx.insert(purchases).values(purchaseValues(made)).returning()
        await writeCounters(tx, counters)
        return replaceChildren(tx, made, row)
      })
      mirror.putPurchase(saved)
      markPurchases([saved])
      markItems(counters)
      return saved
    } catch (e) {
      if (made) { mirror.removePurchase(made.id); forgetPurchase(made.id) }
      await revertItemCounters(counters.map((it) => it.id))
      PurchasesService.noConflict(e)
    }
  }

  /** Replaces a document and its lines, and writes the counters in the same transaction. */
  async update(p: Purchase): Promise<Purchase> {
    const counters = captureCounters(p)
    try {
      const saved = await db.transaction(async (tx) => {
        await lockState(tx)
        const [row] = await tx.update(purchases).set(purchaseValues(p)).where(eq(purchases.id, p.id)).returning()
        if (!row) throw new Problem(404, `${LABEL} not found`)
        await writeCounters(tx, counters)
        return replaceChildren(tx, p, row)
      })
      mirror.putPurchase(saved)
      markPurchases([saved])
      markItems(counters)
      return saved
    } catch (e) {
      await revertItemCounters(counters.map((it) => it.id))
      throw e as Error
    }
  }

  /**
   * Soft delete: the row and its lines stay (the number is retired, the audit trail quotes the document) and the
   * stamped copy becomes the undo buffer's entry, exactly as the mock's trash did.
   */
  async remove(p: Purchase, at: string) {
    await db.transaction(async (tx) => {
      await lockState(tx)
      await tx.update(purchases).set({ ...purchaseValues(p), deletedAt: new Date(at) }).where(eq(purchases.id, p.id))
    })
    mirror.removePurchase(p.id)
    mirror.trash().push({ kind: "purchase", doc: p, at })
    forgetPurchase(p.id)
  }

  /** Clears the stamp: the draft is back in the register with its number, its lines and its history. */
  async restore(p: Purchase): Promise<Purchase> {
    let row: PurchaseDb | undefined
    try {
      ;[row] = await db.transaction(async (tx) => {
        await lockState(tx)
        return tx.update(purchases).set({ ...purchaseValues(p), deletedAt: null }).where(eq(purchases.id, p.id)).returning()
      })
    } catch (e) {
      PurchasesService.noConflict(e)
    }
    if (!row) throw new Problem(404, `${LABEL} not found in trash`)
    const saved = (await assemblePurchases([row]))[0]
    const i = mirror.trash().findIndex((t) => t.kind === "purchase" && t.doc.id === p.id)
    if (i >= 0) mirror.trash().splice(i, 1)
    mirror.putPurchase(saved)
    markPurchases([saved])
    return saved
  }

  /** A duplicate bill number the application check missed (two requests at once) is a 409, not a 500. */
  private static noConflict(e: unknown): never {
    if (uniqueViolation(e) !== null) throw new Problem(409, "That purchase number was just taken — please try again.")
    throw e as Error
  }
}

/* ── controller ────────────────────────────────────────────────────────── */

/**
 * The eight purchase endpoints. The behaviour is shared with the mock handlers (see the header); this class only
 * adds storage, the state guard and the audit trail.
 */
@Controller("api/v1/purchases")
export class PurchasesController {
  constructor(
    @Inject(PurchasesService) private readonly svc: PurchasesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** The register: Page<Purchase> with facets and vendor labels, or CSV. Goods by default, `?category=` for the rest. */
  @Get() @Authed()
  async list(@Req() req: Request, @Res() res: Response) {
    const c = compat()
    const sp = searchParams(req)
    if (!sp.get("sort")) sp.set("sort", "createdAt.desc")
    const r = runQuery(c.purchaseCategory(sp, await this.svc.all()), sp, c.purchaseSpec)
    if (sp.get("format") === "csv") {
      sendCsv(res, toCSV(c.purchaseCsvRows(r.all, sp.get("ids")), c.purchaseCsvColumns), `purchases-${today()}.csv`)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    res.json({ ...page, facetLabels: c.purchaseFacetLabels() })
  }

  /** Create a draft, or create and approve it in one step (which needs the approve permission). */
  @Post() @Authed("doc.create")
  async create(@Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const r = c.parsePurchase(jsonBody(req))
    if ("status" in r) throw new Problem(r.status, r.title, r.errors)
    const user = req.dz!.user
    const approving = r.data.process === "Approved"
    if (approving) deny(user, "doc.approve")
    const fields = c.buildPurchaseFields(r.data, r.vendor)
    const at = new Date().toISOString()
    const purchase = await this.svc.create(r.data.category, r.data.issueDate, (ident) => {
      const p: Purchase = { ...fields, ...ident, createdAt: at, process: "Created", history: [] }
      c.stampDocHistory(p, user.name, "created", undefined, at)
      if (approving) {
        p.process = "Approved"
        c.postStock("purchase", p.lines, 1)
        c.stampDocHistory(p, user.name, "approved")
      }
      return p
    })
    await this.audit.record({ at, actor: user, entity: "purchase", entityId: purchase.id, ref: purchase.invoiceNo, action: "created" })
    const approved = purchase.history?.find((h) => h.action === "approved")
    if (approved) await this.audit.record({ at: approved.at, actor: user, entity: "purchase", entityId: purchase.id, ref: purchase.invoiceNo, action: "approved" })
    res.status(201).json(purchase)
  }

  /** Bulk approve — skips rows that are not drafts or sit in a locked period, and reports them.
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
      if (!d || d.process !== "Created" || c.periodLocked(d.issueDate) || c.approveRule("purchase", d)) { skipped.push(id); continue }
      const at = new Date().toISOString()
      const next = structuredClone(d)
      next.process = "Approved"
      c.postStock("purchase", next.lines, 1)
      c.stampDocHistory(next, user.name, "approved", undefined, at)
      const saved = await this.svc.update(next)
      await this.audit.record({ at, actor: user, entity: "purchase", entityId: saved.id, ref: saved.invoiceNo, action: "approved" })
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

  /** Edit a draft (full replacement). Optional approve-on-save. A goods purchase cannot become a service one. */
  @Put(":id") @Authed("doc.edit")
  async update(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const cur = await this.svc.find(id)
    if (!cur) throw new Problem(404, `${LABEL} not found`)
    const draft = c.editDraftRule(cur)
    if (draft) throw new Problem(draft.status, draft.title, draft.errors)
    const parsed = c.parsePurchase(jsonBody(req), cur)
    if ("status" in parsed) throw new Problem(parsed.status, parsed.title, parsed.errors)
    const user = req.dz!.user
    const approving = parsed.data.process === "Approved"
    if (approving) deny(user, "doc.approve")
    const cat = c.purchaseCategoryRule(cur, parsed.data.category)
    if (cat) throw new Problem(cat.status, cat.title, cat.errors)
    const before = structuredClone(cur)
    const fields = c.buildPurchaseFields(parsed.data, parsed.vendor)
    const next: Purchase = { ...cur, ...fields }
    if (!("boe" in fields)) delete next.boe
    const at = new Date().toISOString()
    c.stampDocHistory(next, user.name, "edited", undefined, at)
    const changes = c.docDiff(before, next)
    let approvedAt: string | undefined
    if (approving) {
      const rule = c.approveRule("purchase", next)
      if (rule) throw new Problem(rule.status, rule.title, rule.errors)
      approvedAt = new Date().toISOString()
      next.process = "Approved"
      c.postStock("purchase", next.lines, 1)
      c.stampDocHistory(next, user.name, "approved", undefined, approvedAt)
    }
    const saved = await this.svc.update(next)
    await this.audit.record({ at, actor: user, entity: "purchase", entityId: saved.id, ref: saved.invoiceNo, action: "edited", changes })
    if (approvedAt) await this.audit.record({ at: approvedAt, actor: user, entity: "purchase", entityId: saved.id, ref: saved.invoiceNo, action: "approved" })
    res.json(saved)
  }

  /** State transitions: approve (moves the stock in), or cancel with a mandatory reason (takes it back out). */
  @Patch(":id") @Authed()
  async patch(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const cur = await this.svc.find(id)
    if (!cur) throw new Problem(404, `${LABEL} not found`)
    const body = jsonBody(req) as { process?: string; reason?: string }
    const user = req.dz!.user
    if (body.process === "Approved") {
      deny(user, "doc.approve")
      const rule = c.approveRule("purchase", cur)
      if (rule) throw new Problem(rule.status, rule.title, rule.errors)
      const at = new Date().toISOString()
      const next = structuredClone(cur)
      next.process = "Approved"
      c.postStock("purchase", next.lines, 1)
      c.stampDocHistory(next, user.name, "approved", undefined, at)
      const saved = await this.svc.update(next)
      await this.audit.record({ at, actor: user, entity: "purchase", entityId: saved.id, ref: saved.invoiceNo, action: "approved" })
      res.json(saved)
      return
    }
    if (body.process === "Cancelled") {
      deny(user, "doc.cancel")
      const rule = c.cancelRule("purchase", cur, body.reason ?? "")
      if (rule) throw new Problem(rule.status, rule.title, rule.errors)
      const reason = parse(cancelInput, { reason: body.reason ?? "" }).reason
      const at = new Date().toISOString()
      const next = structuredClone(cur)
      if (next.process === "Approved") c.postStock("purchase", next.lines, -1)
      next.process = "Cancelled"
      next.cancelReason = reason
      c.stampDocHistory(next, user.name, "cancelled", reason, at)
      const saved = await this.svc.update(next)
      await this.audit.record({ at, actor: user, entity: "purchase", entityId: saved.id, ref: saved.invoiceNo, action: "cancelled", note: reason })
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
    await this.audit.record({ at, actor: req.dz!.user, entity: "purchase", entityId: cur.id, ref: cur.invoiceNo, action: "deleted" })
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
    await this.audit.record({ at, actor: req.dz!.user, entity: "purchase", entityId: saved.id, ref: saved.invoiceNo, action: "restored" })
    res.status(200).json(saved)
  }

  /** Per line item: purchased, already returned (non-cancelled debit notes) and still returnable. `?exclude=<dn id>`. */
  @Get(":id/returnable") @Authed()
  async returnable(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    const cur = await this.svc.find(id)
    if (!cur || cur.category === "service") throw new Problem(404, `${LABEL} not found`)
    const exclude = searchParams(req).get("exclude") ?? undefined
    res.json({
      purchase: { id: cur.id, invoiceNo: cur.invoiceNo, process: cur.process, issueDate: cur.issueDate },
      lines: compat().returnable(cur, exclude),
    })
  }
}
