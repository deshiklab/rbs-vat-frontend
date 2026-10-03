import { vdsCertificateDue } from "@/lib/rules"
import { amendmentRow, extensionFor, lateFilingRow } from "@/lib/return-apps"
/**
 * R4 mock API — Accounting (money accounts, receipts, payments, statements, config) and NBR VAT
 * (treasury deposits / TR-6, VDS / Mushak 6.6, VAT adjustments, Mushak 9.1 returns, compliance centre, period lock).
 */
import { TODAY } from "@/lib/company"
import { company } from "@/lib/mock/company"
import { db } from "@/lib/mock/db"
import { auditStore, diff, recordAudit } from "@/lib/mock/audit"
import { csvResponse, delay, runQuery, toCSV, type QuerySpec } from "@/lib/mock/query"
import { computeReturn, EMPTY_MANUAL, lockingReturn, subForm } from "@/lib/mock/vat-return"
import { FIRST_RETURN } from "@/lib/mock/seed-r4"
import {
  ADJUSTMENT_NOTE, economicCode, M610_LIMIT, METHOD_ACCOUNT, noteDef, PERIOD_RE, periodEnd, periodLabel, periodOf, periodsBetween, prevPeriod, returnDue,
} from "@/lib/r4"
import { accountInput, accountingConfigInput, adjustmentInput, cancelInput, moneyInput, returnInput, treasuryInput, vatSettingsInput, vdsInput } from "@/lib/schemas"
import type {
  Allocation, AuditChange, AuditEntity, HistoryEntry, MoneyAccount, MoneyAccountRow, MoneyDoc, MoneyKind, OpenInvoice, Party, PartyStatement, Process,
  Purchase, ReturnView, Sale, StatementRow, TaxPeriod, TreasuryDeposit, VatAdjustment, VatReturn, VatReturnRow, VdsEligible, VdsEntry,
} from "@/lib/types"
import type { User } from "@/lib/auth/roles"
import { round2 } from "@/lib/vat"
import { sdEligible, sdExportLink } from "@/lib/sd-export"
import { deny, json, problem, withAuth, zodProblem, type RuleProblem } from "./_lib"

type Ctx = { params: Promise<{ id: string }> }
const invalid = (errors: Record<string, string[]>) => problem(422, "Validation failed", errors)
const has = (e: Record<string, string[]>) => Object.keys(e).length > 0
const ISO = /^\d{4}-\d{2}-\d{2}$/
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5)
const CURRENT = periodOf(TODAY)

/* ── Period lock (Mushak 9.1 submitted) & accounting close ─────────────── */

/** The submitted Mushak 9.1 return that locks a date's tax period, if any. */
export const periodLocked = (date: string) => lockingReturn(db, date)
/** R5.3: the lock as data — the field error, and the 409's title — so the native modules raise the same problem. */
export const lockedFieldRule = (date: string, field: string) => (periodLocked(date) ? { [field]: ["periodLocked"] } : null)
export function lockedConflictRule(date: string, no: string) {
  const r = periodLocked(date)
  return r ? `Tax period ${periodLabel(r.period)} is locked — its Mushak 9.1 return was submitted on ${r.submissionDate}. ${no} cannot change; record a correction in the current period (credit/debit note or VAT adjustment).` : null
}
/** 422 field error when a date falls in a tax period whose return has been submitted. */
export function lockedField(date: string, field: string) {
  const errors = lockedFieldRule(date, field)
  return errors ? invalid(errors) : null
}
/** The lock as a 409 rule problem (R5.3) — what both runtimes raise for approve / cancel in a locked period. */
export function lockedConflictProblem(date: string, no: string): RuleProblem | null {
  const title = lockedConflictRule(date, no)
  return title ? { status: 409, title } : null
}
/** 409 when a document's tax period is locked (approve / cancel of an existing document). */
export function lockedConflict(date: string, no: string) {
  const title = lockedConflictRule(date, no)
  return title ? problem(409, title) : null
}
const closed = (date: string) => !!db.accountingConfig.closedUpTo && date <= db.accountingConfig.closedUpTo

/** Receipts, payments and VDS that settle an invoice — it cannot be cancelled while they stand. */
export function settlementsOf(kind: "sale" | "purchase", id: string) {
  const money = db.moneyDocs.filter((m) => m.process !== "Cancelled" && m.kind === (kind === "sale" ? "receipt" : "payment") && m.allocations.some((a) => a.docId === id))
  const vds = db.vds.filter((v) => v.process !== "Cancelled" && v.mode === (kind === "sale" ? "sales" : "purchase") && v.docId === id)
  return [...money.map((m) => m.no), ...vds.map((v) => v.no)]
}

/* ── Generic document lifecycle (draft → approved → cancelled) ─────────── */

interface LifeDoc { id: string; no: string; process: Process; history?: HistoryEntry[]; updatedAt?: string; cancelReason?: string; createdAt: string }
interface Life<T extends LifeDoc, F> {
  entity: AuditEntity
  label: string
  list: () => T[]
  idPrefix: string
  seq: keyof typeof db.seq
  noPrefix: string
  /** validates a body → fields (or a problem) */
  build: (body: unknown, self?: T) => { error: Response } | { fields: F; process: "Created" | "Approved"; date: string }
  /** business checks + side effects when approving; return a problem to refuse */
  approve?: (d: T) => Response | null
  /** checks + reversal when cancelling an approved document */
  cancel?: (d: T) => Response | null
  /** lock check for approve/cancel of an existing document */
  locked?: (d: T) => Response | null
  diffFields: string[]
  spec: QuerySpec<T>
  csv: { key: string; label: string; get?: (r: T) => unknown }[]
  csvName: string
  facetLabels?: () => Record<string, Record<string, string>>
  filter?: (rows: T[], sp: URLSearchParams) => T[]
}

export function nextNo(prefix: string, entity: AuditEntity, list: { no: string }[], date: string) {
  const key = `${prefix}-${date.slice(5, 7)}${date.slice(2, 4)}`
  const used = [...list.map((d) => d.no), ...auditStore.events.filter((e) => e.entity === entity).map((e) => e.ref)]
  const n = used.reduce((m, no) => (no.startsWith(key) ? Math.max(m, Number(no.slice(key.length)) || 0) : m), 0) + 1
  return `${key}${String(n).padStart(4, "0")}`
}
function history(entity: AuditEntity, d: LifeDoc, by: string, action: HistoryEntry["action"], note?: string, changes?: AuditChange[], ref = d.no, entityId = d.id) {
  const at = new Date().toISOString()
  d.history = [...(d.history ?? []), { at, by, action, note }]
  d.updatedAt = at
  recordAudit({ at, actor: by, entity, entityId, ref, action, note, changes })
}

