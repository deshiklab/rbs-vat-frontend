/**
 * R5.3 — stock documents on their own tables: the first business documents out of the compat layer. A transfer
 * moves goods between branches, a damage entry writes them off; both are a header with priced lines, and both only
 * touch stock once approved.
 *
 * As with the parties and the items, the rules are the mock's own (src/app/api/v1/_stock.ts, reused through the
 * compat bundle): line validation and pricing, the monthly document numbers, the branch-stock checks around
 * approving and cancelling, the item counter a damage write-off moves, the document's history, the register's spec
 * and its CSV columns all come from the same code the Next.js mock and the static demo run, so the responses, error
 * codes and audit events cannot drift. What changed is underneath:
 *   - a document is a row in `stock_documents` with its lines in `stock_document_lines`, so the quantities and
 *     values a movement carries can be summed in SQL instead of walked in memory;
 *   - the document number is unique in the database as well, so two requests cannot share one;
 *   - the counters an approval moves are written with the document, in the same transaction;
 *   - every write goes through the state guard, and the in-memory copies stay in step — the branch split and an
 *     item's ledger still derive from *every* movement document, and the ones without tables yet (sales, purchases,
 *     returns, production, opening entries) are compat state until R5.3–R5.4 finish.
 */
import { Controller, Delete, Get, Inject, Injectable, Param, Patch, Post, Put, Req, Res } from "@nestjs/common"
import { asc, eq, inArray, sql, type SQL } from "drizzle-orm"
import type { Request, Response } from "express"
import { can, ROLE_PERMS, type Permission, type User } from "@/lib/auth/roles"
import { runQuery, toCSV } from "@/lib/mock/query"
import { cancelInput } from "@/lib/schemas"
import type { Damage, DamageReason, Item, Process, StockDoc, StockDocKind, StockLine, Transfer } from "@/lib/types"
import { Authed, type AuthedRequest } from "../common/auth"
import { jsonBody, parse, Problem, searchParams, sendCsv, uniqueViolation } from "../common/http"
import { lockState } from "../common/state-guard"
import { WriteBack, type Delta } from "../common/writeback"
import { db, type Tx } from "../db/client"
import { items, stockDocumentLines, stockDocuments } from "../db/schema"
import { compat, mirror } from "../state"
import { AuditService } from "./audit"
import { markItems, revertItemCounters } from "./items"

type DocDb = typeof stockDocuments.$inferSelect
type LineDb = typeof stockDocumentLines.$inferSelect
const today = () => new Date().toISOString().slice(0, 10)
/** The mock's deny(): 403 naming the permission the role lacks — for the second permission a route needs. */
const deny = (user: User, perm: Permission) => {
  if (!can(ROLE_PERMS[user.role], perm)) throw new Problem(403, `Your role (${user.role}) is not allowed to do this (${perm}).`)
}

/** Row → stock line (the contract shape). */
export const toStockLine = (r: LineDb): StockLine => ({ itemId: r.itemId, name: r.name, sku: r.sku, uom: r.uom, qty: r.qty, cost: r.cost, value: r.value })

/** Header row + its lines → contract shape. A NULL column is an absent optional field. */
export function toStockDoc(r: DocDb, lines: StockLine[]): StockDoc {
  const head = {
    id: r.id, no: r.no, date: r.date, process: r.process as Process, lines,
    totalQty: r.totalQty, totalValue: r.totalValue, issuedBy: r.issuedBy, createdAt: r.createdAt.toISOString(),
  }
  if (r.kind === "transfer") {
    const d: Transfer = { kind: "transfer", ...head, fromBranchId: r.fromBranchId, fromBranch: r.fromBranch, toBranchId: r.toBranchId!, toBranch: r.toBranch! }
    if (r.vehicle != null) d.vehicle = r.vehicle
    return tail(d, r)
  }
  return tail({ kind: "damage", ...head, branchId: r.fromBranchId, branch: r.fromBranch, reason: r.reason as DamageReason } as Damage, r)
}

