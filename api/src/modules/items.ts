/**
 * R5.2 — items (SKUs) and master items on their own tables: the rest of the master data out of the compat layer.
 *
 * As with the parties, the rules are the mock's own (src/app/api/v1/_items.ts, reused through the compat bundle):
 * the register's spec and CSV columns, the derived cost price, the duplicate-SKU and unit checks, the master item's
 * tax-override rules and its history all come from the same code the Next.js mock and the static demo run, so the
 * responses, error codes and audit events cannot drift. What changed is underneath:
 *   - rows live in PostgreSQL, with the unique SKU and master-item name enforced by the database as well;
 *   - an item's movement counters are columns, so `remain` (and the valuation built from it) travels with the row;
 *   - renaming a master item carries its SKUs along in the same transaction (they reference it by name);
 *   - every write goes through the state guard, and the in-memory copies the unported handlers read are kept in
 *     step — documents still move an item's counters, and those changes are written back to the table.
 *
 * The stock ledger and the branch split stay derived from documents, which are compat state until R5.3; so those
 * two endpoints (`items/[id]/ledger`, `stock`) are still served by the compat layer.
 */
import { Controller, Get, Inject, Injectable, Param, Post, Put, Req, Res } from "@nestjs/common"
import { asc, eq, inArray, sql } from "drizzle-orm"
import type { Request, Response } from "express"
import { runQuery, toCSV } from "@/lib/mock/query"
import { itemInput, masterItemInput } from "@/lib/schemas"
import type { HistoryEntry, Item, MasterItem } from "@/lib/types"
import { Authed, type AuthedRequest } from "../common/auth"
import { jsonBody, parse, Problem, searchParams, sendCsv, uniqueViolation } from "../common/http"
import { lockState } from "../common/state-guard"
import { WriteBack, type Delta } from "../common/writeback"
import { db, type Tx } from "../db/client"
import { items, masterItems } from "../db/schema"
import { compat, mirror } from "../state"
import { AuditService } from "./audit"

type ItemDb = typeof items.$inferSelect
type MasterDb = typeof masterItems.$inferSelect
const today = () => new Date().toISOString().slice(0, 10)

/** Row → contract shape (the field order the mock's objects have). */
export const toItem = (r: ItemDb): Item => ({
  id: r.id, hsCode: r.hsCode, group: r.group as Item["group"], masterItem: r.masterItem, brand: r.brand, name: r.name,
  unit: r.unit, sku: r.sku, purchasePrice: r.purchasePrice, costPrice: r.costPrice, salePrice: r.salePrice,
  vatRate: r.vatRate, sdRate: r.sdRate, opening: r.opening, purchased: r.purchased, prodReceive: r.prodReceive,
  prodIssue: r.prodIssue, sold: r.sold, damage: r.damage, reorderLevel: r.reorderLevel, active: r.active,
})

/** Contract shape → row values (`ord` is the table's own). */
export const itemValues = (i: Item) => ({
  id: i.id, hsCode: i.hsCode, group: i.group, masterItem: i.masterItem, brand: i.brand, name: i.name, unit: i.unit,
  sku: i.sku, purchasePrice: i.purchasePrice, costPrice: i.costPrice, salePrice: i.salePrice, vatRate: i.vatRate,
  sdRate: i.sdRate, opening: i.opening, purchased: i.purchased, prodReceive: i.prodReceive, prodIssue: i.prodIssue,
  sold: i.sold, damage: i.damage, reorderLevel: i.reorderLevel, active: i.active,
})

/** Row → contract shape: a NULL column is an absent optional field, and the tax profile becomes `rates` again. */
export const toMaster = (r: MasterDb): MasterItem => {
  const m: MasterItem = {
    id: r.id, name: r.name, hsCode: r.hsCode, group: r.group as MasterItem["group"], category: r.category as MasterItem["category"],
    unit: r.unit, priceMethod: r.priceMethod as MasterItem["priceMethod"],
    rates: { vat: r.vat, sd: r.sd, cd: r.cd, rd: r.rd, ait: r.ait, at: r.at },
    active: r.active, createdAt: r.createdAt.toISOString(),
  }
  if (r.description != null) m.description = r.description
  if (r.overrideReason != null) m.overrideReason = r.overrideReason
  if (r.updatedAt) m.updatedAt = r.updatedAt.toISOString()
  if (r.history?.length) m.history = r.history
  return m
}

