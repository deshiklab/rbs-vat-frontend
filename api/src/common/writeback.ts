/**
 * R5.2 — write-back for the master data that lives both in PostgreSQL and in the in-memory world the unported
 * handlers still read. A collection remembers the shape it last persisted as a canonical JSON signature (key order
 * is not part of the contract, so it must not make a row look modified). After every compat request the difference
 * is applied to the table, so a handler that still writes through the mock's arrays — the R6.2 bulk import creating
 * a customer, a document approval moving an item's counters — cannot leave the two copies apart.
 *
 * The other direction is the modules' own job: they write to the table and then keep the mirror in step.
 */

export interface Delta<T> {
  insert: T[]
  update: T[]
  /** in the table but gone from memory */
  missing: string[]
}

export const deltaEmpty = (d: Delta<unknown>) => !d.insert.length && !d.update.length && !d.missing.length

/** Canonical shape: the same record with its keys in a different order is not a change. */
const sig = (x: object) => JSON.stringify(x, Object.keys(x).sort())

export class WriteBack<T extends object> {
  private readonly sigs = new Map<string, string>()

  /** @param live  the rows as the in-memory world holds them right now
   *  @param key   the row's id */
  constructor(readonly name: string, private readonly live: () => T[], private readonly key: (t: T) => string) {}

  /** These shapes are the persisted baseline (after a save, a seed, a restore, a boot-time adoption). */
  mark(list: T[]) { for (const t of list) this.sigs.set(this.key(t), sig(t)) }

  /** A row left the table (a soft delete) — forget it, so restoring it later counts as an insert again. */
  forget(id: string) { this.sigs.delete(id) }

  /** What changed in memory since the last persist. A pure read: `commit` records it once the transaction is in,
   *  so a failure (a stale instance, a deadlock) retries the same delta instead of dropping it. */
  delta(): Delta<T> {
    const d: Delta<T> = { insert: [], update: [], missing: [] }
    const live = new Set<string>()
    for (const t of this.live()) {
      const id = this.key(t)
      live.add(id)
      const s = sig(t)
      const had = this.sigs.get(id)
      if (had === undefined) d.insert.push(t)
      else if (had !== s) d.update.push(t)
    }
    for (const id of this.sigs.keys()) if (!live.has(id)) d.missing.push(id)
    return d
  }

  /** The transaction committed: remember what memory holds for those rows now — which is the shape the columns
   *  actually stored, so a value the column type rounded is not rewritten on every request. */
  commit(d: Delta<T>) {
    const live = new Map(this.live().map((t) => [this.key(t), t]))
    for (const t of [...d.insert, ...d.update]) {
      const now = live.get(this.key(t))
      this.sigs.set(this.key(t), sig(now ?? t))
    }
  }

  /** The last persisted shape of a row that vanished from memory, if this process still has it. */
  stored(id: string): T | undefined {
    const s = this.sigs.get(id)
    return s ? JSON.parse(s) as T : undefined
  }
}
