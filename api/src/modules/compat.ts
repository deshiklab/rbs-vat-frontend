/**
 * Compat layer (R5.1): the ~70 mock route modules not yet ported run unchanged inside NestJS.
 * Auth comes from the sessions table (via the session-user shim), and after every request the shared state is
 * saved to PostgreSQL (`compat_state` JSONB + forwarded audit events) in one transaction — so documents survive
 * restarts and redeploys. Registered last: native controllers always win.
 */
import { createHash } from "node:crypto"
import { All, Controller, Inject, Injectable, Req, Res } from "@nestjs/common"
import type { Request, Response } from "express"
import { SessionService } from "../common/auth"
import { isHttps } from "../common/http"
import { withStateLock } from "../common/lock"
import { lockState } from "../common/state-guard"
import { compatCtx } from "../compat/session-user.shim"
import { db } from "../db/client"
import { compatState } from "../db/schema"
import { compat, G, type TrashEntry } from "../state"
import { AuditService } from "./audit"
import { UsersService } from "./identity"
import { deltaEmpty } from "../common/writeback"
import { applyItemDelta, applyMasterDelta, commitItemDelta, commitMasterDelta, itemDelta, masterDelta } from "./items"
import { applyPartyDelta, commitPartyDelta, partyDelta } from "./parties"
import { applyNoteDelta, commitNoteDelta, noteDelta } from "./notes"
import { applyPurchaseDelta, commitPurchaseDelta, purchaseDelta } from "./purchases"
import { applySaleDelta, commitSaleDelta, saleDelta } from "./sales"
import { applyStockDelta, commitStockDelta, stockDelta } from "./stock"

type Handler = (req: globalThis.Request, ctx: { params: Promise<Record<string, string>> }) => Promise<globalThis.Response> | globalThis.Response
interface Route { pattern: RegExp; names: string[]; statics: number; mod: Record<string, unknown> }

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "expect", "te", "trailer", "proxy-connection"])

/** The JSONB document saved for the unported modules (units, parties, items, master items, the stock documents,
 *  the sales invoices, the purchases and both note families have their own tables). */
export function compatSnapshot() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { units, customers, vendors, items, masterItems, transfers, damages, sales, purchases, creditNotes, debitNotes, ...rest } = G.__dzDb!
  // R5.2/R5.3: a deleted party, sale or purchase is a `deleted_at` row, so the undo buffer keeps the rest only
  const kept = rest as { trash?: TrashEntry[] }
  kept.trash = (kept.trash ?? []).filter((t) => t.kind !== "customer" && t.kind !== "vendor" && t.kind !== "sale"
    && t.kind !== "purchase")
  return JSON.stringify({ db: rest, notifRead: G.__dzUsers!.notifRead })
}

let lastSaved = ""
export const markSaved = (json: string) => { lastSaved = createHash("sha1").update(json).digest("hex") }

@Injectable()
export class CompatService {
  private routes: Route[] | null = null

  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  /** Same matching as the static demo runtime (src/lib/demo/runtime.ts): static segments beat dynamic ones. */
  private table(): Route[] {
    return (this.routes ??= compat().routeModules.map(([path, mod]) => {
      const segs = path.split("/").filter(Boolean)
      const names: string[] = []
      const src = segs.map((s) => {
        const m = /^\[(\.\.\.)?(.+)\]$/.exec(s)
        if (!m) return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        names.push(m[2])
        return m[1] ? "(.+)" : "([^/]+)"
      }).join("/")
      return { pattern: new RegExp(`^/${src}/?$`), names, statics: segs.filter((s) => !s.startsWith("[")).length, mod }
    }).sort((a, b) => b.statics - a.statics || a.names.length - b.names.length))
  }

  get size() { return compat().routeModules.length }

