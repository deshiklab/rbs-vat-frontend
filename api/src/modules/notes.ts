/**
 * R5.3 — credit notes (Mushak 6.7) and debit notes (Mushak 6.8) on their own tables: the documents that adjust a
 * sales invoice or a purchase after the fact. A credit note is goods a customer returns (the sold quantity comes
 * down, the output VAT with it); a debit note is goods returned to a vendor (the purchased quantity comes down, and
 * the input tax credit the purchase claimed is reversed).
 *
 * As with the parties, the items, the stock documents, the sales invoices and the purchases, the rules are the
 * mock's own (src/app/api/v1/_r2.ts, _r3.ts, _r4.ts and _docs.ts, reused through the compat bundle): what a body may
 * contain, the source document that has to exist and still be approved, how much of each item is still returnable,
 * how a returned line is priced pro rata, the numbers a note takes, the period lock, the stock a cancellation needs,
 * the registers' specs and CSV columns all come from the same code the Next.js mock and the static demo run, so the
 * responses, error codes and audit events cannot drift. What changed is underneath:
 *   - a note is a row in `notes` (`kind` tells a credit note from a debit note) with its lines in `note_lines`, so
 *     what a customer returned, what a vendor was charged back and the tax a period adjusts can be summed in SQL;
 *   - the note number is unique in the database as well, so two requests cannot share one;
 *   - a deleted draft keeps its row with `deleted_at`: the mock removed it from its array and its id counter moved
 *     on, so the row is what stops a later note taking the same id (there is no undo for a note);
 *   - the item counter an approval moves (`sold` for a credit note, `purchased` for a debit note) is written with
 *     the note, in the same transaction;
 *   - every write goes through the state guard, and the in-memory copies stay in step: a document's `creditable` /
 *     `returnable`, a customer's credit, the VAT returns and the branch stock still read *every* document, and the
 *     families without tables yet (production, opening entries) are compat state until R5.4.
 */
import { Controller, Delete, Get, Inject, Injectable, Param, Patch, Post, Put, Req, Res } from "@nestjs/common"
import { asc, eq, inArray, sql, type SQL } from "drizzle-orm"
import type { Request, Response } from "express"
import { can, ROLE_PERMS, type Permission, type User } from "@/lib/auth/roles"
import { runQuery, toCSV } from "@/lib/mock/query"
import type { CreditLine, CreditNote, DebitLine, DebitNote, Item, Line } from "@/lib/types"
import { Authed, type AuthedRequest } from "../common/auth"
import { jsonBody, Problem, searchParams, sendCsv, uniqueViolation } from "../common/http"
import { lockState } from "../common/state-guard"
import { WriteBack, type Delta } from "../common/writeback"
import { db, type Tx } from "../db/client"
import { items, noteLines, notes } from "../db/schema"
import { compat, mirror } from "../state"
import { AuditService } from "./audit"
import { markItems, revertItemCounters } from "./items"

export type NoteKind = "credit" | "debit"
export type Note = CreditNote | DebitNote
type NoteDb = typeof notes.$inferSelect
type LineDb = typeof noteLines.$inferSelect
/** What a new note is given inside the state lock: its id and the number it occupies. */
export type NoteIdentity = { id: string; no: string }
const today = () => new Date().toISOString().slice(0, 10)
const LABEL: Record<NoteKind, string> = { credit: "Credit note", debit: "Debit note" }
const ENTITY: Record<NoteKind, "creditNote" | "debitNote"> = { credit: "creditNote", debit: "debitNote" }
const kindOf = (n: Note): NoteKind => ("saleId" in n ? "credit" : "debit")
/** The mock's deny(): 403 naming the permission the role lacks — for the second permission a route needs. */
const deny = (user: User, perm: Permission) => {
  if (!can(ROLE_PERMS[user.role], perm)) throw new Problem(403, `Your role (${user.role}) is not allowed to do this (${perm}).`)
}

/* ── mappers ───────────────────────────────────────────────────────────── */

