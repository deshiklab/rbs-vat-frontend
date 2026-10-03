import type { z } from "zod"
import { branchLabels, branchName, db, resolveBranch, stockShortfall } from "@/lib/mock/db"
import { auditStore, diff, recordAudit } from "@/lib/mock/audit"
import { csvResponse, delay, runQuery, toCSV, type QuerySpec } from "@/lib/mock/query"
import { cancelInput, debitNoteInput, openingInput } from "@/lib/schemas"
import type { AuditChange, DebitLine, DebitNote, HistoryEntry, OpeningEntry, Purchase } from "@/lib/types"
import { calcDebitLine, round2 } from "@/lib/vat"
import { deny, invalidRule, json, problem, ruleResponse, withAuth, zodErrors, zodProblem, type RuleProblem } from "./_lib"
import { noteDiff, noteDraftRule } from "./_docs"
import { lockedConflictProblem, lockedFieldRule } from "./_r4"

type Ctx = { params: Promise<{ id: string }> }
type Entity = "debitNote" | "opening"
type Doc = DebitNote | OpeningEntry

/** Next DN-/OS-MMYY#### — numbers of deleted drafts live on in the audit trail and are skipped. */
function nextNo(prefix: "DN" | "OS", entity: Entity, list: { no: string }[], date: string) {
  const key = `${prefix}-${date.slice(5, 7)}${date.slice(2, 4)}`
  const used = [...list.map((d) => d.no), ...auditStore.events.filter((e) => e.entity === entity).map((e) => e.ref)]
  const n = used.reduce((m, no) => (no.startsWith(key) ? Math.max(m, Number(no.slice(key.length)) || 0) : m), 0) + 1
  return `${key}${String(n).padStart(4, "0")}`
}

function addHistory(entity: Entity, d: Doc, ref: string, by: string, action: HistoryEntry["action"], note?: string, changes?: AuditChange[]) {
  const at = new Date().toISOString()
  d.history = [...(d.history ?? []), { at, by, action, note }]
  d.updatedAt = at
  recordAudit({ at, actor: by, entity, entityId: d.id, ref, action, note, changes })
}

/* ── Debit notes (Mushak 6.8) ───────────────────────────────────────────── */

/** Quantity per item still returnable on a purchase (other non-cancelled debit notes deducted). */
export function returnable(p: Purchase, excludeId?: string) {
  const returned = new Map<string, number>()
  for (const n of db.debitNotes) {
    if (n.purchaseId !== p.id || n.process === "Cancelled" || n.id === excludeId) continue
    for (const l of n.lines) returned.set(l.itemId, round2((returned.get(l.itemId) ?? 0) + l.qty))
  }
  const seen = new Set<string>()
  return p.lines.filter((l) => !seen.has(l.itemId) && seen.add(l.itemId)).map((l) => {
    const purchasedQty = round2(p.lines.filter((x) => x.itemId === l.itemId).reduce((a, x) => a + x.qty, 0))
    const returnedQty = returned.get(l.itemId) ?? 0
    return { itemId: l.itemId, name: l.name, hsCode: l.hsCode, uom: l.uom, price: l.price, sdRate: l.sdRate, vatRate: l.vatRate, purchasedQty, returnedQty, remaining: round2(purchasedQty - returnedQty), import: !!l.duty }
  })
}

/** What `buildDebit` returns: every field of the note but the identity and the lifecycle the caller adds. */
export type DebitFields = Omit<DebitNote, "id" | "no" | "process" | "createdAt" | "history">