function lifecycle<T extends LifeDoc, F extends object>(c: Life<T, F>) {
  const find = (id: string) => c.list().find((x) => x.id === id || x.no === id)
  const doApprove = (d: T, user: User) => {
    const err = c.approve?.(d)
    if (err) return err
    d.process = "Approved"
    history(c.entity, d, user.name, "approved")
    return null
  }
  const listGET = withAuth(null, async (req) => {
    const sp = new URL(req.url).searchParams
    if (!sp.get("sort")) sp.set("sort", "createdAt.desc")
    const r = runQuery(c.filter ? c.filter(c.list(), sp) : c.list(), sp, c.spec)
    if (sp.get("format") === "csv") return csvResponse(toCSV(r.all, c.csv), `${c.csvName}-${new Date().toISOString().slice(0, 10)}.csv`)
    await delay()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    return json({ ...page, facetLabels: c.facetLabels?.() ?? {} })
  })
  const POST = withAuth("doc.create", async (req, _ctx, user) => {
    const r = c.build(await req.json().catch(() => ({})))
    if ("error" in r) return r.error
    if (r.process === "Approved") { const no = deny(user, "doc.approve"); if (no) return no }
    const d = { ...r.fields, id: `${c.idPrefix}${db.seq[c.seq] + 1}`, no: nextNo(c.noPrefix, c.entity, c.list(), r.date), process: "Created", createdAt: new Date().toISOString(), history: [] } as unknown as T
    if (r.process === "Approved") { const err = c.approve?.(d); if (err) return err }
    if ("issuedBy" in d) (d as { issuedBy: string }).issuedBy = user.name
    db.seq[c.seq] += 1
    c.list().push(d)
    history(c.entity, d, user.name, "created")
    if (r.process === "Approved") { d.process = "Approved"; history(c.entity, d, user.name, "approved") }
    return json(d, { status: 201 })
  })
  const GET = withAuth<Ctx>(null, async (_req, { params }) => {
    const { id } = await params
    await delay(80)
    const d = find(id)
    return d ? json(d) : problem(404, `${c.label} not found`)
  })
  const PUT = withAuth<Ctx>("doc.edit", async (req, { params }, user) => {
    const { id } = await params
    const d = find(id)
    if (!d) return problem(404, `${c.label} not found`)
    if (d.process !== "Created") return problem(409, `Only drafts can be edited — ${d.no} is ${d.process}.`)
    const r = c.build(await req.json().catch(() => ({})), d)
    if ("error" in r) return r.error
    if (r.process === "Approved") { const no = deny(user, "doc.approve"); if (no) return no }
    const before = structuredClone(d)
    Object.assign(d, r.fields)
    if (r.process === "Approved") {
      const err = c.approve?.(d)
      if (err) { Object.keys(d).forEach((k) => delete (d as Record<string, unknown>)[k]); Object.assign(d, before); return err }
    }
    history(c.entity, d, user.name, "edited", undefined, diff(before, d, c.diffFields))
    if (r.process === "Approved") { d.process = "Approved"; history(c.entity, d, user.name, "approved") }
    return json(d)
  })
  const PATCH = withAuth<Ctx>(null, async (req, { params }, user) => {
    const { id } = await params
    const d = find(id)
    if (!d) return problem(404, `${c.label} not found`)
    const body = (await req.json().catch(() => ({}))) as { process?: string; reason?: string }
    if (body.process === "Approved") {
      const no = deny(user, "doc.approve"); if (no) return no
      if (d.process !== "Created") return problem(409, `Cannot approve — ${d.no} is ${d.process}.`)
      const lock = c.locked?.(d); if (lock) return lock
      const err = doApprove(d, user)
      return err ?? json(d)
    }
    if (body.process === "Cancelled") {
      const no = deny(user, "doc.cancel"); if (no) return no
      if (d.process === "Cancelled") return problem(409, `${d.no} is already cancelled.`)
      const r = cancelInput.safeParse({ reason: body.reason ?? "" })
      if (!r.success) return zodProblem(r.error)
      if (d.process === "Approved") {
        const lock = c.locked?.(d); if (lock) return lock
        const err = c.cancel?.(d); if (err) return err
      }
      d.process = "Cancelled"
      d.cancelReason = r.data.reason
      history(c.entity, d, user.name, "cancelled", r.data.reason)
      return json(d)
    }
    return problem(400, "process must be Approved or Cancelled")
  })
  const DELETE = withAuth<Ctx>("doc.delete", async (_req, { params }, user) => {
    const { id } = await params
    const list = c.list()
    const i = list.findIndex((x) => x.id === id)
    if (i < 0) return problem(404, `${c.label} not found`)
    if (list[i].process !== "Created") return problem(409, `Only drafts can be deleted — cancel ${list[i].no} instead.`)
    const [d] = list.splice(i, 1)
    history(c.entity, d, user.name, "deleted")
    return json({ ok: true })
  })
  return { list: { GET: listGET, POST }, doc: { GET, PUT, PATCH, DELETE } }
}

/* ── Money accounts ────────────────────────────────────────────────────── */

export function accountRow(a: MoneyAccount): MoneyAccountRow {
  const docs = db.moneyDocs.filter((m) => m.accountId === a.id && m.process === "Approved")
  const dep = db.treasury.filter((t) => t.accountId === a.id && t.process === "Approved")
  const inflow = round2(docs.filter((m) => m.kind === "receipt").reduce((s, m) => s + m.amount - m.charge, 0))
  const outflow = round2(docs.filter((m) => m.kind === "payment").reduce((s, m) => s + m.amount, 0) + dep.reduce((s, t) => s + t.amount, 0))
  const dates = [...docs.map((m) => m.date), ...dep.map((t) => t.challanDate)].sort()
  return { ...a, inflow, outflow, balance: round2(a.openingBalance + inflow - outflow), lastDate: dates.at(-1), docs: docs.length + dep.length }
}
const accountSpec: QuerySpec<MoneyAccountRow> = {
  search: (a) => `${a.provider} ${a.accountNo} ${a.owner} ${a.branch ?? ""} ${a.authorised ?? ""}`,
  facets: { kind: (a) => a.kind, status: (a) => (a.active ? "active" : "inactive") },
  totals: ["balance", "inflow", "outflow", "openingBalance"],
}
type AccountFields = Omit<MoneyAccount, "id" | "createdAt" | "updatedAt" | "history">
function parseAccount(body: unknown, self?: MoneyAccount): { error: Response } | { fields: AccountFields } {
  const parsed = accountInput.safeParse(body)
  if (!parsed.success) return { error: zodProblem(parsed.error) }
  const a = parsed.data
  if (self && self.kind !== a.kind) return { error: problem(409, "An account cannot change its kind — add a new account.") }
  const dup = db.moneyAccounts.find((x) => x.id !== self?.id && x.kind === a.kind && a.accountNo && x.accountNo.replace(/\D/g, "") === a.accountNo.replace(/\D/g, "") && x.provider === a.provider)
  if (dup) return { error: invalid({ accountNo: ["duplicate"] }) }
  if (self && !a.active && self.active) {
    const drafts = db.moneyDocs.filter((m) => m.accountId === self.id && m.process === "Created")
    if (drafts.length) return { error: problem(409, `Drafts still use this account (${drafts.map((m) => m.no).join(", ")}) — approve or delete them first.`) }
  }
  const fields: AccountFields = {
    kind: a.kind, provider: a.provider, accountNo: a.accountNo, owner: a.owner, serviceCharge: a.serviceCharge, openingBalance: a.openingBalance, openingDate: a.openingDate, active: a.active,
    branch: a.kind === "bank" ? a.branch || undefined : undefined, address: a.address || undefined, bankType: a.kind === "bank" ? a.bankType : undefined,
    walletType: a.kind === "mobile" ? a.walletType : undefined, authorised: a.kind === "mobile" ? a.authorised : undefined,
  }
  return { fields }
}
export const accountRoutes = {
  GET: withAuth(null, async (req) => {
    const sp = new URL(req.url).searchParams
    if (!sp.get("sort")) sp.set("sort", "provider.asc")
    const r = runQuery(db.moneyAccounts.map(accountRow), sp, accountSpec)
    if (sp.get("format") === "csv") {
      return csvResponse(toCSV(r.all, [
        { key: "kind", label: "Kind" }, { key: "provider", label: "Bank / service" }, { key: "branch", label: "Branch" }, { key: "accountNo", label: "Account / wallet no" },
        { key: "owner", label: "Account owner" }, { key: "bankType", label: "Account type", get: (a) => a.bankType ?? a.walletType ?? "" }, { key: "serviceCharge", label: "Service charge %" },
        { key: "openingBalance", label: "Opening balance" }, { key: "inflow", label: "Received" }, { key: "outflow", label: "Paid out" }, { key: "balance", label: "Balance" },
        { key: "active", label: "Status", get: (a) => (a.active ? "Active" : "Inactive") },
      ]), `money-accounts-${new Date().toISOString().slice(0, 10)}.csv`)
    }
    await delay()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    return json(page)
  }),
  POST: withAuth("master.edit", async (req, _ctx, user) => {
    const r = parseAccount(await req.json().catch(() => ({})))
    if ("error" in r) return r.error
    const a: MoneyAccount = { ...r.fields, id: `ac${db.seq.account + 1}`, createdAt: new Date().toISOString(), history: [] }
    db.seq.account += 1
    db.moneyAccounts.push(a)
    history("account", a as unknown as LifeDoc, user.name, "created", undefined, undefined, `${a.provider} · ${a.accountNo}`)
    return json(accountRow(a), { status: 201 })
  }),
}
export const accountDocRoutes = {
  GET: withAuth<Ctx>(null, async (_req, { params }) => {
    const { id } = await params
    const a = db.moneyAccounts.find((x) => x.id === id)
    return a ? json(accountRow(a)) : problem(404, "Account not found")
  }),
  PUT: withAuth<Ctx>("master.edit", async (req, { params }, user) => {
    const { id } = await params
    const a = db.moneyAccounts.find((x) => x.id === id)
    if (!a) return problem(404, "Account not found")
    const r = parseAccount(await req.json().catch(() => ({})), a)
    if ("error" in r) return r.error
    const before = structuredClone(a)
    Object.assign(a, r.fields)
    const changes = diff(before, a, ["provider", "accountNo", "owner", "branch", "bankType", "walletType", "authorised", "serviceCharge", "openingBalance", "openingDate", "active"])
    const action = before.active !== a.active ? (a.active ? "activated" : "deactivated") : "updated"
    const at = new Date().toISOString()
    a.updatedAt = at
    recordAudit({ at, actor: user.name, entity: "account", entityId: a.id, ref: `${a.provider} · ${a.accountNo}`, action, changes })
    return json(accountRow(a))
  }),
  DELETE: withAuth<Ctx>("master.edit", async (_req, { params }, user) => {
    const { id } = await params
    const i = db.moneyAccounts.findIndex((x) => x.id === id)
    if (i < 0) return problem(404, "Account not found")
    const a = db.moneyAccounts[i]
    const used = db.moneyDocs.some((m) => m.accountId === id) || db.treasury.some((t) => t.accountId === id)
    if (used) return problem(409, `${a.provider} · ${a.accountNo} has transactions — deactivate it instead.`)
    db.moneyAccounts.splice(i, 1)
    recordAudit({ actor: user.name, entity: "account", entityId: a.id, ref: `${a.provider} · ${a.accountNo}`, action: "deleted" })
    return json({ ok: true })
  }),
}