/** Row → note line. The source quantity and the two debit-only totals are named by the note's kind. */
const toNoteLine = (kind: NoteKind, r: LineDb): CreditLine | DebitLine => {
  const base = {
    itemId: r.itemId, name: r.name, hsCode: r.hsCode, uom: r.uom, qty: r.qty, price: r.price,
    sdRate: r.sdRate, vatRate: r.vatRate, subtotal: r.subtotal, sd: r.sd, vat: r.vat, total: r.total,
  }
  return kind === "credit"
    ? { ...base, soldQty: r.soldQty! } as CreditLine
    : { ...base, purchasedQty: r.purchasedQty!, tti: r.tti!, rebate: r.rebate! } as DebitLine
}

/** Header row + its lines → contract shape. The source and the party are named by kind, as the mock's two shapes are. */
export function toNote(kind: NoteKind, r: NoteDb, lines: Line[]): Note {
  const base = {
    id: r.id, no: r.no, challanNo: r.challanNo, branchId: r.branchId, branchName: r.branchName,
    issueDate: r.issueDate, issueTime: r.issueTime, reason: r.reason, issuedBy: r.issuedBy,
    designation: r.designation, process: r.process, lines, subtotal: r.subtotal, sd: r.sd, vat: r.vat,
    total: r.total, createdAt: r.createdAt.toISOString(), history: r.history ?? [],
  }
  const named = kind === "credit"
    ? {
      saleId: r.sourceId, saleNo: r.sourceNo, saleDate: r.sourceDate, saleMode: r.sourceMode as CreditNote["saleMode"],
      customerId: r.partyId, customerName: r.partyName, customerBin: r.partyBin, customerAddress: r.partyAddress,
    }
    : {
      purchaseId: r.sourceId, purchaseNo: r.sourceNo, purchaseDate: r.sourceDate,
      purchaseMode: r.sourceMode as DebitNote["purchaseMode"],
      vendorId: r.partyId, vendorName: r.partyName, vendorBin: r.partyBin, vendorAddress: r.partyAddress,
      tti: r.tti!, rebate: r.rebate!,
    }
  const n = { ...base, ...named } as Note
  if (r.note != null) n.note = r.note
  if (r.updatedAt) n.updatedAt = r.updatedAt.toISOString()
  if (r.cancelReason != null) n.cancelReason = r.cancelReason
  return n
}

/** Contract shape → header row values (`ord`, `kind` and `deletedAt` are the table's own). */
export const noteValues = (n: Note) => {
  const credit = kindOf(n) === "credit"
  const c = n as CreditNote, d = n as DebitNote
  return {
    id: n.id, kind: credit ? "credit" as const : "debit" as const, no: n.no,
    sourceId: credit ? c.saleId : d.purchaseId, sourceNo: credit ? c.saleNo : d.purchaseNo,
    sourceDate: credit ? c.saleDate : d.purchaseDate, sourceMode: credit ? c.saleMode : d.purchaseMode,
    challanNo: n.challanNo,
    partyId: credit ? c.customerId : d.vendorId, partyName: credit ? c.customerName : d.vendorName,
    partyBin: credit ? c.customerBin : d.vendorBin, partyAddress: credit ? c.customerAddress : d.vendorAddress,
    branchId: n.branchId, branchName: n.branchName, issueDate: n.issueDate, issueTime: n.issueTime,
    reason: n.reason, note: n.note ?? null, issuedBy: n.issuedBy, designation: n.designation, process: n.process,
    subtotal: n.subtotal, sd: n.sd, vat: n.vat, total: n.total,
    tti: credit ? null : d.tti, rebate: credit ? null : d.rebate,
    createdAt: new Date(n.createdAt), updatedAt: n.updatedAt ? new Date(n.updatedAt) : null,
    cancelReason: n.cancelReason ?? null, history: n.history ?? null,
  }
}

/** The note's lines as child rows, in the order they are printed. */
export const noteLineValues = (n: Note) => {
  const credit = kindOf(n) === "credit"
  return n.lines.map((l, i) => {
    const cl = l as CreditLine, dl = l as DebitLine
    return {
      noteId: n.id, ord: i + 1, itemId: l.itemId, name: l.name, hsCode: l.hsCode, uom: l.uom,
      soldQty: credit ? cl.soldQty : null, purchasedQty: credit ? null : dl.purchasedQty,
      qty: l.qty, price: l.price, sdRate: l.sdRate, vatRate: l.vatRate,
      subtotal: l.subtotal, sd: l.sd, vat: l.vat, total: l.total,
      tti: credit ? null : dl.tti, rebate: credit ? null : dl.rebate,
    }
  })
}

