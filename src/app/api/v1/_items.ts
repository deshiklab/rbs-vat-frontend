/**
 * R5.2 — the item and master-item rules shared by the mock handlers (Next.js and the static GitHub Pages demo) and
 * the native PostgreSQL API, which reuses them through the compat bundle (api/src/compat/entry.ts) instead of
 * copying them: responses, error codes, audit events and stored shapes cannot drift between the two.
 *
 * What differs is only the storage — rows live in the `items` and `master_items` tables there. The derived numbers
 * stay derived: an item's `remain` comes from its own movement counters, while the branch split and the stock
 * ledger come from documents, which are still compat state until R5.3.
 */
import type { z } from "zod"
import { db, withStock } from "@/lib/mock/db"
import { diff, recordAudit } from "@/lib/mock/audit"
import { badUnit } from "@/lib/mock/units"
import { findTariff } from "@/lib/mock/tariff"
import { csvResponse, delay, runQuery, toCSV, type QuerySpec } from "@/lib/mock/query"
import { itemInput, masterItemInput } from "@/lib/schemas"
import { TAX_KEYS } from "@/lib/r2"
import type { AuditChange, HistoryEntry, Item, ItemWithStock, MasterItem, MasterItemRow, TaxProfile } from "@/lib/types"
import { json, problem, withAuth, zodProblem } from "./_lib"

type Ctx = { params: Promise<{ id: string }> }
const csvDate = () => new Date().toISOString().slice(0, 10)

/* ── items (SKUs) ─────────────────────────────────────────────────────── */

/** What an edit is audited on: `costPrice` and the movement counters are derived, never typed in. */
export const ITEM_FIELDS = ["name", "sku", "hsCode", "group", "unit", "purchasePrice", "salePrice", "vatRate", "sdRate", "reorderLevel", "active", "masterItem"]

export const itemSpec: QuerySpec<ItemWithStock> = {
  search: (i) => `${i.name} ${i.hsCode} ${i.sku} ${i.masterItem}`,
  facets: {
    group: (i) => i.group,
    unit: (i) => i.unit,
    stock: (i) => (i.remain <= 0 ? "out" : i.remain < i.reorderLevel ? "low" : "ok"),
  },
  totals: [] as (keyof ItemWithStock)[],
}

export const itemCsvColumns = [
  { key: "sku", label: "SKU" }, { key: "hsCode", label: "HS Code" }, { key: "name", label: "Name" }, { key: "group", label: "Group" },
  { key: "unit", label: "Unit" }, { key: "purchasePrice", label: "PP" }, { key: "costPrice", label: "CP" }, { key: "salePrice", label: "SP" },
  { key: "vatRate", label: "VAT %" }, { key: "opening", label: "Opening" }, { key: "purchased", label: "Purchase" }, { key: "prodReceive", label: "Prod. Receive" },
  { key: "prodIssue", label: "Prod. Issue" }, { key: "sold", label: "Sales" }, { key: "damage", label: "Damage" }, { key: "remain", label: "Remain" },
]

/** Stock valuation at cost for a filtered set (the register's `totals.stockValue`). */
export const itemStockValue = (rows: ItemWithStock[]) => Math.round(rows.reduce((a, i) => a + Math.max(0, i.remain) * i.costPrice, 0))

/** `i<n>-<base36>`: one above the number of items, so a SKU is never renumbered while the list grows. */
export const newItemId = (suffix = "") => `i${db.items.length + 1}-${Date.now().toString(36)}${suffix}`

/** SKUs are unique case-insensitively; `selfId` excludes the item being edited. */
export const skuTaken = (sku: string, selfId?: string) => db.items.some((i) => i.id !== selfId && i.sku.toLowerCase() === sku.toLowerCase())

export type ItemInputData = ReturnType<typeof itemInput.parse>

/** The fields a form edits: everything but the master-item reference, which is stored as the master's *name*. */
export const itemEdit = (d: ItemInputData, masterName?: string) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { masterItemId, ...data } = d
  return masterName ? { ...data, masterItem: masterName } : data
}

/** A new SKU: no master given, its own name's first word becomes the master-item label (as the legacy data does). */
export const buildItem = (d: ItemInputData, masterName: string, id = newItemId()): Item => ({
  id, ...itemEdit(d), masterItem: masterName, brand: "Local",
  costPrice: d.purchasePrice ? Math.round(d.purchasePrice * 112) / 100 : Math.round(d.salePrice * 78) / 100,
  opening: 0, purchased: 0, prodReceive: 0, prodIssue: 0, sold: 0, damage: 0,
})

/** The master item a form refers to, or the 422 the API answers with when the reference is unknown. */
export function findMaster(masterItemId?: string): { master?: MasterItem; error?: ReturnType<typeof problem> } {
  const master = masterItemId ? db.masterItems.find((m) => m.id === masterItemId) : undefined
  return masterItemId && !master ? { error: problem(422, "Validation failed", { masterItemId: ["unknown"] }) } : { master }
}

