import type { z } from "zod"
import { branchLabels, branchName, db, resolveBranch, stockShortfall } from "@/lib/mock/db"
import { auditStore, diff, recordAudit } from "@/lib/mock/audit"
import { stockLine } from "@/lib/mock/seed-stock"
import { csvResponse, delay, runQuery, toCSV, type QuerySpec } from "@/lib/mock/query"
import { cancelInput, damageInput, transferInput } from "@/lib/schemas"
import type { AuditChange, Damage, HistoryEntry, Process, StockDoc, StockDocKind, Transfer } from "@/lib/types"
import { deny, json, problem, ruleResponse, withAuth, zodErrors, zodProblem, type RuleProblem } from "./_lib"

type Ctx = { params: Promise<{ id: string }> }
type TransferData = z.output<typeof transferInput>
type DamageData = z.output<typeof damageInput>

/**
 * R5.3 — the rules below are shared with the API's native stock module (through the compat bundle), so the
 * PostgreSQL tables and the mock handlers cannot drift: validation, numbering, the branch-stock checks, the item
 * counter a damage entry moves, the document's own history, the register's spec and its CSV columns. They return
 * data — a document's fields, or a rejection as `{status, title, errors}` — and each side turns that into its own
 * response: a Web Response here (the same handlers also run in the browser for the static demo), an RFC 9457
 * problem in Nest.
 */

export const LABEL: Record<StockDocKind, string> = { transfer: "Stock transfer", damage: "Damage entry" }
export const PREFIX: Record<StockDocKind, "TR" | "DM"> = { transfer: "TR", damage: "DM" }
/** A rejection as data: the status, title and field → codes both sides answer with. */
export type StockProblem = RuleProblem

/** The documents of one kind, in insertion order — the order a sorted list falls back to. */
export const stockDocs = (k: StockDocKind): StockDoc[] => (k === "transfer" ? db.transfers : db.damages)
/** By id or by number: registers, the ledger and the audit trail link both. */
export const findStockDoc = (k: StockDocKind, id: string) => stockDocs(k).find((d) => d.id === id || d.no === id)
export const round2 = (n: number) => Math.round(n * 100) / 100
/** Branch whose stock the document consumes on approval. */
export const stockSource = (d: StockDoc) => (d.kind === "transfer" ? d.fromBranchId : d.branchId)

/** TR-MMYY#### / DM-MMYY####. Deleted drafts live on in the audit trail, so their numbers are skipped too. */
export function nextStockNo(k: StockDocKind, date: string) {
  const key = `${PREFIX[k]}-${date.slice(5, 7)}${date.slice(2, 4)}`
  const used = [...stockDocs(k).map((d) => d.no), ...auditStore.events.filter((e) => e.entity === k).map((e) => e.ref)]
  const n = used.reduce((m, no) => (no.startsWith(key) ? Math.max(m, Number(no.slice(key.length)) || 0) : m), 0) + 1
  return `${key}${String(n).padStart(4, "0")}`
}

/** The document's own trail; the matching audit event is recorded by the caller. */
export function stampHistory(d: StockDoc, by: string, action: HistoryEntry["action"], at: string, note?: string) {
  d.history = [...(d.history ?? []), { at, by, action, note }]
  d.updatedAt = at
}

/** Appends to the document's own history and the global audit trail. */
function addHistory(d: StockDoc, by: string, action: HistoryEntry["action"], note?: string, changes?: AuditChange[]) {
  const at = new Date().toISOString()
  stampHistory(d, by, action, at, note)
  recordAudit({ at, actor: by, entity: d.kind, entityId: d.id, ref: d.no, action, note, changes })
}

/** Lines → priced stock lines (quantities rounded to the unit's precision), or field errors. */
function buildLines(lines: { itemId: string; qty: number }[]) {
  const errors: Record<string, string[]> = {}
  const out = lines.map((l, i) => {
    const it = db.items.find((x) => x.id === l.itemId && x.active)
    if (!it) { errors[`lines.${i}.itemId`] = ["unknown"]; return null }
    const dec = db.units.find((u) => u.code === it.unit)?.decimals ?? 2
    const qty = Math.round(l.qty * 10 ** dec) / 10 ** dec
    if (qty <= 0) errors[`lines.${i}.qty`] = ["positive"]
    return stockLine(it, qty)
  })
  return Object.keys(errors).length ? { errors } : { lines: out.filter((l) => l !== null) }
}

