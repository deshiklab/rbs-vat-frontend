/**
 * R5.2 — customers and vendors on their own table (`parties`): the first business records out of the compat layer.
 *
 * Responses, error codes and audit events are identical to the mock handlers in src/app/api/v1/_parties.ts, whose
 * rules this module *reuses* (through the compat bundle) rather than reimplements: `partyRow` aggregates, the
 * duplicate/mode checks, the stored shape and the id format all come from the same code the mock and the static
 * demo run. What changed is underneath:
 *   - rows live in PostgreSQL, with the uniqueness rules enforced by partial unique indexes;
 *   - a delete is a `deleted_at` stamp, so master data never leaves relational storage (the undo trash is rebuilt
 *     from the table at boot);
 *   - every write goes through the state guard, so an instance whose data set was replaced refuses to write;
 *   - the in-memory copies the unported handlers read (documents quote a customer id, the picker lists them) are
 *     kept in step, and parties a compat handler creates (bulk import) are adopted into the table.
 *
 * The list still runs on the shared in-memory engine (`runQuery`), like units: its aggregates, facets and totals
 * are computed from documents, which stay in `compat_state` until R5.3 — then it becomes a SQL join.
 */
import { Controller, Delete, Get, Inject, Injectable, Param, Post, Put, Req, Res } from "@nestjs/common"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import type { Request, Response } from "express"
import { runQuery, toCSV } from "@/lib/mock/query"
import { partyInput } from "@/lib/schemas"
import type { Party } from "@/lib/types"
import { Authed, type AuthedRequest } from "../common/auth"
import { WriteBack, type Delta } from "../common/writeback"
import { jsonBody, parse, Problem, searchParams, sendCsv, uniqueViolation } from "../common/http"
import { lockState } from "../common/state-guard"
import { db, type Tx } from "../db/client"
import { parties } from "../db/schema"
import { compat, mirror, type PartyKind } from "../state"
import { AuditService } from "./audit"

export type { PartyKind }
type PartyDb = typeof parties.$inferSelect

/** Row → contract shape: a NULL column is an absent optional field, exactly as the mock leaves it undefined. */
export const toParty = (r: PartyDb): Party => {
  const p: Party = {
    id: r.id, name: r.name, bin: r.bin, mobile: r.mobile, address: r.address, kind: r.kind, mode: r.mode as Party["mode"],
  }
  if (r.country != null) p.country = r.country
  if (r.active != null) p.active = r.active
  if (r.creditLimit != null) p.creditLimit = r.creditLimit
  if (r.vdsWithholder != null) p.vdsWithholder = r.vdsWithholder
  if (r.email != null) p.email = r.email
  if (r.contactPerson != null) p.contactPerson = r.contactPerson
  if (r.exporterType != null) p.exporterType = r.exporterType as Party["exporterType"]
  if (r.bondLicenseNo != null) p.bondLicenseNo = r.bondLicenseNo
  if (r.bondLicenseExpiry != null) p.bondLicenseExpiry = r.bondLicenseExpiry
  if (r.associationNo != null) p.associationNo = r.associationNo
  return p
}

/** Contract shape → row values (`ord` and `deleted_at` are managed by the service). */
export const partyValues = (p: Party) => ({
  id: p.id, kind: p.kind, name: p.name, bin: p.bin, mode: p.mode, mobile: p.mobile, address: p.address,
  country: p.country ?? null, email: p.email ?? null, contactPerson: p.contactPerson ?? null,
  active: p.active ?? null, creditLimit: p.creditLimit ?? null, vdsWithholder: p.vdsWithholder ?? null,
  exporterType: p.exporterType ?? null, bondLicenseNo: p.bondLicenseNo ?? null,
  bondLicenseExpiry: p.bondLicenseExpiry ?? null, associationNo: p.associationNo ?? null,
})

/* ── write-back: what the unported handlers changed ─────────────────────── */