export function buildDebit(body: unknown, excludeId?: string): RuleProblem | { process: "Created" | "Approved"; fields: DebitFields } {
  const parsed = debitNoteInput.safeParse(body)
  if (!parsed.success) return invalidRule(zodErrors(parsed.error))
  const d: z.output<typeof debitNoteInput> = parsed.data
  const p = db.purchases.find((x) => x.id === d.purchaseId)
  if (!p || p.category === "service") return invalidRule({ purchaseId: ["unknown"] })
  if (p.process !== "Approved") return invalidRule({ purchaseId: ["notApproved"] })
  if (d.issueDate < p.issueDate) return invalidRule({ issueDate: ["beforePurchase"] })
  { const lock = lockedFieldRule(d.issueDate, "issueDate"); if (lock) return invalidRule(lock) }
  const avail = returnable(p, excludeId)
  const errors: Record<string, string[]> = {}
  const lines: DebitLine[] = []
  d.lines.forEach((l, i) => {
    if (!l.qty) return
    const r = avail.find((a) => a.itemId === l.itemId)
    if (!r) { errors[`lines.${i}.itemId`] = ["unknown"]; return }
    if (l.qty > r.remaining + 1e-9) { errors[`lines.${i}.qty`] = ["exceedsRemaining"]; return }
    // pro rata of the (first) purchase line for this item — scaled to the item's total purchased quantity
    const src = p.lines.find((x) => x.itemId === l.itemId)!
    const scale = src.qty / r.purchasedQty
    const c = calcDebitLine(src, l.qty * scale)
    lines.push({ itemId: r.itemId, name: r.name, hsCode: r.hsCode, uom: r.uom, purchasedQty: r.purchasedQty, qty: l.qty, price: src.price, sdRate: src.sdRate, vatRate: src.vatRate, ...c })
  })
  if (Object.keys(errors).length) return invalidRule(errors)
  if (!lines.length) return invalidRule({ lines: ["atLeastOneLine"] })
  const sum = (k: "subtotal" | "sd" | "vat" | "tti" | "total" | "rebate") => round2(lines.reduce((a, l) => a + l[k], 0))
  return {
    process: d.process,
    fields: {
      purchaseId: p.id, purchaseNo: p.invoiceNo, purchaseDate: p.issueDate, purchaseMode: p.mode, challanNo: p.challanNo,
      vendorId: p.vendorId, vendorName: p.vendorName, vendorBin: p.vendorBin, vendorAddress: p.vendorAddress, branchId: p.branchId, branchName: p.branchName,
      issueDate: d.issueDate, issueTime: d.issueTime, reason: d.reason, note: d.note || undefined, issuedBy: d.issuedBy, designation: d.designation, lines,
      subtotal: sum("subtotal"), sd: sum("sd"), vat: sum("vat"), tti: sum("tti"), total: sum("total"), rebate: sum("rebate"),
    } satisfies DebitFields as DebitFields,
  }
}

/** Approved return: goods leave the receiving branch (purchased quantity goes down). */
export function postDebit(n: DebitNote, sign: 1 | -1) {
  for (const l of n.lines) { const it = db.items.find((i) => i.id === l.itemId); if (it) it.purchased = round2(it.purchased - sign * l.qty) }
}
function approveDebit(n: DebitNote, by: string, status: 409 | 422 = 409) {
  const short = debitStockRule(n.lines, n.branchId, status); if (short) return ruleResponse(short)
  n.process = "Approved"
  postDebit(n, 1)
  addHistory("debitNote", n, n.no, by, "approved")
  return null
}

/** The goods a debit note returns must still be on hand: 422 while saving, 409 when approving a draft. */
export function debitStockRule(lines: DebitLine[], branchId: string, status: 409 | 422 = 409): RuleProblem | undefined {
  const short = stockShortfall(lines, branchId)
  return short ? { status, title: `Insufficient stock to return — ${short.detail}`, errors: short.errors } : undefined
}

/**
 * A new debit note's identity: the next id in the `dn` series (the counter lives in the state, because a deleted
 * note leaves no row behind) and the next DN-MMYY#### — which the audit trail takes part in, so a deleted draft's
 * number is not reused either. Claimed separately, so a create refused after this point consumes nothing.
 */
export function debitIdentity(issueDate: string) {
  return { id: `dn${db.seq.debitNote + 1}`, no: nextNo("DN", "debitNote", db.debitNotes, issueDate) }
}
export const claimDebitId = () => { db.seq.debitNote += 1 }

/** Approving needs a draft, a purchase that is still approved, and an open tax period. */
export function debitApproveRule(n: DebitNote): RuleProblem | undefined {
  if (n.process !== "Created") return { status: 409, title: `Cannot approve — ${n.no} is ${n.process}.` }
  const p = db.purchases.find((x) => x.id === n.purchaseId)
  if (!p || p.process !== "Approved") return { status: 409, title: `Purchase ${n.purchaseNo} is no longer approved.` }
  return lockedConflictProblem(n.issueDate, n.no) ?? undefined
}

/** Cancelling: never twice, the reason is mandatory, and an approved one needs an open period. */
export function debitCancelRule(n: DebitNote, reason: string): RuleProblem | { reason: string } {
  if (n.process === "Cancelled") return { status: 409, title: `${n.no} is already cancelled.` }
  const parsed = cancelInput.safeParse({ reason })
  if (!parsed.success) return invalidRule(zodErrors(parsed.error))
  if (n.process === "Approved") {
    const lock = lockedConflictProblem(n.issueDate, n.no); if (lock) return lock
  }
  return { reason: parsed.data.reason }
}

