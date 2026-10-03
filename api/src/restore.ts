/**
 * R6.3 — restore a DiziVAT backup into a database, and the restore drill that proves the backups are usable
 * (GO 16/Mushak/2019 asks for at least two backups a day; a backup is only as good as its last successful restore).
 *
 *   node dist/restore.js --source <postgres-url | backup.json.gz> --target <postgres-url> [options]
 *
 *   --source URL|FILE     database whose `backups` table holds the snapshot, or a downloaded .json.gz file
 *   --id bkN              which stored backup (default: the newest)            [source = database]
 *   --sha256 HEX          expected checksum (X-Backup-SHA256 / Settings → Backups) [source = file]
 *   --target URL          database to restore into — must be empty (or not exist, with --create)
 *   --create              create the target database first
 *   --admin-user NAME     account that gets --admin-password (default: the first active admin)
 *   --admin-password PW   its new password; every other account gets an unusable one and must be reset
 *   --boot                start the API on the restored database and check health, sign-in and documents
 *   --drop-after          drop the target database at the end (drills)
 *   --record              store the result in the source database (meta.restore_drill → Settings → Backups)
 *   --report FILE         write the result as JSON
 *
 * Password hashes are never in a backup, and sessions / lockouts are not restored: after a restore every user is
 * signed out, the admin signs in with --admin-password and resets the other accounts.
 * Exit code 0 when every check passed, 1 otherwise.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Client } from "pg"
import { BACKUP_FORMAT } from "@/lib/backup-schedule"
import { verifyChain } from "@/lib/integrity"
import type { RestoreDrill } from "@/lib/types"
import { hashPassword } from "./common/password"
import { connection } from "./db/client"

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")
const isUrl = (s: string) => /^postgres(ql)?:\/\//i.test(s)
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`
/** host/database only — never credentials — for logs and the recorded result */
export function redact(url: string) {
  try { const u = new URL(url); return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}` } catch { return "?" }
}

interface Args {
  source: string; id?: string; sha256?: string; target: string; create: boolean; adminUser?: string; adminPassword?: string
  boot: boolean; dropAfter: boolean; record: boolean; report?: string
}
function parseArgs(argv: string[]): Args {
  const a: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}`)
    const name = k.slice(2)
    if (["create", "boot", "drop-after", "record"].includes(name)) a[name] = true
    else { const v = argv[++i]; if (v == null) throw new Error(`${k} needs a value`); a[name] = v }
  }
  if (!a.source || !a.target) throw new Error("usage: restore.js --source <url|file> --target <url> [--create] [--admin-password X] [--boot] [--drop-after] [--record] [--report f]")
  return {
    source: String(a.source), id: a.id as string | undefined, sha256: a.sha256 as string | undefined, target: String(a.target), create: !!a.create,
    adminUser: a["admin-user"] as string | undefined, adminPassword: a["admin-password"] as string | undefined,
    boot: !!a.boot, dropAfter: !!a["drop-after"], record: !!a.record, report: a.report as string | undefined,
  }
}

const client = (url: string) => new Client(connection(url))
const adminUrl = (url: string) => { const u = new URL(url); const name = decodeURIComponent(u.pathname.slice(1)); u.pathname = "/postgres"; return { url: u.toString(), name } }

interface Loaded { data: Buffer; expected?: string; backupId?: string; backupAt?: string }
async function load(a: Args): Promise<Loaded> {
  if (!isUrl(a.source)) return { data: readFileSync(a.source), expected: a.sha256?.toLowerCase() }
  const c = client(a.source)
  await c.connect()
  try {
    const n = a.id ? Number(/^bk(\d+)$/.exec(a.id)?.[1]) : null
    if (a.id && !n) throw new Error(`--id must look like bk12 (got ${a.id})`)
    const r = n
      ? await c.query("select id, at, size, sha256, data from backups where id = $1", [n])
      : await c.query("select id, at, size, sha256, data from backups order by at desc, id desc limit 1")
    const row = r.rows[0] as { id: number; at: Date; size: number; sha256: string; data: Buffer } | undefined
    if (!row) throw new Error(a.id ? `backup ${a.id} not found in the source database` : "the source database has no backups")
    if (row.data.byteLength !== row.size) throw new Error(`backup bk${row.id}: stored size ${row.size} ≠ ${row.data.byteLength} bytes`)
    return { data: row.data, expected: row.sha256, backupId: `bk${row.id}`, backupAt: new Date(row.at).toISOString() }
  } finally { await c.end() }
}