/* ── write-back: what the unported handlers changed ─────────────────────── */

/**
 * The notes are rows now, but the in-memory copies stay: what is still returnable on an invoice, a customer's
 * credit, the VAT returns and the branch stock derive from all of them, together with the documents that are still
 * compat state. A compat handler that writes through the mock's array — a restored backup, the demo runtime — is
 * written back here. See common/writeback.ts.
 */
const creditWb = new WriteBack<CreditNote>("creditNotes", () => mirror.creditNotes(), (n) => n.id)
const debitWb = new WriteBack<DebitNote>("debitNotes", () => mirror.debitNotes(), (n) => n.id)
export type NoteDelta = { credit: Delta<CreditNote>; debit: Delta<DebitNote> }
export const markCreditNotes = (list: CreditNote[]) => creditWb.mark(list)
export const markDebitNotes = (list: DebitNote[]) => debitWb.mark(list)
export const markNotes = (kind: NoteKind, list: Note[]) =>
  (kind === "credit" ? markCreditNotes(list as CreditNote[]) : markDebitNotes(list as DebitNote[]))
export const forgetCreditNote = (id: string) => creditWb.forget(id)
export const forgetDebitNote = (id: string) => debitWb.forget(id)
export const noteDelta = (): NoteDelta => ({ credit: creditWb.delta(), debit: debitWb.delta() })
export const commitNoteDelta = (d: NoteDelta) => { creditWb.commit(d.credit); debitWb.commit(d.debit) }
const wb = (kind: NoteKind) => (kind === "credit" ? creditWb : debitWb)

/**
 * Applies both notes' deltas inside the persist transaction and reads the saved note back into memory, so a value a
 * column type rounded (money is numeric(18,2), quantities numeric(18,3)) is not rewritten on every request.
 *
 * A note that left the in-memory list was deleted by a handler that still runs the mock's code: notes have no undo
 * buffer, so the row is stamped — which is what keeps its id and its number retired — and the write-back forgets it.
 * Anything else that vanishes is put back from its last persisted shape, because the table is authoritative.
 */
export async function applyNoteDelta(tx: Tx, d: NoteDelta) {
  for (const kind of ["credit", "debit"] as const) {
    const delta = d[kind] as { insert: Note[]; update: Note[]; missing: string[] }
    const inserted = new Set(delta.insert)
    for (const n of [...delta.insert, ...delta.update]) {
      // a note back in the live list is not deleted: an insert clears the stamp a compat delete may have set
      const values = inserted.has(n) ? { ...noteValues(n), deletedAt: null } : noteValues(n)
      const [row] = await tx.insert(notes).values(values)
        .onConflictDoUpdate({ target: notes.id, set: values }).returning()
      put(kind, await replaceChildren(tx, n, row))
    }
    for (const id of delta.missing) {
      const stored = (kind === "credit" ? creditWb.stored(id) : debitWb.stored(id)) as Note | undefined
      if (stored) {
        await tx.update(notes).set({ ...noteValues(stored), deletedAt: new Date() }).where(eq(notes.id, id))
        wb(kind).forget(id)
        continue
      }
      console.warn(`[notes] ${kind} note ${id} vanished from the in-memory state and has no stored row`)
    }
  }
}

const put = (kind: NoteKind, n: Note) => (kind === "credit" ? mirror.putCreditNote(n as CreditNote) : mirror.putDebitNote(n as DebitNote))

/** Replaces a note's lines with the ones it carries now, and reads both back. */
async function replaceChildren(tx: Tx, n: Note, row: NoteDb): Promise<Note> {
  const kind = kindOf(n)
  await tx.delete(noteLines).where(eq(noteLines.noteId, n.id))
  const lineRows = noteLineValues(n)
  const lines = lineRows.length ? (await tx.insert(noteLines).values(lineRows).returning()).map((r) => toNoteLine(kind, r)) : []
  return toNote(kind, row, lines)
}