/** Only a draft may be deleted; its number lives on in the audit trail. */
export function debitDeleteRule(n: DebitNote): RuleProblem | undefined {
  return n.process !== "Created" ? { status: 409, title: `Only drafts can be deleted — cancel ${n.no} instead.` } : undefined
}

export const debitSpec: QuerySpec<DebitNote> = {
  search: (n) => `${n.no} ${n.purchaseNo} ${n.challanNo} ${n.vendorName} ${n.vendorBin} ${n.lines.map((l) => l.name).join(" ")}`,
  dateField: "issueDate",
  facets: { process: (n) => n.process, reason: (n) => n.reason, vendor: (n) => n.vendorId, branch: (n) => n.branchId },
  totals: ["subtotal", "vat", "tti", "total", "rebate"],
}

/** The register's `?purchase=` filter: the notes of one purchase, taken out of the params before the query runs. */
export const debitSourceFilter = (params: URLSearchParams, src: DebitNote[]) => {
  const purchase = params.get("purchase")
  params.delete("purchase")
  return purchase ? src.filter((n) => n.purchaseId === purchase) : src
}

export const debitCsvColumns: { key: string; label: string; get?: (n: DebitNote) => unknown }[] = [
  { key: "issueDate", label: "Date" }, { key: "no", label: "Debit Note No" }, { key: "purchaseNo", label: "Purchase No" }, { key: "challanNo", label: "Challan / BoE" },
  { key: "vendorName", label: "Vendor" }, { key: "vendorBin", label: "BIN/NID" }, { key: "reason", label: "Reason" }, { key: "subtotal", label: "Value" },
  { key: "sd", label: "SD" }, { key: "vat", label: "VAT" }, { key: "tti", label: "TTI" }, { key: "total", label: "Total" }, { key: "rebate", label: "Rebate reversed" }, { key: "process", label: "Process" },
]

export const debitFacetLabels = () => ({ vendor: Object.fromEntries(db.vendors.map((v) => [v.id, v.name])), branch: branchLabels() })

export function debitListRoutes() {
  const GET = withAuth(null, async (req) => {
    const sp = new URL(req.url).searchParams
    if (!sp.get("sort")) sp.set("sort", "createdAt.desc")
    const r = runQuery(debitSourceFilter(sp, db.debitNotes), sp, debitSpec)
    if (sp.get("format") === "csv")
      return csvResponse(toCSV(r.all, debitCsvColumns), `debit-notes-${new Date().toISOString().slice(0, 10)}.csv`)
    await delay()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    return json({ ...page, facetLabels: debitFacetLabels() })
  })
  const POST = withAuth("doc.create", async (req, _ctx, user) => {
    const r = buildDebit(await req.json().catch(() => ({})))
    if ("status" in r) return ruleResponse(r)
    if (r.process === "Approved") { const no = deny(user, "doc.approve"); if (no) return no }
    const n: DebitNote = { ...r.fields!, ...debitIdentity(r.fields!.issueDate), process: "Created", createdAt: new Date().toISOString(), history: [] }
    if (r.process === "Approved") { const short = debitStockRule(n.lines, n.branchId, 422); if (short) return ruleResponse(short) }
    claimDebitId()
    addHistory("debitNote", n, n.no, user.name, "created")
    if (r.process === "Approved") approveDebit(n, user.name)
    db.debitNotes.push(n)
    return json(n, { status: 201 })
  })
  return { GET, POST }
}