/* ── Receipts & payments ───────────────────────────────────────────────── */

const invoicesOf = (kind: MoneyKind): (Sale | Purchase)[] => (kind === "receipt" ? db.sales : db.purchases)
const partyOf = (kind: MoneyKind, id: string): Party | undefined => (kind === "receipt" ? db.customers : db.vendors).find((p) => p.id === id)
const invoiceParty = (d: Sale | Purchase) => ("customerId" in d ? d.customerId : d.vendorId)

/** Approved invoices of a party that still have something to settle, oldest first. */
export function openInvoices(kind: MoneyKind, partyId: string): OpenInvoice[] {
  return invoicesOf(kind)
    .filter((d) => d.process === "Approved" && invoiceParty(d) === partyId && d.due > 0.004)
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.invoiceNo.localeCompare(b.invoiceNo))
    .map((d) => ({ id: d.id, no: d.invoiceNo, challanNo: d.challanNo, date: d.issueDate, total: d.netTotal, paid: d.paid, due: d.due, days: daysBetween(d.issueDate, TODAY) }))
}

function buildMoney(kind: MoneyKind) {
  return (body: unknown, self?: MoneyDoc) => {
    const parsed = moneyInput.safeParse(body)
    if (!parsed.success) return { error: zodProblem(parsed.error) }
    const m = parsed.data
    const party = partyOf(kind, m.partyId)
    if (!party || party.active === false) return { error: invalid({ partyId: ["unknown"] }) }
    if (self && self.partyId !== m.partyId) return { error: problem(409, `A ${kind} cannot move to another party — create a new one.`) }
    if (closed(m.date)) return { error: invalid({ date: ["dateClosed"] }) }
    if (m.date > TODAY) return { error: invalid({ date: ["future"] }) }
    const acct = db.moneyAccounts.find((a) => a.id === m.accountId && a.active)
    if (!acct) return { error: invalid({ accountId: ["unknown"] }) }
    if (acct.kind !== METHOD_ACCOUNT[m.method]) return { error: invalid({ accountId: ["accountMismatch"] }) }
    const errors: Record<string, string[]> = {}
    const open = new Map(openInvoices(kind, party.id).map((o) => [o.id, o]))
    const seen = new Set<string>()
    const allocations: Allocation[] = []
    m.allocations.forEach((a, i) => {
      if (!a.amount) return
      const inv = open.get(a.docId)
      if (!inv) { errors[`allocations.${i}.docId`] = ["notOpen"]; return }
      if (seen.has(a.docId)) { errors[`allocations.${i}.docId`] = ["duplicate"]; return }
      seen.add(a.docId)
      if (a.amount > inv.due + 0.004) { errors[`allocations.${i}.amount`] = ["exceedsDue"]; return }
      allocations.push({ docId: inv.id, docNo: inv.no, docDate: inv.date, docTotal: inv.total, amount: round2(a.amount) })
    })
    if (has(errors)) return { error: invalid(errors) }
    const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0))
    if (allocated > m.amount + 0.004) return { error: invalid({ amount: ["overAllocated"] }) }
    if (!db.accountingConfig.allowAdvance && allocated < m.amount - 0.004) return { error: invalid({ amount: ["advanceNotAllowed"] }) }
    return {
      process: m.process, date: m.date,
      fields: {
        kind, date: m.date, partyId: party.id, partyName: party.name, partyBin: party.bin, method: m.method, accountId: acct.id, accountName: `${acct.provider} · ${acct.accountNo}`,
        chequeNo: m.method === "cheque" ? m.chequeNo : undefined, chequeDate: m.method === "cheque" ? m.chequeDate : undefined, chequeBank: m.method === "cheque" ? m.chequeBank || undefined : undefined,
        reference: m.method === "cash" || m.method === "cheque" ? m.reference || undefined : m.reference,
        amount: round2(m.amount), charge: round2(m.charge ?? 0), allocations, allocated, unallocated: round2(m.amount - allocated), note: m.note || undefined,
        issuedBy: self?.issuedBy ?? "",
      } satisfies Partial<MoneyDoc>,
    }
  }
}
/** Apply (+1) or reverse (−1) the allocations on the invoices. */
function settle(d: MoneyDoc, sign: 1 | -1) {
  for (const a of d.allocations) {
    const inv = invoicesOf(d.kind).find((x) => x.id === a.docId)
    if (!inv) continue
    inv.paid = round2(inv.paid + sign * a.amount)
    inv.due = round2(inv.netTotal - inv.paid)
  }
}
const moneySpec: QuerySpec<MoneyDoc> = {
  search: (m) => `${m.no} ${m.partyName} ${m.partyBin} ${m.chequeNo ?? ""} ${m.reference ?? ""} ${m.allocations.map((a) => a.docNo).join(" ")}`,
  dateField: "date",
  facets: { process: (m) => m.process, method: (m) => m.method, party: (m) => m.partyId, account: (m) => m.accountId },
  totals: ["amount", "allocated", "unallocated", "charge"],
}
export function moneyRoutes(kind: MoneyKind) {
  const label = kind === "receipt" ? "Receipt" : "Payment"
  const build = buildMoney(kind)
  return lifecycle<MoneyDoc, ReturnType<typeof build> extends infer R ? R extends { fields: infer F } ? F : never : never>({
    entity: kind, label, list: () => db.moneyDocs, idPrefix: kind === "receipt" ? "mr" : "pv", seq: kind, noPrefix: kind === "receipt" ? "MR" : "PV",
    filter: (rows, sp) => { const inv = sp.get("invoice"); sp.delete("invoice"); return rows.filter((m) => m.kind === kind && (!inv || m.allocations.some((a) => a.docId === inv))) },
    build,
    approve: (d) => {
      if (closed(d.date)) return problem(409, `The books are closed up to ${db.accountingConfig.closedUpTo} — ${d.no} cannot be approved.`)
      const open = new Map(openInvoices(kind, d.partyId).map((o) => [o.id, o]))
      const errors: Record<string, string[]> = {}
      d.allocations.forEach((a, i) => { if (a.amount > (open.get(a.docId)?.due ?? 0) + 0.004) errors[`allocations.${i}.amount`] = ["exceedsDue"] })
      if (has(errors)) return problem(409, `An invoice was settled in the meantime — ${d.allocations.filter((_, i) => errors[`allocations.${i}.amount`]).map((a) => a.docNo).join(", ")} no longer has that much due.`, errors)
      settle(d, 1)
      return null
    },
    cancel: (d) => {
      if (closed(d.date)) return problem(409, `The books are closed up to ${db.accountingConfig.closedUpTo} — ${d.no} cannot be cancelled.`)
      settle(d, -1)
      return null
    },
    diffFields: ["date", "method", "accountName", "chequeNo", "chequeDate", "reference", "amount", "charge", "allocated", "note"],
    spec: moneySpec,
    csv: [
      { key: "date", label: "Date" }, { key: "no", label: kind === "receipt" ? "Receipt No" : "Voucher No" }, { key: "partyName", label: kind === "receipt" ? "Customer" : "Supplier" },
      { key: "partyBin", label: "BIN" }, { key: "method", label: "Method" }, { key: "accountName", label: "Account" }, { key: "chequeNo", label: "Cheque No" }, { key: "reference", label: "Reference" },
      { key: "amount", label: "Amount" }, { key: "charge", label: "Charge" }, { key: "allocated", label: "Allocated" }, { key: "unallocated", label: "On account" },
      { key: "invoices", label: "Invoices", get: (m) => m.allocations.map((a) => `${a.docNo}:${a.amount}`).join("; ") }, { key: "process", label: "Process" },
    ],
    csvName: kind === "receipt" ? "receipts" : "payments",
    facetLabels: () => ({
      party: Object.fromEntries((kind === "receipt" ? db.customers : db.vendors).map((p) => [p.id, p.name])),
      account: Object.fromEntries(db.moneyAccounts.map((a) => [a.id, `${a.provider} · ${a.accountNo}`])),
    }),
  })
}
export const openInvoicesRoute = withAuth(null, async (req) => {
  const sp = new URL(req.url).searchParams
  const kind = sp.get("kind") === "payment" ? "payment" : "receipt"
  const party = sp.get("party") ?? ""
  if (!partyOf(kind, party)) return invalid({ party: ["unknown"] })
  await delay(60)
  return json(openInvoices(kind, party))
})

