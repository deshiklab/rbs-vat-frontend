import { db } from "@/lib/mock/db"
import { csvResponse, delay, runQuery, toCSV } from "@/lib/mock/query"
import { partyInput } from "@/lib/schemas"
import type { Party, PartyRow } from "@/lib/types"
import { round2 } from "@/lib/vat"
import { json, problem, withAuth, zodProblem } from "./_lib"
import { diff, recordAudit } from "@/lib/mock/audit"
import { TODAY } from "@/lib/company"
import { customerCredit } from "./_r3"

/**
 * Customers and vendors (one shape, `kind` tells them apart).
 *
 * The rules below are shared with the PostgreSQL API (R5.2): `api/src/compat/entry.ts` re-exports them and
 * `api/src/modules/parties.ts` calls them through `compat()`, so the native handlers and these mock handlers
 * cannot drift. Everything that reads *documents* (aggregates, in-use checks) lives here, because documents are
 * still in the compat state until R5.3.
 */
export const PARTY_FIELDS = ["name", "bin", "mode", "mobile", "email", "address", "contactPerson", "active", "exporterType", "bondLicenseNo", "bondLicenseExpiry", "associationNo"]

export type PartyKind = "customer" | "vendor"
type Ctx = { params: Promise<{ id: string }> }
export const partyColl = (k: PartyKind) => (k === "customer" ? db.customers : db.vendors)
export const partyDocs = (k: PartyKind, id: string) => (k === "customer" ? db.sales.filter((s) => s.customerId === id) : db.purchases.filter((p) => p.vendorId === id))
export const partyLabel = (k: PartyKind) => (k === "customer" ? "Customer" : "Vendor")

/** A party with its document aggregates (turnover, amount due, last document, and the customer's credit position). */
export function partyRow(k: PartyKind, p: Party): PartyRow {
  const docs = partyDocs(k, p.id).filter((d) => d.process !== "Cancelled")
  const approved = docs.filter((d) => d.process === "Approved")
  return {
    ...p,
    docs: docs.length,
    turnover: round2(approved.reduce((a, d) => a + d.netTotal, 0)),
    due: round2(approved.reduce((a, d) => a + d.due, 0)),
    lastDate: docs.map((d) => d.issueDate).sort().pop(),
    ...(k === "customer" ? (({ overdue, dueInvoices }) => ({ overdue, dueInvoices }))(customerCredit(p.id, TODAY)) : {}),
  }
}

export const partySpec = {
  search: (p: PartyRow) => `${p.name} ${p.bin} ${p.mobile} ${p.address} ${p.contactPerson ?? ""}`,
  facets: {
    mode: (p: PartyRow) => p.mode,
    status: (p: PartyRow) => (p.active === false ? "inactive" : "active"),
    balance: (p: PartyRow) => (p.due > 0 ? "due" : "clear"),
  },
  totals: ["turnover", "due", "docs"] as (keyof PartyRow)[],
}

/** CSV columns of the party register (labels differ per kind). */
export const partyCsvColumns = (k: PartyKind) => [
  { key: "name", label: "Name" }, { key: "mode", label: "Type" }, { key: "bin", label: k === "customer" ? "BIN / Ref" : "BIN / NID" },
  { key: "mobile", label: "Mobile" }, { key: "email", label: "Email" }, { key: "contactPerson", label: "Contact" }, { key: "address", label: "Address" },
  { key: "country", label: "Country" }, { key: "docs", label: k === "customer" ? "Invoices" : "Purchases" },
  { key: "turnover", label: "Turnover" }, { key: "due", label: k === "customer" ? "Receivable" : "Payable" },
  { key: "active", label: "Status", get: (p: PartyRow) => (p.active === false ? "Inactive" : "Active") },
]

export type PartyInputData = ReturnType<typeof partyInput.parse>

/** Field errors shared by create and update: a customer must be registered, BINs and names are unique per kind. */
export function partyErrors(k: PartyKind, d: PartyInputData, selfId?: string): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  if (k === "customer" && d.mode === "Non-registered") errors.mode = ["customerMode"]
  const others = partyColl(k).filter((p) => p.id !== selfId)
  if (d.bin && others.some((p) => p.bin.replace(/^NID /, "") === d.bin.replace(/^NID /, ""))) errors.bin = ["duplicate"]
  if (others.some((p) => p.name.trim().toLowerCase() === d.name.toLowerCase())) errors.name = ["duplicate"]
  return errors
}