/** Header rows + their lines → notes, in the rows' order (the service and boot share it). */
export async function assembleNotes(rows: NoteDb[]): Promise<Note[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const lineRows = await db.select().from(noteLines).where(inArray(noteLines.noteId, ids))
    .orderBy(asc(noteLines.noteId), asc(noteLines.ord))
  const kinds = new Map(rows.map((r) => [r.id, r.kind]))
  const lines = new Map<string, Line[]>()
  for (const l of lineRows) {
    const a = lines.get(l.noteId) ?? []
    a.push(toNoteLine(kinds.get(l.noteId)!, l))
    lines.set(l.noteId, a)
  }
  return rows.map((r) => toNote(r.kind, r, lines.get(r.id) ?? []))
}

/** The SKUs an approval moves: a credit note takes `sold` down, a debit note `purchased`. */
const captureCounters = (n: Note) => n.lines.map((l) => mirror.findItem(l.itemId)).filter((it): it is Item => !!it)
async function writeCounters(tx: Tx, kind: NoteKind, list: Item[]) {
  for (const it of list) {
    await tx.update(items).set(kind === "credit" ? { sold: it.sold } : { purchased: it.purchased }).where(eq(items.id, it.id))
  }
}

/* ── service ───────────────────────────────────────────────────────────── */

@Injectable()
export class NotesService {
  /** Every live note of one kind in insertion order — the order the mock's array had. */
  async all(kind: NoteKind): Promise<Note[]> {
    const rows = await db.select().from(notes)
      .where(sql`${notes.kind} = ${kind} and ${notes.deletedAt} is null`).orderBy(asc(notes.ord))
    return assembleNotes(rows)
  }

  /** One note by id or by number: the registers and the audit trail link both. */
  find(kind: NoteKind, idOrNo: string) {
    return this.first(sql`${notes.kind} = ${kind} and (${notes.id} = ${idOrNo} or ${notes.no} = ${idOrNo}) and ${notes.deletedAt} is null`)
  }

  /** One live note by id only — what a delete matches on. */
  byId(kind: NoteKind, id: string) {
    return this.first(sql`${notes.kind} = ${kind} and ${notes.id} = ${id} and ${notes.deletedAt} is null`)
  }

  private async first(match: SQL) {
    const rows = await db.select().from(notes).where(match)
    return rows.length ? (await assembleNotes(rows))[0] : undefined
  }

  /**
   * Stores a new note with its lines. `make` builds it once the id and the number are known — inside the lock, so
   * two creates in flight cannot share a number — and claims the id counter the mock's `db.seq` keeps. The counter
   * an approval moves is written with the note.
   */
  async create(kind: NoteKind, issueDate: string, make: (ident: NoteIdentity) => Note): Promise<Note> {
    let made: Note | undefined
    let counters: Item[] = []
    try {
      const saved = await db.transaction(async (tx) => {
        await lockState(tx)
        const c = compat()
        made = make(kind === "credit" ? c.creditIdentity(issueDate) : c.debitIdentity(issueDate))
        // claimed in memory first: a compat persist running mid-insert must not adopt the note twice
        put(kind, made)
        counters = captureCounters(made)
        const [row] = await tx.insert(notes).values(noteValues(made)).returning()
        await writeCounters(tx, kind, counters)
        return replaceChildren(tx, made, row)
      })
      put(kind, saved)
      markNotes(kind, [saved])
      markItems(counters)
      return saved
    } catch (e) {
      if (made) { remove(kind, made.id); forget(kind, made.id) }
      await revertItemCounters(counters.map((it) => it.id))
      NotesService.noConflict(e)
    }
  }

  /** Replaces a note and its lines, and writes the counters in the same transaction. */
  async update(kind: NoteKind, n: Note): Promise<Note> {
    const counters = captureCounters(n)
    try {
      const saved = await db.transaction(async (tx) => {
        await lockState(tx)
        const [row] = await tx.update(notes).set(noteValues(n)).where(eq(notes.id, n.id)).returning()
        if (!row) throw new Problem(404, `${LABEL[kind]} not found`)
        await writeCounters(tx, kind, counters)
        return replaceChildren(tx, n, row)
      })
      put(kind, saved)
      markNotes(kind, [saved])
      markItems(counters)
      return saved
    } catch (e) {
      await revertItemCounters(counters.map((it) => it.id))
      throw e as Error
    }
  }