export const masterValues = (m: MasterItem) => ({
  id: m.id, name: m.name, hsCode: m.hsCode, group: m.group, category: m.category, unit: m.unit, priceMethod: m.priceMethod,
  description: m.description ?? null,
  vat: m.rates.vat, sd: m.rates.sd, cd: m.rates.cd, rd: m.rates.rd, ait: m.rates.ait, at: m.rates.at,
  overrideReason: m.overrideReason ?? null, active: m.active,
  createdAt: new Date(m.createdAt), updatedAt: m.updatedAt ? new Date(m.updatedAt) : null, history: m.history ?? null,
})

/** The master item's own trail and `updatedAt`; the caller records the audit event with the same timestamp. */
export const stampHistory = (m: MasterItem, by: string, action: HistoryEntry["action"], at: string, note?: string) => {
  m.history = [...(m.history ?? []), { at, by, action, note }]
  m.updatedAt = at
}

/* ── write-back: what the unported handlers changed ─────────────────────── */

/**
 * Documents still move an item's counters (approving or cancelling a sale, a debit note, a damage or production
 * document, an opening entry) and the bulk import creates SKUs — all through the in-memory world, so every compat
 * request is followed by a comparison and the table takes whatever changed. See common/writeback.ts.
 */
const itemWb = new WriteBack<Item>("items", () => mirror.items(), (i) => i.id)
const masterWb = new WriteBack<MasterItem>("master_items", () => mirror.masterItems(), (m) => m.id)
export type ItemDelta = Delta<Item>
export type MasterDelta = Delta<MasterItem>
export const markItems = (list: Item[]) => itemWb.mark(list)
export const markMasters = (list: MasterItem[]) => masterWb.mark(list)
export const itemDelta = () => itemWb.delta()
export const masterDelta = () => masterWb.delta()
export const commitItemDelta = (d: ItemDelta) => itemWb.commit(d)
export const commitMasterDelta = (d: MasterDelta) => masterWb.commit(d)

/**
 * R5.3: a document's transaction moved item counters in memory — a damage write-off, a sale's approval — and then
 * failed, so the table still holds the values from before it. Read those back into the mirror. The write-back
 * baseline is left alone: it already describes them, so the item simply stops looking modified.
 */
export async function revertItemCounters(ids: string[]) {
  if (!ids.length) return
  const rows = await db.select({ id: items.id, sold: items.sold, purchased: items.purchased, damage: items.damage })
    .from(items).where(inArray(items.id, ids))
  for (const r of rows) {
    const it = mirror.findItem(r.id)
    if (it) { it.sold = r.sold; it.purchased = r.purchased; it.damage = r.damage }
  }
}

/**
 * Applies a delta inside the persist transaction and reads the saved rows back into memory: a column type that
 * rounds (money is numeric(18,2)) must not leave the two copies differing, or every request would rewrite the row.
 * A row that disappeared from memory is put back from its last persisted shape — the table is authoritative, and
 * documents still quote it.
 */
export async function applyItemDelta(tx: Tx, d: ItemDelta) {
  for (const i of d.insert) {
    const [row] = await tx.insert(items).values(itemValues(i)).onConflictDoUpdate({ target: items.id, set: itemValues(i) }).returning()
    mirror.putItem(toItem(row))
  }
  for (const i of d.update) {
    const [row] = await tx.update(items).set(itemValues(i)).where(eq(items.id, i.id)).returning()
    if (row) mirror.putItem(toItem(row))
  }
  for (const id of d.missing) {
    const it = itemWb.stored(id)
    if (!it) continue
    mirror.putItem(it)
    console.warn(`[items] ${id} vanished from the in-memory state — restored from the table copy`)
  }
}

