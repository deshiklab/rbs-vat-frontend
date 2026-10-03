/**
 * Compat bundle (dist/compat.js): the mock route handlers plus the helpers the native modules need from the same
 * in-memory world. Loaded once at boot, after main.ts has put the saved state into the globals.
 */
export { routeModules } from "./routes.gen"
export { db, usedBranchIds, withStock } from "@/lib/mock/db"
export { badUnit, unitUsage } from "@/lib/mock/units"
export { auditStore, dhakaDay, diff } from "@/lib/mock/audit"
export { tariff, TARIFF_FY } from "@/lib/mock/tariff"
export { userStore, DEMO_PASSWORD } from "@/lib/mock/users"
export { company } from "@/lib/mock/company"
// R5.2: the party rules (aggregates, duplicate/mode checks, stored shape, ids) are shared with the native module,
// so the PostgreSQL API and the mock handlers cannot drift. They read the documents, which are still compat state.
export {
  buildParty, newPartyId, normaliseParty, partyCsvColumns, partyDocs, partyErrors, partyLabel, partyRow, partySpec, PARTY_FIELDS,
} from "@/app/api/v1/_parties"
// R5.2: the item and master-item rules, shared the same way. `withStock` derives `remain` from the item's own
// counters; the branch split and the ledger stay derived from documents (compat state) until R5.3.
export {
  buildItem, buildMaster, flatMaster, itemCsvColumns, itemEdit, ITEM_FIELDS, itemSpec, itemStockValue, masterCsvColumns,
  MASTER_FIELDS, masterErrors, masterFields, masterRow, masterSpec, newItemId, skuTaken,
} from "@/app/api/v1/_items"
// R5.3: the stock-document rules, shared the same way — validation and pricing of the lines, the monthly numbers
// (which the audit trail takes part in), the branch-stock checks around approving and cancelling, the item counter
// a damage entry moves, the document's own history, and the register's spec and CSV columns. The documents
// themselves live in `stock_documents`; the branch split and an item's ledger still derive from *every* movement
// document, so they stay with the compat layer until the rest have tables (R5.3–R5.4).
export {
  approveDoc, buildStock, cancelDoc, findStockDoc, LABEL as STOCK_LABEL, nextStockNo, stampHistory as stampStockHistory,
  stockCsvColumns, stockCsvRows, stockDocs, stockDocDiff, stockSource, stockSpec,
  type DamageFields, type StockBuilt, type StockProblem, type TransferFields,
} from "@/app/api/v1/_stock"
// R5.3: the sale rules, shared the same way — what an invoice body may contain and how its lines are priced
// (_r3.parseSale), the numbers a new invoice takes, the stock and lot checks around approving and cancelling, the
// notes and settlements that block a cancellation, the export proceeds (PRC) entries, the document's own history,
// the diff an edit records and the register's spec, CSV columns and facet labels. The invoices themselves live in
// `sales`; the branch stock, the ledger and the VAT returns still derive from every document, so they stay with the
// compat layer until the rest have tables (R5.3–R5.5).
export {
  approveRule, buildRealisation, cancelRule, deleteRule, docDiff, editDraftRule, parseRealisation, purchaseCategory,
  purchaseCategoryRule, purchaseCsvColumns, purchaseCsvRows, purchaseFacetLabels, purchaseIdentity, parsePurchase,
  purchaseSpec, realisableRule, realisationNotes, realisationRemovedNotes, saleCategory, saleCsvColumns, saleCsvRows,
  saleFacetLabels, saleIdentity, saleSpec, saleStockRule, stampDocHistory, noteDiff, noteDraftRule, stampNoteHistory,
} from "@/app/api/v1/_docs"
// R5.3: the credit and debit note rules, shared the same way — what a note body may contain and how a returned line
// is priced pro rata, the numbers a new note takes, the source document that has to still be approved, the stock a
// cancellation needs, the registers' specs, filters and CSV columns. The notes themselves live in `notes`; what is
// still returnable on an invoice, a customer's credit and the VAT returns still derive from every document.
export {
  buildCredit, claimCreditId, creditApproveRule, creditCancelRule, creditCsvColumns, creditDeleteRule,
  creditFacetLabels, creditIdentity, creditMovedRule, creditSourceFilter, creditSpec, postCredit,
} from "@/app/api/v1/_r3"
export {
  buildDebit, claimDebitId, debitApproveRule, debitCancelRule, debitCsvColumns, debitDeleteRule, debitFacetLabels,
  debitIdentity, debitSourceFilter, debitSpec, debitStockRule, postDebit, returnable,
} from "@/app/api/v1/_r2"
export { creditable, parseSale } from "@/app/api/v1/_r3"

// R5.3: how a purchase body becomes the document it stores — the local, the service and the import (Bill of Entry,
// duty per line) variants, priced by the same functions the mock and the static demo run.
export { buildPurchaseFields } from "@/lib/mock/build"
export { periodLocked } from "@/app/api/v1/_r4"
export { branchLabels, postStock, stockShortfall } from "@/lib/mock/db"