/** The optional fields both kinds share: a NULL column stays out of the response. */
function tail<T extends StockDoc>(d: T, r: DocDb): T {
  if (r.note != null) d.note = r.note
  if (r.updatedAt) d.updatedAt = r.updatedAt.toISOString()
  if (r.cancelReason != null) d.cancelReason = r.cancelReason
  d.history = r.history ?? []
  return d
}

/**
 * Contract shape → header row values (`ord` is the table's own). Both kinds share the columns: the branch a
 * document consumes is `from_branch_id` — a transfer's origin, a damage entry's own branch — and only a transfer
 * has a destination.
 */
export const stockDocValues = (d: StockDoc) => ({
  id: d.id, kind: d.kind, no: d.no, date: d.date, process: d.process,
  fromBranchId: d.kind === "transfer" ? d.fromBranchId : d.branchId,
  fromBranch: d.kind === "transfer" ? d.fromBranch : d.branch,
  toBranchId: d.kind === "transfer" ? d.toBranchId : null,
  toBranch: d.kind === "transfer" ? d.toBranch : null,
  reason: d.kind === "damage" ? d.reason : null,
  vehicle: d.kind === "transfer" ? d.vehicle ?? null : null,
  note: d.note ?? null,
  totalQty: d.totalQty, totalValue: d.totalValue, issuedBy: d.issuedBy,
  createdAt: new Date(d.createdAt), updatedAt: d.updatedAt ? new Date(d.updatedAt) : null,
  cancelReason: d.cancelReason ?? null, history: d.history ?? null,
})

/** The document's lines as child rows, in the order they are printed. */
export const stockLineValues = (d: StockDoc) => d.lines.map((l, i) => ({
  docId: d.id, ord: i + 1, itemId: l.itemId, name: l.name, sku: l.sku, uom: l.uom, qty: l.qty, cost: l.cost, value: l.value,
}))

/* ── write-back: what the unported handlers changed ─────────────────────── */

/**
 * The documents are rows now, but the in-memory copies stay: the branch split (`stockByBranch`) and an item's
 * ledger derive from every movement document, and the ones still in compat state are read together with these.
 * A compat handler that writes through the mock's arrays — a restored backup, the demo seed — is written back
 * here. See common/writeback.ts.
 */
const stockWb = new WriteBack<StockDoc>("stock_documents", () => [...mirror.stockDocs("transfer"), ...mirror.stockDocs("damage")], (d) => d.id)
export type StockDelta = Delta<StockDoc>
export const markStockDocs = (list: StockDoc[]) => stockWb.mark(list)
export const stockDelta = () => stockWb.delta()
export const commitStockDelta = (d: StockDelta) => stockWb.commit(d)

/**
 * Applies a delta inside the persist transaction and reads the saved document back into memory, so a value a
 * column type rounded (money is numeric(18,2), quantities numeric(18,3)) is not rewritten on every request.
 * A document that disappeared from memory is put back from its last persisted shape — the table is authoritative.
 */
export async function applyStockDelta(tx: Tx, d: StockDelta) {
  for (const doc of [...d.insert, ...d.update]) {
    const [row] = await tx.insert(stockDocuments).values(stockDocValues(doc))
      .onConflictDoUpdate({ target: stockDocuments.id, set: stockDocValues(doc) }).returning()
    await tx.delete(stockDocumentLines).where(eq(stockDocumentLines.docId, doc.id))
    const lines = doc.lines.length ? (await tx.insert(stockDocumentLines).values(stockLineValues(doc)).returning()).map(toStockLine) : []
    mirror.putStockDoc(toStockDoc(row, lines))
  }
  for (const id of d.missing) {
    const doc = stockWb.stored(id)
    if (!doc) continue
    mirror.putStockDoc(doc)
    console.warn(`[stock_documents] ${id} vanished from the in-memory state — restored from the table copy`)
  }
}