export async function applyMasterDelta(tx: Tx, d: MasterDelta) {
  for (const m of d.insert) {
    const [row] = await tx.insert(masterItems).values(masterValues(m)).onConflictDoUpdate({ target: masterItems.id, set: masterValues(m) }).returning()
    mirror.putMasterItem(toMaster(row))
  }
  for (const m of d.update) {
    const [row] = await tx.update(masterItems).set(masterValues(m)).where(eq(masterItems.id, m.id)).returning()
    if (row) mirror.putMasterItem(toMaster(row))
  }
  for (const id of d.missing) {
    const m = masterWb.stored(id)
    if (!m) continue
    mirror.putMasterItem(m)
    console.warn(`[master_items] ${id} vanished from the in-memory state — restored from the table copy`)
  }
}

/** `m<n>`: one above the highest number the table has ever held, so a master item is never renumbered. */
async function nextMasterId(tx: Tx): Promise<string> {
  const [r] = await tx.select({ n: sql<number>`coalesce(max(nullif(regexp_replace(${masterItems.id}, '\\D', '', 'g'), '')::int), 0) + 1` }).from(masterItems)
  return `m${Number(r.n)}`
}

/* ── service ───────────────────────────────────────────────────────────── */

@Injectable()
export class ItemsService {
  /** Every SKU in insertion order — the order the mock's array had (a master item's `skus` are listed in it). */
  async allItems(): Promise<Item[]> {
    return (await db.select().from(items).orderBy(asc(items.ord))).map(toItem)
  }

  async itemRow(id: string): Promise<ItemDb | undefined> {
    const [r] = await db.select().from(items).where(eq(items.id, id))
    return r
  }

  /** The SKUs that belong to a master item — they reference it by name, as the legacy data does. */
  async skus(masterItem: string): Promise<Item[]> {
    return (await db.select().from(items).where(eq(items.masterItem, masterItem)).orderBy(asc(items.ord))).map(toItem)
  }

  async createItem(i: Item) {
    // Claimed in memory first (synchronously): the next id is derived from the number of items, so two creates in
    // flight must not share one, and a compat persist running mid-insert must not adopt the row twice.
    mirror.putItem(i)
    try {
      const [row] = await db.transaction(async (tx) => {
        await lockState(tx)
        return tx.insert(items).values(itemValues(i)).returning()
      })
      const saved = toItem(row)
      mirror.putItem(saved)
      markItems([saved])
      return saved
    } catch (e) {
      mirror.removeItem(i.id)
      itemWb.forget(i.id)
      ItemsService.skuConflict(e)
    }
  }

  async updateItem(i: Item) {
    const before = mirror.findItem(i.id)
    try {
      const [row] = await db.transaction(async (tx) => {
        await lockState(tx)
        return tx.update(items).set(itemValues(i)).where(eq(items.id, i.id)).returning()
      })
      const saved = toItem(row)
      if (before) mirror.putItem(saved)
      markItems([saved])
      return saved
    } catch (e) {
      if (before) mirror.putItem(before)
      itemWb.mark(before ? [before] : [])
      ItemsService.skuConflict(e)
    }
  }

  async allMasters(): Promise<MasterItem[]> {
    return (await db.select().from(masterItems).orderBy(asc(masterItems.ord))).map(toMaster)
  }

  async masterById(id: string): Promise<MasterDb | undefined> {
    const [r] = await db.select().from(masterItems).where(eq(masterItems.id, id))
    return r
  }

  /** Stores the new master item with its first history entry; `at` is the timestamp the audit event must share. */
  async createMaster(fields: Partial<MasterItem>, by: string, note?: string): Promise<{ master: MasterItem; at: string }> {
    const at = new Date().toISOString()
    let row: MasterDb
    try {
      ;[row] = await db.transaction(async (tx) => {
        await lockState(tx)
        const m = { ...fields, id: await nextMasterId(tx), createdAt: at, history: [] } as MasterItem
        stampHistory(m, by, "created", at, note)
        return tx.insert(masterItems).values(masterValues(m)).returning()
      })
    } catch (e) {
      ItemsService.nameConflict(e)
    }
    const master = toMaster(row)
    mirror.putMasterItem(master)
    markMasters([master])
    // the mock's counter is kept in step: ids come from the table, but the compat world still carries the number
    const seq = compat().db.seq
    seq.masterItem = Math.max(seq.masterItem ?? 0, Number(master.id.slice(1)) || 0)
    return { master, at }
  }