export function debitDocRoutes() {
  const find = (id: string) => db.debitNotes.find((n) => n.id === id || n.no === id)
  const GET = withAuth<Ctx>(null, async (_req, { params }) => {
    const { id } = await params
    await delay(100)
    const n = find(id)
    return n ? json(n) : problem(404, "Debit note not found")
  })
  const PUT = withAuth<Ctx>("doc.edit", async (req, { params }, user) => {
    const { id } = await params
    const n = find(id)
    if (!n) return problem(404, "Debit note not found")
    const draft = noteDraftRule(n); if (draft) return ruleResponse(draft)
    const r = buildDebit(await req.json().catch(() => ({})), n.id)
    if ("status" in r) return ruleResponse(r)
    if (r.process === "Approved") {
      const no = deny(user, "doc.approve"); if (no) return no
      const short = debitStockRule(r.fields!.lines, r.fields!.branchId, 422); if (short) return ruleResponse(short)
    }
    const before = structuredClone(n)
    Object.assign(n, r.fields)
    addHistory("debitNote", n, n.no, user.name, "edited", undefined, noteDiff(before, n))
    if (r.process === "Approved") approveDebit(n, user.name)
    return json(n)
  })
  const PATCH = withAuth<Ctx>(null, async (req, { params }, user) => {
    const { id } = await params
    const n = find(id)
    if (!n) return problem(404, "Debit note not found")
    const body = (await req.json().catch(() => ({}))) as { process?: string; reason?: string }
    if (body.process === "Approved") {
      const no = deny(user, "doc.approve"); if (no) return no
      const rule = debitApproveRule(n); if (rule) return ruleResponse(rule)
      return approveDebit(n, user.name) ?? json(n)
    }
    if (body.process === "Cancelled") {
      const no = deny(user, "doc.cancel"); if (no) return no
      const r = debitCancelRule(n, body.reason ?? "")
      if ("status" in r) return ruleResponse(r)
      if (n.process === "Approved") postDebit(n, -1) // the goods come back on the books
      n.process = "Cancelled"
      n.cancelReason = r.reason
      addHistory("debitNote", n, n.no, user.name, "cancelled", r.reason)
      return json(n)
    }
    return problem(400, "process must be Approved or Cancelled")
  })
  const DELETE = withAuth<Ctx>("doc.delete", async (_req, { params }, user) => {
    const { id } = await params
    const i = db.debitNotes.findIndex((x) => x.id === id)
    if (i < 0) return problem(404, "Debit note not found")
    const gone = debitDeleteRule(db.debitNotes[i]); if (gone) return ruleResponse(gone)
    const [n] = db.debitNotes.splice(i, 1)
    addHistory("debitNote", n, n.no, user.name, "deleted")
    return json({ ok: true })
  })
  return { GET, PUT, PATCH, DELETE }
}

/* ── Opening stock ─────────────────────────────────────────────────────── */

function buildOpening(body: unknown) {
  const parsed = openingInput.safeParse(body)
  if (!parsed.success) return { error: zodProblem(parsed.error) }
  const d: z.output<typeof openingInput> = parsed.data
  const errors: Record<string, string[]> = {}
  const it = db.items.find((i) => i.id === d.itemId && i.active)
  if (!it) errors.itemId = ["unknown"]
  if (!resolveBranch(d.branchId)) errors.branchId = ["unknownBranch"]
  if (Object.keys(errors).length || !it) return { error: problem(422, "Validation failed", errors) }
  const dec = db.units.find((u) => u.code === it.unit)?.decimals ?? 2
  const qty = Math.round(d.qty * 10 ** dec) / 10 ** dec
  if (qty <= 0) return { error: problem(422, "Validation failed", { qty: ["positive"] }) }
  return {
    process: d.process,
    fields: {
      itemId: it.id, name: it.name, hsCode: it.hsCode, sku: it.sku, uom: it.unit, branchId: d.branchId, branchName: branchName(d.branchId),
      date: d.date, inputTax: d.inputTax, qty, price: d.price, value: round2(qty * d.price), vatPaid: round2(d.vatPaid ?? 0), note: d.note || undefined,
    } satisfies Partial<OpeningEntry>,
  }
}
function postOpening(o: OpeningEntry, sign: 1 | -1) {
  const it = db.items.find((i) => i.id === o.itemId)
  if (it) it.opening = round2(it.opening + sign * o.qty)
}
function approveOpening(o: OpeningEntry, by: string) {
  o.process = "Approved"
  postOpening(o, 1)
  addHistory("opening", o, o.no, by, "approved")
}

const osSpec: QuerySpec<OpeningEntry> = {
  search: (o) => `${o.no} ${o.name} ${o.sku} ${o.hsCode} ${o.note ?? ""}`,
  dateField: "date",
  facets: { process: (o) => o.process, branch: (o) => o.branchId, inputTax: (o) => o.inputTax },
  totals: ["value", "vatPaid"],
}