/**
 * The compat handlers read parties everywhere but only one of them writes (the R6.2 bulk import creates
 * customers/vendors); comparing signatures after each request adopts those rows and heals any drift, so the table
 * and the in-memory world cannot come apart. See common/writeback.ts.
 */
const wb = new WriteBack<Party>("parties", () => [...mirror.parties("customer"), ...mirror.parties("vendor")], (p) => p.id)
export type PartyDelta = Delta<Party>
export const markParties = (list: Party[]) => wb.mark(list)
export const forgetParty = (id: string) => wb.forget(id)
export const partyDelta = () => wb.delta()
export const commitPartyDelta = (d: PartyDelta) => wb.commit(d)

/**
 * Applies the delta inside the persist transaction. A party that disappeared from memory is put back from its last
 * persisted shape: the table is authoritative, and a document may still quote it.
 */
export async function applyPartyDelta(tx: Tx, d: PartyDelta) {
  // upsert: a party created here may have reached the table through another path (two instances, a retried request)
  for (const p of d.insert) await tx.insert(parties).values(partyValues(p)).onConflictDoUpdate({ target: parties.id, set: partyValues(p) })
  for (const p of d.update) await tx.update(parties).set(partyValues(p)).where(eq(parties.id, p.id))
  for (const id of d.missing) {
    const p = wb.stored(id)
    if (!p) continue
    mirror.putParty(p)
    console.warn(`[parties] ${p.kind} ${id} vanished from the in-memory state — restored from the table copy`)
  }
}

/* ── service ───────────────────────────────────────────────────────────── */

@Injectable()
export class PartiesService {
  /** Live parties of one kind in insertion order — the order the mock's array had. */
  async all(kind: PartyKind): Promise<Party[]> {
    const rows = await db.select().from(parties).where(and(eq(parties.kind, kind), isNull(parties.deletedAt))).orderBy(asc(parties.ord))
    return rows.map(toParty)
  }

  async row(kind: PartyKind, id: string): Promise<PartyDb | undefined> {
    const [r] = await db.select().from(parties).where(and(eq(parties.id, id), eq(parties.kind, kind), isNull(parties.deletedAt)))
    return r
  }

  async trashedRow(kind: PartyKind, id: string): Promise<PartyDb | undefined> {
    const [r] = await db.select().from(parties).where(and(eq(parties.id, id), eq(parties.kind, kind), sql`${parties.deletedAt} is not null`))
    return r
  }

  /** A duplicate the application checks missed (two requests at once) is a 422, not a 500. */
  private static conflict(e: unknown): never {
    const index = uniqueViolation(e)
    if (index === null) throw e as Error
    if (index.includes("name")) throw new Problem(422, "Validation failed", { name: ["duplicate"] })
    throw new Problem(422, "Validation failed", { bin: ["duplicate"] })
  }

  async create(kind: PartyKind, p: Party) {
    // Claimed in memory first (synchronously), so a compat persist running mid-insert does not adopt it twice
    mirror.putParty(p)
    markParties([p])
    try {
      const [row] = await db.transaction(async (tx) => {
        await lockState(tx)
        return tx.insert(parties).values(partyValues(p)).returning()
      })
      return toParty(row)
    } catch (e) {
      mirror.removeParty(kind, p.id)
      forgetParty(p.id)
      PartiesService.conflict(e)
    }
  }

  async update(kind: PartyKind, p: Party) {
    const before = mirror.findParty(kind, p.id)
    try {
      const [row] = await db.transaction(async (tx) => {
        await lockState(tx)
        return tx.update(parties).set(partyValues(p)).where(eq(parties.id, p.id)).returning()
      })
      const next = toParty(row)
      if (before) mirror.putParty(next)
      markParties([next])
      return next
    } catch (e) {
      if (before) mirror.putParty(before)
      markParties(before ? [before] : [])
      PartiesService.conflict(e)
    }
  }