/* ── Party statement ───────────────────────────────────────────────────── */

export function statement(kind: "customer" | "vendor", party: Party, from: string, to: string): PartyStatement {
  const mk: MoneyKind = kind === "customer" ? "receipt" : "payment"
  const invs = invoicesOf(mk).filter((d) => d.process === "Approved" && invoiceParty(d) === party.id)
  const money = db.moneyDocs.filter((m) => m.kind === mk && m.process === "Approved" && m.partyId === party.id)
  const vds = db.vds.filter((v) => v.mode === (kind === "customer" ? "sales" : "purchase") && v.process === "Approved" && v.partyId === party.id && (v.settled ?? 0) > 0)
  const all: Omit<StatementRow, "balance">[] = []
  for (const d of invs) {
    all.push({ date: d.issueDate, type: "invoice", ref: d.invoiceNo, refId: d.id, note: d.challanNo, debit: d.netTotal, credit: 0 })
    const later = money.reduce((s, m) => s + m.allocations.filter((a) => a.docId === d.id).reduce((x, a) => x + a.amount, 0), 0) + vds.filter((v) => v.docId === d.id).reduce((s, v) => s + (v.settled ?? 0), 0)
    const onInvoice = round2(d.paid - later)
    if (onInvoice > 0.004) all.push({ date: d.issueDate, type: "settledOnInvoice", ref: d.invoiceNo, refId: d.id, debit: 0, credit: onInvoice })
  }
  for (const m of money) {
    if (m.allocated) all.push({ date: m.date, type: mk, ref: m.no, refId: m.id, note: m.allocations.map((a) => a.docNo).join(", "), debit: 0, credit: m.allocated })
    if (m.unallocated > 0.004) all.push({ date: m.date, type: "advance", ref: m.no, refId: m.id, note: m.note, debit: 0, credit: m.unallocated })
  }
  for (const v of vds) all.push({ date: v.certificateDate, type: "vds", ref: v.no, refId: v.id, note: v.docNo, debit: 0, credit: v.settled ?? 0 })
  const order: Record<string, number> = { invoice: 0, settledOnInvoice: 1, receipt: 2, payment: 2, vds: 3, advance: 4 }
  all.sort((a, b) => a.date.localeCompare(b.date) || order[a.type] - order[b.type] || (a.ref ?? "").localeCompare(b.ref ?? ""))
  const opening = round2(all.filter((r) => r.date < from).reduce((s, r) => s + r.debit - r.credit, 0))
  let bal = opening
  const rows: StatementRow[] = [{ date: from, type: "opening", debit: 0, credit: 0, balance: opening }]
  for (const r of all.filter((x) => x.date >= from && x.date <= to)) { bal = round2(bal + r.debit - r.credit); rows.push({ ...r, balance: bal }) }
  const open = openInvoices(mk, party.id)
  const ageing = { d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 }
  for (const o of open) {
    const k = o.days <= 30 ? "d0_30" : o.days <= 60 ? "d31_60" : o.days <= 90 ? "d61_90" : "d90"
    ageing[k] = round2(ageing[k] + o.due)
  }
  const advances = round2(money.reduce((s, m) => s + m.unallocated, 0))
  const invoiceDue = round2(invs.reduce((s, d) => s + d.due, 0))
  const fullClosing = round2(all.reduce((s, r) => s + r.debit - r.credit, 0))
  return {
    kind, party, from, to, opening, rows,
    totals: { debit: round2(rows.reduce((s, r) => s + r.debit, 0)), credit: round2(rows.reduce((s, r) => s + r.credit, 0)) },
    closing: bal, ageing, openInvoices: open, advances, invoiceDue, reconciled: Math.abs(fullClosing - (invoiceDue - advances)) < 0.01,
  }
}
export const statementRoute = withAuth(null, async (req) => {
  const sp = new URL(req.url).searchParams
  const kind = sp.get("kind") === "vendor" ? "vendor" : "customer"
  const party = (kind === "customer" ? db.customers : db.vendors).find((p) => p.id === sp.get("party"))
  const from = sp.get("from") || "2025-07-01", to = sp.get("to") || TODAY
  const errors: Record<string, string[]> = {}
  if (!party) errors.party = ["required"]
  if (!ISO.test(from)) errors.from = ["required"]
  if (!ISO.test(to)) errors.to = ["required"]
  if (!errors.from && !errors.to && from > to) errors.to = ["toBeforeFrom"]
  if (has(errors) || !party) return invalid(errors)
  const s = statement(kind, party, from, to)
  if (sp.get("format") === "csv") {
    return csvResponse(toCSV(s.rows, [
      { key: "date", label: "Date" }, { key: "type", label: "Type" }, { key: "ref", label: "Reference" }, { key: "note", label: "Details" },
      { key: "debit", label: kind === "customer" ? "Invoiced" : "Billed" }, { key: "credit", label: kind === "customer" ? "Received" : "Paid" }, { key: "balance", label: "Balance" },
    ]), `statement-${party.name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${from}-${to}.csv`)
  }
  await delay(120)
  return json(s)
})

/* ── Accounting config ─────────────────────────────────────────────────── */