/** users first: saved_views (and sessions, never restored) reference users */
const ORDER = (t: string) => (t === "users" ? 0 : t === "compat_state" ? 2 : 1)

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) })
    s.on("error", rej)
  })
}

async function bootCheck(target: string, admin: { username: string; password: string } | null, docs: { sales: number; purchases: number }, log: (m: string) => void): Promise<{ ok: boolean; detail: string }> {
  const port = await freePort()
  const child: ChildProcess = spawn(process.execPath, [join(__dirname, "main.js")], {
    env: { ...process.env, DATABASE_URL: target, API_PORT: String(port), API_HOST: "127.0.0.1", BACKUPS: "off", DEMO_RESEED: "off", SESSION_SECRET: randomBytes(24).toString("hex") },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""
  child.stdout?.on("data", (b) => { out += String(b) }); child.stderr?.on("data", (b) => { out += String(b) })
  const base = `http://127.0.0.1:${port}/api/v1`
  try {
    const t0 = Date.now()
    let healthy = false
    while (Date.now() - t0 < 120_000) {
      if (child.exitCode != null) return { ok: false, detail: `API exited (${child.exitCode}): ${out.slice(-400)}` }
      try { const r = await fetch(`${base}/health`); if (r.ok) { healthy = true; break } } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!healthy) return { ok: false, detail: `health check timed out: ${out.slice(-400)}` }
    if (/re-seeding|seeded demo data/.test(out)) return { ok: false, detail: "the API re-seeded instead of using the restored data" }
    log(`  API up on the restored database in ${Date.now() - t0} ms`)
    if (!admin) return { ok: true, detail: "health ok (sign-in not checked: no --admin-password)" }
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ username: admin.username, password: admin.password }) })
    if (!login.ok) return { ok: false, detail: `sign-in as ${admin.username} failed: HTTP ${login.status}` }
    const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).join("; ")
    for (const [path, want] of [["sales", docs.sales], ["purchases", docs.purchases]] as const) {
      const r = await fetch(`${base}/${path}?category=all&pageSize=1`, { headers: { cookie } })
      if (!r.ok) return { ok: false, detail: `GET /${path} failed: HTTP ${r.status}` }
      const page = (await r.json()) as { total?: number }
      if (page.total !== want) return { ok: false, detail: `GET /${path} total ${page.total} ≠ ${want} ${path} in the backup` }
    }
    log(`  signed in as ${admin.username}; /sales lists all ${docs.sales} invoices, /purchases all ${docs.purchases}`)
    return { ok: true, detail: "health, sign-in and documents ok" }
  } finally {
    child.kill("SIGTERM")
    await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r(null) }, 8000); child.once("exit", () => { clearTimeout(t); r(null) }) })
  }
}

