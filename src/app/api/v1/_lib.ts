import type { ZodError } from "zod"
import { currentUser } from "@/lib/auth/session-user"
import { can, ROLE_PERMS, type Permission, type User } from "@/lib/auth/roles"
import { recordAudit } from "@/lib/mock/audit"

// Web-standard Response only: the same handlers also run in the browser for the static GitHub Pages demo
export const json = (data: unknown, init?: ResponseInit) => Response.json(data, init)
/** RFC 9457 problem+json — the error shape the Symfony API will return */
export const problem = (status: number, title: string, errors?: Record<string, string[]>) =>
  Response.json({ type: "about:blank", title, status, errors }, { status, headers: { "content-type": "application/problem+json" } })
/**
 * A rejection as data: the status, title and field → codes both sides answer with. Shared rules return this (R5.3)
 * so the mock and the API's native modules cannot drift: the mock turns it into a Web Response, Nest into an
 * RFC 9457 problem.
 */
export type RuleProblem = { status: 400 | 409 | 422; title: string; errors?: Record<string, string[]> }
/** The mock's side of a RuleProblem. */
export const ruleResponse = (p: RuleProblem) => problem(p.status, p.title, p.errors)
/** A 422 "Validation failed" as data. */
export const invalidRule = (errors: Record<string, string[]>): RuleProblem => ({ status: 422, title: "Validation failed", errors })

/** zod issues → field → codes (R5.3: data, so the API's native modules answer with the same 422 body). */
export const zodErrors = (e: ZodError): Record<string, string[]> => {
  const errors: Record<string, string[]> = {}
  for (const i of e.issues) (errors[i.path.join(".") || "_"] ??= []).push(i.message)
  return errors
}
export const zodProblem = (e: ZodError) => problem(422, "Validation failed", zodErrors(e))

/** 403 problem if the user lacks `perm`, else null. */
export const deny = (user: User, perm: Permission) =>
  can(ROLE_PERMS[user.role], perm) ? null : problem(403, `Your role (${user.role}) is not allowed to do this (${perm}).`)

/**
 * Route-handler wrapper: 401 without a valid session, 403 without `perm`.
 * Mirrors the Symfony firewall + voters so screens handle both responses already.
 */
export function withAuth<C = unknown>(perm: Permission | null, fn: (req: Request, ctx: C, user: User) => Promise<Response> | Response) {
  return async (req: Request, ctx: C) => {
    const user = await currentUser(req)
    if (!user) return problem(401, "Your session has expired. Please sign in again.")
    if (perm) { const d = deny(user, perm); if (d) return d }
    if (user.role === "vatOfficer") logOfficerAccess(user, req)
    return fn(req, ctx, user)
  }
}

/**
 * R6.2 (GO 16/Mushak/2019 — VAT officials' access for audit): every read a VAT officer makes is written to the audit
 * trail (entity "access", action "viewed"), at most once a minute per path so paging does not flood the log.
 */
const seen = (globalThis as unknown as { __dzAccess?: Map<string, number> }).__dzAccess ??= new Map()
export function logOfficerAccess(user: User, req: Request) {
  const u = new URL(req.url)
  const path = u.pathname.replace(/^.*\/api\/v1/, "") || "/"
  const key = `${user.id}|${req.method}|${path}`, now = Date.now()
  if ((seen.get(key) ?? 0) > now - 60_000) return
  seen.set(key, now)
  recordAudit({ actor: user, entity: "access", entityId: user.id, ref: path, action: "viewed", note: [req.method !== "GET" ? req.method : "", u.search.slice(1, 200)].filter(Boolean).join(" ") || undefined })
}