  /** A rename carries the SKUs along in the same transaction (they reference their master by name). */
  async updateMaster(m: MasterItem, renameFrom?: string) {
    const before = mirror.findMasterItem(m.id)
    try {
      const row = await db.transaction(async (tx) => {
        await lockState(tx)
        const [r] = await tx.update(masterItems).set(masterValues(m)).where(eq(masterItems.id, m.id)).returning()
        if (renameFrom) await tx.update(items).set({ masterItem: m.name }).where(eq(items.masterItem, renameFrom))
        return r
      })
      const saved = toMaster(row)
      if (before) mirror.putMasterItem(saved)
      markMasters([saved])
      if (renameFrom) {
        for (const it of mirror.items()) if (it.masterItem === renameFrom) it.masterItem = saved.name
        markItems(mirror.items().filter((it) => it.masterItem === saved.name))
      }
      return saved
    } catch (e) {
      if (before) mirror.putMasterItem(before)
      masterWb.mark(before ? [before] : [])
      ItemsService.nameConflict(e)
    }
  }

  /** A duplicate master-item name the application check missed (two requests at once) is a 422, not a 500. */
  private static nameConflict(e: unknown): never {
    if (uniqueViolation(e) !== null) throw new Problem(422, "Validation failed", { name: ["duplicate"] })
    throw e as Error
  }

  /** A duplicate SKU the application check missed (two requests at once) is a 422, not a 500. */
  private static skuConflict(e: unknown): never {
    if (uniqueViolation(e) !== null) throw new Problem(422, "Validation failed", { sku: ["duplicate"] })
    throw e as Error
  }
}

/* ── controllers ───────────────────────────────────────────────────────── */