/** Validated input → the document's fields and the process it asks for, or a 422. */
export function buildStock(k: StockDocKind, body: unknown): StockBuilt | StockProblem {
  if (k === "transfer") {
    const parsed = transferInput.safeParse(body)
    if (!parsed.success) return { status: 422, title: "Validation failed", errors: zodErrors(parsed.error) }
    const d: TransferData = parsed.data
    const errors: Record<string, string[]> = {}
    if (!resolveBranch(d.fromBranchId)) errors.fromBranchId = ["unknownBranch"]
    if (!resolveBranch(d.toBranchId)) errors.toBranchId = ["unknownBranch"]
    const b = buildLines(d.lines)
    if ("errors" in b) Object.assign(errors, b.errors)
    if (Object.keys(errors).length || !("lines" in b)) return { status: 422, title: "Validation failed", errors }
    const lines = b.lines!
    return {
      process: d.process,
      fields: {
        date: d.date, fromBranchId: d.fromBranchId, fromBranch: branchName(d.fromBranchId), toBranchId: d.toBranchId, toBranch: branchName(d.toBranchId),
        vehicle: d.vehicle || undefined, note: d.note || undefined, lines,
        totalQty: round2(lines.reduce((a, l) => a + l.qty, 0)), totalValue: round2(lines.reduce((a, l) => a + l.value, 0)),
      } satisfies Partial<Transfer>,
    }
  }
  const parsed = damageInput.safeParse(body)
  if (!parsed.success) return { status: 422, title: "Validation failed", errors: zodErrors(parsed.error) }
  const d: DamageData = parsed.data
  const errors: Record<string, string[]> = {}
  if (!resolveBranch(d.branchId)) errors.branchId = ["unknownBranch"]
  const b = buildLines(d.lines)
  if ("errors" in b) Object.assign(errors, b.errors)
  if (Object.keys(errors).length || !("lines" in b)) return { status: 422, title: "Validation failed", errors }
  const lines = b.lines!
  return {
    process: d.process,
    fields: {
      date: d.date, branchId: d.branchId, branch: branchName(d.branchId), reason: d.reason, note: d.note || undefined, lines,
      totalQty: round2(lines.reduce((a, l) => a + l.qty, 0)), totalValue: round2(lines.reduce((a, l) => a + l.value, 0)),
    } satisfies Partial<Damage>,
  }
}

/** The fields buildStock produces: a transfer names both branches, a damage entry one branch and a reason. */
export type TransferFields = Pick<Transfer, "date" | "fromBranchId" | "fromBranch" | "toBranchId" | "toBranch" | "lines" | "totalQty" | "totalValue"> & { vehicle?: string; note?: string }
export type DamageFields = Pick<Damage, "date" | "branchId" | "branch" | "reason" | "lines" | "totalQty" | "totalValue"> & { note?: string }
/** What buildStock returns on success: the fields to store and the process the request asked for. */
export type StockBuilt = { process: Process; fields: TransferFields | DamageFields }

/** Damage writes off company stock (Item.damage); a transfer only moves it between branches. */
export function postStockDoc(d: StockDoc, sign: 1 | -1) {
  if (d.kind !== "damage") return
  for (const l of d.lines) { const it = db.items.find((i) => i.id === l.itemId); if (it) it.damage = round2(it.damage + sign * l.qty) }
}

/** Approve: the source branch must hold the quantity. Stamps the history; a rejection comes back as data. */
export function approveDoc(d: StockDoc, by: string, at: string, status: 409 | 422 = 409): StockProblem | null {
  const short = stockShortfall(d.lines, stockSource(d))
  if (short) return { status, title: `Insufficient stock — ${short.detail}`, errors: short.errors }
  d.process = "Approved"
  postStockDoc(d, 1)
  stampHistory(d, by, "approved", at)
  return null
}

function approve(d: StockDoc, by: string, status: 409 | 422 = 409) {
  const at = new Date().toISOString()
  const p = approveDoc(d, by, at, status)
  if (p) return ruleResponse(p)
  recordAudit({ at, actor: by, entity: d.kind, entityId: d.id, ref: d.no, action: "approved" })
  return null
}

/**
 * Cancel: an approved document gives its stock back — reversing a transfer takes the goods out of the receiving
 * branch, so they must still be there. Stamps the history; a rejection comes back as data.
 */