  /**
   * Delete a draft: the row is stamped and leaves the register. Notes have no undo, but the row stays — the mock's
   * id counter moved on when the note was removed, and the row is what keeps a later note from taking its id.
   */
  async remove(kind: NoteKind, n: Note, at: string) {
    await db.transaction(async (tx) => {
      await lockState(tx)
      await tx.update(notes).set({ ...noteValues(n), deletedAt: new Date(at) }).where(eq(notes.id, n.id))
    })
    remove(kind, n.id)
    forget(kind, n.id)
  }

  /** A duplicate number the application check missed (two requests at once) is a 409, not a 500. */
  private static noConflict(e: unknown): never {
    if (uniqueViolation(e) !== null) throw new Problem(409, "That note number was just taken — please try again.")
    throw e as Error
  }
}

const remove = (kind: NoteKind, id: string) => (kind === "credit" ? mirror.removeCreditNote(id) : mirror.removeDebitNote(id))
const forget = (kind: NoteKind, id: string) => (kind === "credit" ? forgetCreditNote(id) : forgetDebitNote(id))

/* ── controller ────────────────────────────────────────────────────────── */

/**
 * The two note registers. The behaviour is shared with the mock handlers (see the header); this base only adds
 * storage, the state guard and the audit trail. Nest does not pick up decorated methods from a base class, so each
 * concrete controller declares its own routes and delegates here.
 */
abstract class NotesControllerBase {
  protected constructor(
    @Inject(NotesService) protected readonly svc: NotesService,
    @Inject(AuditService) protected readonly audit: AuditService,
  ) {}

  protected abstract readonly kind: NoteKind

  /** The register: Page<CreditNote | DebitNote> with facets and party labels, or CSV. */
  protected async list(req: Request, res: Response) {
    const kind = this.kind
    const c = compat()
    const sp = searchParams(req)
    if (!sp.get("sort")) sp.set("sort", "createdAt.desc")
    const all = await this.svc.all(kind)
    const r = kind === "credit"
      ? runQuery(c.creditSourceFilter(sp, all as CreditNote[]), sp, c.creditSpec)
      : runQuery(c.debitSourceFilter(sp, all as DebitNote[]), sp, c.debitSpec)
    if (sp.get("format") === "csv") {
      const columns = kind === "credit" ? c.creditCsvColumns : c.debitCsvColumns
      sendCsv(res, toCSV(r.all as never[], columns as never[]), `${kind === "credit" ? "credit" : "debit"}-notes-${today()}.csv`)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all: _all, ...page } = r
    res.json({ ...page, facetLabels: kind === "credit" ? c.creditFacetLabels() : c.debitFacetLabels() })
  }

  /** Create a draft, or create and approve it in one step (which needs the approve permission). */
  protected async create(req: AuthedRequest, res: Response) {
    const kind = this.kind
    const c = compat()
    const built = kind === "credit" ? c.buildCredit(jsonBody(req)) : c.buildDebit(jsonBody(req))
    if ("status" in built) throw new Problem(built.status, built.title, built.errors)
    const user = req.dz!.user
    const approving = built.process === "Approved"
    if (approving) deny(user, "doc.approve")
    const fields = built.fields as Note
    // before the note exists: a debit note that cannot be approved must not consume an id
    if (kind === "debit" && approving) {
      const short = c.debitStockRule(fields.lines as DebitLine[], fields.branchId, 422)
      if (short) throw new Problem(short.status, short.title, short.errors)
    }
    const at = new Date().toISOString()
    const note = await this.svc.create(kind, fields.issueDate, (ident) => {
      const n = { ...fields, ...ident, process: "Created" as const, createdAt: at, history: [] } as unknown as Note
      if (kind === "credit") c.claimCreditId(); else c.claimDebitId()
      c.stampNoteHistory(n, user.name, "created", undefined, at)
      if (approving) {
        n.process = "Approved"
        if (kind === "credit") c.postCredit(n as CreditNote, 1); else c.postDebit(n as DebitNote, 1)
        c.stampNoteHistory(n, user.name, "approved")
      }
      return n
    })
    await this.audit.record({ at, actor: user, entity: ENTITY[kind], entityId: note.id, ref: note.no, action: "created" })
    const approved = note.history?.find((h) => h.action === "approved")
    if (approved) await this.audit.record({ at: approved.at, actor: user, entity: ENTITY[kind], entityId: note.id, ref: note.no, action: "approved" })
    res.status(201).json(note)
  }

