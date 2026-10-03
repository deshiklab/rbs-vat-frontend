import { addHistory, db, postStock } from "@/lib/mock/db"
import { csvResponse, delay, runQuery, toCSV } from "@/lib/mock/query"
import type { Sale } from "@/lib/types"
import { deny, json, ruleResponse, withAuth } from "../_lib"
import { parseSale } from "../_r3"
import { saleCategory, saleCsvColumns, saleCsvRows, saleFacetLabels, saleIdentity, saleSpec, saleStockRule } from "../_docs"

export const GET = withAuth(null, async (req) => {
  const sp = new URL(req.url).searchParams
  if (!sp.get("sort")) sp.set("sort", "createdAt.desc")
  // R3: goods (default, incl. exports) and service sales are separate lists; ?category=service | all; ?trade=export,deemed = exports
  const r = runQuery(saleCategory(sp, db.sales), sp, saleSpec)
  if (sp.get("format") === "csv")
    return csvResponse(toCSV(saleCsvRows(r.all, sp.get("ids")), saleCsvColumns), `sales-${new Date().toISOString().slice(0, 10)}.csv`)
  await delay()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { all, ...page } = r
  return json({ ...page, facetLabels: saleFacetLabels() })
})

export const POST = withAuth("doc.create", async (req, _ctx, user) => {
  const r = parseSale(await req.json().catch(() => ({})))
  if ("status" in r) return ruleResponse(r)
  const { data: d, fields } = r
  if (d.process === "Approved") {
    const no = deny(user, "doc.approve"); if (no) return no
    const short = saleStockRule(fields.lines, fields.branchId, undefined, 422); if (short) return ruleResponse(short)
  }
  const sale: Sale = {
    ...fields,
    ...saleIdentity(d.category ?? "goods", d.issueDate),
    createdAt: new Date().toISOString(),
    process: "Created",
    history: [],
  }
  addHistory(sale, user.name, "created")
  if (d.process === "Approved") { sale.process = "Approved"; postStock("sale", sale.lines, 1); addHistory(sale, user.name, "approved") }
  db.sales.push(sale)
  return json(sale, { status: 201 })
})