export function itemCollection() {
  const GET = withAuth(null, async (req) => {
    const sp = new URL(req.url).searchParams
    if (!sp.get("sort")) sp.set("sort", "sku.asc")
    const r = runQuery(db.items.map(withStock), sp, itemSpec)
    // stock valuation at cost for the filtered set
    r.totals.stockValue = itemStockValue(r.all)
    if (sp.get("format") === "csv") return csvResponse(toCSV(r.all, itemCsvColumns), `items-${csvDate()}.csv`)
    await delay()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    return json(page)
  })

  const POST = withAuth("master.edit", async (req, _ctx, user) => {
    const parsed = itemInput.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) return zodProblem(parsed.error)
    const d = parsed.data
    if (skuTaken(d.sku)) return problem(422, "Validation failed", { sku: ["duplicate"] })
    const bu = badUnit(d.unit)
    if (bu) return problem(422, "Validation failed", bu)
    const { master, error } = findMaster(d.masterItemId)
    if (error) return error
    const it = buildItem(d, master?.name ?? d.name.split(" ")[0])
    db.items.push(it)
    recordAudit({ actor: user, entity: "item", entityId: it.id, ref: `${it.sku} · ${it.name}`, action: "created" })
    return json(withStock(it), { status: 201 })
  })

  return { GET, POST }
}

export function itemDoc() {
  const find = (id: string) => db.items.find((i) => i.id === id)

  const GET = withAuth<Ctx>(null, async (_req, { params }) => {
    const { id } = await params
    const it = find(id)
    return it ? json(withStock(it)) : problem(404, "Item not found")
  })

  const PUT = withAuth<Ctx>("master.edit", async (req, { params }, user) => {
    const { id } = await params
    const it = find(id)
    if (!it) return problem(404, "Item not found")
    const parsed = itemInput.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) return zodProblem(parsed.error)
    if (skuTaken(parsed.data.sku, id)) return problem(422, "Validation failed", { sku: ["duplicate"] })
    // an inactive unit may be kept (the item still holds stock in it) but not switched to
    const bu = badUnit(parsed.data.unit, it.unit)
    if (bu) return problem(422, "Validation failed", bu)
    const { master, error } = findMaster(parsed.data.masterItemId)
    if (error) return error
    const before = { ...it }
    // an edit keeps the cost price and the movement counters as they are
    Object.assign(it, itemEdit(parsed.data, master?.name))
    recordAudit({ actor: user, entity: "item", entityId: it.id, ref: `${it.sku} · ${it.name}`, action: "edited", changes: diff(before, it, ITEM_FIELDS) })
    return json(withStock(it))
  })

  return { GET, PUT }
}

/* ── Master items (HS-code products with their tax profile) ───────────── */

export const tariffProfile = (hs: string): TaxProfile | null => {
  const t = findTariff(hs)
  return t ? { vat: t.vat, sd: t.sd, cd: t.cd, rd: t.rd, ait: t.ait, at: t.at } : null
}

export function masterRow(m: MasterItem): MasterItemRow {
  const tariff = tariffProfile(m.hsCode)
  return {
    ...m, tariff, tariffDescription: findTariff(m.hsCode)?.description,
    items: db.items.filter((i) => i.masterItem === m.name).length,
    overrides: tariff ? TAX_KEYS.filter((k) => m.rates[k] !== tariff[k]) : [],
  }
}

/** Master items are audited on their rates as flat `vatRate`/`sdRate`/… fields (what the form shows). */
export const flatMaster = (x: MasterItem) => ({ ...x, ...Object.fromEntries(TAX_KEYS.map((k) => [`${k}Rate`, x.rates[k]])) })

export const MASTER_FIELDS = ["name", "hsCode", "group", "category", "unit", "priceMethod", "description", ...TAX_KEYS.map((k) => `${k}Rate`), "overrideReason", "active"]

export const masterSpec: QuerySpec<MasterItemRow> = {
  search: (m) => `${m.name} ${m.hsCode} ${m.hsCode.slice(0, 4)}.${m.hsCode.slice(4, 6)}.${m.hsCode.slice(6)} ${m.description ?? ""}`,
  facets: { group: (m) => m.group, status: (m) => (m.active ? "active" : "inactive"), override: (m) => (m.overrides.length ? "yes" : "no") },
}

export const masterCsvColumns = [
  { key: "hsCode", label: "HS Code" }, { key: "name", label: "Master item" }, { key: "group", label: "Group" }, { key: "category", label: "Category" }, { key: "unit", label: "Unit" },
  ...TAX_KEYS.map((k) => ({ key: k, label: `${k.toUpperCase()} %`, get: (m: MasterItemRow) => m.rates[k] })),
  { key: "overrides", label: "Overrides", get: (m: MasterItemRow) => m.overrides.join(" ") }, { key: "overrideReason", label: "Override reason" },
  { key: "items", label: "SKUs" }, { key: "active", label: "Active" },
]