  protected async one(kind: NoteKind, id: string, res: Response) {
    const n = await this.svc.find(kind, id)
    if (!n) throw new Problem(404, `${LABEL[kind]} not found`)
    res.json(n)
  }

  /** Edit a draft (full replacement). Optional approve-on-save. */
  protected async update(kind: NoteKind, id: string, req: AuthedRequest, res: Response) {
    const c = compat()
    const cur = await this.svc.find(kind, id)
    if (!cur) throw new Problem(404, `${LABEL[kind]} not found`)
    const draft = c.noteDraftRule(cur)
    if (draft) throw new Problem(draft.status, draft.title, draft.errors)
    const built = kind === "credit" ? c.buildCredit(jsonBody(req), cur.id) : c.buildDebit(jsonBody(req), cur.id)
    if ("status" in built) throw new Problem(built.status, built.title, built.errors)
    const user = req.dz!.user
    const approving = built.process === "Approved"
    if (approving) deny(user, "doc.approve")
    const fields = built.fields as Note
    if (kind === "credit") {
      const moved = c.creditMovedRule(cur as CreditNote, (fields as CreditNote).saleId)
      if (moved) throw new Problem(moved.status, moved.title, moved.errors)
    } else if (approving) {
      const short = c.debitStockRule(fields.lines as DebitLine[], fields.branchId, 422)
      if (short) throw new Problem(short.status, short.title, short.errors)
    }
    const before = structuredClone(cur)
    const next = { ...cur, ...fields } as Note
    const at = new Date().toISOString()
    c.stampNoteHistory(next, user.name, "edited", undefined, at)
    const changes = c.noteDiff(before, next)
    let approvedAt: string | undefined
    if (approving) {
      approvedAt = new Date().toISOString()
      next.process = "Approved"
      if (kind === "credit") c.postCredit(next as CreditNote, 1); else c.postDebit(next as DebitNote, 1)
      c.stampNoteHistory(next, user.name, "approved", undefined, approvedAt)
    }
    const saved = await this.svc.update(kind, next)
    await this.audit.record({ at, actor: user, entity: ENTITY[kind], entityId: saved.id, ref: saved.no, action: "edited", changes })
    if (approvedAt) await this.audit.record({ at: approvedAt, actor: user, entity: ENTITY[kind], entityId: saved.id, ref: saved.no, action: "approved" })
    res.json(saved)
  }

  /** State transitions: approve (moves the stock and the counter), or cancel with a mandatory reason (reverses it). */
  protected async patch(kind: NoteKind, id: string, req: AuthedRequest, res: Response) {
    const c = compat()
    const cur = await this.svc.find(kind, id)
    if (!cur) throw new Problem(404, `${LABEL[kind]} not found`)
    const body = jsonBody(req) as { process?: string; reason?: string }
    const user = req.dz!.user
    if (body.process === "Approved") {
      deny(user, "doc.approve")
      const rule = kind === "credit" ? c.creditApproveRule(cur as CreditNote) : c.debitApproveRule(cur as DebitNote)
      if (rule) throw new Problem(rule.status, rule.title, rule.errors)
      if (kind === "debit") {
        const short = c.debitStockRule(cur.lines as DebitLine[], cur.branchId, 409)
        if (short) throw new Problem(short.status, short.title, short.errors)
      }
      const at = new Date().toISOString()
      const next = structuredClone(cur)
      next.process = "Approved"
      if (kind === "credit") c.postCredit(next as CreditNote, 1); else c.postDebit(next as DebitNote, 1)
      c.stampNoteHistory(next, user.name, "approved", undefined, at)
      const saved = await this.svc.update(kind, next)
      await this.audit.record({ at, actor: user, entity: ENTITY[kind], entityId: saved.id, ref: saved.no, action: "approved" })
      res.json(saved)
      return
    }
    if (body.process === "Cancelled") {
      deny(user, "doc.cancel")
      const r = kind === "credit"
        ? c.creditCancelRule(cur as CreditNote, body.reason ?? "")
        : c.debitCancelRule(cur as DebitNote, body.reason ?? "")
      if ("status" in r) throw new Problem(r.status, r.title, r.errors)
      const at = new Date().toISOString()
      const next = structuredClone(cur)
      if (next.process === "Approved") {
        if (kind === "credit") c.postCredit(next as CreditNote, -1); else c.postDebit(next as DebitNote, -1)
      }
      next.process = "Cancelled"
      next.cancelReason = r.reason
      c.stampNoteHistory(next, user.name, "cancelled", r.reason, at)
      const saved = await this.svc.update(kind, next)
      await this.audit.record({ at, actor: user, entity: ENTITY[kind], entityId: saved.id, ref: saved.no, action: "cancelled", note: r.reason })
      res.json(saved)
      return
    }
    throw new Problem(400, "process must be Approved or Cancelled")
  }

