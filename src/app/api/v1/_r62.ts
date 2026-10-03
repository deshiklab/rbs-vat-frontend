/**
 * R6.2 shared logic for the mock API (the PostgreSQL build runs the same code through the compat layer, except backups,
 * which the native backup module owns).
 *  - RMG: UD / UP register with bond licence watch-list, subcontracting (Mushak 6.4) register
 *  - NBR enlistment: bulk master-data import, database backups (GO 16/Mushak/2019: at least two a day)
 */
import { BACKUP_FORMAT, BACKUP_KEEP, BACKUP_SLOTS, dhakaDayOf, lastSlot, nextSlot } from "@/lib/backup-schedule"
import { db } from "@/lib/mock/db"
import { auditStore } from "@/lib/mock/audit"
import { userStore } from "@/lib/mock/users"
import { COMPANY } from "@/lib/company"
import { bondRows, daysBetween, udRow, UD_WARN_PCT } from "@/lib/rmg"
import { itemInput, partyInput, type UdInput } from "@/lib/schemas"
import type {
  BackupRow, BackupStatus, Batch, ImportEntity, ImportIssue, ImportResult, Item, Party, SubconProcess, SubconRegister, SubconRow,
  UdLine, UdRegister, RestoreDrill,
} from "@/lib/types"
import type { User } from "@/lib/auth/roles"
import { round2 } from "@/lib/vat"
import { badUnit } from "@/lib/mock/units"
import { buildItem, newItemId } from "./_items"
import { newPartyId } from "./_parties"

/* ── UD / UP register ─────────────────────────────────────────────────────── */

export function udRegister(today: string, customerId?: string): UdRegister {
  const rows = db.uds
    .filter((u) => !customerId || u.customerId === customerId)
    .map((u) => udRow(u, db.sales, today))
    .sort((a, b) => b.date.localeCompare(a.date) || a.no.localeCompare(b.no))
  const p = db.vatSettings.profile
  const own = p && (p.bondLicenseNo || p.segment === "rmgDirect" || p.segment === "rmgComposite")
    ? { name: COMPANY.name, licenceNo: p.bondLicenseNo, expiry: p.bondLicenseExpiry } : null
  const bonds = bondRows(own, db.customers.filter((c) => c.active !== false), today)
  return {
    rows, bonds,
    totals: {
      active: rows.filter((r) => r.state === "ok" || r.state === "warn").length,
      warn: rows.filter((r) => r.state === "warn" || r.state === "exhausted").length,
      over: rows.filter((r) => r.state === "over").length,
      expired: rows.filter((r) => r.state === "expired").length,
    },
  }
}
export { UD_WARN_PCT }

/** Business rules for create / update: the customer must be an exporter, items must exist, numbers unique per customer. */
export function udCheck(d: UdInput & { lines: { itemId: string; qty: number; value?: number }[] }, selfId?: string): { errors?: Record<string, string[]>; customer?: Party; lines?: UdLine[] } {
  const errors: Record<string, string[]> = {}
  const customer = db.customers.find((c) => c.id === d.customerId)
  if (!customer) errors.customerId = ["unknown"]
  else if (!customer.exporterType) errors.customerId = ["notExporter"]
  const no = d.no.trim().toUpperCase()
  if (db.uds.some((u) => u.id !== selfId && u.customerId === d.customerId && u.no.trim().toUpperCase() === no)) errors.no = ["duplicate"]
  const lines: UdLine[] = []
  d.lines.forEach((l, i) => {
    const it = db.items.find((x) => x.id === l.itemId)
    if (!it) { errors[`lines.${i}.itemId`] = ["unknown"]; return }
    lines.push({ itemId: it.id, name: it.name, hsCode: it.hsCode, uom: it.unit, qty: l.qty, ...(l.value != null && Number.isFinite(l.value) ? { value: Math.round(l.value * 100) / 100 } : {}) })
  })
  return Object.keys(errors).length ? { errors } : { customer, lines }
}

/** Quantity of a UD line already supplied on approved / draft invoices (a UD whose lines are in use cannot be deleted). */
export const udInUse = (udNo: string, customerId: string) =>
  db.sales.some((s) => s.customerId === customerId && s.process !== "Cancelled" && s.export?.deemed && (s.export.udNo ?? "").trim().toUpperCase() === udNo.trim().toUpperCase())