export function cancelDoc(d: StockDoc, by: string, reason: string, at: string): StockProblem | null {
  if (d.process === "Approved") {
    if (d.kind === "transfer") {
      const short = stockShortfall(d.lines, d.toBranchId)
      if (short) return { status: 409, title: `Goods from this transfer have already been used at ${d.toBranch} — ${short.detail}` }
    }
    postStockDoc(d, -1)
  }
  d.process = "Cancelled"
  d.cancelReason = reason
  stampHistory(d, by, "cancelled", at, reason)
  return null
}

const FIELDS = ["date", "fromBranch", "toBranch", "branch", "reason", "vehicle", "note", "totalValue"]
/** What an edit changed, for the audit trail: the header fields plus a readable signature of the lines. */
export function stockDocDiff(a: StockDoc, b: StockDoc) {
  const out = diff(a, b, FIELDS)
  const sig = (d: StockDoc) => d.lines.map((l) => `${l.name} × ${l.qty} ${l.uom}`).join("; ")
  if (sig(a) !== sig(b)) out.push({ field: "lines", from: sig(a), to: sig(b) })
  return out
}

export const stockSpec = (k: StockDocKind): QuerySpec<StockDoc> => ({
  search: (d: StockDoc) => `${d.no} ${d.note ?? ""} ${d.lines.map((l) => `${l.name} ${l.sku}`).join(" ")} ${d.kind === "transfer" ? `${d.fromBranch} ${d.toBranch} ${d.vehicle ?? ""}` : d.branch}`,
  dateField: "date" as const,
  facets: k === "transfer"
    ? { process: (d: StockDoc) => d.process, fromBranch: (d: StockDoc) => (d as Transfer).fromBranchId, toBranch: (d: StockDoc) => (d as Transfer).toBranchId }
    : { process: (d: StockDoc) => d.process, branch: (d: StockDoc) => (d as Damage).branchId, reason: (d: StockDoc) => (d as Damage).reason },
  totals: ["totalValue"],
})

/** CSV export: one row per line, with its document's header. */
export const stockCsvColumns = (k: StockDocKind) => [
  { key: "date", label: "Date", get: (x: { d: StockDoc }) => x.d.date }, { key: "no", label: k === "transfer" ? "Transfer No" : "Entry No", get: (x: { d: StockDoc }) => x.d.no },
  ...(k === "transfer"
    ? [{ key: "from", label: "From", get: (x: { d: StockDoc }) => (x.d as Transfer).fromBranch }, { key: "to", label: "To", get: (x: { d: StockDoc }) => (x.d as Transfer).toBranch }]
    : [{ key: "branch", label: "Branch", get: (x: { d: StockDoc }) => (x.d as Damage).branch }, { key: "reason", label: "Reason", get: (x: { d: StockDoc }) => (x.d as Damage).reason }]),
  { key: "sku", label: "SKU", get: (x: { d: StockDoc; l: { sku: string } }) => x.l.sku }, { key: "item", label: "Item", get: (x: { d: StockDoc; l: { name: string } }) => x.l.name },
  { key: "qty", label: "Qty", get: (x: { d: StockDoc; l: { qty: number } }) => x.l.qty },
  { key: "uom", label: "Unit", get: (x: { d: StockDoc; l: { uom: string } }) => x.l.uom }, { key: "cost", label: "Unit cost", get: (x: { d: StockDoc; l: { cost: number } }) => x.l.cost },
  { key: "value", label: "Value", get: (x: { d: StockDoc; l: { value: number } }) => x.l.value },
  { key: "process", label: "Process", get: (x: { d: StockDoc }) => x.d.process }, { key: "note", label: "Note", get: (x: { d: StockDoc }) => x.d.note ?? "" },
]

/** The lines of a document as CSV rows. */
export const stockCsvRows = (docs: StockDoc[]) => docs.flatMap((d) => d.lines.map((l) => ({ d, l })))

