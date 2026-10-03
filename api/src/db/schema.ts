/**
 * PostgreSQL schema (Drizzle). R5.1 moves identity, sessions, audit and reference data into real tables, R5.2 the
 * master data (customers and vendors as `parties`, SKUs as `items`, HS-code products as `master_items`) and R5.3
 * the documents (transfers and damage entries as `stock_documents`, sales invoices as `sales`) with their lines;
 * the remaining documents still live in `compat_state` until R5.3–R5.5 give each module its own tables.
 * Migrations are generated with `npm run db:generate` into ./drizzle and applied at boot.
 */
import { sql } from "drizzle-orm"
import {
  bigserial, boolean, check, customType, date, index, integer, jsonb, numeric, pgSequence, pgTable, primaryKey, serial, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import type { AuditChange, HistoryEntry } from "@/lib/types"

const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: "date" })

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  /** insertion order — tie-breaker so sorted lists are stable, exactly like the in-memory mock */
  ord: serial("ord").notNull(),
  username: text("username").notNull(),
  name: text("name").notNull(),
  designation: text("designation").notNull(),
  initials: text("initials").notNull(),
  email: text("email").notNull(),
  role: text("role", { enum: ["admin", "approver", "operator", "viewer", "vatOfficer"] }).notNull(),
  mobile: text("mobile"),
  department: text("department"),
  active: boolean("active").notNull().default(true),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  /** scrypt$N$r$p$salt$hash — never the password itself */
  passwordHash: text("password_hash").notNull(),
  /** seeded account still on the published demo password (listed on the login page) */
  passwordIsDemo: boolean("password_is_demo").notNull().default(false),
  preferences: jsonb("preferences").$type<Record<string, string>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSignInAt: ts("last_sign_in_at"),
  /** R6.2: VAT officer — last day (Asia/Dhaka) the account may sign in; null for every other role */
  accessUntil: date("access_until", { mode: "string" }),
}, (t) => [
  uniqueIndex("users_username_key").on(t.username),
  uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`),
  check("users_role_check", sql`${t.role} in ('admin','approver','operator','viewer','vatOfficer')`),
  check("users_officer_access_check", sql`${t.role} <> 'vatOfficer' or ${t.accessUntil} is not null`),
])

/** Server-side sessions: the signed cookie carries `sid`; revoking a row signs that browser out immediately. */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  remember: boolean("remember").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  lastSeenAt: ts("last_seen_at"),
  revokedAt: ts("revoked_at"),
  revokeReason: text("revoke_reason"),
  userAgent: text("user_agent"),
  ip: text("ip"),
}, (t) => [index("sessions_user_idx").on(t.userId)])

/** Brute-force protection survives restarts: 5 failures → 60 s lock per username. */
export const loginFailures = pgTable("login_failures", {
  username: text("username").primaryKey(),
  failures: integer("failures").notNull(),
  lockedUntil: ts("locked_until"),
})

export const savedViews = pgTable("saved_views", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tableKey: text("table_key").notNull(),
  name: text("name").notNull(),
  query: text("query").notNull(),
  /** re-saving a view moves it to the end, as in the mock */
  pos: bigserial("pos", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.tableKey, t.name] })])

/** Single-row company profile (printed on every Mushak form). */
export const company = pgTable("company", {
  id: integer("id").primaryKey().default(1),
  name: text("name").notNull(),
  vatSlab: text("vat_slab").notNull(),
  bin: text("bin").notNull(),
  tin: text("tin").notNull(),
  mobile: text("mobile").notNull(),
  phone: text("phone"),
  email: text("email").notNull(),
  address: text("address").notNull(),
  owner: jsonb("owner").$type<{ name: string; nid?: string; mobile: string; designation?: string }>().notNull(),
  signatory: jsonb("signatory").$type<{ name: string; designation: string; mobile: string; email: string; nid: string }>().notNull(),
  updatedAt: ts("updated_at"),
  updatedBy: text("updated_by"),
}, (t) => [check("company_single_row", sql`${t.id} = 1`)])

export const branches = pgTable("branches", {
  id: text("id").primaryKey(),
  position: integer("position").notNull(),
  code: text("code"),
  name: text("name").notNull(),
  address: text("address").notNull(),
  category: text("category").notNull(),
})

/** Append-only audit trail (NBR audits rely on it): the app never updates or deletes rows. */
export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: ts("at").notNull(),
  /** calendar day in Asia/Dhaka — the date filter works on it */
  day: date("day", { mode: "string" }).notNull(),
  actor: text("actor").notNull(),
  actorId: text("actor_id"),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  ref: text("ref").notNull(),
  action: text("action").notNull(),
  changes: jsonb("changes").$type<AuditChange[]>(),
  note: text("note"),
  /** R6: tamper-evident chain — hash = SHA-256(prev_hash + "\n" + canonical event); see src/lib/integrity.ts */
  prevHash: text("prev_hash"),
  hash: text("hash"),
}, (t) => [
  index("audit_at_idx").on(t.at),
  index("audit_day_idx").on(t.day),
  index("audit_entity_id_idx").on(t.entityId),
  index("audit_entity_idx").on(t.entity),
])

export const unitIdSeq = pgSequence("unit_id_seq", { startWith: 1 })
export const units = pgTable("units", {
  id: text("id").primaryKey(),
  ord: serial("ord").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  decimals: integer("decimals").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("units_code_lower_key").on(sql`lower(${t.code})`)])

/** NBR customs & VAT tariff, one row per HS code and fiscal year. Rates in %. */
export const tariffLines = pgTable("tariff_lines", {
  fy: text("fy").notNull(),
  hsCode: text("hs_code").notNull(),
  description: text("description").notNull(),
  chapter: text("chapter").notNull(),
  cd: numeric("cd", { precision: 7, scale: 2, mode: "number" }).notNull(),
  sd: numeric("sd", { precision: 7, scale: 2, mode: "number" }).notNull(),
  vat: numeric("vat", { precision: 7, scale: 2, mode: "number" }).notNull(),
  ait: numeric("ait", { precision: 7, scale: 2, mode: "number" }).notNull(),
  rd: numeric("rd", { precision: 7, scale: 2, mode: "number" }).notNull(),
  at: numeric("at", { precision: 7, scale: 2, mode: "number" }).notNull(),
  tti: numeric("tti", { precision: 9, scale: 2, mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.fy, t.hsCode] })])

/**
 * R5.2 — customers and vendors: the first business records out of the compat layer. One table, `kind` tells them
 * apart; documents (still in `compat_state` until R5.3) reference them by id.
 * A deleted party keeps its row (`deleted_at`) — that is the 10-second undo trash — so master data never leaves
 * relational storage, and the uniqueness rules the API checks are also enforced here.
 */
export const parties = pgTable("parties", {
  id: text("id").primaryKey(),
  /** insertion order — tie-breaker so sorted lists are stable, exactly like the in-memory mock */
  ord: serial("ord").notNull(),
  kind: text("kind", { enum: ["customer", "vendor"] }).notNull(),
  /** party names in capitals, as printed on Mushak 6.3 */
  name: text("name").notNull(),
  /** BIN (Local), NID (Non-registered) or foreign reference; "" when unknown */
  bin: text("bin").notNull().default(""),
  mode: text("mode").notNull(),
  mobile: text("mobile").notNull().default(""),
  address: text("address").notNull(),
  country: text("country"),
  email: text("email"),
  contactPerson: text("contact_person"),
  /** optional in the contract: NULL means active (only `false` is ever stored) */
  active: boolean("active"),
  /** R3 (customers): credit limit in BDT and VDS-withholder flag — seeded, not editable through the API */
  creditLimit: numeric("credit_limit", { precision: 18, scale: 2, mode: "number" }),
  vdsWithholder: boolean("vds_withholder"),
  /** R6 (RMG): exporter class, customs bond licence and trade-body membership */
  exporterType: text("exporter_type"),
  bondLicenseNo: text("bond_license_no"),
  bondLicenseExpiry: date("bond_license_expiry", { mode: "string" }),
  associationNo: text("association_no"),
  /** in the undo trash: DELETE sets it, restore clears it */
  deletedAt: ts("deleted_at"),
}, (t) => [
  index("parties_live_kind_idx").on(t.kind).where(sql`${t.deletedAt} is null`),
  // the duplicate rules of partyErrors(), enforced by the database (per kind, NID prefix ignored, trash excluded)
  uniqueIndex("parties_live_name_key").on(t.kind, sql`lower(btrim(${t.name}))`).where(sql`${t.deletedAt} is null`),
  uniqueIndex("parties_live_bin_key").on(t.kind, sql`regexp_replace(${t.bin}, '^NID ', '')`).where(sql`${t.bin} <> '' and ${t.deletedAt} is null`),
  check("parties_kind_check", sql`${t.kind} in ('customer','vendor')`),
  check("parties_exporter_check", sql`${t.exporterType} is null or ${t.exporterType} in ('direct','deemed')`),
])

/**
 * R5.2 — SKUs. The movement counters live on the row, so an item's `remain`
 * (opening + purchased + prodReceive − prodIssue − sold − damage) travels with it; the documents that move the
 * counters are still compat state until R5.3 and write them back through the mirror. Quantities carry the units'
 * three decimals, money two. Items are never deleted — an unused one is deactivated (its ledger must stay readable).
 */
export const items = pgTable("items", {
  id: text("id").primaryKey(),
  /** insertion order — tie-breaker so sorted lists are stable, exactly like the in-memory mock */
  ord: serial("ord").notNull(),
  hsCode: text("hs_code").notNull(),
  group: text("group").notNull(),
  /** the master item's *name*: SKUs reference their master by name, so renaming one carries them along */
  masterItem: text("master_item").notNull(),
  brand: text("brand").notNull(),
  name: text("name").notNull(),
  /** unit-of-measure code from the Units master */
  unit: text("unit").notNull(),
  sku: text("sku").notNull(),
  purchasePrice: numeric("purchase_price", { precision: 18, scale: 2, mode: "number" }).notNull(),
  /** derived when the SKU is created (from the purchase price, or the sale price without one) and never edited */
  costPrice: numeric("cost_price", { precision: 18, scale: 2, mode: "number" }).notNull(),
  salePrice: numeric("sale_price", { precision: 18, scale: 2, mode: "number" }).notNull(),
  vatRate: numeric("vat_rate", { precision: 7, scale: 2, mode: "number" }).notNull(),
  sdRate: numeric("sd_rate", { precision: 7, scale: 2, mode: "number" }).notNull(),
  opening: numeric("opening", { precision: 18, scale: 3, mode: "number" }).notNull(),
  purchased: numeric("purchased", { precision: 18, scale: 3, mode: "number" }).notNull(),
  prodReceive: numeric("prod_receive", { precision: 18, scale: 3, mode: "number" }).notNull(),
  prodIssue: numeric("prod_issue", { precision: 18, scale: 3, mode: "number" }).notNull(),
  sold: numeric("sold", { precision: 18, scale: 3, mode: "number" }).notNull(),
  damage: numeric("damage", { precision: 18, scale: 3, mode: "number" }).notNull(),
  reorderLevel: numeric("reorder_level", { precision: 18, scale: 3, mode: "number" }).notNull(),
  active: boolean("active").notNull(),
}, (t) => [
  // SKUs are unique case-insensitively (skuTaken)
  uniqueIndex("items_sku_lower_key").on(sql`lower(${t.sku})`),
  index("items_master_item_idx").on(t.masterItem),
  index("items_hs_code_idx").on(t.hsCode),
  check("items_group_check", sql`${t.group} in ('Raw Material','Consumable','Packing Materials','Finished Goods')`),
])

/**
 * R5.2 — master items: the HS-code product a SKU belongs to, with its tax profile. Rates default from the tariff
 * (`tariff_lines`); a difference is flagged as an override and needs a reason. The profile is stored flat, like the
 * tariff's own columns, so a master item and its HS line can be compared in SQL.
 */
export const masterItems = pgTable("master_items", {
  id: text("id").primaryKey(),
  /** insertion order — tie-breaker so sorted lists are stable, exactly like the in-memory mock */
  ord: serial("ord").notNull(),
  name: text("name").notNull(),
  hsCode: text("hs_code").notNull(),
  group: text("group").notNull(),
  category: text("category").notNull(),
  unit: text("unit").notNull(),
  priceMethod: text("price_method").notNull(),
  description: text("description"),
  vat: numeric("vat", { precision: 7, scale: 2, mode: "number" }).notNull(),
  sd: numeric("sd", { precision: 7, scale: 2, mode: "number" }).notNull(),
  cd: numeric("cd", { precision: 7, scale: 2, mode: "number" }).notNull(),
  rd: numeric("rd", { precision: 7, scale: 2, mode: "number" }).notNull(),
  ait: numeric("ait", { precision: 7, scale: 2, mode: "number" }).notNull(),
  at: numeric("at", { precision: 7, scale: 2, mode: "number" }).notNull(),
  /** mandatory once a rate differs from the tariff (buildMaster) */
  overrideReason: text("override_reason"),
  active: boolean("active").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at"),
  /** the master item's own trail, shown on its register row; the same entries are in `audit_events` */
  history: jsonb("history").$type<HistoryEntry[]>(),
}, (t) => [
  // names are unique case-insensitively (buildMaster)
  uniqueIndex("master_items_name_lower_key").on(sql`lower(${t.name})`),
  index("master_items_hs_code_idx").on(t.hsCode),
  check("master_items_group_check", sql`${t.group} in ('Raw Material','Consumable','Packing Materials','Finished Goods')`),
  check("master_items_category_check", sql`${t.category} in ('general','commercialImporter','medicine','petroleum','superShop')`),
  check("master_items_price_method_check", sql`${t.priceMethod} in ('average','standard')`),
])

/**
 * R5.3 — stock documents: a transfer moves goods between branches, a damage entry writes them off. Both are a
 * header with priced lines, both are numbered per month and never reuse a number (a deleted draft stays in the
 * audit trail), and both only move stock once approved. The two kinds share a table because that is how the
 * registers and the branch-stock derivation read them (`StockDoc`): the branch a document consumes is
 * `from_branch_id` for either kind, and a transfer also names where the goods go.
 */
export const stockDocuments = pgTable("stock_documents", {
  id: text("id").primaryKey(),
  /** insertion order — tie-breaker so sorted lists are stable, exactly like the in-memory mock */
  ord: serial("ord").notNull(),
  kind: text("kind", { enum: ["transfer", "damage"] }).notNull(),
  /** TR-MMYY#### / DM-MMYY#### — unique forever, so a deleted draft's number is not handed out again */
  no: text("no").notNull(),
  /** the document date the number is derived from and the registers filter by */
  date: date("date", { mode: "string" }).notNull(),
  process: text("process", { enum: ["Created", "Approved", "Cancelled"] }).notNull(),
  /** the branch the stock leaves: a transfer's origin, a damage entry's own branch */
  fromBranchId: text("from_branch_id").notNull(),
  fromBranch: text("from_branch").notNull(),
  /** a transfer's destination; NULL on a damage entry, which moves nothing */
  toBranchId: text("to_branch_id"),
  toBranch: text("to_branch"),
  /** damage only: why the stock was written off */
  reason: text("reason", { enum: ["damaged", "expired", "wastage", "lost"] }),
  /** transfer only: the vehicle that carried the goods */
  vehicle: text("vehicle"),
  note: text("note"),
  totalQty: numeric("total_qty", { precision: 18, scale: 3, mode: "number" }).notNull(),
  totalValue: numeric("total_value", { precision: 18, scale: 2, mode: "number" }).notNull(),
  issuedBy: text("issued_by").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at"),
  cancelReason: text("cancel_reason"),
  /** the document's own trail, shown on its register row; the same entries are in `audit_events` */
  history: jsonb("history").$type<HistoryEntry[]>(),
}, (t) => [
  uniqueIndex("stock_documents_no_key").on(t.no),
  index("stock_documents_kind_created_idx").on(t.kind, t.createdAt),
  check("stock_documents_kind_check", sql`${t.kind} in ('transfer','damage')`),
  check("stock_documents_process_check", sql`${t.process} in ('Created','Approved','Cancelled')`),
  check("stock_documents_reason_check", sql`${t.reason} is null or ${t.reason} in ('damaged','expired','wastage','lost')`),
  // a transfer names both branches, a damage entry only the one it writes off
  check("stock_documents_branches_check", sql`(${t.kind} = 'transfer' and ${t.toBranchId} is not null) or (${t.kind} = 'damage' and ${t.toBranchId} is null and ${t.reason} is not null)`),
])

/**
 * The lines of a stock document: the item, the quantity and the unit cost at posting, so the entry keeps the value
 * it was approved with even after the SKU's price moves. A child table rather than JSON — that is what lets the
 * branch stock and an item's ledger be summed in SQL.
 */
export const stockDocumentLines = pgTable("stock_document_lines", {
  docId: text("doc_id").notNull(),
  /** position on the document */
  ord: integer("ord").notNull(),
  itemId: text("item_id").notNull(),
  /** as printed on the document: the SKU's name and code at posting */
  name: text("name").notNull(),
  sku: text("sku").notNull(),
  uom: text("uom").notNull(),
  qty: numeric("qty", { precision: 18, scale: 3, mode: "number" }).notNull(),
  cost: numeric("cost", { precision: 18, scale: 2, mode: "number" }).notNull(),
  value: numeric("value", { precision: 18, scale: 2, mode: "number" }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.docId, t.ord] }),
  index("stock_document_lines_item_idx").on(t.itemId),
])

/**
 * R5.3 — sales invoices: the first revenue document out of the compat layer. A sale is a header with its priced
 * lines, and it moves stock only once approved (a service sale moves nothing). The export / deemed-export shipping
 * documents are flattened onto the header — `export_deemed` is the presence marker, NULL when the invoice is a
 * local or a service sale — so an LC number, a country or a foreign-currency value can be read in SQL, the way
 * `master_items` flattened its rate block. The proceeds realised against an export invoice (R6.2, PRC entries) are
 * rows of their own: they are added and removed one at a time, and one PRC may be split over several invoices.
 *
 * A deleted draft is a row with `deleted_at` set rather than a document in the undo buffer, exactly like a deleted
 * party (R5.2): its number stays retired, and the restore route puts the row back.
 */
export const sales = pgTable("sales", {
  id: text("id").primaryKey(),
  /** insertion order — tie-breaker so sorted lists are stable, exactly like the in-memory mock */
  ord: serial("ord").notNull(),
  /** S-MMYY#### (goods, exports) / SS-MMYY#### (services) — unique forever, so a deleted draft's number is not reused */
  invoiceNo: text("invoice_no").notNull(),
  /** delivery challan number, one above the highest ever used */
  challanNo: text("challan_no").notNull(),
  /** the invoice date the number is derived from, the registers filter by and the tax period follows */
  issueDate: date("issue_date", { mode: "string" }).notNull(),
  issueTime: text("issue_time").notNull(),
  process: text("process", { enum: ["Created", "Approved", "Cancelled"] }).notNull(),
  /** NULL (absent) for a goods sale, which is what every pre-R3 invoice is */
  category: text("category", { enum: ["goods", "service"] }),
  /** the branch / warehouse the goods leave */
  branchId: text("branch_id").notNull(),
  branchName: text("branch_name").notNull(),
  customerId: text("customer_id").notNull(),
  /** as printed on the invoice: the customer's name, BIN and address at issue */
  customerName: text("customer_name").notNull(),
  customerBin: text("customer_bin").notNull(),
  customerAddress: text("customer_address").notNull(),
  deliveryAddress: text("delivery_address").notNull(),
  vehicle: text("vehicle"),
  /** the customer's mode decides whether the invoice is zero-rated */
  mode: text("mode", { enum: ["Local", "Foreign"] }).notNull(),
  method: text("method", { enum: ["Bank", "Cash", "Cheque", "Mobile", "Transaction"] }).notNull(),
  /** VDS withheld by the customer — never on a zero-rated invoice */
  vds: boolean("vds").notNull(),
  subtotal: numeric("subtotal", { precision: 18, scale: 2, mode: "number" }).notNull(),
  sd: numeric("sd", { precision: 18, scale: 2, mode: "number" }).notNull(),
  vat: numeric("vat", { precision: 18, scale: 2, mode: "number" }).notNull(),
  discount: numeric("discount", { precision: 18, scale: 2, mode: "number" }).notNull(),
  netTotal: numeric("net_total", { precision: 18, scale: 2, mode: "number" }).notNull(),
  paid: numeric("paid", { precision: 18, scale: 2, mode: "number" }).notNull(),
  due: numeric("due", { precision: 18, scale: 2, mode: "number" }).notNull(),
  issuedBy: text("issued_by").notNull(),
  designation: text("designation").notNull(),
  narration: text("narration"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at"),
  cancelReason: text("cancel_reason"),
  /** the invoice's own trail, shown on its register row; the same entries are in `audit_events` */
  history: jsonb("history").$type<HistoryEntry[]>(),
  /** the undo buffer: a draft deleted within the last seconds, restorable and still holding its number */
  deletedAt: ts("deleted_at"),

  /* export / deemed-export shipping documents (Mushak 4.1, zero-rated) — `exportDeemed` is the presence marker */
  exportDeemed: boolean("export_deemed"),
  exportLcNo: text("export_lc_no"),
  exportLcDate: date("export_lc_date", { mode: "string" }),
  exportCustomsHouse: text("export_customs_house"),
  exportCountry: text("export_country"),
  /** bill of export: its number and date (absent on a deemed export, which never leaves the country) */
  exportBillNo: text("export_bill_no"),
  /** text, not date: a deemed export carries no bill and the invoice stores an empty string, not NULL */
  exportBillDate: text("export_bill_date"),
  exportShippingAddress: text("export_shipping_address"),
  exportCnfFirm: text("export_cnf_firm"),
  /** R6 (RMG): the Utilization Declaration / Permission of the exporter that lists this deemed supply */
  exportUdNo: text("export_ud_no"),
  /** text, not date: the UD date is optional and the invoice stores an empty string when it is unknown */
  exportUdDate: text("export_ud_date"),
  /** R6 (RMG): EXP form number (direct export) */
  exportExpNo: text("export_exp_no"),
  /** R6 (RMG): invoice currency, foreign-currency value and exchange rate */
  exportCurrency: text("export_currency", { enum: ["USD", "EUR", "GBP", "BDT"] }),
  exportFcValue: numeric("export_fc_value", { precision: 18, scale: 2, mode: "number" }),
  exportExchangeRate: numeric("export_exchange_rate", { precision: 18, scale: 6, mode: "number" }),
  /** R6 (RMG): the exporter's bond licence (deemed export; defaults to the customer's) */
  exportExporterBond: text("export_exporter_bond"),
  /** R6.5 (RMG): our own UD / UP this shipment is made under — its bonded inputs are settled against it */
  exportOwnUdNo: text("export_own_ud_no"),
  /**
   * Presence marker for the `export.realisations` array: the entries themselves are `sale_realisations` rows, and
   * an invoice that had one entry and lost it again answers with an empty array, not with no array at all.
   */
  exportRealisations: boolean("export_realisations").notNull().default(false),
}, (t) => [
  uniqueIndex("sales_invoice_no_key").on(t.invoiceNo),
  index("sales_live_idx").on(t.createdAt).where(sql`${t.deletedAt} is null`),
  index("sales_issue_date_idx").on(t.issueDate),
  index("sales_customer_idx").on(t.customerId),
  index("sales_branch_idx").on(t.branchId),
  check("sales_process_check", sql`${t.process} in ('Created','Approved','Cancelled')`),
  check("sales_category_check", sql`${t.category} is null or ${t.category} in ('goods','service')`),
  check("sales_mode_check", sql`${t.mode} in ('Local','Foreign')`),
  check("sales_method_check", sql`${t.method} in ('Bank','Cash','Cheque','Mobile','Transaction')`),
  // the shipping documents are a block: either all of the header is there, or none of it is
  check("sales_export_check", sql`(${t.exportDeemed} is null and ${t.exportLcNo} is null) or (${t.exportDeemed} is not null and ${t.exportLcNo} is not null)`),
  check("sales_export_currency_check", sql`${t.exportCurrency} is null or ${t.exportCurrency} in ('USD','EUR','GBP','BDT')`),
])

/**
 * The lines of a sales invoice: the item (or service code), the quantity and the prices at issue, so the invoice
 * keeps the values it was approved with even after the SKU's price moves. A child table rather than JSON — that is
 * what lets the branch stock, an item's ledger and a customer's turnover be summed in SQL.
 */
export const saleLines = pgTable("sale_lines", {
  saleId: text("sale_id").notNull(),
  /** position on the invoice */
  ord: integer("ord").notNull(),
  itemId: text("item_id").notNull(),
  /** as printed on the invoice: the SKU's name, HS code and unit at issue (a service line carries its code) */
  name: text("name").notNull(),
  hsCode: text("hs_code").notNull(),
  uom: text("uom").notNull(),
  qty: numeric("qty", { precision: 18, scale: 3, mode: "number" }).notNull(),
  price: numeric("price", { precision: 18, scale: 2, mode: "number" }).notNull(),
  sdRate: numeric("sd_rate", { precision: 7, scale: 2, mode: "number" }).notNull(),
  vatRate: numeric("vat_rate", { precision: 7, scale: 2, mode: "number" }).notNull(),
  subtotal: numeric("subtotal", { precision: 18, scale: 2, mode: "number" }).notNull(),
  sd: numeric("sd", { precision: 18, scale: 2, mode: "number" }).notNull(),
  vat: numeric("vat", { precision: 18, scale: 2, mode: "number" }).notNull(),
  total: numeric("total", { precision: 18, scale: 2, mode: "number" }).notNull(),
  /** R3: the production batch (lot) the finished goods ship from */
  batchId: text("batch_id"),
  batchNo: text("batch_no"),
}, (t) => [
  primaryKey({ columns: [t.saleId, t.ord] }),
  index("sale_lines_item_idx").on(t.itemId),
])

/**
 * R6.2 (RMG) — export proceeds realised through the bank: one row per PRC entry against an export invoice. A PRC
 * may be split over several invoices of the same buyer / LC (a bank file posts one batch), so the number is not
 * unique here — the register groups by it. `batchId` names the bank file the entry came from, absent when it was
 * typed in on the invoice.
 */
export const saleRealisations = pgTable("sale_realisations", {
  id: text("id").primaryKey(),
  saleId: text("sale_id").notNull(),
  /** position in the invoice's list of entries */
  ord: integer("ord").notNull(),
  date: date("date", { mode: "string" }).notNull(),
  bank: text("bank").notNull(),
  prcNo: text("prc_no").notNull(),
  fcAmount: numeric("fc_amount", { precision: 18, scale: 2, mode: "number" }).notNull(),
  /** the exchange rate the proceeds were booked at */
  rate: numeric("rate", { precision: 18, scale: 6, mode: "number" }).notNull(),
  bdt: numeric("bdt", { precision: 18, scale: 2, mode: "number" }).notNull(),
  note: text("note"),
  by: text("by").notNull(),
  at: ts("at").notNull(),
  batchId: text("batch_id"),
}, (t) => [
  index("sale_realisations_sale_idx").on(t.saleId),
  index("sale_realisations_prc_idx").on(t.prcNo),
])

/**
 * R5.3 — a purchase: goods from a local or a foreign vendor, a service purchase, or an import against a Bill of
 * Entry. Same shape as `sales`, with the vendor's side of the header, the two totals a purchase adds (`tti`, the
 * total tax incidence, and `rebate`, the input tax credit claimable in Mushak 9.1) and the Bill of Entry block in
 * place of the export one. Stock arrives when the purchase is approved, so an approval writes `items.purchased`
 * with the document.
 */
export const purchases = pgTable("purchases", {
  id: text("id").primaryKey(),
  /** insertion order — tie-breaker so sorted lists are stable, exactly like the in-memory mock */
  ord: serial("ord").notNull(),
  /** P-MMYY#### (goods, imports) / PS-MMYY#### (services) — unique forever, so a deleted draft's number is not reused */
  invoiceNo: text("invoice_no").notNull(),
  /** the vendor's challan, or the Bill of Entry number on an import */
  challanNo: text("challan_no").notNull(),
  challanDate: date("challan_date", { mode: "string" }).notNull(),
  /** the date the number is derived from, the registers filter by and the tax period follows */
  issueDate: date("issue_date", { mode: "string" }).notNull(),
  process: text("process", { enum: ["Created", "Approved", "Cancelled"] }).notNull(),
  /** R2: goods (stock) or service purchase (no stock movement); NULL = goods, as the mock leaves the key out */
  category: text("category", { enum: ["goods", "service"] }),
  /** branch / warehouse the goods arrive at */
  branchId: text("branch_id").notNull(),
  branchName: text("branch_name").notNull(),
  vendorId: text("vendor_id").notNull(),
  /** as printed: the vendor's name, BIN (or NID for a non-registered one) and address at issue */
  vendorName: text("vendor_name").notNull(),
  vendorBin: text("vendor_bin").notNull(),
  vendorAddress: text("vendor_address").notNull(),
  mode: text("mode", { enum: ["Local", "Foreign", "Non-registered"] }).notNull(),
  method: text("method", { enum: ["Bank", "Cash", "Cheque", "Mobile", "Transaction"] }).notNull(),
  subtotal: numeric("subtotal", { precision: 18, scale: 2, mode: "number" }).notNull(),
  sd: numeric("sd", { precision: 18, scale: 2, mode: "number" }).notNull(),
  vat: numeric("vat", { precision: 18, scale: 2, mode: "number" }).notNull(),
  discount: numeric("discount", { precision: 18, scale: 2, mode: "number" }).notNull(),
  netTotal: numeric("net_total", { precision: 18, scale: 2, mode: "number" }).notNull(),
  paid: numeric("paid", { precision: 18, scale: 2, mode: "number" }).notNull(),
  due: numeric("due", { precision: 18, scale: 2, mode: "number" }).notNull(),
  /** R2 (imports): total tax incidence — CD + RD + SD + VAT + AIT + AT over the Bill of Entry */
  tti: numeric("tti", { precision: 18, scale: 2, mode: "number" }).notNull(),
  /** R2: input tax credit claimable in Mushak 9.1 (the rebateable lines' VAT and AT) */
  rebate: numeric("rebate", { precision: 18, scale: 2, mode: "number" }).notNull(),
  issuedBy: text("issued_by").notNull(),
  designation: text("designation").notNull(),
  narration: text("narration"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at"),
  cancelReason: text("cancel_reason"),
  /** the document's own trail: created / edited / approved / cancelled / deleted / restored, as the mock stamped it */
  history: jsonb("history").$type<HistoryEntry[]>(),
  /** the undo buffer: a deleted draft keeps its row and its lines, so its number stays retired */
  deletedAt: ts("deleted_at"),
  /* the Bill of Entry an import purchase clears (R2) — `boeNo` is the presence marker */
  boeNo: text("boe_no"),
  boeDate: date("boe_date", { mode: "string" }),
  boeLcNo: text("boe_lc_no"),
  boeLcDate: date("boe_lc_date", { mode: "string" }),
  boeCustomsHouse: text("boe_customs_house"),
  boeOrigin: text("boe_origin"),
  boeCnfFirm: text("boe_cnf_firm"),
  boeReceiveAddress: text("boe_receive_address"),
  /** R6.4: warehoused under the customs bond (IM-7) — duty and VAT suspended, no input credit, tracked in the bond register */
  boeBonded: boolean("boe_bonded"),
  /** R6.5: the own UD / UP the bonded inputs were imported against (settled per UD after export) */
  boeUdNo: text("boe_ud_no"),
}, (t) => [
  uniqueIndex("purchases_invoice_no_key").on(t.invoiceNo),
  index("purchases_live_idx").on(t.createdAt).where(sql`${t.deletedAt} is null`),
  index("purchases_issue_date_idx").on(t.issueDate),
  index("purchases_vendor_idx").on(t.vendorId),
  index("purchases_branch_idx").on(t.branchId),
  /** R6.4: the bond register reads the warehoused BoEs by their number and date */
  index("purchases_boe_bonded_idx").on(t.boeNo).where(sql`${t.boeBonded} is true`),
  check("purchases_process_check", sql`${t.process} in ('Created','Approved','Cancelled')`),
  check("purchases_category_check", sql`${t.category} is null or ${t.category} in ('goods','service')`),
  check("purchases_mode_check", sql`${t.mode} in ('Local','Foreign','Non-registered')`),
  check("purchases_method_check", sql`${t.method} in ('Bank','Cash','Cheque','Mobile','Transaction')`),
  // the Bill of Entry is a block: either all of its header is there, or none of it is
  check("purchases_boe_check", sql`(${t.boeNo} is null and ${t.boeLcNo} is null) or (${t.boeNo} is not null and ${t.boeLcNo} is not null)`),
  // only an import is warehoused under bond, and only a bonded entry names our own UD
  check("purchases_boe_bonded_check", sql`${t.boeBonded} is null or ${t.boeNo} is not null`),
  check("purchases_boe_ud_check", sql`${t.boeUdNo} is null or ${t.boeBonded} is true`),
])

/**
 * The lines of a purchase: the item (or service code), the quantity and the prices at issue. An import line also
 * carries its duty breakdown as columns, so the duty foregone under bond and the assessable value a BoE cleared
 * can be summed in SQL (the R6.4 bond register and the R6.5 drawback claims read exactly that) instead of walked
 * in memory. A NULL `duty_av` is a line with no Bill of Entry.
 */
export const purchaseLines = pgTable("purchase_lines", {
  purchaseId: text("purchase_id").notNull(),
  /** position on the document */
  ord: integer("ord").notNull(),
  itemId: text("item_id").notNull(),
  /** as printed: the SKU's name, HS code and unit at issue (a service line carries its code) */
  name: text("name").notNull(),
  hsCode: text("hs_code").notNull(),
  uom: text("uom").notNull(),
  qty: numeric("qty", { precision: 18, scale: 3, mode: "number" }).notNull(),
  /** an import line's price is the unit assessable value */
  price: numeric("price", { precision: 18, scale: 2, mode: "number" }).notNull(),
  sdRate: numeric("sd_rate", { precision: 7, scale: 2, mode: "number" }).notNull(),
  vatRate: numeric("vat_rate", { precision: 7, scale: 2, mode: "number" }).notNull(),
  /** an import line's subtotal is its assessable value (AV) */
  subtotal: numeric("subtotal", { precision: 18, scale: 2, mode: "number" }).notNull(),
  sd: numeric("sd", { precision: 18, scale: 2, mode: "number" }).notNull(),
  vat: numeric("vat", { precision: 18, scale: 2, mode: "number" }).notNull(),
  total: numeric("total", { precision: 18, scale: 2, mode: "number" }).notNull(),
  /** purchase only: the line's VAT (and AT) is claimable as input tax, and VDS was deducted at source */
  rebateable: boolean("rebateable"),
  vds: boolean("vds"),
  /** imports: this line's total tax incidence (CD + RD + SD + VAT + AIT + AT) */
  tti: numeric("tti", { precision: 18, scale: 2, mode: "number" }),
  /* R2 — the Bill of Entry duty breakdown: the invoice keeps the rates and the amounts it was cleared with */
  dutyUsd: numeric("duty_usd", { precision: 18, scale: 2, mode: "number" }),
  dutyUsdRate: numeric("duty_usd_rate", { precision: 18, scale: 6, mode: "number" }),
  dutyAv: numeric("duty_av", { precision: 18, scale: 2, mode: "number" }),
  dutyCdRate: numeric("duty_cd_rate", { precision: 7, scale: 2, mode: "number" }),
  dutyCd: numeric("duty_cd", { precision: 18, scale: 2, mode: "number" }),
  dutyRdRate: numeric("duty_rd_rate", { precision: 7, scale: 2, mode: "number" }),
  dutyRd: numeric("duty_rd", { precision: 18, scale: 2, mode: "number" }),
  dutyAitRate: numeric("duty_ait_rate", { precision: 7, scale: 2, mode: "number" }),
  dutyAit: numeric("duty_ait", { precision: 18, scale: 2, mode: "number" }),
  dutyAtRate: numeric("duty_at_rate", { precision: 7, scale: 2, mode: "number" }),
  dutyAt: numeric("duty_at", { precision: 18, scale: 2, mode: "number" }),
  /* R6.4 — a bonded (IM-7) entry: the duty stack suspended under bond, which the register reports as foregone */
  foregoneCd: numeric("foregone_cd", { precision: 18, scale: 2, mode: "number" }),
  foregoneRd: numeric("foregone_rd", { precision: 18, scale: 2, mode: "number" }),
  foregoneSd: numeric("foregone_sd", { precision: 18, scale: 2, mode: "number" }),
  foregoneVat: numeric("foregone_vat", { precision: 18, scale: 2, mode: "number" }),
  foregoneAit: numeric("foregone_ait", { precision: 18, scale: 2, mode: "number" }),
  foregoneAt: numeric("foregone_at", { precision: 18, scale: 2, mode: "number" }),
  foregoneTotal: numeric("foregone_total", { precision: 18, scale: 2, mode: "number" }),
}, (t) => [
  primaryKey({ columns: [t.purchaseId, t.ord] }),
  index("purchase_lines_item_idx").on(t.itemId),
  // the duty breakdown is a block: an import line has all of it, a local or service line none
  check("purchase_lines_duty_check", sql`(${t.dutyAv} is null and ${t.dutyCd} is null) or (${t.dutyAv} is not null and ${t.dutyCd} is not null)`),
  check("purchase_lines_foregone_check", sql`${t.foregoneTotal} is null or ${t.dutyAv} is not null`),
])

/**
 * R5.3 — credit notes (Mushak 6.7, goods a customer returns against a sales invoice) and debit notes (Mushak 6.8,
 * goods returned to a vendor against a purchase) in one table, `kind` telling them apart — the same choice the
 * stock documents made, because the two registers, the two lists a document's `creditable` / `returnable` answer
 * comes from and the input- and output-tax sides of a VAT return read them the same way.
 *
 * The document each note was raised against is `source_id` (a sale or a purchase) and the party is `party_id` (a
 * customer or a vendor); the response names them by kind, as the mock's two shapes do. A debit note carries two
 * totals a credit note does not — `tti` and the `rebate` it reverses — so they are NULL on the credit side and a
 * check constraint says so.
 */
export const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  /** insertion order — tie-breaker so sorted lists are stable, exactly like the in-memory mock */
  ord: serial("ord").notNull(),
  kind: text("kind", { enum: ["credit", "debit"] }).notNull(),
  /** CN-MMYY#### / DN-MMYY#### — unique, and never reused: the audit trail keeps a deleted draft's number */
  no: text("no").notNull(),
  /** the sales invoice (credit) or purchase (debit) the note was raised against */
  sourceId: text("source_id").notNull(),
  sourceNo: text("source_no").notNull(),
  sourceDate: date("source_date", { mode: "string" }).notNull(),
  sourceMode: text("source_mode").notNull(),
  challanNo: text("challan_no").notNull(),
  /** the customer (credit) or vendor (debit) as printed on the note */
  partyId: text("party_id").notNull(),
  partyName: text("party_name").notNull(),
  partyBin: text("party_bin").notNull(),
  partyAddress: text("party_address").notNull(),
  /** branch the goods come back into (credit) or leave again from (debit) */
  branchId: text("branch_id").notNull(),
  branchName: text("branch_name").notNull(),
  issueDate: date("issue_date", { mode: "string" }).notNull(),
  issueTime: text("issue_time").notNull(),
  reason: text("reason").notNull(),
  note: text("note"),
  issuedBy: text("issued_by").notNull(),
  designation: text("designation").notNull(),
  process: text("process", { enum: ["Created", "Approved", "Cancelled"] }).notNull(),
  subtotal: numeric("subtotal", { precision: 18, scale: 2, mode: "number" }).notNull(),
  sd: numeric("sd", { precision: 18, scale: 2, mode: "number" }).notNull(),
  vat: numeric("vat", { precision: 18, scale: 2, mode: "number" }).notNull(),
  total: numeric("total", { precision: 18, scale: 2, mode: "number" }).notNull(),
  /** debit notes only: the tax incidence of the returned goods, and the input tax credit this note reverses */
  tti: numeric("tti", { precision: 18, scale: 2, mode: "number" }),
  rebate: numeric("rebate", { precision: 18, scale: 2, mode: "number" }),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at"),
  cancelReason: text("cancel_reason"),
  /** the note's own trail: created / edited / approved / cancelled / deleted, as the mock stamped it */
  history: jsonb("history").$type<HistoryEntry[]>(),
  /**
   * A deleted draft leaves the register but keeps its row: the mock removed it from its array and its id counter
   * moved on, so the row is what stops a later note taking the same id. There is no undo for a note.
   */
  deletedAt: ts("deleted_at"),
}, (t) => [
  uniqueIndex("notes_no_key").on(t.no),
  index("notes_live_idx").on(t.createdAt).where(sql`${t.deletedAt} is null`),
  index("notes_kind_idx").on(t.kind),
  index("notes_issue_date_idx").on(t.issueDate),
  /** the register's `?sale=` / `?purchase=` filter, and what a document's creditable / returnable deducts */
  index("notes_source_idx").on(t.sourceId),
  index("notes_party_idx").on(t.partyId),
  index("notes_branch_idx").on(t.branchId),
  check("notes_kind_check", sql`${t.kind} in ('credit','debit')`),
  check("notes_process_check", sql`${t.process} in ('Created','Approved','Cancelled')`),
  check("notes_reason_check", sql`${t.reason} in ('damaged','quality','excess','wrongItem','priceAdjustment','priceDispute')`),
  check("notes_source_mode_check", sql`${t.sourceMode} in ('Local','Foreign','Non-registered')`),
  // the two totals only a debit note has
  check("notes_debit_totals_check", sql`${t.kind} = 'debit' or (${t.tti} is null and ${t.rebate} is null)`),
])

/**
 * The lines of a note: what came back, at the price and the rates the source document carried. The quantity the
 * source document had (`sold_qty` on a credit note, `purchased_qty` on a debit note) is what the register's
 * "remaining" column is measured against, so it stays on the line.
 */
export const noteLines = pgTable("note_lines", {
  noteId: text("note_id").notNull(),
  /** position on the note */
  ord: integer("ord").notNull(),
  itemId: text("item_id").notNull(),
  name: text("name").notNull(),
  hsCode: text("hs_code").notNull(),
  uom: text("uom").notNull(),
  /** credit note: the quantity the sales invoice sold */
  soldQty: numeric("sold_qty", { precision: 18, scale: 3, mode: "number" }),
  /** debit note: the quantity the purchase bought */
  purchasedQty: numeric("purchased_qty", { precision: 18, scale: 3, mode: "number" }),
  qty: numeric("qty", { precision: 18, scale: 3, mode: "number" }).notNull(),
  price: numeric("price", { precision: 18, scale: 2, mode: "number" }).notNull(),
  sdRate: numeric("sd_rate", { precision: 7, scale: 2, mode: "number" }).notNull(),
  vatRate: numeric("vat_rate", { precision: 7, scale: 2, mode: "number" }).notNull(),
  subtotal: numeric("subtotal", { precision: 18, scale: 2, mode: "number" }).notNull(),
  sd: numeric("sd", { precision: 18, scale: 2, mode: "number" }).notNull(),
  vat: numeric("vat", { precision: 18, scale: 2, mode: "number" }).notNull(),
  total: numeric("total", { precision: 18, scale: 2, mode: "number" }).notNull(),
  /** debit notes only */
  tti: numeric("tti", { precision: 18, scale: 2, mode: "number" }),
  rebate: numeric("rebate", { precision: 18, scale: 2, mode: "number" }),
}, (t) => [
  primaryKey({ columns: [t.noteId, t.ord] }),
  index("note_lines_item_idx").on(t.itemId),
  // exactly one of the two source quantities, and the debit-only totals, follow the note's kind
  check("note_lines_qty_check", sql`(${t.soldQty} is null) <> (${t.purchasedQty} is null)`),
  check("note_lines_debit_check", sql`(${t.tti} is null and ${t.rebate} is null) or ${t.purchasedQty} is not null`),
])

/**
 * Modules not yet migrated (purchases, production, accounting, VAT returns…) keep their exact
 * mock behaviour: their state is one JSONB document, saved after every write. R5.2+ replaces it table by table.
 */
export const compatState = pgTable("compat_state", {
  key: text("key").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
})

export const meta = pgTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
})

/** R6.2 (GO 16/Mushak/2019 — at least two backups a day): gzip JSON snapshots of every table, with their SHA-256. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })
export const backups = pgTable("backups", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: ts("at").notNull().defaultNow(),
  kind: text("kind", { enum: ["scheduled", "manual"] }).notNull(),
  /** schedule slot "YYYY-MM-DD HH:MM" (Asia/Dhaka) the backup belongs to */
  slot: text("slot").notNull(),
  by: text("by").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  tables: jsonb("tables").$type<Record<string, number>>().notNull(),
  data: bytea("data").notNull(),
}, (t) => [
  index("backups_at_idx").on(t.at),
  uniqueIndex("backups_scheduled_slot_key").on(t.slot).where(sql`${t.kind} = 'scheduled'`),
  check("backups_kind_check", sql`${t.kind} in ('scheduled','manual')`),
])