/* ── Subcontracting (Mushak 6.4) register ─────────────────────────────────── */

export const SUBCON_OVERDUE_DAYS = 30

export function subconRegister(from: string, to: string, today: string, overdueDays = SUBCON_OVERDUE_DAYS): SubconRegister {
  const rows: SubconRow[] = db.batches
    .filter((b) => b.mode === "contractual" && b.issueDate >= from && b.issueDate <= to)
    .map((b) => subconRow(b, today, overdueDays))
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.no.localeCompare(a.no))
  const live = rows.filter((r) => r.status === "atContractor" || r.status === "partial" || r.status === "overdue")
  return {
    from, to, overdueDays, rows,
    totals: {
      atContractor: live.length,
      pendingValue: round2(live.reduce((a, r) => a + r.materialValue * (r.issued ? r.pending / r.issued : 0), 0)),
      overdue: rows.filter((r) => r.status === "overdue").length,
      returned: rows.filter((r) => r.status === "returned").length,
    },
  }
}

function subconRow(b: Batch, today: string, overdueDays: number): SubconRow {
  const issued = b.totalIssue, received = b.totalReceive, damaged = b.totalDamage
  const pending = Math.max(0, round2(issued - received - damaged))
  const end = b.receivedAt ? b.receivedAt.slice(0, 10) : today
  const days = Math.max(0, daysBetween(b.issueDate, end))
  const status: SubconRow["status"] = b.process === "Cancelled" ? "cancelled" : b.process === "Created" ? "draft"
    : b.receivedAt && pending <= 1e-9 ? "returned"
    : days > overdueDays ? "overdue"
    : received > 0 ? "partial" : "atContractor"
  return {
    id: b.id, no: b.no, issueDate: b.issueDate, receiveDate: b.receivedAt?.slice(0, 10) ?? b.receiveDate, vendorId: b.vendorId,
    vendorName: b.vendorName ?? "", vendorBin: b.vendorBin ?? "", process: (b.jobProcess ?? "manufacture") as SubconProcess, state: b.process,
    materialValue: b.materialValue, value: b.value, issued, received, damaged, pending, days, status,
  }
}

/* ── Bulk import (items, customers, vendors) ──────────────────────────────── */

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim())
const num = (v: unknown, dflt: number) => { const s = str(v).replace(/,/g, ""); if (!s) return dflt; const n = Number(s); return Number.isFinite(n) ? n : NaN }
const bool = (v: unknown, dflt: boolean) => { const s = str(v).toLowerCase(); return !s ? dflt : !["0", "no", "false", "n", "inactive", "না"].includes(s) }
const GROUPS: Record<string, Item["group"]> = { raw: "Raw Material", "raw material": "Raw Material", consumable: "Consumable", packing: "Packing Materials", "packing materials": "Packing Materials", "packing material": "Packing Materials", finished: "Finished Goods", "finished goods": "Finished Goods" }

/** Units are matched case-insensitively against the Units master ("pcs" → "Pcs"). */
const unitCode = (u: string) => db.units.find((x) => x.code.toLowerCase() === u.toLowerCase())?.code ?? u
/** Map one spreadsheet row (header names already normalised to field names) to the item create payload. */
function itemPayload(r: Record<string, unknown>) {
  const hs = str(r.hsCode).replace(/\D/g, "")
  return {
    name: str(r.name), hsCode: hs.length === 10 ? hs.slice(0, 8) : hs, group: GROUPS[str(r.group).toLowerCase()] ?? str(r.group),
    unit: unitCode(str(r.unit)), sku: str(r.sku).toUpperCase(),
    purchasePrice: num(r.purchasePrice, 0), salePrice: num(r.salePrice, 0), vatRate: num(r.vatRate, 15), sdRate: num(r.sdRate, 0),
    reorderLevel: num(r.reorderLevel, 0), active: bool(r.active, true),
  }
}
function partyPayload(r: Record<string, unknown>) {
  const mode = str(r.mode) || "Local"
  const ex = str(r.exporterType).toLowerCase()
  return {
    name: str(r.name), mode: mode[0].toUpperCase() + mode.slice(1).toLowerCase(), bin: str(r.bin), country: str(r.country), mobile: str(r.mobile),
    email: str(r.email), contactPerson: str(r.contactPerson), address: str(r.address), active: bool(r.active, true),
    exporterType: ex === "direct" || ex === "deemed" ? ex : "", bondLicenseNo: str(r.bondLicenseNo), bondLicenseExpiry: str(r.bondLicenseExpiry), associationNo: str(r.associationNo),
  }
}

