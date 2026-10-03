/** HTTP helpers shared by the native modules: RFC 9457 problems, raw-body JSON, cookies, CSV. */
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common"
import type { Request, Response } from "express"
import type { ZodError } from "zod"

/** Same body as the mock's `problem()`: {type, title, status, errors?} with content-type application/problem+json. */
export class Problem extends HttpException {
  constructor(status: number, title: string, errors?: Record<string, string[]>) {
    super({ type: "about:blank", title, status, errors }, status)
  }
}

/**
 * The unique index a write collided with, or null when the error is something else. Drizzle wraps the driver error
 * (`DrizzleQueryError: Failed query: …`), so the PostgreSQL code has to be read from the cause — without this every
 * duplicate that the application checks did not catch (two requests at once, an undo against a record created since)
 * would reach the user as a 500 instead of the 422 the form validation answers with.
 */
export function uniqueViolation(e: unknown): string | null {
  for (const x of [e, (e as { cause?: unknown } | null)?.cause]) {
    const c = x as { code?: string; constraint_name?: string; constraint?: string } | null | undefined
    if (c?.code === "23505") return String(c.constraint_name ?? c.constraint ?? "")
  }
  return null
}

export const zodErrors = (e: ZodError, fallback = "_") => {
  const errors: Record<string, string[]> = {}
  for (const i of e.issues) (errors[i.path.join(".") || fallback] ??= []).push(i.message)
  return errors
}

/** Validate like the mock handlers: 422 "Validation failed" with field → codes. */
// Structural type: the shared schemas in ../src are typed against the root package's zod copy
type Schema = { _output: unknown; safeParse(v: unknown): { success: boolean; data?: unknown; error?: unknown } }
export function parse<S extends Schema>(schema: S, body: unknown): S["_output"] {
  const r = schema.safeParse(body)
  if (!r.success) throw new Problem(422, "Validation failed", zodErrors(r.error as ZodError))
  return r.data as S["_output"]
}

/** `await req.json().catch(() => ({}))` semantics on the raw body. */
export function jsonBody(req: Request): unknown {
  const b = req.body as Buffer | undefined
  if (!b || !Buffer.isBuffer(b) || !b.length) return {}
  try { return JSON.parse(b.toString("utf8")) } catch { return {} }
}

export const searchParams = (req: Request) => new URL(req.originalUrl, "http://x").searchParams

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>()
    let status = 500
    let body: Record<string, unknown> = { type: "about:blank", title: "Internal error", status }
    if (e instanceof HttpException) {
      status = e.getStatus()
      const r = e.getResponse()
      body = typeof r === "object" && r && "type" in r ? (r as Record<string, unknown>) : { type: "about:blank", title: e.message, status }
    } else {
      console.error("[api]", e)
      if (e instanceof Error) body.title = e.message
    }
    if (res.headersSent) return
    res.status(status).type("application/problem+json").send(JSON.stringify(body))
  }
}

export interface CookieOptions { maxAge: number; httpOnly?: boolean; sameSite?: "lax" | "strict" | "none"; secure?: boolean; path?: string; partitioned?: boolean }

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(/;\s*/)) {
    const i = part.indexOf("=")
    if (i > 0 && part.slice(0, i) === name) {
      try { return decodeURIComponent(part.slice(i + 1)) } catch { return undefined }
    }
  }
  return undefined
}

export function setCookie(res: Response, name: string, value: string, o: CookieOptions) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? "/"}`, `Max-Age=${o.maxAge}`, `SameSite=${o.sameSite === "strict" ? "Strict" : o.sameSite === "none" ? "None" : "Lax"}`]
  if (o.httpOnly !== false) parts.push("HttpOnly")
  if (o.secure || o.sameSite === "none") parts.push("Secure")
  if (o.partitioned) parts.push("Partitioned")
  res.append("Set-Cookie", parts.join("; "))
}

/**
 * HTTPS as seen by the browser. Behind Render's TLS proxy and the Next.js rewrite, x-forwarded-proto may be a
 * list ("https,http"); any https hop means the browser is on https.
 */
export const isHttps = (req: Request) => /https/i.test(String(req.headers["x-forwarded-proto"] ?? "")) || req.protocol === "https"

export function sendCsv(res: Response, csv: string, name: string) {
  res.status(200).set({ "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` }).send(csv)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** timestamptz from Drizzle (Date) or from a raw query (Postgres text "2026-01-12 10:05:00.123+06") → ISO-8601 UTC. */
export function toIso(v: Date | string): string {
  if (v instanceof Date) return v.toISOString()
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d+)?)(?:([+-]\d\d)(?::?(\d\d))?|Z)?$/.exec(v)
  return new Date(m ? `${m[1]}T${m[2]}${m[3] ? `${m[3]}:${m[4] ?? "00"}` : "Z"}` : v).toISOString()
}