/** Header rows + their lines → documents, in the rows' order (the service and boot share it). */
export async function assembleStockDocs(rows: DocDb[]): Promise<StockDoc[]> {
  if (!rows.length) return []
  const lines = await db.select().from(stockDocumentLines)
    .where(inArray(stockDocumentLines.docId, rows.map((r) => r.id)))
    .orderBy(asc(stockDocumentLines.docId), asc(stockDocumentLines.ord))
  const byDoc = new Map<string, StockLine[]>()
  for (const l of lines) {
    const a = byDoc.get(l.docId) ?? []
    a.push(toStockLine(l))
    byDoc.set(l.docId, a)
  }
  return rows.map((r) => toStockDoc(r, byDoc.get(r.id) ?? []))
}

/** `t<n>` / `d<n>`: one above the highest number the table has ever held for that kind, so ids are never reused. */
async function nextStockDocId(tx: Tx, kind: StockDocKind): Promise<string> {
  const [r] = await tx.select({ n: sql<number>`coalesce(max(nullif(regexp_replace(${stockDocuments.id}, '\\D', '', 'g'), '')::int), 0) + 1` })
    .from(stockDocuments).where(eq(stockDocuments.kind, kind))
  return `${kind === "transfer" ? "t" : "d"}${Number(r.n)}`
}

/* ── service ───────────────────────────────────────────────────────────── */

@Injectable()
export class StockService {
  /** Every document of one kind in insertion order — the order the mock's array had. */
  async all(kind: StockDocKind): Promise<StockDoc[]> {
    return this.withLines(await db.select().from(stockDocuments).where(eq(stockDocuments.kind, kind)).orderBy(asc(stockDocuments.ord)))
  }

  /** One document by id or by number: the registers, the ledger and the audit trail link both. */
  find(kind: StockDocKind, idOrNo: string) {
    return this.first(kind, sql`(${stockDocuments.id} = ${idOrNo} or ${stockDocuments.no} = ${idOrNo})`)
  }

  /** One document by id only — what deleting a draft matches on. */
  byId(kind: StockDocKind, id: string) {
    return this.first(kind, sql`${stockDocuments.id} = ${id}`)
  }

  private async first(kind: StockDocKind, match: SQL) {
    const rows = await db.select().from(stockDocuments).where(sql`${stockDocuments.kind} = ${kind} and ${match}`)
    return rows.length ? (await this.withLines(rows))[0] : undefined
  }

  /** The lines of the given documents, in order, in one query. */
  private withLines(rows: DocDb[]) { return assembleStockDocs(rows) }

  /**
   * Stores a new document with its lines. `make` builds it once the id is known — inside the lock, so two creates
   * in flight cannot share a number. The counters an approval moves are written with the document.
   */
  async create(kind: StockDocKind, make: (id: string) => StockDoc): Promise<StockDoc> {
    let made: StockDoc | undefined
    let counters: Item[] = []
    try {
      const saved = await db.transaction(async (tx) => {
        await lockState(tx)
        made = make(await nextStockDocId(tx, kind))
        // claimed in memory first: a compat persist running mid-insert must not adopt the document twice
        mirror.putStockDoc(made)
        counters = captureCounters(made)
        const [row] = await tx.insert(stockDocuments).values(stockDocValues(made)).returning()
        const lines = made.lines.length ? (await tx.insert(stockDocumentLines).values(stockLineValues(made)).returning()).map(toStockLine) : []
        await writeCounters(tx, counters)
        return toStockDoc(row, lines)
      })
      mirror.putStockDoc(saved)
      markStockDocs([saved])
      markItems(counters)
      const seq = compat().db.seq
      seq[kind] = Math.max(seq[kind] ?? 0, Number(saved.id.slice(1)) || 0)
      return saved
    } catch (e) {
      if (made) { mirror.removeStockDoc(kind, made.id); stockWb.forget(made.id) }
      await revertItemCounters(counters.map((it) => it.id))
      StockService.noConflict(e)
    }
  }