export async function run(a: Args, log: (m: string) => void = console.log): Promise<RestoreDrill> {
  const t0 = Date.now()
  if (a.target === a.source) throw new Error("--target must not be the source database")
  const mismatches: string[] = []

  // 1 — read + verify the snapshot
  const src = await load(a)
  const hash = sha256(src.data)
  if (src.expected && hash !== src.expected) throw new Error(`checksum mismatch: expected ${src.expected}, got ${hash}`)
  log(`backup ${src.backupId ?? a.source}: ${Math.round(src.data.byteLength / 1024)} KB, SHA-256 ${hash.slice(0, 16)}… ${src.expected ? "verified" : "(no expected checksum given)"}`)
  const payload = JSON.parse(gunzipSync(src.data).toString("utf8")) as { format: string; at: string; company?: string; tables: Record<string, Record<string, unknown>[]> }
  if (payload.format !== BACKUP_FORMAT) throw new Error(`unknown backup format ${payload.format} (expected ${BACKUP_FORMAT})`)
  const backupAt = src.backupAt ?? payload.at

  // 2 — target: create, migrate, must be empty
  if (a.create) {
    const { url, name } = adminUrl(a.target)
    const c = client(url); await c.connect()
    try { await c.query(`create database ${q(name)}`); log(`created database ${name}`) } finally { await c.end() }
  }
  const tc = client(a.target)
  await tc.connect()
  let rows = 0, tables = 0, documents = 0
  let auditChain: RestoreDrill["auditChain"] = "skipped"
  let users: { id: string; username: string; role: string; active: boolean }[] = []
  try {
    await migrate(drizzle(tc), { migrationsFolder: join(__dirname, "../drizzle") })
    const list = (await tc.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name")).rows.map((r) => r.table_name as string)
    for (const t of list) {
      const { rows: [{ n }] } = await tc.query(`select count(*)::int as n from ${q(t)}`)
      if (n > 0) throw new Error(`target database is not empty (${t} has ${n} rows) — restore into a new database`)
    }
    const missing = Object.keys(payload.tables).filter((t) => !list.includes(t))
    if (missing.length) throw new Error(`the backup has tables this version does not know: ${missing.join(", ")}`)

    // 3 — users: no password hashes in a backup
    const userRows = payload.tables.users ?? []
    users = userRows.map((u) => ({ id: String(u.id), username: String(u.username), role: String(u.role), active: !!u.active }))
    const admin = a.adminUser ? users.find((u) => u.username === a.adminUser) : users.find((u) => u.role === "admin" && u.active)
    if (a.adminPassword && !admin) throw new Error(a.adminUser ? `no user ${a.adminUser} in the backup` : "no active admin in the backup")
    const unusable = `!restored-${randomBytes(8).toString("hex")}` // not a scrypt hash: sign-in always fails until reset
    const adminHash = a.adminPassword ? await hashPassword(a.adminPassword) : null
    for (const u of userRows) {
      const isAdmin = !!adminHash && u.id === admin?.id
      u.password_hash = isAdmin ? adminHash : unusable
      u.password_is_demo = false
      u.must_change_password = !isAdmin
    }

    // 4 — insert, table by table, in one transaction
    await tc.query("begin")
    try {
      for (const t of Object.keys(payload.tables).sort((x, y) => ORDER(x) - ORDER(y) || x.localeCompare(y))) {
        const data = payload.tables[t]
        for (let i = 0; i < data.length; i += 1000)
          await tc.query(`insert into ${q(t)} select * from json_populate_recordset(null::${q(t)}, $1::json)`, [JSON.stringify(data.slice(i, i + 1000))])
        rows += data.length; tables++
      }
      // 5 — sequences continue after the restored ids
      const seqs = (await tc.query(`select table_name, column_name, pg_get_serial_sequence(quote_ident(table_name), column_name) as seq
        from information_schema.columns where table_schema = 'public' and column_default like 'nextval(%'`)).rows as { table_name: string; column_name: string; seq: string | null }[]
      for (const s of seqs) if (s.seq) await tc.query(`select setval($1, coalesce((select max(${q(s.column_name)}) from ${q(s.table_name)}), 1), (select count(*) > 0 from ${q(s.table_name)}))`, [s.seq])
      await tc.query(`select setval('unit_id_seq', greatest(1, coalesce((select max(nullif(regexp_replace(id, '\\D', '', 'g'), '')::bigint) from units), 1)))`)
      await tc.query("commit")
    } catch (e) { await tc.query("rollback"); throw e }
    log(`restored ${rows} rows into ${tables} tables`)

    // 6 — verify: row counts, documents, audit chain
    for (const t of Object.keys(payload.tables)) {
      const { rows: [{ n }] } = await tc.query(`select count(*)::int as n from ${q(t)}`)
      if (n !== payload.tables[t].length) mismatches.push(`${t}: ${n} rows ≠ ${payload.tables[t].length} in the backup`)
    }
    const want = (payload.tables.compat_state?.[0] as { data?: { db?: Record<string, unknown> } } | undefined)?.data?.db ?? {}
    const got = ((await tc.query("select data from compat_state where key = 'main'")).rows[0]?.data as { db?: Record<string, unknown> } | undefined)?.db ?? {}
    for (const [k, v] of Object.entries(want)) if (Array.isArray(v)) {
      const g = got[k]
      documents += v.length
      if (!Array.isArray(g) || g.length !== v.length) mismatches.push(`documents.${k}: ${Array.isArray(g) ? g.length : "missing"} ≠ ${v.length}`)
      else if (sha256(JSON.stringify(g)) !== sha256(JSON.stringify(v))) mismatches.push(`documents.${k}: content differs`)
    }
    if (payload.tables.audit_events?.length) {
      const raw = (await tc.query("select * from audit_events order by id")).rows as Record<string, unknown>[]
      const report = verifyChain(raw.map((r) => ({
        id: `a${r.id}`, at: new Date(r.at as string).toISOString(), actor: r.actor as string, actorId: r.actor_id as string | null, entity: r.entity as string,
        entityId: r.entity_id as string | null, ref: r.ref as string, action: r.action as string, changes: r.changes as never, note: r.note as string | null,
        prevHash: r.prev_hash as string | null, hash: r.hash as string | null,
      })), (s) => sha256(s))
      auditChain = report.ok ? "ok" : "broken"
      if (!report.ok) mismatches.push(`audit chain broken at ${report.broken?.id} (${report.broken?.reason})`)
      log(`audit chain: ${report.ok ? "intact" : "BROKEN"} (${report.count} events)`)
    }
    log(`documents: ${documents} in ${Object.values(want).filter(Array.isArray).length} collections — ${mismatches.length ? `${mismatches.length} mismatch(es)` : "all match"}`)
  } finally { await tc.end() }

  // 7 — boot the API on it
  let boot: RestoreDrill["boot"] = "skipped"
  if (a.boot) {
    const admin = a.adminPassword ? (a.adminUser ? users.find((u) => u.username === a.adminUser) : users.find((u) => u.role === "admin" && u.active)) : undefined
    // the documents the restored instance must list: their own tables since R5.3 (a stamped draft is not listed),
    // the snapshot's arrays in a backup taken before that
    const snapshotDb = (payload.tables.compat_state?.[0] as { data?: { db?: Record<string, unknown[]> } } | undefined)?.data?.db
    const live = (table: string, collection: string) => {
      const rows = payload.tables[table] as { deleted_at?: string | null }[] | undefined
      return rows ? rows.filter((r) => !r.deleted_at).length : (snapshotDb?.[collection] ?? []).length
    }
    const r = await bootCheck(a.target, admin && a.adminPassword ? { username: admin.username, password: a.adminPassword } : null,
      { sales: live("sales", "sales"), purchases: live("purchases", "purchases") }, log)
    boot = r.ok ? "ok" : "failed"
    if (!r.ok) mismatches.push(`boot: ${r.detail}`)
  }

  if (a.dropAfter) {
    const { url, name } = adminUrl(a.target)
    const c = client(url); await c.connect()
    try { await c.query(`drop database if exists ${q(name)} with (force)`); log(`dropped database ${name}`) } finally { await c.end() }
  }

  const result: RestoreDrill = {
    at: new Date().toISOString(), ok: mismatches.length === 0, backupId: src.backupId, backupAt, sha256: hash, target: redact(a.target), ms: Date.now() - t0,
    tables, rows, documents, auditChain, boot, mismatches, by: process.env.DRILL_BY ?? "restore.js",
  }
  if (a.record && isUrl(a.source)) {
    const c = client(a.source); await c.connect()
    try { await c.query("insert into meta (key, value) values ('restore_drill', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(result)]) } finally { await c.end() }
    log("result recorded in the source database (Settings → Backups → last restore drill)")
  }
  if (a.report) writeFileSync(a.report, JSON.stringify(result, null, 2))
  return result
}

if (require.main === module) {
  let a: Args
  try { a = parseArgs(process.argv.slice(2)) } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(2) }
  run(a).then((r) => {
    console.log(`${r.ok ? "RESTORE OK" : "RESTORE FAILED"} — ${r.tables} tables, ${r.rows} rows, ${r.documents} documents, audit chain ${r.auditChain}, boot ${r.boot}, ${(r.ms / 1000).toFixed(1)} s`)
    for (const m of r.mismatches) console.log(`  ✗ ${m}`)
    process.exit(r.ok ? 0 : 1)
  }).catch((e) => { console.error(`RESTORE FAILED — ${e instanceof Error ? e.message : String(e)}`); process.exit(1) })
}