  /** Delete a draft: the row is stamped, so its id and its number stay retired. Notes have no undo. */
  protected async remove(kind: NoteKind, id: string, req: AuthedRequest, res: Response) {
    const c = compat()
    const cur = await this.svc.byId(kind, id)
    if (!cur) throw new Problem(404, `${LABEL[kind]} not found`)
    const rule = kind === "credit" ? c.creditDeleteRule(cur as CreditNote) : c.debitDeleteRule(cur as DebitNote)
    if (rule) throw new Problem(rule.status, rule.title, rule.errors)
    const at = new Date().toISOString()
    const next = structuredClone(cur)
    c.stampNoteHistory(next, req.dz!.user.name, "deleted", undefined, at)
    await this.svc.remove(kind, next, at)
    await this.audit.record({ at, actor: req.dz!.user, entity: ENTITY[kind], entityId: cur.id, ref: cur.no, action: "deleted" })
    res.json({ ok: true })
  }
}

@Controller("api/v1/credit-notes")
export class CreditNotesController extends NotesControllerBase {
  constructor(@Inject(NotesService) svc: NotesService, @Inject(AuditService) audit: AuditService) { super(svc, audit) }
  protected readonly kind: NoteKind = "credit"

  @Get() @Authed()
  listCreditNotes(@Req() req: Request, @Res() res: Response) { return this.list(req, res) }

  @Post() @Authed("doc.create")
  createCreditNote(@Req() req: AuthedRequest, @Res() res: Response) { return this.create(req, res) }

  @Get(":id") @Authed()
  getCreditNote(@Param("id") id: string, @Res() res: Response) { return this.one(this.kind, id, res) }

  @Put(":id") @Authed("doc.edit")
  putCreditNote(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.update(this.kind, id, req, res) }

  @Patch(":id") @Authed()
  patchCreditNote(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.patch(this.kind, id, req, res) }

  @Delete(":id") @Authed("doc.delete")
  deleteCreditNote(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.remove(this.kind, id, req, res) }
}

@Controller("api/v1/debit-notes")
export class DebitNotesController extends NotesControllerBase {
  constructor(@Inject(NotesService) svc: NotesService, @Inject(AuditService) audit: AuditService) { super(svc, audit) }
  protected readonly kind: NoteKind = "debit"

  @Get() @Authed()
  listDebitNotes(@Req() req: Request, @Res() res: Response) { return this.list(req, res) }

  @Post() @Authed("doc.create")
  createDebitNote(@Req() req: AuthedRequest, @Res() res: Response) { return this.create(req, res) }

  @Get(":id") @Authed()
  getDebitNote(@Param("id") id: string, @Res() res: Response) { return this.one(this.kind, id, res) }

  @Put(":id") @Authed("doc.edit")
  putDebitNote(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.update(this.kind, id, req, res) }

  @Patch(":id") @Authed()
  patchDebitNote(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.patch(this.kind, id, req, res) }

  @Delete(":id") @Authed("doc.delete")
  deleteDebitNote(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.remove(this.kind, id, req, res) }
}