  /** Replaces a document and its lines, and writes the counters the change moved in the same transaction. */
  async update(d: StockDoc): Promise<StockDoc> {
    const counters = captureCounters(d)
    try {
      const saved = await db.transaction(async (tx) => {
        await lockState(tx)
        const [row] = await tx.update(stockDocuments).set(stockDocValues(d)).where(eq(stockDocuments.id, d.id)).returning()
        if (!row) throw new Problem(404, `${compat().STOCK_LABEL[d.kind]} not found`)
        await tx.delete(stockDocumentLines).where(eq(stockDocumentLines.docId, d.id))
        const lines = d.lines.length ? (await tx.insert(stockDocumentLines).values(stockLineValues(d)).returning()).map(toStockLine) : []
        await writeCounters(tx, counters)
        return toStockDoc(row, lines)
      })
      mirror.putStockDoc(saved)
      markStockDocs([saved])
      markItems(counters)
      return saved
    } catch (e) {
      await revertItemCounters(counters.map((it) => it.id))
      throw e as Error
    }
  }

  /** Deletes a draft and its lines. The number stays retired — the audit trail keeps the record. */
  async remove(d: StockDoc) {
    await db.transaction(async (tx) => {
      await lockState(tx)
      await tx.delete(stockDocumentLines).where(eq(stockDocumentLines.docId, d.id))
      await tx.delete(stockDocuments).where(eq(stockDocuments.id, d.id))
    })
    mirror.removeStockDoc(d.kind, d.id)
    stockWb.forget(d.id)
  }

  /** A duplicate document number the application check missed (two requests at once) is a 409, not a 500. */
  private static noConflict(e: unknown): never {
    if (uniqueViolation(e) !== null) throw new Problem(409, "That document number was just taken — please try again.")
    throw e as Error
  }
}

/** The SKUs whose counters a document's lines move — they are written with the document, in its transaction. */
const captureCounters = (d: StockDoc) => d.lines.map((l) => mirror.findItem(l.itemId)).filter((it): it is Item => !!it)
/** A damage write-off moves Item.damage; the rows follow the document, in its transaction. */
async function writeCounters(tx: Tx, list: Item[]) {
  for (const it of list) await tx.update(items).set({ damage: it.damage }).where(eq(items.id, it.id))
}

/* ── controllers ───────────────────────────────────────────────────────── */

abstract class StockControllerBase {
  protected constructor(
    @Inject(StockService) protected readonly svc: StockService,
    @Inject(AuditService) protected readonly audit: AuditService,
  ) {}

  protected abstract readonly kind: StockDocKind