/** Stored shape: names in capitals (as printed on Mushak 6.3), NID prefix, country and exporter details only when given. */
export const normaliseParty = (d: PartyInputData) => {
  const { exporterType, bondLicenseNo, bondLicenseExpiry, associationNo, ...rest } = d
  return {
    ...rest,
    name: d.name.toUpperCase(), // legacy convention: party names in capitals (as printed on Mushak 6.3)
    bin: d.mode === "Non-registered" && d.bin && !d.bin.startsWith("NID ") ? `NID ${d.bin}` : d.bin,
    country: d.mode === "Foreign" ? d.country : undefined,
    // R6 (RMG): exporter details — kept only when given (a cleared field removes the value)
    exporterType: exporterType || undefined, bondLicenseNo: bondLicenseNo || undefined,
    bondLicenseExpiry: bondLicenseExpiry || undefined, associationNo: associationNo || undefined,
  }
}

/** New party id (`c12-mb3x9k`): one above the live count, trash included, so ids are never reused. */
export const newPartyId = (k: PartyKind, suffix = "") =>
  `${k[0]}${partyColl(k).length + db.trash.length + 1}-${Date.now().toString(36)}${suffix}`

export const buildParty = (k: PartyKind, d: PartyInputData, id: string): Party => ({ ...normaliseParty(d), id, kind: k })

export function partyCollection(k: PartyKind) {
  const GET = withAuth(null, async (req) => {
    const sp = new URL(req.url).searchParams
    if (sp.get("view") !== "table") {
      // Picker options: active parties only
      const q = (sp.get("q") ?? "").toLowerCase()
      return json(partyColl(k).filter((p) => p.active !== false && (!q || `${p.name} ${p.bin}`.toLowerCase().includes(q))))
    }
    if (!sp.get("sort")) sp.set("sort", "name.asc")
    const r = runQuery(partyColl(k).map((p) => partyRow(k, p)), sp, partySpec)
    if (sp.get("format") === "csv") return csvResponse(toCSV(r.all, partyCsvColumns(k)), `${k}s-${new Date().toISOString().slice(0, 10)}.csv`)
    await delay()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    return json(page)
  })

  const POST = withAuth("master.edit", async (req, _ctx, user) => {
    const parsed = partyInput.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) return zodProblem(parsed.error)
    const errors = partyErrors(k, parsed.data)
    if (Object.keys(errors).length) return problem(422, "Validation failed", errors)
    const p = buildParty(k, parsed.data, newPartyId(k))
    partyColl(k).push(p)
    recordAudit({ actor: user, entity: k, entityId: p.id, ref: p.name, action: "created" })
    return json(p, { status: 201 })
  })
  return { GET, POST }
}

export function partyItem(k: PartyKind) {
  const GET = withAuth<Ctx>(null, async (_req, { params }) => {
    const { id } = await params
    const p = partyColl(k).find((x) => x.id === id)
    return p ? json(partyRow(k, p)) : problem(404, `${partyLabel(k)} not found`)
  })

  const PUT = withAuth<Ctx>("master.edit", async (req, { params }, user) => {
    const { id } = await params
    const p = partyColl(k).find((x) => x.id === id)
    if (!p) return problem(404, `${partyLabel(k)} not found`)
    const parsed = partyInput.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) return zodProblem(parsed.error)
    const errors = partyErrors(k, parsed.data, id)
    if (Object.keys(errors).length) return problem(422, "Validation failed", errors)
    // A party with documents cannot change registration type (would change the VAT treatment of issued documents)
    if (parsed.data.mode !== p.mode && partyDocs(k, id).length) return problem(422, "Validation failed", { mode: ["modeLocked"] })
    const before = { ...p }
    Object.assign(p, normaliseParty(parsed.data))
    recordAudit({ actor: user, entity: k, entityId: p.id, ref: p.name, action: "edited", changes: diff(before, p, PARTY_FIELDS) })
    return json(p)
  })

  /** Only parties without documents can be deleted (moved to trash → undo). Others must be deactivated. */
  const DELETE = withAuth<Ctx>("master.edit", async (_req, { params }, user) => {
    const { id } = await params
    const arr = partyColl(k)
    const i = arr.findIndex((x) => x.id === id)
    if (i < 0) return problem(404, `${partyLabel(k)} not found`)
    const n = partyDocs(k, id).length
    if (n) return problem(409, `in-use:${n}`)
    const [p] = arr.splice(i, 1)
    db.trash.push({ kind: k, doc: p, at: new Date().toISOString() })
    recordAudit({ actor: user, entity: k, entityId: p.id, ref: p.name, action: "deleted" })
    return json({ ok: true })
  })
  return { GET, PUT, DELETE }
}

export function partyRestore(k: PartyKind) {
  return withAuth<Ctx>("master.edit", async (_req, { params }, user) => {
    const { id } = await params
    const i = db.trash.findIndex((t) => t.kind === k && t.doc.id === id)
    if (i < 0) return problem(404, `${partyLabel(k)} not found in trash`)
    const [t] = db.trash.splice(i, 1)
    partyColl(k).push(t.doc as Party)
    recordAudit({ actor: user, entity: k, entityId: t.doc.id, ref: (t.doc as Party).name, action: "restored" })
    return json(t.doc)
  })
}