  /** Soft delete: the row stays (audit, documents that quote it) and becomes the undo trash. */
  async remove(kind: PartyKind, p: Party, at: string) {
    await db.transaction(async (tx) => {
      await lockState(tx)
      await tx.update(parties).set({ deletedAt: new Date(at) }).where(eq(parties.id, p.id))
    })
    mirror.removeParty(kind, p.id)
    mirror.trash().push({ kind, doc: p, at })
    forgetParty(p.id)
  }

  /** Clears the stamp. The row keeps its `ord`: the mock pushed a restored party to the end of its array, but the
   *  register sorts by name — unique per kind — so the order the user sees is the same either way. */
  async restore(kind: PartyKind, id: string) {
    let row: PartyDb
    try {
      ;[row] = await db.transaction(async (tx) => {
        await lockState(tx)
        return tx.update(parties).set({ deletedAt: null }).where(eq(parties.id, id)).returning()
      })
    } catch (e) {
      // An undo can collide with a party created after the delete — the unique indexes ignore the trash, so the name
      // or BIN may be taken by now. The record stays deleted and the caller gets the same 422 the form gets.
      PartiesService.conflict(e)
    }
    const p = toParty(row)
    const i = mirror.trash().findIndex((t) => t.kind === kind && t.doc.id === id)
    if (i >= 0) mirror.trash().splice(i, 1)
    mirror.putParty(p)
    markParties([p])
    return p
  }
}

/* ── controllers ───────────────────────────────────────────────────────── */

/**
 * The six party endpoints, once per kind. The behaviour is shared with the mock handlers (see the header); this
 * class only adds storage, the state guard and the audit trail.
 */
abstract class PartyControllerBase {
  protected constructor(
    @Inject(PartiesService) protected readonly svc: PartiesService,
    @Inject(AuditService) protected readonly audit: AuditService,
  ) {}

  protected abstract readonly kind: PartyKind

  /** `?view=table` → the register (Page<PartyRow>, facets, totals, CSV); otherwise the picker's options. */
  protected async list(req: Request, res: Response) {
    const sp = searchParams(req)
    const kind = this.kind
    const live = await this.svc.all(kind)
    if (sp.get("view") !== "table") {
      const q = (sp.get("q") ?? "").toLowerCase()
      res.json(live.filter((p) => p.active !== false && (!q || `${p.name} ${p.bin}`.toLowerCase().includes(q))))
      return
    }
    if (!sp.get("sort")) sp.set("sort", "name.asc")
    const c = compat()
    const r = runQuery(live.map((p) => c.partyRow(kind, p)), sp, c.partySpec)
    if (sp.get("format") === "csv") {
      sendCsv(res, toCSV(r.all, c.partyCsvColumns(kind)), `${kind}s-${new Date().toISOString().slice(0, 10)}.csv`)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    res.json(page)
  }

  protected async create(req: AuthedRequest, res: Response) {
    const kind = this.kind
    const d = parse(partyInput, jsonBody(req))
    const c = compat()
    const errors = c.partyErrors(kind, d)
    if (Object.keys(errors).length) throw new Problem(422, "Validation failed", errors)
    const p = c.buildParty(kind, d, c.newPartyId(kind))
    const user = req.dz!.user
    const made = await this.svc.create(kind, p)
    await this.audit.record({ actor: user, entity: kind, entityId: made.id, ref: made.name, action: "created" })
    res.status(201).json(made)
  }

  protected async one(kind: PartyKind, id: string, res: Response) {
    const r = await this.svc.row(kind, id)
    if (!r) throw new Problem(404, `${compat().partyLabel(kind)} not found`)
    res.json(compat().partyRow(kind, toParty(r)))
  }

  protected async update(kind: PartyKind, id: string, req: AuthedRequest, res: Response) {
    const row = await this.svc.row(kind, id)
    if (!row) throw new Problem(404, `${compat().partyLabel(kind)} not found`)
    const d = parse(partyInput, jsonBody(req))
    const c = compat()
    const errors = c.partyErrors(kind, d, id)
    if (Object.keys(errors).length) throw new Problem(422, "Validation failed", errors)
    const before = toParty(row)
    // A party with documents cannot change registration type (it would change the VAT treatment of issued documents)
    if (d.mode !== before.mode && c.partyDocs(kind, id).length) throw new Problem(422, "Validation failed", { mode: ["modeLocked"] })
    // Object.assign semantics: the id, the kind and the seeded credit terms survive an edit
    const next: Party = { ...before, ...c.normaliseParty(d) }
    const saved = await this.svc.update(kind, next)
    await this.audit.record({ actor: req.dz!.user, entity: kind, entityId: saved.id, ref: saved.name, action: "edited", changes: c.diff(before, saved, c.PARTY_FIELDS) })
    res.json(saved)
  }

  /** Only parties without documents can be deleted; the others must be deactivated (409 in-use:N). */
  protected async remove(kind: PartyKind, id: string, req: AuthedRequest, res: Response) {
    const row = await this.svc.row(kind, id)
    if (!row) throw new Problem(404, `${compat().partyLabel(kind)} not found`)
    const p = toParty(row)
    const n = compat().partyDocs(kind, id).length
    if (n) throw new Problem(409, `in-use:${n}`)
    await this.svc.remove(kind, p, new Date().toISOString())
    await this.audit.record({ actor: req.dz!.user, entity: kind, entityId: p.id, ref: p.name, action: "deleted" })
    res.json({ ok: true })
  }

  protected async undo(kind: PartyKind, id: string, req: AuthedRequest, res: Response) {
    const row = await this.svc.trashedRow(kind, id)
    if (!row) throw new Problem(404, `${compat().partyLabel(kind)} not found in trash`)
    const p = await this.svc.restore(kind, id)
    await this.audit.record({ actor: req.dz!.user, entity: kind, entityId: p.id, ref: p.name, action: "restored" })
    // 200, not the 201 Nest gives every @Post: an undo puts an existing record back, it does not create one
    res.status(200).json(p)
  }
}

@Controller("api/v1/customers")
export class CustomersController extends PartyControllerBase {
  constructor(@Inject(PartiesService) svc: PartiesService, @Inject(AuditService) audit: AuditService) { super(svc, audit) }
  protected readonly kind: PartyKind = "customer"