  /** The register: Page<StockDoc> with facets and branch labels, or CSV (one row per line). */
  protected async list(req: Request, res: Response) {
    const kind = this.kind
    const sp = searchParams(req)
    if (!sp.get("sort")) sp.set("sort", "createdAt.desc")
    const c = compat()
    const r = runQuery(await this.svc.all(kind), sp, c.stockSpec(kind))
    if (sp.get("format") === "csv") {
      sendCsv(res, toCSV(c.stockCsvRows(r.all), c.stockCsvColumns(kind)), `${kind === "transfer" ? "stock-transfers" : "damage-entries"}-${today()}.csv`)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    const b = c.branchLabels()
    res.json({ ...page, facetLabels: kind === "transfer" ? { fromBranch: b, toBranch: b } : { branch: b } })
  }

  /** Create a draft, or create and approve it in one step (which needs the approve permission and the stock). */
  protected async create(req: AuthedRequest, res: Response) {
    const kind = this.kind
    const c = compat()
    const r = c.buildStock(kind, jsonBody(req))
    if ("status" in r) throw new Problem(r.status, r.title, r.errors)
    const user = req.dz!.user
    if (r.process === "Approved") deny(user, "doc.approve")
    const at = new Date().toISOString()
    const doc = await this.svc.create(kind, (id) => {
      const base = { id, no: c.nextStockNo(kind, r.fields.date), process: "Created" as const, issuedBy: user.name, createdAt: at, history: [] }
      const d = (kind === "transfer" ? { kind: "transfer", ...base, ...r.fields } : { kind: "damage", ...base, ...r.fields }) as StockDoc
      if (r.process === "Approved") {
        // before the document exists: a create that cannot be approved must not consume a number
        const short = c.stockShortfall(d.lines, c.stockSource(d))
        if (short) throw new Problem(422, `Insufficient stock — ${short.detail}`, short.errors)
      }
      c.stampStockHistory(d, user.name, "created", at)
      if (r.process === "Approved") {
        const p = c.approveDoc(d, user.name, new Date().toISOString())
        if (p) throw new Problem(p.status, p.title, p.errors)
      }
      return d
    })
    await this.audit.record({ at, actor: user, entity: kind, entityId: doc.id, ref: doc.no, action: "created" })
    const approved = doc.history?.find((h) => h.action === "approved")
    if (approved) await this.audit.record({ at: approved.at, actor: user, entity: kind, entityId: doc.id, ref: doc.no, action: "approved" })
    res.status(201).json(doc)
  }

  protected async one(kind: StockDocKind, id: string, res: Response) {
    const d = await this.svc.find(kind, id)
    if (!d) throw new Problem(404, `${compat().STOCK_LABEL[kind]} not found`)
    res.json(d)
  }

  /** Drafts only: replace the header and the lines, and approve in the same step when asked. */
  protected async update(kind: StockDocKind, id: string, req: AuthedRequest, res: Response) {
    const c = compat()
    const cur = await this.svc.find(kind, id)
    if (!cur) throw new Problem(404, `${c.STOCK_LABEL[kind]} not found`)
    if (cur.process !== "Created") throw new Problem(409, `Only drafts can be edited — ${cur.no} is ${cur.process}.`)
    const r = c.buildStock(kind, jsonBody(req))
    if ("status" in r) throw new Problem(r.status, r.title, r.errors)
    const user = req.dz!.user
    if (r.process === "Approved") {
      deny(user, "doc.approve")
      const probe = { ...cur, ...r.fields } as StockDoc
      const short = c.stockShortfall(probe.lines, c.stockSource(probe))
      if (short) throw new Problem(422, `Insufficient stock — ${short.detail}`, short.errors)
    }
    const before = structuredClone(cur)
    const at = new Date().toISOString()
    const next = { ...cur, ...r.fields } as StockDoc
    c.stampStockHistory(next, user.name, "edited", at)
    let approvedAt: string | undefined
    if (r.process === "Approved") {
      approvedAt = new Date().toISOString()
      const p = c.approveDoc(next, user.name, approvedAt)
      if (p) throw new Problem(p.status, p.title, p.errors)
    }
    const saved = await this.svc.update(next)
    await this.audit.record({ at, actor: user, entity: kind, entityId: saved.id, ref: saved.no, action: "edited", changes: c.stockDocDiff(before, saved) })
    if (approvedAt) await this.audit.record({ at: approvedAt, actor: user, entity: kind, entityId: saved.id, ref: saved.no, action: "approved" })
    res.json(saved)
  }

  /** Approve (moves the stock) or cancel (gives it back — a transfer's destination must still hold the goods). */
  protected async patch(kind: StockDocKind, id: string, req: AuthedRequest, res: Response) {
    const c = compat()
    const cur = await this.svc.find(kind, id)
    if (!cur) throw new Problem(404, `${c.STOCK_LABEL[kind]} not found`)
    const body = jsonBody(req) as { process?: string; reason?: string }
    const user = req.dz!.user
    if (body.process === "Approved") {
      deny(user, "doc.approve")
      if (cur.process !== "Created") throw new Problem(409, `Cannot approve — ${cur.no} is ${cur.process}.`)
      const at = new Date().toISOString()
      const p = c.approveDoc(cur, user.name, at)
      if (p) throw new Problem(p.status, p.title, p.errors)
      const saved = await this.svc.update(cur)
      await this.audit.record({ at, actor: user, entity: kind, entityId: saved.id, ref: saved.no, action: "approved" })
      res.json(saved)
      return
    }
    if (body.process === "Cancelled") {
      deny(user, "doc.cancel")
      if (cur.process === "Cancelled") throw new Problem(409, `${cur.no} is already cancelled.`)
      const reason = parse(cancelInput, { reason: body.reason ?? "" }).reason
      const at = new Date().toISOString()
      const p = c.cancelDoc(cur, user.name, reason, at)
      if (p) throw new Problem(p.status, p.title, p.errors)
      const saved = await this.svc.update(cur)
      await this.audit.record({ at, actor: user, entity: kind, entityId: saved.id, ref: saved.no, action: "cancelled", note: reason })
      res.json(saved)
      return
    }
    throw new Problem(400, "process must be Approved or Cancelled")
  }

  /** Drafts only, matched by id: an approved document is cancelled, never deleted. */
  protected async remove(kind: StockDocKind, id: string, req: AuthedRequest, res: Response) {
    const c = compat()
    const cur = await this.svc.byId(kind, id)
    if (!cur) throw new Problem(404, `${c.STOCK_LABEL[kind]} not found`)
    if (cur.process !== "Created") throw new Problem(409, `Only drafts can be deleted — cancel ${cur.no} instead.`)
    await this.svc.remove(cur)
    await this.audit.record({ actor: req.dz!.user, entity: kind, entityId: cur.id, ref: cur.no, action: "deleted" })
    res.json({ ok: true })
  }
}

@Controller("api/v1/transfers")
export class TransfersController extends StockControllerBase {
  constructor(@Inject(StockService) svc: StockService, @Inject(AuditService) audit: AuditService) { super(svc, audit) }
  protected readonly kind: StockDocKind = "transfer"