/**
 * Validates every row; rows that already exist (same SKU / same BIN or name) are skipped as duplicates, not errors.
 * All-or-nothing: with any issue nothing is created. dryRun only reports.
 */
export function bulkImport(entity: ImportEntity, rows: Record<string, unknown>[], dryRun: boolean, actor: User,
  audit: (e: { entity: "item" | "customer" | "vendor" | "import"; entityId?: string; ref: string; note?: string }) => void): ImportResult {
  const issues: ImportIssue[] = []
  const toCreate: (() => void)[] = []
  let duplicates = 0
  const seen = new Set<string>()
  rows.forEach((raw, i) => {
    const row = i + 2 // spreadsheet row number (row 1 = header)
    if (entity === "items") {
      const p = itemPayload(raw)
      const parsed = itemInput.safeParse(p)
      if (!parsed.success) { for (const is of parsed.error.issues) issues.push({ row, field: is.path.join(".") || "_", message: is.message }); return }
      const d = parsed.data
      const key = d.sku.toLowerCase()
      if (seen.has(key)) { issues.push({ row, field: "sku", message: "duplicateInFile" }); return }
      seen.add(key)
      if (badUnit(d.unit)) { issues.push({ row, field: "unit", message: "unknownUnit" }); return }
      if (db.items.some((x) => x.sku.toLowerCase() === key)) { duplicates++; return }
      toCreate.push(() => {
        // the same stored shape the item form produces (R5.2: shared with the native handlers through _items.ts)
        const it = buildItem(d, d.name.split(" ")[0], newItemId(String(i)))
        db.items.push(it)
        audit({ entity: "item", entityId: it.id, ref: `${it.sku} · ${it.name}`, note: "Bulk import" })
      })
    } else {
      const k = entity === "customers" ? "customer" : "vendor"
      const parsed = partyInput.safeParse(partyPayload(raw))
      if (!parsed.success) { for (const is of parsed.error.issues) issues.push({ row, field: is.path.join(".") || "_", message: is.message }); return }
      const d = parsed.data
      if (k === "customer" && d.mode === "Non-registered") { issues.push({ row, field: "mode", message: "customerMode" }); return }
      const name = d.name.toUpperCase(), bin = d.bin.replace(/^NID /, "")
      const key = bin ? `b:${bin}` : `n:${name}`
      if (seen.has(key) || seen.has(`n:${name}`)) { issues.push({ row, field: bin ? "bin" : "name", message: "duplicateInFile" }); return }
      seen.add(key); seen.add(`n:${name}`)
      const coll = k === "customer" ? db.customers : db.vendors
      if (coll.some((p) => (bin && p.bin.replace(/^NID /, "") === bin) || p.name.trim().toUpperCase() === name)) { duplicates++; return }
      toCreate.push(() => {
        const { exporterType, bondLicenseNo, bondLicenseExpiry, associationNo, ...rest } = d
        const p: Party = {
          ...rest, name, id: newPartyId(k, String(i)), kind: k,
          bin: d.mode === "Non-registered" && d.bin && !d.bin.startsWith("NID ") ? `NID ${d.bin}` : d.bin,
          country: d.mode === "Foreign" ? d.country : undefined,
          exporterType: exporterType || undefined, bondLicenseNo: bondLicenseNo || undefined, bondLicenseExpiry: bondLicenseExpiry || undefined, associationNo: associationNo || undefined,
        }
        coll.push(p)
        audit({ entity: k, entityId: p.id, ref: p.name, note: "Bulk import" })
      })
    }
  })
  const valid = rows.length - new Set(issues.map((x) => x.row)).size
  const ok = issues.length === 0
  if (ok && !dryRun && toCreate.length) {
    toCreate.forEach((f) => f())
    audit({ entity: "import", ref: `${entity} · ${toCreate.length} created`, note: `${rows.length} rows, ${duplicates} already on file (skipped)` })
  }
  void actor
  return { entity, dryRun, total: rows.length, valid, created: ok && !dryRun ? toCreate.length : 0, duplicates, issues: issues.slice(0, 500) }
}