export function openingListRoutes() {
  const GET = withAuth(null, async (req) => {
    const sp = new URL(req.url).searchParams
    if (!sp.get("sort")) sp.set("sort", "createdAt.desc")
    const item = sp.get("item"); sp.delete("item")
    const r = runQuery(item ? db.openings.filter((o) => o.itemId === item) : db.openings, sp, osSpec)
    if (sp.get("format") === "csv") {
      return csvResponse(toCSV(r.all, [
        { key: "date", label: "Date" }, { key: "no", label: "Entry No" }, { key: "hsCode", label: "HS Code" }, { key: "sku", label: "SKU" }, { key: "name", label: "Item" },
        { key: "branchName", label: "Branch" }, { key: "inputTax", label: "Input tax" }, { key: "qty", label: "Qty" }, { key: "uom", label: "Unit" },
        { key: "price", label: "Purchase price" }, { key: "value", label: "Value" }, { key: "vatPaid", label: "VAT paid" }, { key: "process", label: "Process" },
      ]), `opening-stock-${new Date().toISOString().slice(0, 10)}.csv`)
    }
    await delay()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    return json({ ...page, facetLabels: { branch: branchLabels() } })
  })
  const POST = withAuth("doc.create", async (req, _ctx, user) => {
    const r = buildOpening(await req.json().catch(() => ({})))
    if (r.error) return r.error
    if (r.process === "Approved") { const no = deny(user, "doc.approve"); if (no) return no }
    db.seq.opening += 1
    const o: OpeningEntry = { ...r.fields!, id: `os${db.seq.opening}`, no: nextNo("OS", "opening", db.openings, r.fields!.date), process: "Created", issuedBy: user.name, createdAt: new Date().toISOString(), history: [] }
    addHistory("opening", o, o.no, user.name, "created")
    if (r.process === "Approved") approveOpening(o, user.name)
    db.openings.push(o)
    return json(o, { status: 201 })
  })
  return { GET, POST }
}

export function openingDocRoutes() {
  const find = (id: string) => db.openings.find((o) => o.id === id || o.no === id)
  const GET = withAuth<Ctx>(null, async (_req, { params }) => {
    const { id } = await params
    const o = find(id)
    return o ? json(o) : problem(404, "Opening entry not found")
  })
  const PUT = withAuth<Ctx>("doc.edit", async (req, { params }, user) => {
    const { id } = await params
    const o = find(id)
    if (!o) return problem(404, "Opening entry not found")
    if (o.process !== "Created") return problem(409, `Only drafts can be edited — ${o.no} is ${o.process}.`)
    const r = buildOpening(await req.json().catch(() => ({})))
    if (r.error) return r.error
    if (r.process === "Approved") { const no = deny(user, "doc.approve"); if (no) return no }
    const before = structuredClone(o)
    Object.assign(o, r.fields)
    addHistory("opening", o, o.no, user.name, "edited", undefined, diff(before, o, ["name", "branchName", "date", "inputTax", "qty", "price", "value", "vatPaid", "note"]))
    if (r.process === "Approved") approveOpening(o, user.name)
    return json(o)
  })
  const PATCH = withAuth<Ctx>(null, async (req, { params }, user) => {
    const { id } = await params
    const o = find(id)
    if (!o) return problem(404, "Opening entry not found")
    const body = (await req.json().catch(() => ({}))) as { process?: string; reason?: string }
    if (body.process === "Approved") {
      const no = deny(user, "doc.approve"); if (no) return no
      if (o.process !== "Created") return problem(409, `Cannot approve — ${o.no} is ${o.process}.`)
      approveOpening(o, user.name)
      return json(o)
    }
    if (body.process === "Cancelled") {
      const no = deny(user, "doc.cancel"); if (no) return no
      if (o.process === "Cancelled") return problem(409, `${o.no} is already cancelled.`)
      const r = cancelInput.safeParse({ reason: body.reason ?? "" })
      if (!r.success) return zodProblem(r.error)
      if (o.process === "Approved") {
        const short = stockShortfall([{ itemId: o.itemId, qty: o.qty }], o.branchId)
        if (short) return problem(409, `This opening stock has already been used — ${short.detail}`)
        postOpening(o, -1)
      }
      o.process = "Cancelled"
      o.cancelReason = r.data.reason
      addHistory("opening", o, o.no, user.name, "cancelled", r.data.reason)
      return json(o)
    }
    return problem(400, "process must be Approved or Cancelled")
  })
  const DELETE = withAuth<Ctx>("doc.delete", async (_req, { params }, user) => {
    const { id } = await params
    const i = db.openings.findIndex((x) => x.id === id)
    if (i < 0) return problem(404, "Opening entry not found")
    if (db.openings[i].process !== "Created") return problem(409, `Only drafts can be deleted — cancel ${db.openings[i].no} instead.`)
    const [o] = db.openings.splice(i, 1)
    addHistory("opening", o, o.no, user.name, "deleted")
    return json({ ok: true })
  })
  return { GET, PUT, PATCH, DELETE }
}