export const accountingConfigRoutes = {
  GET: withAuth(null, async () => json(db.accountingConfig)),
  PUT: withAuth("settings.manage", async (req, _ctx, user) => {
    const parsed = accountingConfigInput.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) return zodProblem(parsed.error)
    const c = parsed.data
    if (c.closedUpTo && c.closedUpTo > TODAY) return invalid({ closedUpTo: ["future"] })
    if (c.closedUpTo) {
      const drafts = db.moneyDocs.filter((m) => m.process === "Created" && m.date <= c.closedUpTo)
      if (drafts.length) return problem(409, `Drafts dated on or before ${c.closedUpTo} are still open (${drafts.map((m) => m.no).join(", ")}) — approve or delete them before closing the books.`)
    }
    const before = { ...db.accountingConfig }
    db.accountingConfig = { closedUpTo: c.closedUpTo || undefined, allowAdvance: c.allowAdvance, autoAllocate: c.autoAllocate, updatedAt: new Date().toISOString(), updatedBy: user.name }
    recordAudit({ actor: user.name, entity: "accountingConfig", ref: "Accounting config", action: "updated", changes: diff(before, db.accountingConfig, ["closedUpTo", "allowAdvance", "autoAllocate"]) })
    return json(db.accountingConfig)
  }),
}

/* ── Treasury deposits (TR-6) ──────────────────────────────────────────── */

const treasurySpec: QuerySpec<TreasuryDeposit> = {
  search: (t) => `${t.no} ${t.challanNo} ${t.bank} ${t.bankBranch} ${t.code} ${t.description}`,
  dateField: "challanDate",
  facets: { process: (t) => t.process, head: (t) => t.head, period: (t) => t.taxPeriod, mode: (t) => t.mode },
  totals: ["amount"],
}
type TreasuryFields = Omit<TreasuryDeposit, "id" | "no" | "process" | "createdAt" | "history">
export const treasuryRoutes = lifecycle<TreasuryDeposit, TreasuryFields>({
  entity: "treasury", label: "Treasury deposit", list: () => db.treasury, idPrefix: "tc", seq: "treasury", noPrefix: "TC",
  build: (body, self) => {
    const parsed = treasuryInput.safeParse(body)
    if (!parsed.success) return { error: zodProblem(parsed.error) }
    const t = parsed.data
    if (t.challanDate > TODAY) return { error: invalid({ challanDate: ["future"] }) }
    if (t.taxPeriod > CURRENT || t.taxPeriod < FIRST_RETURN) return { error: invalid({ taxPeriod: ["outOfRange"] }) }
    const lock = lockedField(`${t.taxPeriod}-01`, "taxPeriod"); if (lock) return { error: lock }
    if (t.accountId && !db.moneyAccounts.some((a) => a.id === t.accountId && a.kind === "bank" && a.active)) return { error: invalid({ accountId: ["unknown"] }) }
    const dup = db.treasury.find((x) => x.id !== self?.id && x.process !== "Cancelled" && x.challanNo === t.challanNo)
    if (dup) return { error: invalid({ challanNo: ["duplicate"] }) }
    return {
      process: t.process, date: t.challanDate,
      fields: {
        head: t.head, code: economicCode(t.head, db.vatSettings.zoneCode), taxPeriod: t.taxPeriod, challanNo: t.challanNo, challanDate: t.challanDate, mode: t.mode,
        bank: t.bank, bankBranch: t.bankBranch, district: t.district, bankAddress: t.bankAddress || undefined, accountId: t.accountId || undefined, amount: round2(t.amount),
        depositor: t.depositor, designation: t.designation || undefined, address: t.address, description: t.description,
      },
    }
  },
  locked: (d) => lockedConflict(`${d.taxPeriod}-01`, d.no),
  approve: (d) => {
    if (d.accountId) {
      const a = db.moneyAccounts.find((x) => x.id === d.accountId)
      if (a && accountRow(a).balance < d.amount - 0.004) return problem(409, `Not enough balance in ${a.provider} · ${a.accountNo} for this deposit.`)
    }
    return null
  },
  cancel: (d) => {
    const linked = db.vds.filter((v) => v.treasuryId === d.id && v.process !== "Cancelled")
    return linked.length ? problem(409, `VDS entries ${linked.map((v) => v.no).join(", ")} quote this challan — unlink them first.`) : null
  },
  diffFields: ["head", "taxPeriod", "challanNo", "challanDate", "mode", "bank", "bankBranch", "district", "amount", "description"],
  spec: treasurySpec,
  csv: [
    { key: "challanDate", label: "Challan date" }, { key: "challanNo", label: "Treasury challan no" }, { key: "no", label: "Internal no" }, { key: "head", label: "Head" },
    { key: "code", label: "Economic code" }, { key: "taxPeriod", label: "Tax period" }, { key: "bank", label: "Bank" }, { key: "bankBranch", label: "Branch" },
    { key: "district", label: "District" }, { key: "mode", label: "Mode" }, { key: "amount", label: "Amount" }, { key: "process", label: "Process" },
  ],
  csvName: "treasury-deposits",
})

/* ── VDS (Mushak 6.6) ──────────────────────────────────────────────────── */

