import { db } from "@/lib/mock/db"
import { recordAudit } from "@/lib/mock/audit"
import type { Realisation } from "@/lib/types"
import { json, problem, ruleResponse, withAuth } from "../../../_lib"
import { buildRealisation, realisationNotes, realisationRemovedNotes, realisableRule, parseRealisation } from "../../../_docs"

type Ctx = { params: Promise<{ id: string }> }

/**
 * R6.2 (RMG): export proceeds realised through the bank (PRC). Only approved export invoices with an FC value;
 * the total realised may not exceed the invoice FC value (+0.5 % rounding); the date must fall between the invoice
 * date and today. Returns the updated sale. The rules live in _docs.ts, so the API's native sale module answers
 * with the same 409/422 and writes the same history and audit entries.
 */
export const POST = withAuth<Ctx>("doc.edit", async (req, { params }, user) => {
  const { id } = await params
  const sale = db.sales.find((x) => x.id === id)
  if (!sale) return problem(404, "Sale not found")
  const allowed = realisableRule(sale)
  if (allowed) return ruleResponse(allowed)
  const parsed = parseRealisation(sale, await req.json().catch(() => ({})))
  if ("status" in parsed) return ruleResponse(parsed)
  const at = new Date().toISOString()
  const r: Realisation = buildRealisation(sale, parsed.data, parsed.prc, user.name, at)
  const notes = realisationNotes(sale.export!, r)
  ;(sale.export!.realisations ??= []).push(r)
  ;(sale.history ??= []).push({ at, by: user.name, action: "edited", note: notes.history })
  recordAudit({ actor: user, entity: "sale", entityId: sale.id, ref: sale.invoiceNo, action: "realised", note: notes.audit })
  return json(sale, { status: 201 })
})

/** DELETE ?rid= — remove a realisation entered by mistake (approvers / admin). */
export const DELETE = withAuth<Ctx>("doc.approve", async (req, { params }, user) => {
  const { id } = await params
  const sale = db.sales.find((x) => x.id === id)
  const rid = new URL(req.url).searchParams.get("rid")
  const list = sale?.export?.realisations
  const i = list?.findIndex((r) => r.id === rid) ?? -1
  if (!sale || !list || i < 0) return problem(404, "Realisation not found")
  const [r] = list.splice(i, 1)
  const at = new Date().toISOString()
  const notes = realisationRemovedNotes(sale.export!, r)
  ;(sale.history ??= []).push({ at, by: user.name, action: "edited", note: notes.history })
  recordAudit({ actor: user, entity: "sale", entityId: sale.id, ref: sale.invoiceNo, action: "deleted", note: notes.audit })
  return json(sale)
})