/* ── Backups (mock: in memory; the PostgreSQL build stores them in the backups table) ── */

export { BACKUP_KEEP, BACKUP_SLOTS, lastSlot, nextSlot } from "@/lib/backup-schedule"
interface Stored extends BackupRow { data: Uint8Array }
const bstore = (globalThis as unknown as { __dzBackups?: { rows: Stored[]; seq: number } }).__dzBackups ??= { rows: [], seq: 0 }

async function sha256(b: Uint8Array) {
  const h = await crypto.subtle.digest("SHA-256", b as unknown as ArrayBuffer)
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("")
}
async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip")
  const out = new Blob([text]).stream().pipeThrough(cs)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

export function snapshotTables(): Record<string, unknown[]> {
  const t: Record<string, unknown[]> = {}
  for (const [k, v] of Object.entries(db)) if (Array.isArray(v)) t[k] = v
  t.auditEvents = auditStore.events
  t.users = userStore.users
  return t
}

export async function createBackup(kind: "scheduled" | "manual", by: string, slot: string): Promise<BackupRow> {
  const tables = snapshotTables()
  const at = new Date().toISOString()
  const data = await gzip(JSON.stringify({ format: BACKUP_FORMAT, at, company: COMPANY.name, tables, settings: { vat: db.vatSettings, accounting: db.accountingConfig } }))
  const row: Stored = {
    id: `bk${++bstore.seq}`, at, kind, slot, by, size: data.byteLength, sha256: await sha256(data),
    tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), data,
  }
  bstore.rows.unshift(row)
  bstore.rows.splice(BACKUP_KEEP)
  return strip(row)
}
const strip = ({ data, ...r }: Stored): BackupRow => (void data, r)

/** Scheduled backups run lazily in the mock: the first request after a slot takes the slot's backup. */
export async function ensureScheduled() {
  const { slot } = lastSlot()
  if (!bstore.rows.some((r) => r.slot === slot && r.kind === "scheduled")) await createBackup("scheduled", "System", slot)
}

export function backupStatus(): BackupStatus {
  const today = new Date(Date.now() + 6 * 36e5).toISOString().slice(0, 10)
  const rows = bstore.rows.map(strip)
  return {
    timezone: "Asia/Dhaka", schedule: [...BACKUP_SLOTS], retention: BACKUP_KEEP, storage: "memory",
    today: rows.filter((r) => dhakaDayOf(r.at) === today).length,
    next: nextSlot(), last: rows[0], rows,
    drill: MOCK_DRILL,
  }
}
/**
 * R6.3: the PostgreSQL build records each restore drill (api/dist/restore.js --record); the in-memory mock shows
 * the shape of a passed drill so the Settings → Backups card can be reviewed without a database.
 */
const MOCK_DRILL: RestoreDrill = {
  at: "2026-09-21T03:12:40.000Z", ok: true, backupId: "bk58", backupAt: "2026-09-20T20:00:00.000Z",
  sha256: "4f1c9a7be2d0583e6a91c4d7f0b2e8a35c6d9e1f0a7b4c2d8e5f3a6b9c0d1e2f", target: "127.0.0.1:5432/dizivat_restore_drill", ms: 21_480,
  tables: 9, rows: 3_412, documents: 1_386, auditChain: "ok", boot: "ok", mismatches: [], by: "CI restore drill (GitHub Actions)",
}
export const backupData = (id: string) => bstore.rows.find((r) => r.id === id)
export async function verifyBackup(id: string) {
  const r = backupData(id)
  if (!r) return null
  const h = await sha256(r.data)
  return { id, ok: h === r.sha256 && r.data.byteLength === r.size, sha256: h, size: r.data.byteLength, checkedAt: new Date().toISOString() }
}