const vdsDoc = (mode: VdsEntry["mode"], id: string): Sale | Purchase | undefined => (mode === "sales" ? db.sales : db.purchases).find((d) => d.id === id)
/** VAT subject to VDS on an invoice: sales → the invoice VAT (buyer is a withholding entity); purchases → VAT on the lines flagged VDS. */
function vdsBase(mode: VdsEntry["mode"], d: Sale | Purchase) {
  if (mode === "sales") return (d as Sale).vds ? { value: d.subtotal, vat: d.vat } : { value: 0, vat: 0 }
  const ls = d.lines.filter((l) => l.vds)
  return { value: round2(ls.reduce((s, l) => s + l.subtotal, 0)), vat: round2(ls.reduce((s, l) => s + l.vat, 0)) }
}
export function vdsEligible(mode: VdsEntry["mode"], excludeId?: string): VdsEligible[] {
  const docs = (mode === "sales" ? db.sales : db.purchases) as (Sale | Purchase)[]
  return docs.filter((d) => d.process === "Approved").flatMap((d) => {
    const b = vdsBase(mode, d)
    if (!b.vat) return []
    const withheld = round2(db.vds.filter((v) => v.docId === d.id && v.mode === mode && v.process !== "Cancelled" && v.id !== excludeId).reduce((s, v) => s + v.amount, 0))
    return [{ id: d.id, no: d.invoiceNo, challanNo: d.challanNo, date: d.issueDate, partyId: invoiceParty(d), partyName: "customerName" in d ? d.customerName : d.vendorName, value: b.value, vat: b.vat, withheld, remaining: round2(b.vat - withheld) }]
  }).sort((a, b) => b.date.localeCompare(a.date))
}
const vdsSpec: QuerySpec<VdsEntry> = {
  search: (v) => `${v.no} ${v.docNo} ${v.challanNo} ${v.partyName} ${v.partyBin} ${v.certificateNo ?? ""} ${v.treasuryChallan ?? ""}`,
  dateField: "certificateDate",
  facets: { process: (v) => v.process, mode: (v) => v.mode, party: (v) => v.partyId, period: (v) => v.taxPeriod },
  totals: ["amount", "docVat", "docValue"],
}
type VdsFields = Omit<VdsEntry, "id" | "no" | "process" | "createdAt" | "history">
export const vdsRoutes = lifecycle<VdsEntry, VdsFields>({
  entity: "vds", label: "VDS entry", list: () => db.vds, idPrefix: "vds", seq: "vds", noPrefix: "VDS",
  build: (body, self) => {
    const parsed = vdsInput.safeParse(body)
    if (!parsed.success) return { error: zodProblem(parsed.error) }
    const v = parsed.data
    if (self && (self.mode !== v.mode || self.docId !== v.docId)) return { error: problem(409, "A VDS entry cannot move to another invoice — create a new one.") }
    const d = vdsDoc(v.mode, v.docId)
    if (!d || d.process !== "Approved") return { error: invalid({ docId: ["notApproved"] }) }
    const el = vdsEligible(v.mode, self?.id).find((x) => x.id === d.id)
    if (!el) return { error: invalid({ docId: ["notVds"] }) }
    if (v.amount > el.remaining + 0.004) return { error: invalid({ amount: ["exceedsVds"] }) }
    if (v.certificateDate < d.issueDate) return { error: invalid({ certificateDate: ["beforeInvoice"] }) }
    if (v.certificateDate > TODAY) return { error: invalid({ certificateDate: ["future"] }) }
    const lock = lockedField(v.certificateDate, "certificateDate"); if (lock) return { error: lock }
    const t = v.treasuryId ? db.treasury.find((x) => x.id === v.treasuryId && x.head === "vds" && x.process !== "Cancelled") : undefined
    if (v.treasuryId && !t) return { error: invalid({ treasuryId: ["unknown"] }) }
    if (v.mode === "sales" && t) return { error: invalid({ treasuryId: ["purchaseOnly"] }) }
    const party = "customerId" in d ? db.customers.find((c) => c.id === d.customerId) : db.vendors.find((x) => x.id === (d as Purchase).vendorId)
    return {
      process: v.process, date: v.certificateDate,
      fields: {
        mode: v.mode, docId: d.id, docNo: d.invoiceNo, challanNo: d.challanNo, docDate: d.issueDate,
        partyId: invoiceParty(d), partyName: party?.name ?? "", partyBin: party?.bin ?? "", partyAddress: party?.address ?? "",
        docValue: el.value, docVat: el.vat, amount: round2(v.amount), certificateNo: v.certificateNo || undefined, certificateDate: v.certificateDate, taxPeriod: periodOf(v.certificateDate),
        treasuryId: t?.id, treasuryChallan: t?.challanNo, remark: v.remark || undefined, issuedBy: self?.issuedBy ?? "",
      },
    }
  },
  locked: (d) => lockedConflict(d.certificateDate, d.no),
  approve: (d) => {
    const el = vdsEligible(d.mode, d.id).find((x) => x.id === d.docId)
    if (!el || d.amount > el.remaining + 0.004) return problem(409, `${d.docNo} has only ${el?.remaining ?? 0} VAT left to withhold.`, { amount: ["exceedsVds"] })
    const inv = vdsDoc(d.mode, d.docId)!
    // the certificate settles part of what is owed on the invoice
    d.settled = round2(Math.min(d.amount, Math.max(0, inv.due)))
    inv.paid = round2(inv.paid + d.settled)
    inv.due = round2(inv.netTotal - inv.paid)
    return null
  },
  cancel: (d) => {
    const inv = vdsDoc(d.mode, d.docId)
    if (inv && d.settled) { inv.paid = round2(inv.paid - d.settled); inv.due = round2(inv.netTotal - inv.paid) }
    d.settled = 0
    return null
  },
  diffFields: ["amount", "certificateNo", "certificateDate", "treasuryChallan", "remark"],
  spec: vdsSpec,
  csv: [
    { key: "certificateDate", label: "Certificate date" }, { key: "no", label: "VDS No" }, { key: "mode", label: "Mode" }, { key: "certificateNo", label: "Certificate No" },
    { key: "docNo", label: "Invoice" }, { key: "challanNo", label: "Challan (6.3)" }, { key: "partyName", label: "Party" }, { key: "partyBin", label: "BIN" },
    { key: "docValue", label: "Value" }, { key: "docVat", label: "Invoice VAT" }, { key: "amount", label: "VAT deducted" }, { key: "taxPeriod", label: "Tax period" },
    { key: "treasuryChallan", label: "Treasury challan" }, { key: "process", label: "Process" },
  ],
  csvName: "vds",
  facetLabels: () => ({ party: Object.fromEntries([...db.customers, ...db.vendors].map((p) => [p.id, p.name])) }),
})
/** R6.3: SD-paid purchase lines and the six-month export window (`exclude` = the claim being edited). */
export const sdEligibleRoute = withAuth(null, async (req) => {
  const sp = new URL(req.url).searchParams
  await delay(60)
  return json(sdEligible({ purchases: db.purchases, sales: db.sales, adjustments: db.adjustments }, TODAY, sp.get("exclude") ?? undefined))
})
export const vdsEligibleRoute = withAuth(null, async (req) => {
  const sp = new URL(req.url).searchParams
  const mode = sp.get("mode") === "sales" ? "sales" : "purchase"
  await delay(60)
  return json(vdsEligible(mode, sp.get("exclude") ?? undefined))
})

/* ── VAT adjustments ───────────────────────────────────────────────────── */

type AdjFields = Omit<VatAdjustment, "id" | "no" | "process" | "createdAt" | "history">
export const adjustmentRoutes = lifecycle<VatAdjustment, AdjFields>({
  entity: "adjustment", label: "VAT adjustment", list: () => db.adjustments, idPrefix: "va", seq: "adjustment", noPrefix: "VA",
  build: (body, self) => {
    const parsed = adjustmentInput.safeParse(body)
    if (!parsed.success) return { error: zodProblem(parsed.error) }
    const a = parsed.data
    if (a.issueDate > TODAY) return { error: invalid({ issueDate: ["future"] }) }
    if (a.taxPeriod > CURRENT || a.taxPeriod < FIRST_RETURN) return { error: invalid({ taxPeriod: ["outOfRange"] }) }
    const lock = lockedField(`${a.taxPeriod}-01`, "taxPeriod"); if (lock) return { error: lock }
    // R6.3: SD on inputs of exported goods — linked, window-checked, amount computed from the purchase line
    let amount = round2(a.amount), sdExport: VatAdjustment["sdExport"]
    if (a.kind === "sdExport") {
      const r = sdExportLink(a, { purchases: db.purchases, sales: db.sales, adjustments: db.adjustments }, self?.id)
      if ("errors" in r) return { error: invalid(r.errors) }
      amount = r.amount; sdExport = r.link
    }
    return {
      process: a.process, date: a.issueDate,
      fields: { kind: a.kind, note: ADJUSTMENT_NOTE[a.kind], issueDate: a.issueDate, taxPeriod: a.taxPeriod, amount, description: a.description, reference: a.reference || undefined, sdExport, issuedBy: self?.issuedBy ?? "" },
    }
  },
  locked: (d) => lockedConflict(`${d.taxPeriod}-01`, d.no),
  // R6.3: re-check an SD claim on approval — another claim may have used the quantity since the draft was saved
  approve: (d) => {
    if (d.kind !== "sdExport" || !d.sdExport) return null
    const x = d.sdExport
    const r = sdExportLink({ purchaseId: x.purchaseId, itemId: x.itemId, qty: x.qty, saleId: x.saleId, issueDate: d.issueDate, taxPeriod: d.taxPeriod }, { purchases: db.purchases, sales: db.sales, adjustments: db.adjustments }, d.id)
    return "errors" in r ? invalid(r.errors) : null
  },
  diffFields: ["kind", "issueDate", "taxPeriod", "amount", "description", "reference"],
  spec: {
    search: (a) => `${a.no} ${a.description} ${a.reference ?? ""} ${a.sdExport ? `${a.sdExport.purchaseNo} ${a.sdExport.saleNo} ${a.sdExport.itemName}` : ""}`,
    dateField: "issueDate",
    facets: { process: (a) => a.process, kind: (a) => a.kind, period: (a) => a.taxPeriod },
    totals: ["amount"],
  },
  csv: [
    { key: "issueDate", label: "Date" }, { key: "no", label: "Adjustment No" }, { key: "kind", label: "Kind" }, { key: "note", label: "9.1 note" }, { key: "taxPeriod", label: "Tax period" },
    { key: "amount", label: "Amount" }, { key: "description", label: "Description" }, { key: "reference", label: "Reference" }, { key: "process", label: "Process" },
  ],
  csvName: "vat-adjustments",
})

/* ── Mushak 9.1 returns ────────────────────────────────────────────────── */