@Controller("api/v1/items")
export class ItemsController {
  constructor(
    @Inject(ItemsService) private readonly svc: ItemsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** The register: Page<ItemWithStock> with facets, the stock valuation at cost, and CSV. */
  @Get() @Authed()
  async list(@Req() req: Request, @Res() res: Response) {
    const sp = searchParams(req)
    if (!sp.get("sort")) sp.set("sort", "sku.asc")
    const c = compat()
    const r = runQuery((await this.svc.allItems()).map(c.withStock), sp, c.itemSpec)
    r.totals.stockValue = c.itemStockValue(r.all)
    if (sp.get("format") === "csv") {
      sendCsv(res, toCSV(r.all, c.itemCsvColumns), `items-${today()}.csv`)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    res.json(page)
  }

  @Post() @Authed("master.edit")
  async create(@Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const d = parse(itemInput, jsonBody(req))
    if (c.skuTaken(d.sku)) throw new Problem(422, "Validation failed", { sku: ["duplicate"] })
    const bu = c.badUnit(d.unit)
    if (bu) throw new Problem(422, "Validation failed", bu)
    const masterName = await this.masterName(d.masterItemId)
    const it = c.buildItem(d, masterName ?? d.name.split(" ")[0], c.newItemId())
    const saved = await this.svc.createItem(it)
    await this.audit.record({ actor: req.dz!.user, entity: "item", entityId: saved.id, ref: `${saved.sku} · ${saved.name}`, action: "created" })
    res.status(201).json(c.withStock(saved))
  }

  @Get(":id") @Authed()
  async one(@Param("id") id: string, @Res() res: Response) {
    const row = await this.svc.itemRow(id)
    if (!row) throw new Problem(404, "Item not found")
    res.json(compat().withStock(toItem(row)))
  }

  @Put(":id") @Authed("master.edit")
  async update(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const row = await this.svc.itemRow(id)
    if (!row) throw new Problem(404, "Item not found")
    const c = compat()
    const d = parse(itemInput, jsonBody(req))
    if (c.skuTaken(d.sku, id)) throw new Problem(422, "Validation failed", { sku: ["duplicate"] })
    // the in-memory copy first: a document may have moved its counters since the row was read
    const before = { ...(mirror.findItem(id) ?? toItem(row)) }
    // an inactive unit may be kept (the item still holds stock in it) but not switched to
    const bu = c.badUnit(d.unit, before.unit)
    if (bu) throw new Problem(422, "Validation failed", bu)
    const masterName = await this.masterName(d.masterItemId)
    // an edit keeps the cost price and the movement counters as they are
    const saved = await this.svc.updateItem({ ...before, ...c.itemEdit(d, masterName) })
    await this.audit.record({
      actor: req.dz!.user, entity: "item", entityId: saved.id, ref: `${saved.sku} · ${saved.name}`, action: "edited",
      changes: c.diff(before, saved, c.ITEM_FIELDS),
    })
    res.json(c.withStock(saved))
  }

  /** The name a SKU stores for its master item, or the 422 the API answers with for an unknown reference. */
  private async masterName(masterItemId?: string): Promise<string | undefined> {
    if (!masterItemId) return undefined
    const m = await this.svc.masterById(masterItemId)
    if (!m) throw new Problem(422, "Validation failed", { masterItemId: ["unknown"] })
    return m.name
  }
}

@Controller("api/v1/master-items")
export class MasterItemsController {
  constructor(
    @Inject(ItemsService) private readonly svc: ItemsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** The register: Page<MasterItemRow> (tax profile, tariff comparison, SKU count) with facets and CSV. */
  @Get() @Authed()
  async list(@Req() req: Request, @Res() res: Response) {
    const sp = searchParams(req)
    if (!sp.get("sort")) sp.set("sort", "name.asc")
    const c = compat()
    const rows = (await this.svc.allMasters()).map(c.masterRow)
    // the BOM picker asks for every active master item at once
    if (sp.get("active") === "1") { sp.delete("active"); sp.set("size", sp.get("size") ?? "200") }
    const r = runQuery(rows, sp, c.masterSpec)
    if (sp.get("format") === "csv") {
      sendCsv(res, toCSV(r.all, c.masterCsvColumns), `master-items-${today()}.csv`)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    res.json(page)
  }

  @Post() @Authed("master.edit")
  async create(@Req() req: AuthedRequest, @Res() res: Response) {
    const c = compat()
    const d = parse(masterItemInput, jsonBody(req))
    const { errors, overridden } = c.masterErrors(d)
    if (Object.keys(errors).length) throw new Problem(422, "Validation failed", errors)
    const fields = c.masterFields(d, overridden)
    const note = fields.overrideReason ? `Tax override: ${fields.overrideReason}` : undefined
    const { master, at } = await this.svc.createMaster(fields, req.dz!.user.name, note)
    await this.audit.record({ at, actor: req.dz!.user, entity: "masterItem", entityId: master.id, ref: `${master.hsCode} · ${master.name}`, action: "created", note })
    res.status(201).json(c.masterRow(master))
  }

  /** One master item with the SKUs that belong to it. */
  @Get(":id") @Authed()
  async one(@Param("id") id: string, @Res() res: Response) {
    const row = await this.svc.masterById(id)
    if (!row) throw new Problem(404, "Master item not found")
    const c = compat()
    const m = toMaster(row)
    const skus = await this.svc.skus(m.name)
    res.json({ ...c.masterRow(m), items: skus.length, skus: skus.map(c.withStock) })
  }

  @Put(":id") @Authed("master.edit")
  async update(@Param("id") id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const row = await this.svc.masterById(id)
    if (!row) throw new Problem(404, "Master item not found")
    const c = compat()
    const d = parse(masterItemInput, jsonBody(req))
    // cloned: the mirror's object is replaced in place below, and the audit diff compares against this copy
    const before = structuredClone(mirror.findMasterItem(id) ?? toMaster(row))
    const { errors, overridden } = c.masterErrors(d, id)
    if (Object.keys(errors).length) throw new Problem(422, "Validation failed", errors)
    const fields = c.masterFields(d, overridden)
    const at = new Date().toISOString()
    const next: MasterItem = { ...before, ...fields }
    if (!fields.overrideReason) delete next.overrideReason
    stampHistory(next, req.dz!.user.name, "edited", at)
    const saved = await this.svc.updateMaster(next, fields.name !== before.name ? before.name : undefined)
    await this.audit.record({
      at, actor: req.dz!.user, entity: "masterItem", entityId: saved.id, ref: `${saved.hsCode} · ${saved.name}`, action: "edited",
      changes: c.diff(c.flatMaster(before), c.flatMaster(saved), c.MASTER_FIELDS),
    })
    res.json(c.masterRow(saved))
  }
}