/** GET list (filters, facets, CSV) and POST create for /transfers and /damage. */
export function stockListRoutes(k: StockDocKind) {
  const spec = stockSpec(k)
  const GET = withAuth(null, async (req) => {
    const sp = new URL(req.url).searchParams
    if (!sp.get("sort")) sp.set("sort", "createdAt.desc")
    const r = runQuery(stockDocs(k), sp, spec)
    if (sp.get("format") === "csv") {
      return csvResponse(toCSV(stockCsvRows(r.all), stockCsvColumns(k)), `${k === "transfer" ? "stock-transfers" : "damage-entries"}-${new Date().toISOString().slice(0, 10)}.csv`)
    }
    await delay()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    const b = branchLabels()
    return json({ ...page, facetLabels: k === "transfer" ? { fromBranch: b, toBranch: b } : { branch: b } })
  })

  const POST = withAuth("doc.create", async (req, _ctx, user) => {
    const r = buildStock(k, await req.json().catch(() => ({})))
    if ("status" in r) return ruleResponse(r)
    if (r.process === "Approved") { const no = deny(user, "doc.approve"); if (no) return no }
    db.seq[k] += 1
    const base = { id: `${k === "transfer" ? "t" : "d"}${db.seq[k]}`, no: nextStockNo(k, r.fields!.date), process: "Created" as const, issuedBy: user.name, createdAt: new Date().toISOString(), history: [] }
    const doc = (k === "transfer" ? { kind: "transfer", ...base, ...r.fields } : { kind: "damage", ...base, ...r.fields }) as StockDoc
    if (r.process === "Approved") {
      const short = stockShortfall(doc.lines, stockSource(doc))
      if (short) { db.seq[k] -= 1; return problem(422, `Insufficient stock — ${short.detail}`, short.errors) }
    }
    addHistory(doc, user.name, "created")
    if (r.process === "Approved") approve(doc, user.name)
    stockDocs(k).push(doc)
    return json(doc, { status: 201 })
  })
  return { GET, POST }
}

/** GET one, PUT (drafts), PATCH approve/cancel, DELETE (drafts) for /transfers/{id} and /damage/{id}. */
export function stockDocRoutes(k: StockDocKind) {
  const GET = withAuth<Ctx>(null, async (_req, { params }) => {
    const { id } = await params
    await delay(100)
    const d = findStockDoc(k, id)
    return d ? json(d) : problem(404, `${LABEL[k]} not found`)
  })

  const PUT = withAuth<Ctx>("doc.edit", async (req, { params }, user) => {
    const { id } = await params
    const d = findStockDoc(k, id)
    if (!d) return problem(404, `${LABEL[k]} not found`)
    if (d.process !== "Created") return problem(409, `Only drafts can be edited — ${d.no} is ${d.process}.`)
    const r = buildStock(k, await req.json().catch(() => ({})))
    if ("status" in r) return ruleResponse(r)
    if (r.process === "Approved") {
      const no = deny(user, "doc.approve"); if (no) return no
      const probe = { ...d, ...r.fields } as StockDoc
      const short = stockShortfall(probe.lines, stockSource(probe))
      if (short) return problem(422, `Insufficient stock — ${short.detail}`, short.errors)
    }
    const before = structuredClone(d)
    Object.assign(d, r.fields)
    addHistory(d, user.name, "edited", undefined, stockDocDiff(before, d))
    if (r.process === "Approved") approve(d, user.name)
    return json(d)
  })

  const PATCH = withAuth<Ctx>(null, async (req, { params }, user) => {
    const { id } = await params
    const d = findStockDoc(k, id)
    if (!d) return problem(404, `${LABEL[k]} not found`)
    const body = (await req.json().catch(() => ({}))) as { process?: string; reason?: string }
    if (body.process === "Approved") {
      const no = deny(user, "doc.approve"); if (no) return no
      if (d.process !== "Created") return problem(409, `Cannot approve — ${d.no} is ${d.process}.`)
      return approve(d, user.name) ?? json(d)
    }
    if (body.process === "Cancelled") {
      const no = deny(user, "doc.cancel"); if (no) return no
      if (d.process === "Cancelled") return problem(409, `${d.no} is already cancelled.`)
      const r = cancelInput.safeParse({ reason: body.reason ?? "" })
      if (!r.success) return zodProblem(r.error)
      const at = new Date().toISOString()
      const p = cancelDoc(d, user.name, r.data.reason, at)
      if (p) return ruleResponse(p)
      recordAudit({ at, actor: user.name, entity: d.kind, entityId: d.id, ref: d.no, action: "cancelled", note: r.data.reason })
      return json(d)
    }
    return problem(400, "process must be Approved or Cancelled")
  })

  /** Drafts only; the number is not reused (the audit trail keeps the record). */
  const DELETE = withAuth<Ctx>("doc.delete", async (_req, { params }, user) => {
    const { id } = await params
    const arr = stockDocs(k)
    const i = arr.findIndex((x) => x.id === id)
    if (i < 0) return problem(404, `${LABEL[k]} not found`)
    if (arr[i].process !== "Created") return problem(409, `Only drafts can be deleted — cancel ${arr[i].no} instead.`)
    const [d] = arr.splice(i, 1)
    addHistory(d, user.name, "deleted")
    return json({ ok: true })
  })

  return { GET, PUT, PATCH, DELETE }
}