const findReturn = (period: string) => db.returns.find((r) => r.period === period)
function returnRow(r: VatReturn): VatReturnRow {
  const c = r.snapshot ?? computeReturn(db, r.period, r.manual)
  const due = returnDue(r.period, db.vatSettings)
  return { ...r, snapshot: undefined, due, netPayable: c.payableVat, deposited: c.depositedVat, closing: c.closingVat, late: !!r.submissionDate && r.submissionDate > due }
}
export function taxPeriods(): TaxPeriod[] {
  return periodsBetween(FIRST_RETURN, CURRENT).map((p) => {
    const r = findReturn(p)
    const due = returnDue(p, db.vatSettings)
    // R6.6: an approved / deemed Mushak 9.3 extension keeps an unfiled period "open" up to the allowed date
    const extendedTo = extensionFor(p, db.lateFilings, db.vatSettings, TODAY)
    const status = r?.status === "submitted" ? "submitted" : r ? "draft" : TODAY > (extendedTo ?? due) ? "overdue" : "open"
    return { period: p, due, status, returnId: r?.id, submittedAt: r?.submissionDate, locked: r?.status === "submitted", ...(extendedTo ? { extendedTo } : {}) }
  })
}
function returnView(period: string): ReturnView | null {
  const r = findReturn(period)
  if (!r) {
    if (!PERIOD_RE.test(period) || period < FIRST_RETURN || period > CURRENT) return null
    const computation = computeReturn(db, period)
    return { id: period, period, type: "original", activities: true, status: "draft", manual: EMPTY_MANUAL, createdAt: "", due: returnDue(period, db.vatSettings), netPayable: computation.payableVat, deposited: computation.depositedVat, closing: computation.closingVat, late: false, computation, live: true, notStarted: true, applications: applicationsOf(period) }
  }
  const computation = r.snapshot ?? computeReturn(db, period, r.manual)
  return { ...returnRow(r), computation, live: !r.snapshot, applications: applicationsOf(period) }
}
/** R6.6: the period's Mushak 9.3 (latest that is not refused) and 9.4 applications. */
function applicationsOf(period: string): NonNullable<ReturnView["applications"]> {
  const ret = findReturn(period)
  const lf = [...(db.lateFilings ?? [])].reverse().find((x) => x.period === period && x.status !== "rejected")
  const lr = lf ? lateFilingRow(lf, ret, db.vatSettings, TODAY) : undefined
  return {
    ...(lr ? { late: { id: lr.id, no: lr.no, state: lr.state, effectiveDate: lr.effectiveDate } } : {}),
    amendments: ret ? (db.returnAmendments ?? []).filter((a) => a.period === period).map((a) => { const x = amendmentRow(a, ret, db.returnAmendments, db.vatSettings, TODAY); return { id: x.id, no: x.no, state: x.state, direction: x.effect.direction } }) : [],
  }
}
function refundProblem(period: string, manual: VatReturn["manual"]) {
  if (!manual.refund) return null
  const avail = computeReturn(db, period, { ...manual, refund: false, refundVat: 0, refundSd: 0 })
  const errors: Record<string, string[]> = {}
  if (manual.refundVat > Math.max(0, avail.closingVat) + 0.004) errors["manual.refundVat"] = ["refundExceeds"]
  if (manual.refundSd > Math.max(0, avail.closingSd) + 0.004) errors["manual.refundSd"] = ["refundExceeds"]
  return has(errors) ? invalid(errors) : null
}
export const returnListRoutes = {
  GET: withAuth(null, async (req) => {
    const sp = new URL(req.url).searchParams
    if (!sp.get("sort")) sp.set("sort", "period.desc")
    const r = runQuery(db.returns.map(returnRow), sp, {
      search: (x) => `${x.period} ${periodLabel(x.period)} ${x.ackNo ?? ""}`,
      facets: { status: (x) => x.status, type: (x) => x.type },
      totals: ["netPayable", "deposited"],
    })
    if (sp.get("format") === "csv") {
      return csvResponse(toCSV(r.all, [
        { key: "period", label: "Tax period", get: (x) => periodLabel(x.period) }, { key: "type", label: "Return type" }, { key: "status", label: "Status" },
        { key: "submissionDate", label: "Submission date" }, { key: "due", label: "Due date" }, { key: "netPayable", label: "Net payable VAT (50)" },
        { key: "deposited", label: "VAT deposited (58)" }, { key: "closing", label: "Closing balance (65)" }, { key: "ackNo", label: "Acknowledgement" },
      ]), `vat-returns-${new Date().toISOString().slice(0, 10)}.csv`)
    }
    await delay()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { all, ...page } = r
    return json({ ...page, periods: taxPeriods() })
  }),
  POST: withAuth("doc.create", async (req, _ctx, user) => {
    const { period } = (await req.json().catch(() => ({}))) as { period?: string }
    if (!period || !PERIOD_RE.test(period)) return invalid({ period: ["required"] })
    if (period < FIRST_RETURN || period > CURRENT) return invalid({ period: ["outOfRange"] })
    if (findReturn(period)) return problem(409, `A return for ${periodLabel(period)} already exists.`)
    const prev = prevPeriod(period)
    if (prev >= FIRST_RETURN && findReturn(prev)?.status !== "submitted") return problem(409, `Submit the ${periodLabel(prev)} return first — returns are filed in order.`)
    const r: VatReturn = { id: period, period, type: "original", activities: true, status: "draft", manual: { ...EMPTY_MANUAL }, createdAt: new Date().toISOString(), history: [] }
    db.returns.push(r)
    history("vatReturn", r as unknown as LifeDoc, user.name, "created", undefined, undefined, `9.1 · ${periodLabel(period)}`, period)
    return json(returnView(period), { status: 201 })
  }),
}
type PCtx = { params: Promise<{ period: string }> }
export const returnDocRoutes = {
  GET: withAuth<PCtx>(null, async (_req, { params }) => {
    const { period } = await params
    await delay(200)
    const v = returnView(period)
    return v ? json(v) : problem(404, "Tax period not found")
  }),
  PUT: withAuth<PCtx>("doc.edit", async (req, { params }, user) => {
    const { period } = await params
    const r = findReturn(period)
    if (!r) return problem(404, `No return started for ${periodLabel(period)}`)
    if (r.status !== "draft") return problem(409, `The ${periodLabel(period)} return has been submitted — file an amended return in the NBR portal.`)
    const parsed = returnInput.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) return zodProblem(parsed.error)
    const d = parsed.data
    if (d.submissionDate && d.submissionDate <= periodEnd(period)) return invalid({ submissionDate: ["beforePeriodEnd"] })
    const rp = refundProblem(period, d.manual); if (rp) return rp
    const before = structuredClone(r)
    Object.assign(r, { type: d.type, amendReason: d.type === "amended" ? d.amendReason : undefined, activities: d.activities, submissionDate: d.submissionDate || undefined, manual: d.manual })
    const changes = diff(before, r, ["type", "activities", "submissionDate", "manual.interestVat", "manual.interestSd", "manual.penaltyLate", "manual.penaltyOther", "manual.refund", "manual.refundVat"])
    history("vatReturn", r as unknown as LifeDoc, user.name, "edited", undefined, changes, `9.1 · ${periodLabel(period)}`, period)
    return json(returnView(period))
  }),
  PATCH: withAuth<PCtx>("doc.approve", async (req, { params }, user) => {
    const { period } = await params
    const r = findReturn(period)
    if (!r) return problem(404, `No return started for ${periodLabel(period)}`)
    const body = (await req.json().catch(() => ({}))) as { action?: string }
    if (body.action !== "submit") return problem(400, "action must be submit")
    if (r.status === "submitted") return problem(409, `The ${periodLabel(period)} return was already submitted.`)
    if (TODAY <= periodEnd(period)) return problem(409, `The tax period ${periodLabel(period)} ends on ${periodEnd(period)} — the return can be submitted from the next day.`)
    const prev = prevPeriod(period)
    if (prev >= FIRST_RETURN && findReturn(prev)?.status !== "submitted") return problem(409, `Submit the ${periodLabel(prev)} return first.`)
    if (!r.submissionDate) return invalid({ submissionDate: ["required"] })
    if (r.submissionDate > TODAY) return invalid({ submissionDate: ["future"] })
    const rp = refundProblem(period, r.manual); if (rp) return rp
    const c = computeReturn(db, period, r.manual)
    const zone = db.vatSettings.zoneCode
    if (c.shortVat > 0 || c.shortSd > 0) {
      const parts = [c.shortVat > 0 ? `৳${c.shortVat.toLocaleString("en-IN")} VAT under ${economicCode("vat", zone)}` : "", c.shortSd > 0 ? `৳${c.shortSd.toLocaleString("en-IN")} SD under ${economicCode("sd", zone)}` : ""].filter(Boolean)
      return problem(409, `Deposit ${parts.join(" and ")} (TR-6) before submitting — note 58 must cover note 50.`)
    }
    if (r.type === "original" && r.submissionDate > returnDue(period, db.vatSettings)) r.type = "late"
    r.status = "submitted"
    r.snapshot = c
    r.submittedBy = user.name
    r.submittedAt = new Date().toISOString()
    r.ackNo = `NBR-91-${period.replace("-", "")}-${String(900_000 + db.returns.length * 1_117).padStart(7, "0")}`
    history("vatReturn", r as unknown as LifeDoc, user.name, "submitted", `Acknowledgement ${r.ackNo}`, undefined, `9.1 · ${periodLabel(period)}`, period)
    return json(returnView(period))
  }),
  DELETE: withAuth<PCtx>("doc.delete", async (_req, { params }, user) => {
    const { period } = await params
    const i = db.returns.findIndex((r) => r.period === period)
    if (i < 0) return problem(404, `No return started for ${periodLabel(period)}`)
    if (db.returns[i].status !== "draft") return problem(409, "Submitted returns cannot be deleted.")
    const [r] = db.returns.splice(i, 1)
    history("vatReturn", r as unknown as LifeDoc, user.name, "deleted", undefined, undefined, `9.1 · ${periodLabel(period)}`, period)
    return json({ ok: true })
  }),
}
type NCtx = { params: Promise<{ period: string; note: string }> }
/** GET /vat/returns/{period}/notes/{note} — the sub-form: documents behind a note (legacy sub-form crashed with HTTP 500, D-04). */
export const subFormRoute = withAuth<NCtx>(null, async (req, { params }) => {
  const { period, note } = await params
  const n = Number(note)
  const def = noteDef(n)
  if (!def) return problem(404, `Note ${note} does not exist on Mushak 9.1`)
  if (!PERIOD_RE.test(period) || period < FIRST_RETURN || period > CURRENT) return problem(404, "Tax period not found")
  const rows = subForm(db, period, n)
  if (new URL(req.url).searchParams.get("format") === "csv") {
    return csvResponse(toCSV(rows, [
      { key: "date", label: "Date" }, { key: "ref", label: "Document" }, { key: "party", label: "Party" }, { key: "bin", label: "BIN" },
      { key: "value", label: "Value" }, { key: "sd", label: "SD" }, { key: "vat", label: n >= 58 ? "Amount" : "VAT" }, { key: "note", label: "Reference" },
    ]), `mushak-9.1-${period}-note-${n}.csv`)
  }
  await delay(80)
  return json({ period, note: n, rows, total: { value: round2(rows.reduce((s, r) => s + r.value, 0)), sd: round2(rows.reduce((s, r) => s + (r.sd ?? 0), 0)), vat: round2(rows.reduce((s, r) => s + r.vat, 0)) } })
})

