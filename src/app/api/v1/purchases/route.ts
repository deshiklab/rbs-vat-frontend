import { addHistory, db, postStock } from "@/lib/mock/db"
import { buildPurchaseFields } from "@/lib/mock/build"
import { csvResponse, delay, runQuery, toCSV } from "@/lib/mock/query"
import type { Purchase } from "@/lib/types"
import { deny, json, ruleResponse, withAuth } from "../_lib"
import { parsePurchase, purchaseCategory, purchaseCsvColumns, purchaseCsvRows, purchaseFacetLabels, purchaseIdentity, purchaseSpec } from "../_docs"

export const GET = withAuth(null, async (req) => {
  const sp = new URL(req.url).searchParams
  if (!sp.get("sort")) sp.set("sort", "createdAt.desc")
  // R2: goods (default) and service purchases are separate lists; ?category=service | all
  const r = runQuery(purchaseCategory(sp, db.purchases), sp, purchaseSpec)
  if (sp.get("format") === "csv")
    return csvResponse(toCSV(purchaseCsvRows(r.all, sp.get("ids")), purchaseCsvColumns), `purchases-${new Date().toISOString().slice(0, 10)}.csv`)
  await delay()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { all, ...page } = r
  return json({ ...page, facetLabels: purchaseFacetLabels() })
})

export const POST = withAuth("doc.create", async (req, _ctx, user) => {
  const parsed = parsePurchase(await req.json().catch(() => ({})))
  if ("status" in parsed) return ruleResponse(parsed)
  const { data: d, vendor: v } = parsed
  if (d.process === "Approved") { const no = deny(user, "doc.approve"); if (no) return no }
  const p: Purchase = {
    ...buildPurchaseFields(d, v),
    ...purchaseIdentity(d.category ?? "goods", d.issueDate),
    createdAt: new Date().toISOString(),
    process: "Created",
    history: [],
  }
  addHistory(p, user.name, "created")
  // Stock is received on approval only (drafts do not move stock)
  if (d.process === "Approved") { p.process = "Approved"; postStock("purchase", p.lines, 1); addHistory(p, user.name, "approved") }
  db.purchases.push(p)
  return json(p, { status: 201 })
})