  @Get() @Authed()
  listCustomers(@Req() req: Request, @Res() res: Response) { return this.list(req, res) }

  @Post() @Authed("master.edit")
  createCustomer(@Req() req: AuthedRequest, @Res() res: Response) { return this.create(req, res) }

  @Get(":id") @Authed()
  getCustomer(@Param("id") id: string, @Res() res: Response) { return this.one(this.kind, id, res) }

  @Put(":id") @Authed("master.edit")
  putCustomer(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.update(this.kind, id, req, res) }

  @Delete(":id") @Authed("master.edit")
  deleteCustomer(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.remove(this.kind, id, req, res) }

  @Post(":id/restore") @Authed("master.edit")
  restoreCustomer(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.undo(this.kind, id, req, res) }
}

@Controller("api/v1/vendors")
export class VendorsController extends PartyControllerBase {
  constructor(@Inject(PartiesService) svc: PartiesService, @Inject(AuditService) audit: AuditService) { super(svc, audit) }
  protected readonly kind: PartyKind = "vendor"

  @Get() @Authed()
  listVendors(@Req() req: Request, @Res() res: Response) { return this.list(req, res) }

  @Post() @Authed("master.edit")
  createVendor(@Req() req: AuthedRequest, @Res() res: Response) { return this.create(req, res) }

  @Get(":id") @Authed()
  getVendor(@Param("id") id: string, @Res() res: Response) { return this.one(this.kind, id, res) }

  @Put(":id") @Authed("master.edit")
  putVendor(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.update(this.kind, id, req, res) }

  @Delete(":id") @Authed("master.edit")
  deleteVendor(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.remove(this.kind, id, req, res) }

  @Post(":id/restore") @Authed("master.edit")
  restoreVendor(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) { return this.undo(this.kind, id, req, res) }
}