export const periodsRoute = withAuth(null, async () => json(taxPeriods()))

/** Compliance centre summary for one tax period. */
export const complianceRoute = withAuth(null, async (req) => {
  const sp = new URL(req.url).searchParams
  const period = sp.get("period") || CURRENT
  if (!PERIOD_RE.test(period) || period < FIRST_RETURN || period > CURRENT) return invalid({ period: ["outOfRange"] })
  const view = returnView(period)!
  const c = view.computation
  const inP = (d: string) => periodOf(d) === period
  const vdsToIssue = vdsEligible("purchase").filter((e) => inP(e.date) && e.remaining > 0.004)
  const vdsAwaited = vdsEligible("sales").filter((e) => inP(e.date) && e.remaining > 0.004 && db.customers.find((x) => x.id === e.partyId)?.vdsWithholder)
  const deposits = db.treasury.filter((t) => t.taxPeriod === period && t.process !== "Cancelled")
  await delay(150)
  return json({
    period, due: returnDue(period, db.vatSettings), daysLeft: daysBetween(TODAY, returnDue(period, db.vatSettings)), status: view.status, notStarted: !findReturn(period), locked: view.status === "submitted",
    submissionDate: view.submissionDate, ackNo: view.ackNo,
    computation: { outputVat: c.outputVat, inputVat: c.inputVat, increasing: c.increasing, decreasing: c.decreasing, netVat: c.netVat, payableVat: c.payableVat, payableSd: c.payableSd, depositedVat: c.depositedVat, shortVat: c.shortVat, shortSd: c.shortSd, closingVat: c.closingVat, openingVat: c.openingVat, drafts: c.drafts },
    deposits: { count: deposits.length, amount: round2(deposits.filter((t) => t.process === "Approved").reduce((s, t) => s + t.amount, 0)), pending: deposits.filter((t) => t.process === "Created").length },
    vds: { toIssue: vdsToIssue.length, toIssueAmount: round2(vdsToIssue.reduce((s, e) => s + e.remaining, 0)), issueBy: vdsCertificateDue(period, db.vatSettings, view.submissionDate), awaited: vdsAwaited.length, awaitedAmount: round2(vdsAwaited.reduce((s, e) => s + e.remaining, 0)) },
    periods: taxPeriods(),
  })
})

/* ── VAT settings ──────────────────────────────────────────────────────── */

const PROFILE_FIELDS = ["segment", "exportOriented", "importerType", "filerCategory", "bondLicenseNo", "bondLicenseExpiry", "associationNo", "holidays"]

export const vatSettingsRoutes = {
  GET: withAuth(null, async () => json(db.vatSettings)),
  PUT: withAuth("settings.manage", async (req, _ctx, user) => {
    const parsed = vatSettingsInput.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) return zodProblem(parsed.error)
    const before = { ...db.vatSettings }
    db.vatSettings = { zoneCode: parsed.data.zoneCode, profile: parsed.data.profile ?? db.vatSettings.profile, updatedAt: new Date().toISOString(), updatedBy: user.name }
    recordAudit({ actor: user.name, entity: "vatSettings", ref: "VAT settings", action: "updated", changes: diff(before, db.vatSettings, ["zoneCode", ...PROFILE_FIELDS.map((f) => `profile.${f}`)]) })
    return json(db.vatSettings)
  }),
}

/* ── Mushak 6.10 (purchases / sales above Tk 2 lakh) ───────────────────── */

export function mushak610(from: string, to: string) {
  const inR = (d: string) => d >= from && d <= to
  const row = (d: Sale | Purchase, sl: number) => {
    const sale = "customerId" in d
    const p = sale ? db.customers.find((c) => c.id === d.customerId) : db.vendors.find((v) => v.id === (d as Purchase).vendorId)
    return { sl, id: d.id, date: d.issueDate, no: d.invoiceNo, challanNo: d.challanNo, party: p?.name ?? "", address: p?.address ?? "", bin: p?.bin ?? "", value: d.subtotal, vat: d.vat, total: d.netTotal }
  }
  const pick = <T extends Sale | Purchase>(rows: T[]) => rows.filter((d) => d.process === "Approved" && inR(d.issueDate) && d.netTotal > M610_LIMIT).sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.invoiceNo.localeCompare(b.invoiceNo)).map((d, i) => row(d, i + 1))
  const purchases = pick(db.purchases), sales = pick(db.sales)
  const sum = (rows: ReturnType<typeof row>[]) => ({ value: round2(rows.reduce((s, r) => s + r.value, 0)), vat: round2(rows.reduce((s, r) => s + r.vat, 0)), total: round2(rows.reduce((s, r) => s + r.total, 0)) })
  return { from, to, limit: M610_LIMIT, company: { name: company.name, address: company.address, bin: company.bin }, purchases, sales, totals: { purchases: sum(purchases), sales: sum(sales) } }
}