/** `m<n>` from the mock's counter block. Synchronous, so two creates in flight never share a number. */
export const newMasterId = () => { db.seq.masterItem += 1; return `m${db.seq.masterItem}` }

export type MasterInputData = ReturnType<typeof masterItemInput.parse>

/**
 * The 422s a master item can earn: a name already on file (case-insensitively), a unit that is not an active one,
 * an HS code outside the tariff, and rates that differ from the tariff without a reason of at least 5 characters.
 */
export function masterErrors(d: MasterInputData, selfId?: string): { errors: Record<string, string[]>; overridden: boolean } {
  const errors: Record<string, string[]> = {}
  if (db.masterItems.some((m) => m.id !== selfId && m.name.toLowerCase() === d.name.toLowerCase())) errors.name = ["duplicate"]
  if (!db.units.some((u) => u.code === d.unit && u.active)) errors.unit = ["unknownUnit"]
  const tariff = tariffProfile(d.hsCode)
  if (!tariff) errors.hsCode = ["notInTariff"]
  const overridden = tariff ? TAX_KEYS.some((k) => d.rates[k] !== tariff[k]) : false
  if (overridden && (d.overrideReason ?? "").length < 5) errors.overrideReason = ["overrideReason"]
  return { errors, overridden }
}

/** What the form stores: the reason is kept only when the rates really do differ from the tariff. */
export const masterFields = (d: MasterInputData, overridden: boolean) => ({
  name: d.name, hsCode: d.hsCode, group: d.group, category: d.category, unit: d.unit, priceMethod: d.priceMethod,
  description: d.description || undefined, rates: d.rates, overrideReason: overridden ? d.overrideReason : undefined, active: d.active,
} satisfies Partial<MasterItem>)

export function buildMaster(body: unknown, selfId?: string) {
  const parsed = masterItemInput.safeParse(body)
  if (!parsed.success) return { error: zodProblem(parsed.error) }
  const d: z.output<typeof masterItemInput> = parsed.data
  const { errors, overridden } = masterErrors(d, selfId)
  if (Object.keys(errors).length) return { error: problem(422, "Validation failed", errors) }
  return { fields: masterFields(d, overridden) }
}

/** The master item's own history and the global audit trail (one entry each, same timestamp). */
export function addMasterHistory(m: MasterItem, by: string, action: HistoryEntry["action"], note?: string, changes?: AuditChange[]) {
  const at = new Date().toISOString()
  m.history = [...(m.history ?? []), { at, by, action, note }]
  m.updatedAt = at
  recordAudit({ at, actor: by, entity: "masterItem", entityId: m.id, ref: `${m.hsCode} · ${m.name}`, action, note, changes })
}

export function masterListRoutes() {
  const GET = withAuth(null, async (req) => {
    const sp = new URL(req.url).searchParams
    if (!sp.get("sort")) sp.set("sort", "name.asc")
    const rows = db.masterItems.map(masterRow)
    // the BOM picker asks for every active master item at once
    if (sp.get("active") === "1") { sp.delete("active"); sp.set("size", sp.get("size") ?? "200") }
    const r = runQuery(rows, sp, masterSpec)
    if (sp.get("format") === "csv") return csvResponse(toCSV(r.all, masterCsvColumns), `master-items-${csvDate()}.csv`)
    await delay()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    return json(page)
  })

  const POST = withAuth("master.edit", async (req, _ctx, user) => {
    const r = buildMaster(await req.json().catch(() => ({})))
    if (r.error) return r.error
    const m: MasterItem = { ...r.fields!, id: newMasterId(), createdAt: new Date().toISOString(), history: [] }
    addMasterHistory(m, user.name, "created", r.fields!.overrideReason ? `Tax override: ${r.fields!.overrideReason}` : undefined)
    db.masterItems.push(m)
    return json(masterRow(m), { status: 201 })
  })

  return { GET, POST }
}

export function masterDocRoutes() {
  const find = (id: string) => db.masterItems.find((m) => m.id === id)

  const GET = withAuth<Ctx>(null, async (_req, { params }) => {
    const { id } = await params
    const m = find(id)
    return m ? json({ ...masterRow(m), skus: db.items.filter((i) => i.masterItem === m.name).map(withStock) }) : problem(404, "Master item not found")
  })

  const PUT = withAuth<Ctx>("master.edit", async (req, { params }, user) => {
    const { id } = await params
    const m = find(id)
    if (!m) return problem(404, "Master item not found")
    const r = buildMaster(await req.json().catch(() => ({})), m.id)
    if (r.error) return r.error
    const before = structuredClone(m)
    // A rename carries the SKUs along (they reference the master by name)
    if (r.fields!.name !== m.name) for (const it of db.items) if (it.masterItem === m.name) it.masterItem = r.fields!.name
    Object.assign(m, r.fields)
    if (!r.fields!.overrideReason) delete m.overrideReason
    addMasterHistory(m, user.name, "edited", undefined, diff(flatMaster(before), flatMaster(m), MASTER_FIELDS))
    return json(masterRow(m))
  })

  return { GET, PUT }
}