  @Get() @Authed()
  listTransfers(@Req() req: Request, @Res() res: Response) { return this.list(req, res) }

  @Post() @Authed("doc.create")
  createTransfer(@Req() req: AuthedRequest, @Res() res: Response) { return this.create(req, res) }

  @Get(":id") @Authed()
  getTransfer(@Param("id") id: string, @Res() res: Response) { return this.one(this.kind, id, res) }

  @Put(":id") @Authed("doc.edit")
  putTransfer(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.update(this.kind, id, req, res) }

  @Patch(":id") @Authed()
  patchTransfer(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.patch(this.kind, id, req, res) }

  @Delete(":id") @Authed("doc.delete")
  deleteTransfer(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.remove(this.kind, id, req, res) }
}

@Controller("api/v1/damage")
export class DamageController extends StockControllerBase {
  constructor(@Inject(StockService) svc: StockService, @Inject(AuditService) audit: AuditService) { super(svc, audit) }
  protected readonly kind: StockDocKind = "damage"

  @Get() @Authed()
  listDamage(@Req() req: Request, @Res() res: Response) { return this.list(req, res) }

  @Post() @Authed("doc.create")
  createDamage(@Req() req: AuthedRequest, @Res() res: Response) { return this.create(req, res) }

  @Get(":id") @Authed()
  getDamage(@Param("id") id: string, @Res() res: Response) { return this.one(this.kind, id, res) }

  @Put(":id") @Authed("doc.edit")
  putDamage(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.update(this.kind, id, req, res) }

  @Patch(":id") @Authed()
  patchDamage(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.patch(this.kind, id, req, res) }

  @Delete(":id") @Authed("doc.delete")
  deleteDamage(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.remove(this.kind, id, req, res) }
}