  async handle(req: Request, res: Response) {
    const url = new URL(req.originalUrl, `${isHttps(req) ? "https" : "http"}://${req.headers.host ?? "localhost"}`)
    const path = url.pathname.replace(/^\/api\/v1/, "") || "/"
    let route: Route | undefined, m: RegExpExecArray | null = null
    for (const r of this.table()) { m = r.pattern.exec(path); if (m) { route = r; break } }
    if (!route || !m) return problem(res, 404, "Not found")
    const fn = route.mod[req.method.toUpperCase()] as Handler | undefined
    if (typeof fn !== "function") return problem(res, 405, `Method ${req.method} not allowed`)
    const params: Record<string, string> = {}
    route.names.forEach((n, i) => { params[n] = decodeURIComponent(m![i + 1]) })

    const s = await this.sessions.resolve(req)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (v != null && !HOP.has(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v)
    const body = req.method !== "GET" && req.method !== "HEAD" && Buffer.isBuffer(req.body) && req.body.length ? new Uint8Array(req.body) : undefined
    const webReq = new globalThis.Request(url, { method: req.method, headers, body })

    const out = await withStateLock(async () => {
      let r: globalThis.Response
      try {
        r = await compatCtx.run(
          { user: s?.user ?? null, session: s ? { uid: s.token.uid, exp: s.token.exp, iat: s.token.iat } : null, me: (u) => this.users.meFor(u) },
          () => fn(webReq, { params: Promise.resolve(params) }),
        )
      } catch (e) {
        console.error("[compat]", req.method, path, e)
        r = globalThis.Response.json({ type: "about:blank", title: e instanceof Error ? e.message : "Internal error", status: 500 }, { status: 500, headers: { "content-type": "application/problem+json" } })
      }
      await this.persist()
      return r
    })

    res.status(out.status)
    out.headers.forEach((v, k) => { if (k !== "set-cookie" && k !== "content-length" && k !== "content-encoding") res.setHeader(k, v) })
    for (const c of out.headers.getSetCookie()) res.append("Set-Cookie", c)
    res.end(Buffer.from(await out.arrayBuffer()))
  }

  /** Inside the lock: saves the snapshot if it changed, together with any audit events the handler recorded and
   *  any row of a ported collection a compat handler touched (R5.2: the bulk import creates customers, vendors and
   *  SKUs, and approving a document moves an item's counters; R5.3: a restored backup puts stock documents back and
   *  a bank file posts proceeds onto an export invoice, a restored backup puts purchases back — all still through
   *  the in-memory world). */
  async persist() {
    const json = compatSnapshot()
    const hash = createHash("sha1").update(json).digest("hex")
    const parts = partyDelta(), its = itemDelta(), masters = masterDelta(), stock = stockDelta(), sold = saleDelta()
    const bought = purchaseDelta(), noted = noteDelta()
    if (hash === lastSaved && !this.audit.hasPending() && deltaEmpty(parts) && deltaEmpty(its) && deltaEmpty(masters)
      && deltaEmpty(stock) && deltaEmpty(sold) && deltaEmpty(bought)
      && deltaEmpty(noted.credit) && deltaEmpty(noted.debit)) return
    await db.transaction(async (tx) => {
      await lockState(tx) // cross-process: never overwrite a newer instance's re-seed with this process's state
      await this.audit.forwardPending(tx)
      await applyPartyDelta(tx, parts)
      await applyItemDelta(tx, its)
      await applyMasterDelta(tx, masters)
      await applyStockDelta(tx, stock)
      await applySaleDelta(tx, sold)
      await applyPurchaseDelta(tx, bought)
      await applyNoteDelta(tx, noted)
      if (hash !== lastSaved) {
        await tx.insert(compatState).values({ key: "main", data: JSON.parse(json) as unknown })
          .onConflictDoUpdate({ target: compatState.key, set: { data: JSON.parse(json) as unknown, updatedAt: new Date() } })
      }
    })
    // committed: what memory holds now is the new baseline (a rolled-back transaction retries the same delta)
    commitPartyDelta(parts); commitItemDelta(its); commitMasterDelta(masters); commitStockDelta(stock)
    commitSaleDelta(sold); commitPurchaseDelta(bought); commitNoteDelta(noted)
    lastSaved = hash
  }
}

function problem(res: Response, status: number, title: string) {
  res.status(status).type("application/problem+json").send(JSON.stringify({ type: "about:blank", title, status }))
}

@Controller()
export class CompatController {
  constructor(@Inject(CompatService) private readonly svc: CompatService) {}

  @All("api/v1/*path")
  handle(@Req() req: Request, @Res() res: Response) { return this.svc.handle(req, res) }
}
