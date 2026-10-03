"""
R5 backend checks (NestJS + PostgreSQL, branch r5-nestjs) — what the stateless mock could not do.

Runs through the Next.js frontend (BASE_URL, default http://localhost:3000), which proxies /api/v1 to the API.
  API_RESTART_CMD  shell command that restarts the API and returns once it is healthy (enables the restart checks)
  DATABASE_URL     enables the direct database checks (needs `psql`)
  SESSION_SECRET   enables the forged-token check (must equal the API's secret)
Run on a freshly seeded database (`node api/dist/main.js --reset`); it creates its own users and records.
"""
import base64, hashlib, hmac, json, os, subprocess, sys, time, uuid
import requests

BASE = os.environ.get("BASE_URL", "http://localhost:3000") + "/api/v1"
PW = "demo1234"
RESTART = os.environ.get("API_RESTART_CMD")
DB_URL = os.environ.get("DATABASE_URL")
SECRET = os.environ.get("SESSION_SECRET")
API_LOG = os.environ.get("API_LOG")
ok = fail = skip = 0
TAG = uuid.uuid4().hex[:6]

# ── R5.2 upgrade drill ─────────────────────────────────────────────────────────────────────────────────────────
# A database written before R5.2 holds its master data inside compat_state (deleted parties in the undo buffer) and
# has no parties/items/master_items rows. These statements rebuild exactly that shape from the live tables — the
# stored row as the compat world had it: camelCase fields, optional ones absent rather than null, timestamps in the
# ISO-8601 the snapshot carries — so the first boot on this code has to adopt it, and the drill can prove nothing was
# lost. Nothing here ships: it is the inverse of `adoptCompatRows()` in api/src/boot.ts, for the test only.
_NO_NULLS = "(select jsonb_object_agg(key, value) from jsonb_each({}) where value <> 'null'::jsonb)"
_ISO = """to_char({} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')"""
PARTY_DOC = _NO_NULLS.format("""jsonb_build_object(
    'id', id, 'name', name, 'bin', bin, 'mode', mode, 'mobile', mobile, 'address', address, 'kind', kind,
    'country', country, 'email', email, 'contactPerson', contact_person, 'active', active, 'creditLimit', credit_limit,
    'vdsWithholder', vds_withholder, 'exporterType', exporter_type, 'bondLicenseNo', bond_license_no,
    'bondLicenseExpiry', bond_license_expiry, 'associationNo', association_no)""")
ITEM_DOC = _NO_NULLS.format("""jsonb_build_object(
    'id', id, 'hsCode', hs_code, 'group', "group", 'masterItem', master_item, 'brand', brand, 'name', name, 'unit', unit,
    'sku', sku, 'purchasePrice', purchase_price, 'costPrice', cost_price, 'salePrice', sale_price, 'vatRate', vat_rate,
    'sdRate', sd_rate, 'opening', opening, 'purchased', purchased, 'prodReceive', prod_receive, 'prodIssue', prod_issue,
    'sold', sold, 'damage', damage, 'reorderLevel', reorder_level, 'active', active)""")
MASTER_DOC = _NO_NULLS.format("""jsonb_build_object(
    'id', id, 'name', name, 'hsCode', hs_code, 'group', "group", 'category', category, 'unit', unit,
    'priceMethod', price_method, 'description', description,
    'rates', jsonb_build_object('vat', vat, 'sd', sd, 'cd', cd, 'rd', rd, 'ait', ait, 'at', at),
    'overrideReason', override_reason, 'active', active, 'createdAt', """ + _ISO.format("created_at") + """,
    'updatedAt', """ + _ISO.format("updated_at") + """, 'history', history)""")
PARTY_AGG = lambda kind: (f"(select coalesce(jsonb_agg(doc order by ord), '[]'::jsonb) "
                          f"from (select ord, {PARTY_DOC} as doc from parties "
                          f"where kind = '{kind}' and deleted_at is null) {kind[0]})")
# the four collections back inside the snapshot
PRE_R52_COLLECTIONS = f"""update compat_state set data = jsonb_set(data, '{{db}}', (data->'db') || jsonb_build_object(
  'customers', {PARTY_AGG('customer')},
  'vendors', {PARTY_AGG('vendor')},
  'items', (select coalesce(jsonb_agg({ITEM_DOC} order by ord), '[]'::jsonb) from items),
  'masterItems', (select coalesce(jsonb_agg({MASTER_DOC} order by ord), '[]'::jsonb) from master_items)
)) where key = 'main'"""
# … and the deleted parties back into the undo buffer, keeping the documents already in it
PRE_R52_TRASH = f"""update compat_state set data = jsonb_set(data, '{{db,trash}}',
  coalesce(data->'db'->'trash', '[]'::jsonb) || (
    select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'doc', doc, 'at', {_ISO.format('deleted_at')})
                              order by deleted_at), '[]'::jsonb)
    from (select kind, deleted_at, {PARTY_DOC} as doc from parties where deleted_at is not null) t),
  true) where key = 'main'"""
PARTY_TRASH_LEFT = """select count(*) from compat_state where jsonb_typeof(data->'db'->'trash') = 'array'
  and exists (select 1 from jsonb_array_elements(data->'db'->'trash') t where t->>'kind' in ('customer', 'vendor'))"""

# ── R5.3 upgrade drill ─────────────────────────────────────────────────────────────────────────────────────────
# The same, one release later: a database written before R5.3 holds its stock documents (transfers and damage
# entries, lines included) inside compat_state and has no stock_documents rows. These statements rebuild that shape
# from the live tables, so the first boot on this code has to adopt it. Nothing here ships either: it is the inverse
# of the stock-document half of `adoptCompatRows()` in api/src/boot.ts, for the test only.
STOCK_LINES_DOC = """(select coalesce(jsonb_agg(jsonb_build_object(
      'itemId', l.item_id, 'name', l.name, 'sku', l.sku, 'uom', l.uom, 'qty', l.qty, 'cost', l.cost, 'value', l.value)
      order by l.ord), '[]'::jsonb) from stock_document_lines l where l.doc_id = d.id)"""
STOCK_DOC = _NO_NULLS.format("""jsonb_build_object(
    'kind', kind, 'id', id, 'no', no, 'date', date, 'process', process, 'lines', """ + STOCK_LINES_DOC + """,
    'totalQty', total_qty, 'totalValue', total_value, 'note', note,
    'fromBranchId', case when kind = 'transfer' then from_branch_id end,
    'fromBranch', case when kind = 'transfer' then from_branch end,
    'toBranchId', to_branch_id, 'toBranch', to_branch, 'vehicle', vehicle,
    'branchId', case when kind = 'damage' then from_branch_id end,
    'branch', case when kind = 'damage' then from_branch end, 'reason', reason,
    'issuedBy', issued_by, 'createdAt', """ + _ISO.format("created_at") + """,
    'updatedAt', """ + _ISO.format("updated_at") + """, 'cancelReason', cancel_reason, 'history', history)""")
STOCK_AGG = lambda kind: (f"(select coalesce(jsonb_agg({STOCK_DOC} order by ord), '[]'::jsonb) "
                          f"from stock_documents d where kind = '{kind}')")
# both collections back inside the snapshot
PRE_R53_COLLECTIONS = f"""update compat_state set data = jsonb_set(data, '{{db}}', (data->'db') || jsonb_build_object(
  'transfers', {STOCK_AGG('transfer')},
  'damages', {STOCK_AGG('damage')}
)) where key = 'main'"""

# ── R5.3 upgrade drill: the sales invoices ────────────────────────────────────────────────────────────────────
# A database written before the invoices had tables holds them inside compat_state — lines and proceeds entries
# included, a deleted draft in the undo buffer. These statements rebuild that shape from the live tables, so the
# first boot on this code has to adopt it. Nothing here ships either: it is the inverse of the sales half of
# `adoptCompatRows()` in api/src/boot.ts, for the test only.
SALE_LINES_DOC = ("""(select coalesce(jsonb_agg(""" + _NO_NULLS.format("""jsonb_build_object(
      'itemId', l.item_id, 'name', l.name, 'hsCode', l.hs_code, 'uom', l.uom, 'qty', l.qty, 'price', l.price,
      'sdRate', l.sd_rate, 'vatRate', l.vat_rate, 'subtotal', l.subtotal, 'sd', l.sd, 'vat', l.vat, 'total', l.total,
      'batchId', l.batch_id, 'batchNo', l.batch_no)""")
    + """ order by l.ord), '[]'::jsonb) from sale_lines l where l.sale_id = s.id)""")
SALE_REALS_DOC = ("""(select coalesce(jsonb_agg(""" + _NO_NULLS.format("""jsonb_build_object(
      'id', r.id, 'date', r.date, 'bank', r.bank, 'prcNo', r.prc_no, 'fcAmount', r.fc_amount, 'rate', r.rate,
      'bdt', r.bdt, 'note', r.note, 'by', r.by, 'at', """ + _ISO.format("r.at") + """, 'batchId', r.batch_id)""")
    + """ order by r.ord), '[]'::jsonb) from sale_realisations r where r.sale_id = s.id)""")
# the shipping documents are columns of the invoice; `export_deemed` is the block's presence marker
SALE_EXPORT_DOC = ("""(case when s.export_deemed is null then null else """
    + _NO_NULLS.format("""jsonb_build_object(
      'deemed', s.export_deemed, 'lcNo', s.export_lc_no, 'lcDate', s.export_lc_date,
      'customsHouse', s.export_customs_house, 'country', s.export_country, 'billNo', s.export_bill_no,
      'billDate', s.export_bill_date, 'shippingAddress', s.export_shipping_address, 'cnfFirm', s.export_cnf_firm,
      'udNo', s.export_ud_no, 'udDate', s.export_ud_date, 'expNo', s.export_exp_no, 'currency', s.export_currency,
      'fcValue', s.export_fc_value, 'exchangeRate', s.export_exchange_rate, 'exporterBond', s.export_exporter_bond,
      'ownUdNo', s.export_own_ud_no,
      'realisations', case when s.export_realisations then """ + SALE_REALS_DOC + """ else null end)""")
    + " end)")
SALE_DOC = ("""(""" + _NO_NULLS.format("""jsonb_build_object(
    'id', s.id, 'invoiceNo', s.invoice_no, 'challanNo', s.challan_no, 'issueDate', s.issue_date,
    'issueTime', s.issue_time, 'process', s.process, 'category', s.category, 'branchId', s.branch_id,
    'branchName', s.branch_name, 'customerId', s.customer_id, 'customerName', s.customer_name,
    'customerBin', s.customer_bin, 'customerAddress', s.customer_address, 'deliveryAddress', s.delivery_address,
    'vehicle', s.vehicle, 'mode', s.mode, 'method', s.method, 'vds', s.vds, 'subtotal', s.subtotal, 'sd', s.sd,
    'vat', s.vat, 'discount', s.discount, 'netTotal', s.net_total, 'paid', s.paid, 'due', s.due,
    'lines', """ + SALE_LINES_DOC + """, 'issuedBy', s.issued_by, 'designation', s.designation,
    'narration', s.narration, 'createdAt', """ + _ISO.format("s.created_at") + """,
    'updatedAt', """ + _ISO.format("s.updated_at") + """, 'cancelReason', s.cancel_reason, 'history', s.history,
    'export', """ + SALE_EXPORT_DOC + """)""") + ")")
SALE_AGG = f"(select coalesce(jsonb_agg({SALE_DOC} order by s.ord), '[]'::jsonb) from sales s where s.deleted_at is null)"
# the invoices back inside the snapshot …
PRE_R53_SALES = f"""update compat_state set data = jsonb_set(data, '{{db}}', (data->'db') || jsonb_build_object(
  'sales', {SALE_AGG}
)) where key = 'main'"""
# … and the deleted drafts back into the undo buffer, keeping the documents already in it
PRE_R53_SALE_TRASH = f"""update compat_state set data = jsonb_set(data, '{{db,trash}}',
  coalesce(data->'db'->'trash', '[]'::jsonb) || (
    select coalesce(jsonb_agg(jsonb_build_object('kind', 'sale', 'doc', doc, 'at', {_ISO.format('deleted_at')})
                              order by deleted_at), '[]'::jsonb)
    from (select s.deleted_at, {SALE_DOC} as doc from sales s where s.deleted_at is not null) t),
  true) where key = 'main'"""
SALE_TRASH_LEFT = """select count(*) from compat_state where jsonb_typeof(data->'db'->'trash') = 'array'
  and exists (select 1 from jsonb_array_elements(data->'db'->'trash') t where t->>'kind' = 'sale')"""

# ── R5.3 upgrade drill: the purchases ────────────────────────────────────────────────────────────────────────
# A database written before the purchases had tables holds them inside compat_state — lines, Bills of Entry and the
# duty breakdown of every import line included, a deleted draft in the undo buffer. These statements rebuild that
# shape from the live tables, so the first boot on this code has to adopt it. Nothing here ships either: it is the
# inverse of the purchase half of `adoptCompatRows()` in api/src/boot.ts, for the test only.
PURCHASE_LINES_DOC = ("""(select coalesce(jsonb_agg(""" + _NO_NULLS.format("""jsonb_build_object(
      'itemId', l.item_id, 'name', l.name, 'hsCode', l.hs_code, 'uom', l.uom, 'qty', l.qty, 'price', l.price,
      'sdRate', l.sd_rate, 'vatRate', l.vat_rate, 'subtotal', l.subtotal, 'sd', l.sd, 'vat', l.vat, 'total', l.total,
      'rebateable', l.rebateable, 'vds', l.vds, 'tti', l.tti,
      'duty', case when l.duty_av is null then null else """ + _NO_NULLS.format("""jsonb_build_object(
        'usd', l.duty_usd, 'usdRate', l.duty_usd_rate, 'av', l.duty_av, 'cdRate', l.duty_cd_rate, 'cd', l.duty_cd,
        'rdRate', l.duty_rd_rate, 'rd', l.duty_rd, 'aitRate', l.duty_ait_rate, 'ait', l.duty_ait,
        'atRate', l.duty_at_rate, 'at', l.duty_at,
        'foregone', case when l.foregone_total is null then null else jsonb_build_object(
          'cd', l.foregone_cd, 'rd', l.foregone_rd, 'sd', l.foregone_sd, 'vat', l.foregone_vat,
          'ait', l.foregone_ait, 'at', l.foregone_at, 'total', l.foregone_total) end)""") + """ end)""")
    + """ order by l.ord), '[]'::jsonb) from purchase_lines l where l.purchase_id = p.id)""")
# the Bill of Entry is a block of its own columns; `boe_no` is its presence marker
PURCHASE_BOE_DOC = ("""(case when p.boe_no is null then null else """ + _NO_NULLS.format("""jsonb_build_object(
      'no', p.boe_no, 'date', p.boe_date, 'lcNo', p.boe_lc_no, 'lcDate', p.boe_lc_date,
      'customsHouse', p.boe_customs_house, 'origin', p.boe_origin, 'cnfFirm', p.boe_cnf_firm,
      'receiveAddress', p.boe_receive_address, 'bonded', p.boe_bonded, 'udNo', p.boe_ud_no)""") + """ end)""")
PURCHASE_DOC = ("""(""" + _NO_NULLS.format("""jsonb_build_object(
    'id', p.id, 'invoiceNo', p.invoice_no, 'challanNo', p.challan_no, 'challanDate', p.challan_date,
    'issueDate', p.issue_date, 'process', p.process, 'category', p.category, 'branchId', p.branch_id,
    'branchName', p.branch_name, 'vendorId', p.vendor_id, 'vendorName', p.vendor_name, 'vendorBin', p.vendor_bin,
    'vendorAddress', p.vendor_address, 'mode', p.mode, 'method', p.method, 'subtotal', p.subtotal, 'sd', p.sd,
    'vat', p.vat, 'discount', p.discount, 'netTotal', p.net_total, 'paid', p.paid, 'due', p.due, 'tti', p.tti,
    'rebate', p.rebate, 'lines', """ + PURCHASE_LINES_DOC + """, 'issuedBy', p.issued_by,
    'designation', p.designation, 'narration', p.narration, 'createdAt', """ + _ISO.format("p.created_at") + """,
    'updatedAt', """ + _ISO.format("p.updated_at") + """, 'cancelReason', p.cancel_reason, 'history', p.history,
    'boe', """ + PURCHASE_BOE_DOC + """)""") + ")")
PURCHASE_AGG = (f"(select coalesce(jsonb_agg({PURCHASE_DOC} order by p.ord), '[]'::jsonb) "
                f"from purchases p where p.deleted_at is null)")
# the purchases back inside the snapshot …
PRE_R53_PURCHASES = f"""update compat_state set data = jsonb_set(data, '{{db}}', (data->'db') || jsonb_build_object(
  'purchases', {PURCHASE_AGG}
)) where key = 'main'"""
# … and the deleted drafts back into the undo buffer, keeping the documents already in it
PRE_R53_PURCHASE_TRASH = f"""update compat_state set data = jsonb_set(data, '{{db,trash}}',
  coalesce(data->'db'->'trash', '[]'::jsonb) || (
    select coalesce(jsonb_agg(jsonb_build_object('kind', 'purchase', 'doc', doc, 'at', {_ISO.format('deleted_at')})
                              order by deleted_at), '[]'::jsonb)
    from (select p.deleted_at, {PURCHASE_DOC} as doc from purchases p where p.deleted_at is not null) t),
  true) where key = 'main'"""
PURCHASE_TRASH_LEFT = """select count(*) from compat_state where jsonb_typeof(data->'db'->'trash') = 'array'
  and exists (select 1 from jsonb_array_elements(data->'db'->'trash') t where t->>'kind' = 'purchase')"""

# ── R5.3 upgrade drill: the credit and debit notes ───────────────────────────────────────────────────────────
# A database written before the notes had tables holds both families inside compat_state. These statements rebuild
# that shape from the live tables — one table with a `kind`, so the two documents' own field names (saleId /
# purchaseId, customerName / vendorName, soldQty / purchasedQty) come back out of the shared columns. Nothing here
# ships either: it is the inverse of the notes half of `adoptCompatRows()` in api/src/boot.ts, for the test only.
NOTE_LINES_DOC = ("""(select coalesce(jsonb_agg(""" + _NO_NULLS.format("""jsonb_build_object(
      'itemId', l.item_id, 'name', l.name, 'hsCode', l.hs_code, 'uom', l.uom, 'soldQty', l.sold_qty,
      'purchasedQty', l.purchased_qty, 'qty', l.qty, 'price', l.price, 'sdRate', l.sd_rate, 'vatRate', l.vat_rate,
      'subtotal', l.subtotal, 'sd', l.sd, 'vat', l.vat, 'total', l.total, 'tti', l.tti, 'rebate', l.rebate)""")
    + """ order by l.ord), '[]'::jsonb) from note_lines l where l.note_id = n.id)""")
NOTE_DOC = ("""(""" + _NO_NULLS.format("""jsonb_build_object(
    'id', n.id, 'no', n.no,
    'saleId', case when n.kind = 'credit' then n.source_id end,
    'saleNo', case when n.kind = 'credit' then n.source_no end,
    'saleDate', case when n.kind = 'credit' then n.source_date end,
    'saleMode', case when n.kind = 'credit' then n.source_mode end,
    'purchaseId', case when n.kind = 'debit' then n.source_id end,
    'purchaseNo', case when n.kind = 'debit' then n.source_no end,
    'purchaseDate', case when n.kind = 'debit' then n.source_date end,
    'purchaseMode', case when n.kind = 'debit' then n.source_mode end,
    'challanNo', n.challan_no,
    'customerId', case when n.kind = 'credit' then n.party_id end,
    'customerName', case when n.kind = 'credit' then n.party_name end,
    'customerBin', case when n.kind = 'credit' then n.party_bin end,
    'customerAddress', case when n.kind = 'credit' then n.party_address end,
    'vendorId', case when n.kind = 'debit' then n.party_id end,
    'vendorName', case when n.kind = 'debit' then n.party_name end,
    'vendorBin', case when n.kind = 'debit' then n.party_bin end,
    'vendorAddress', case when n.kind = 'debit' then n.party_address end,
    'branchId', n.branch_id, 'branchName', n.branch_name, 'issueDate', n.issue_date, 'issueTime', n.issue_time,
    'reason', n.reason, 'note', n.note, 'issuedBy', n.issued_by, 'designation', n.designation, 'process', n.process,
    'lines', """ + NOTE_LINES_DOC + """, 'subtotal', n.subtotal, 'sd', n.sd, 'vat', n.vat, 'total', n.total,
    'tti', case when n.kind = 'debit' then n.tti end, 'rebate', case when n.kind = 'debit' then n.rebate end,
    'createdAt', """ + _ISO.format("n.created_at") + """, 'updatedAt', """ + _ISO.format("n.updated_at") + """,
    'cancelReason', n.cancel_reason, 'history', n.history)""") + ")")
NOTE_AGG = lambda kind: (f"(select coalesce(jsonb_agg({NOTE_DOC} order by n.ord), '[]'::jsonb) "
                         f"from notes n where n.kind = '{kind}' and n.deleted_at is null)")
# both collections back inside the snapshot (a deleted draft has no place there: the mock removed it for good)
PRE_R53_NOTES = f"""update compat_state set data = jsonb_set(data, '{{db}}', (data->'db') || jsonb_build_object(
  'creditNotes', {NOTE_AGG('credit')},
  'debitNotes', {NOTE_AGG('debit')}
)) where key = 'main'"""


def check(cond, msg):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {msg}")
    else:
        fail += 1
        print(f"  FAIL {msg}")


def skipped(msg):
    global skip
    skip += 1
    print(f"  skip {msg}")


def session(user, pw=PW, remember=False):
    s = requests.Session()
    r = s.post(f"{BASE}/auth/login", json={"username": user, "password": pw, "remember": remember})
    assert r.status_code == 200, f"login {user}: {r.status_code} {r.text[:200]}"
    return s


def token_of(s):
    return s.cookies.get("dizivat_session")


def with_token(tok):
    s = requests.Session()
    s.cookies.set("dizivat_session", tok)
    return s


def restart():
    t = time.time()
    subprocess.run(RESTART, shell=True, check=True)
    for _ in range(60):
        try:
            if requests.get(f"{BASE}/health", timeout=2).ok:
                return time.time() - t
        except requests.RequestException:
            pass
        time.sleep(0.5)
    raise RuntimeError("API did not come back")


def psql(q):
    return subprocess.run(["psql", DB_URL, "-At", "-c", q], capture_output=True, text=True, check=True).stdout.strip()


def invite(admin, username, role="operator"):
    r = admin.post(f"{BASE}/users", json={"username": username, "name": f"Test {username.title()}", "designation": "Tester",
                                           "email": f"{username}@example.com", "mobile": "", "department": "", "role": role, "active": True})
    assert r.status_code == 201, r.text
    return r.json()


def run():
    print(f"R5 backend checks against {BASE}")

    print("health")
    h = requests.get(f"{BASE}/health").json()
    check(h.get("ok") and h["db"]["ok"], f"health: API up, database reachable ({h['db']['ms']} ms)")
    check(h["modules"]["native"] >= 7 and h["modules"]["compatRoutes"] > 0, f"health: {h['modules']['native']} native modules, {h['modules']['compatRoutes']} compat routes")

    print("sign-out is real (server-side sessions)")
    s = session("kamal")
    tok = token_of(s)
    check(s.get(f"{BASE}/me").status_code == 200, "cookie works while signed in")
    s.post(f"{BASE}/auth/logout")
    check(with_token(tok).get(f"{BASE}/me").status_code == 401, "a copied cookie stops working after sign-out")
    check(with_token(tok).get(f"{BASE}/sales?size=1").status_code == 401, "…on compat routes too")

    admin = session("admin")
    print("admin reset and deactivation revoke sessions")
    u = invite(admin, f"r5a{TAG}")
    uid, temp = u["user"]["id"], u["tempPassword"]
    check(u["user"].get("mustChangePassword") is True, "invited user must change the temporary password")
    li = requests.get(f"{BASE}/auth/login-info").json()
    check(all(d["username"] != u["user"]["username"] for d in li["demo"]), "invited user is not listed as a demo account")
    x = session(u["user"]["username"], temp)
    check(x.get(f"{BASE}/me").status_code == 200, "invited user signs in with the temporary password")
    r = admin.post(f"{BASE}/users/{uid}/reset-password")
    temp2 = r.json()["tempPassword"]
    check(r.status_code == 200 and temp2 != temp, "admin reset issues a new one-time password")
    check(x.get(f"{BASE}/me").status_code == 401, "reset signs the user out immediately")
    check(requests.post(f"{BASE}/auth/login", json={"username": u["user"]["username"], "password": temp}).status_code == 401, "old temporary password no longer works")
    x = session(u["user"]["username"], temp2)
    body = admin.get(f"{BASE}/users/{uid}").json()
    body.update(active=False)
    for k in ("id", "username", "initials", "createdAt", "lastSignInAt", "mustChangePassword"):
        body.pop(k, None)
    r = admin.put(f"{BASE}/users/{uid}", json=body)
    check(r.status_code == 200 and r.json()["active"] is False, "admin deactivates the user")
    check(x.get(f"{BASE}/me").status_code == 401, "deactivation signs the user out immediately")
    check(requests.post(f"{BASE}/auth/login", json={"username": u["user"]["username"], "password": temp2}).status_code == 403, "deactivated user cannot sign in (403)")

    print("password change keeps this browser, revokes the others")
    v = invite(admin, f"r5b{TAG}")
    name, temp = v["user"]["username"], v["tempPassword"]
    a, b = session(name, temp, remember=True), session(name, temp)
    new_pw = f"Fresh{TAG}9x"
    r = a.put(f"{BASE}/me/password", json={"current": temp, "next": new_pw, "confirm": new_pw})
    check(r.status_code == 200 and not r.json()["user"].get("mustChangePassword"), "password changed; forced change cleared")
    check(a.get(f"{BASE}/me").status_code == 200, "this browser stays signed in (fresh cookie)")
    check(b.get(f"{BASE}/me").status_code == 401, "the other browser is signed out")

    print("brute-force lockout")
    w = invite(admin, f"r5c{TAG}")
    wname = w["user"]["username"]
    codes = [requests.post(f"{BASE}/auth/login", json={"username": wname, "password": "wrong-pass"}).status_code for _ in range(5)]
    r = requests.post(f"{BASE}/auth/login", json={"username": wname, "password": w["tempPassword"]})
    check(codes == [401] * 5 and r.status_code == 429, "5 wrong passwords → locked (429) even with the right one")

    if SECRET:
        print("forged / legacy tokens")
        def sign(p):
            body = base64.urlsafe_b64encode(json.dumps(p).encode()).rstrip(b"=").decode()
            sig = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
            return f"{body}.{sig}"
        now = int(time.time())
        check(with_token(sign({"uid": "u5", "exp": now + 3600, "iat": now})).get(f"{BASE}/me").status_code == 401, "validly signed token without a session id is rejected")
        check(with_token(sign({"uid": "u5", "sid": "made-up", "exp": now + 3600, "iat": now})).get(f"{BASE}/me").status_code == 401, "validly signed token for an unknown session is rejected")
    else:
        skipped("forged-token checks (SESSION_SECRET not set)")

    print("writes land in PostgreSQL")
    arif = session("arif")
    cust = arif.post(f"{BASE}/customers", json={"name": f"R5 Persist Test {TAG}", "mode": "Foreign", "country": "Japan", "address": "1-2-3 Marunouchi, Tokyo"})
    check(cust.status_code == 201, f"native (R5.2): customer created ({cust.status_code})")
    cid = cust.json().get("id")
    # a second customer is deleted and restored below: since R5.2 a delete is a `deleted_at` stamp, so the record
    # stays in PostgreSQL (and stays deleted across a restart) instead of living in the in-memory undo buffer
    gone = arif.post(f"{BASE}/vendors", json={"name": f"R5 Deleted Vendor {TAG}", "mode": "Foreign", "country": "China", "address": "Shenzhen, China"})
    gid = gone.json().get("id")
    ud_body = {"kind": "UD", "no": f"BKMEA/UD/2026/R5{TAG}".upper(), "date": "2026-09-20", "customerId": "c10",
               "masterLcNo": f"EXP-LC-R5-{TAG}", "buyer": "E2E BUYER", "expiry": "2027-03-31", "lines": [{"itemId": "i21", "qty": 1000}]}
    ud = arif.post(f"{BASE}/vat/uds", json=ud_body)
    check(ud.status_code == 201, f"compat: UD created for the snapshot check ({ud.status_code})")
    unit = arif.post(f"{BASE}/units", json={"code": f"R5{TAG[:3]}", "name": "R5 test unit", "decimals": 1, "active": True})
    check(unit.status_code == 201 and unit.json()["id"].startswith("un"), "native: unit created")
    # R5.2: SKUs and master items are native too. A master item's rename carries its SKUs along (they quote its name),
    # a compat document moves an item's counters, and the R6.2 bulk import creates SKUs — all three must reach the table.
    m0 = arif.get(f"{BASE}/master-items", params={"size": 1}).json()["data"][0]
    HS, UNIT, RATES = m0["hsCode"], m0["unit"], m0["rates"]
    master_body = {"hsCode": HS, "name": f"R5 Master {TAG}", "group": "Raw Material", "category": "general", "unit": UNIT,
                   "priceMethod": "average", "description": "", "rates": RATES, "overrideReason": "", "active": True}
    mi = arif.post(f"{BASE}/master-items", json=master_body)
    check(mi.status_code == 201 and mi.json()["id"].startswith("m"), f"native (R5.2): master item created ({mi.status_code})")
    mid = mi.json().get("id")
    item_body = {"name": f"R5 Item {TAG}", "hsCode": HS, "group": "Raw Material", "unit": UNIT, "sku": f"R5-{TAG}",
                 "purchasePrice": 100, "salePrice": 150, "vatRate": 15, "sdRate": 0, "reorderLevel": 10, "active": True,
                 "masterItemId": mid}
    it = arif.post(f"{BASE}/items", json=item_body)
    check(it.status_code == 201 and it.json()["costPrice"] == 112 and it.json()["remain"] == 0,
          f"native (R5.2): SKU created, cost price derived ({it.status_code})")
    iid = it.json().get("id")
    check(arif.post(f"{BASE}/items", json={**item_body, "name": "Same SKU again"}).status_code == 422, "a duplicate SKU is refused (422)")
    check(arif.post(f"{BASE}/items", json={**item_body, "sku": f"R5B-{TAG}", "masterItemId": "m99999"}).status_code == 422,
          "an unknown master item is refused (422)")
    rn = arif.put(f"{BASE}/master-items/{mid}", json={**master_body, "name": f"R5 Master Renamed {TAG}"})
    check(rn.status_code == 200 and arif.get(f"{BASE}/items/{iid}").json()["masterItem"] == f"R5 Master Renamed {TAG}",
          "R5.2: renaming a master item carries its SKUs along")
    check(any(x["id"] == iid for x in arif.get(f"{BASE}/master-items/{mid}").json()["skus"]), "R5.2: …and it still lists them")
    branch = arif.get(f"{BASE}/stock").json()["branches"][0]["id"]
    op = arif.post(f"{BASE}/opening-stock", json={"itemId": iid, "branchId": branch, "date": "2026-09-22", "inputTax": "standard",
                                                  "qty": 40, "price": 100, "process": "Approved"})
    check(op.status_code == 201 and arif.get(f"{BASE}/items/{iid}").json()["remain"] == 40,
          f"compat: an approved opening entry moves the SKU's stock ({op.status_code})")
    imp = arif.post(f"{BASE}/import", json={"entity": "items", "dryRun": False, "rows": [
        {"name": f"R5 Imported {TAG}", "hsCode": HS, "group": "Consumable", "unit": UNIT, "sku": f"R5IMP-{TAG}",
         "purchasePrice": "12.5", "salePrice": "20", "vatRate": "15", "sdRate": "0", "reorderLevel": "0", "active": "yes"}]})
    check(imp.status_code == 201 and imp.json()["created"] == 1, f"compat (R6.2): the bulk import created a SKU ({imp.status_code})")
    arif.put(f"{BASE}/me/preferences", json={"density": "compact", "accent": "violet"})
    arif.post(f"{BASE}/me/views", json={"table": "sales", "name": f"R5 view {TAG}", "query": "status=approved"})
    audit = arif.get(f"{BASE}/audit", params={"q": TAG, "size": 50}).json()
    check(audit["total"] >= 2, f"audit trail has the new events ({audit['total']})")
    before_ids = sorted(e["id"] for e in audit["data"])

    if DB_URL:
        hashes = psql("select password_hash from users").splitlines()
        check(hashes and all(h.startswith("scrypt$") for h in hashes), f"all {len(hashes)} passwords are scrypt hashes")
        check(PW not in psql("select string_agg(password_hash, '') from users"), "no password stored in clear")
        check(psql(f"select count(*) from audit_events where ref like '%{TAG}%'") != "0", "audit events are rows in audit_events")
        check(int(psql("select count(*) from sessions where revoked_at is not null")) >= 3, "revoked sessions are kept for review")
        check(psql(f"select count(*) from parties where name ilike '%R5 Persist Test {TAG}%'") == "1", "R5.2: customers are rows in the parties table")
        check(psql(f"select count(*) from compat_state where data::text ilike '%R5 Persist Test {TAG}%'") == "0", "R5.2: …and no longer inside the compat snapshot")
        check(psql("select count(*) from compat_state where data->'db' ? 'customers' or data->'db' ? 'vendors'") == "0", "R5.2: the snapshot carries no party collection at all")
        check(psql(f"select count(*) from compat_state where data::text ilike '%R5{TAG}%'") == "1", "compat documents are still saved in compat_state")
        check(int(psql("select count(*) from parties where kind = 'customer'")) >= 10 and int(psql("select count(*) from parties where kind = 'vendor'")) >= 14,
              "R5.2: the demo customers and vendors were seeded into the table")
        dup = subprocess.run(["psql", DB_URL, "-At", "-c", "insert into parties (id, ord, kind, name, bin, mode, mobile, address) "
                              f"select 'dup{TAG}', 999999, kind, name, bin, mode, mobile, address from parties where kind = 'customer' and deleted_at is null limit 1"],
                             capture_output=True, text=True)
        check(dup.returncode != 0, "R5.2: the database refuses a duplicate party name (unique index), not just the API")
        check(psql(f"select count(*) from items where id = '{iid}'") == "1", "R5.2: SKUs are rows in the items table")
        check(psql(f"select count(*) from master_items where id = '{mid}' and name = 'R5 Master Renamed {TAG}'") == "1",
              "R5.2: …and master items in master_items")
        check(psql(f"select count(*) from items where master_item = 'R5 Master Renamed {TAG}'") == "1", "R5.2: the rename carried the SKU along in the table")
        check(psql(f"select opening = 40 from items where id = '{iid}'") == "t", "R5.2: a compat document that moved a counter reached the table")
        # the R6.2 importer uppercases every SKU it reads (`str(r.sku).toUpperCase()`), so the row carries the tag in capitals
        check(psql(f"select count(*) from items where sku = 'R5IMP-{TAG.upper()}'") == "1", "R5.2: …and the compat bulk import was adopted into it")
        check(psql("select count(*) from compat_state where data->'db' ? 'items' or data->'db' ? 'masterItems'") == "0",
              "R5.2: the snapshot carries no item collection at all")
        check(int(psql("select count(*) from items")) >= 22 and int(psql("select count(*) from master_items")) >= 19,
              "R5.2: the demo SKUs and master items were seeded into their tables")
        icols = ('id, ord, hs_code, "group", master_item, brand, name, unit, sku, purchase_price, cost_price, sale_price, vat_rate, '
                 'sd_rate, opening, purchased, prod_receive, prod_issue, sold, damage, reorder_level, active')
        dupsku = subprocess.run(["psql", DB_URL, "-At", "-c",
                                 f"insert into items ({icols}) select 'dups{TAG}', 999999, hs_code, \"group\", master_item, brand, name, unit, sku, "
                                 "purchase_price, cost_price, sale_price, vat_rate, sd_rate, 0, 0, 0, 0, 0, 0, 0, true from items limit 1"],
                                capture_output=True, text=True)
        check(dupsku.returncode != 0, "R5.2: the database refuses a duplicate SKU (unique index), not just the API")
        # R6: tamper-evident, append-only audit trail (NBR enlistment — protection against tampering)
        check(psql("select count(*) from audit_events where hash is null or prev_hash is null") == "0", "R6: every audit event is sealed (prev_hash + hash)")
        def refused(q):
            r = subprocess.run(["psql", DB_URL, "-At", "-c", q], capture_output=True, text=True)
            return r.returncode != 0 and "append-only" in r.stderr
        check(refused("update audit_events set note = 'x' where id = 1"), "R6: the database refuses UPDATE on audit_events")
        check(refused("delete from audit_events where id = 1"), "R6: the database refuses DELETE on audit_events")
        check(refused("truncate audit_events"), "R6: the database refuses TRUNCATE on audit_events")
    else:
        skipped("database checks (DATABASE_URL not set)")

    print("R5.2: deleting a party is a deleted_at stamp, undo restores it")
    d = arif.delete(f"{BASE}/vendors/{gid}")
    check(d.status_code == 200 and d.json().get("ok") is True, "an unused vendor is deleted (undo offered)")
    check(arif.get(f"{BASE}/vendors/{gid}").status_code == 404, "…and is gone from the API")
    check(not any(v["id"] == gid for v in arif.get(f"{BASE}/vendors").json()), "…and from the picker")
    if DB_URL:
        check(psql(f"select count(*) from parties where id = '{gid}' and deleted_at is not null") == "1", "R5.2: the row is kept with deleted_at (master data never leaves the table)")
    r = arif.post(f"{BASE}/vendors/{gid}/restore")
    check(r.status_code == 200 and r.json().get("id") == gid, "restore puts it back (undo)")
    check(arif.post(f"{BASE}/vendors/{gid}/restore").status_code == 404, "restoring something not in the trash is a 404")
    d2 = arif.delete(f"{BASE}/vendors/{gid}")
    check(d2.status_code == 200, "deleted again — left deleted for the restart check")
    # the unique indexes ignore the trash, so a deleted party's name is free again — and an undo that then collides
    # answers with the form's 422 (the driver error unwrapped), not a 500, leaving the record deleted
    ca = arif.post(f"{BASE}/vendors", json={"name": f"R5 CLASH {TAG}", "mode": "Foreign", "country": "China", "address": "Shenzhen, China"}).json()
    arif.delete(f"{BASE}/vendors/{ca['id']}")
    cb = arif.post(f"{BASE}/vendors", json={"name": f"r5 clash {TAG}", "mode": "Foreign", "country": "China", "address": "Chittagong"})
    check(cb.status_code == 201, f"R5.2: a deleted party's name is free again ({cb.status_code})")
    cc = arif.post(f"{BASE}/vendors/{ca['id']}/restore")
    check(cc.status_code == 422 and cc.json().get("errors", {}).get("name") == ["duplicate"],
          f"R5.2: an undo whose name was taken again is a 422, not a 500 ({cc.status_code})")
    if DB_URL:
        check(psql(f"select count(*) from parties where id = '{ca['id']}' and deleted_at is not null") == "1",
              "R5.2: …and the refused undo leaves the record in the trash")
    check(arif.delete(f"{BASE}/customers/c1").status_code == 409, "a customer with invoices cannot be deleted (409 in-use:N)")
    check(arif.post(f"{BASE}/customers", json={"name": "SUNRISE FASHION RETAIL LTD", "mode": "Local", "bin": "004817362-0105", "address": "Dhaka, Bangladesh"}).status_code == 422,
          "a duplicate name/BIN is refused (422) — the rules the mock handlers use")

    # R5.3: transfers and damage entries are the first documents with their own tables. Their registers read
    # PostgreSQL; the branch split and an item's ledger still derive from *every* movement document through the
    # in-memory copies the unported handlers read, so a document written natively has to reach them at once; and an
    # approval writes the item counter it moves in the same transaction as the document.
    print("R5.3: stock documents are rows, and the derived stock follows them")
    other = [b["id"] for b in arif.get(f"{BASE}/stock").json()["branches"] if b["id"] != branch][0]

    def held():
        rows = arif.get(f"{BASE}/stock", params={"size": 100}).json()["data"]
        r = [x for x in rows if x["id"] == iid][0]
        return r["remain"], r["byBranch"].get(branch, 0), r["byBranch"].get(other, 0)

    tdate = time.strftime("%Y-%m-%d")
    t0 = held()
    tr = arif.post(f"{BASE}/transfers", json={"fromBranchId": branch, "toBranchId": other, "date": tdate, "vehicle": "",
                                              "note": f"R5.3 transfer {TAG}", "lines": [{"itemId": iid, "qty": 6}], "process": "Created"})
    tid, tno = tr.json().get("id"), tr.json().get("no")
    check(tr.status_code == 201 and tr.json()["process"] == "Created"
          and [h["action"] for h in tr.json()["history"]] == ["created"], f"native (R5.3): transfer draft created ({tr.status_code})")
    check(held() == t0, "R5.3: a draft moves no stock")
    if DB_URL:
        check(psql(f"select count(*) from stock_documents where id = '{tid}' and process = 'Created'") == "1",
              "R5.3: the draft is a row in stock_documents")
        check(psql(f"select count(*) from stock_document_lines where doc_id = '{tid}'") == "1",
              "R5.3: …and its lines are rows in stock_document_lines")
    ap = arif.patch(f"{BASE}/transfers/{tid}", json={"process": "Approved"})
    check(ap.status_code == 200 and ap.json()["process"] == "Approved" and held() == (t0[0], t0[1] - 6, t0[2] + 6),
          f"R5.3: approving moves the stock, and the branch split derived in memory follows ({ap.status_code})")
    led = arif.get(f"{BASE}/items/{iid}/ledger", params={"branch": other}).json()
    check(any(e["type"] == "transferIn" and e["ref"] == tno for e in led["entries"]),
          "R5.3: …and the item's ledger, still derived from every document, quotes it")
    if DB_URL:
        check(psql(f"select jsonb_array_length(history) from stock_documents where id = '{tid}'") == "2",
              "R5.3: the document's own history travels with the row")
    cn = arif.patch(f"{BASE}/transfers/{tid}", json={"process": "Cancelled", "reason": f"R5.3 cancelled {TAG}"})
    check(cn.status_code == 200 and held() == t0, "R5.3: cancelling gives the stock back")
    if DB_URL:
        check(psql(f"select count(*) from stock_documents where id = '{tid}' and process = 'Cancelled' and cancel_reason is not null") == "1",
              "R5.3: …and the cancellation is stored on the row")
    # a damage entry writes stock off: the item's counter moves with the document, in its transaction
    dm = arif.post(f"{BASE}/damage", json={"branchId": branch, "date": tdate, "reason": "wastage", "note": f"R5.3 damage {TAG}",
                                           "lines": [{"itemId": iid, "qty": 2}], "process": "Approved"})
    did = dm.json().get("id")
    check(dm.status_code == 201 and dm.json()["process"] == "Approved" and held() == (t0[0] - 2, t0[1] - 2, t0[2]),
          f"native (R5.3): a damage entry approved on creation writes the stock off ({dm.status_code})")
    if DB_URL:
        check(psql(f"select damage = 2 from items where id = '{iid}'") == "t",
              "R5.3: …and the counter it moved is written with it (items.damage)")
    dcn = arif.patch(f"{BASE}/damage/{did}", json={"process": "Cancelled", "reason": f"R5.3 cancelled {TAG}"})
    check(dcn.status_code == 200 and held() == t0, "R5.3: cancelling a damage entry puts the stock back")
    if DB_URL:
        check(psql(f"select damage = 0 from items where id = '{iid}'") == "t", "R5.3: …and takes the counter back")
    # editing a draft replaces its lines; deleting one removes the row and retires its number
    d2 = arif.post(f"{BASE}/transfers", json={"fromBranchId": branch, "toBranchId": other, "date": tdate,
                                              "lines": [{"itemId": iid, "qty": 3}], "process": "Created"}).json()
    ed = arif.put(f"{BASE}/transfers/{d2['id']}", json={"fromBranchId": branch, "toBranchId": other, "date": tdate,
                                                        "lines": [{"itemId": iid, "qty": 4}, {"itemId": "i19", "qty": 1}],
                                                        "process": "Created"})
    check(ed.status_code == 200 and [l["qty"] for l in ed.json()["lines"]] == [4, 1],
          f"R5.3: editing a draft replaces its lines ({ed.status_code})")
    if DB_URL:
        check(psql(f"select string_agg(item_id || ':' || qty::text, ',' order by ord) from stock_document_lines where doc_id = '{d2['id']}'")
              == f"{iid}:4.000,i19:1.000", "R5.3: …in the child table, in the order they are printed")
    dl = arif.delete(f"{BASE}/transfers/{d2['id']}")
    check(dl.status_code == 200 and dl.json().get("ok") is True, "R5.3: a draft is deleted")
    if DB_URL:
        check(psql(f"select count(*) from stock_documents where id = '{d2['id']}'") == "0"
              and psql(f"select count(*) from stock_document_lines where doc_id = '{d2['id']}'") == "0",
              "R5.3: …and its row and lines leave the database")
    nx = arif.post(f"{BASE}/transfers", json={"fromBranchId": branch, "toBranchId": other, "date": tdate,
                                              "lines": [{"itemId": iid, "qty": 1}], "process": "Created"}).json()
    check(nx["no"] != d2["no"], f"R5.3: a deleted draft's number stays retired ({d2['no']} → {nx['no']})")
    arif.delete(f"{BASE}/transfers/{nx['id']}")
    rows0 = psql("select count(*) from stock_documents") if DB_URL else None
    sh = arif.post(f"{BASE}/transfers", json={"fromBranchId": other, "toBranchId": branch, "date": tdate,
                                              "lines": [{"itemId": iid, "qty": 100000}], "process": "Approved"})
    check(sh.status_code == 422 and "Insufficient stock" in sh.json().get("title", ""),
          f"R5.3: approving more than the branch holds is a 422 ({sh.status_code})")
    if DB_URL:
        check(psql("select count(*) from stock_documents") == rows0, "R5.3: …and the refused document left no row behind")
        check(psql("select count(*) from compat_state where data->'db' ? 'transfers' or data->'db' ? 'damages'") == "0",
              "R5.3: the snapshot carries no stock-document collection at all")
        check(int(psql("select count(*) from stock_documents where kind = 'transfer'")) >= 8
              and int(psql("select count(*) from stock_documents where kind = 'damage'")) >= 6
              and int(psql("select count(*) from stock_document_lines")) >= 21,
              "R5.3: the demo transfers and damage entries were seeded into their tables")
        dupno = subprocess.run(["psql", DB_URL, "-At", "-c",
                                "insert into stock_documents (id, kind, no, date, process, from_branch_id, from_branch, to_branch_id, "
                                f"to_branch, total_qty, total_value, issued_by, created_at) select 'dupd{TAG}', kind, no, date, process, "
                                "from_branch_id, from_branch, to_branch_id, to_branch, 0, 0, 'x', now() from stock_documents limit 1"],
                               capture_output=True, text=True)
        check(dupno.returncode != 0, "R5.3: the database refuses a duplicate document number (unique index), not just the API")

    # R5.3: the sales invoices are rows too — the first revenue document out of the compat layer. The register, the
    # branch stock, an item's ledger and the credit a customer carries still derive from *every* document through
    # the in-memory copies the unported handlers read, so an invoice written natively has to reach them at once;
    # and approving one writes the SKU counter it moves (`items.sold`) in the same transaction.
    print("R5.3: sales invoices are rows, and the numbers derived from them follow")
    # a finished good with stock at the branch: a sales line has to be saleable (Finished Goods) and coverable
    def stock_rows():
        return {x["id"]: x for x in arif.get(f"{BASE}/stock", params={"size": 200}).json()["data"]}

    items_page = arif.get(f"{BASE}/items", params={"size": 200}).json()
    rows = items_page["data"] if isinstance(items_page, dict) else items_page
    sr = stock_rows()
    siid = [x["id"] for x in rows if x["group"] == "Finished Goods" and sr.get(x["id"], {}).get("byBranch", {}).get(branch, 0) >= 10][0]

    def sold_held():
        r = stock_rows()[siid]
        return r["remain"], r["byBranch"].get(branch, 0), r["byBranch"].get(other, 0)

    def party(mode):
        rows = arif.get(f"{BASE}/customers", params={"size": 100}).json()
        return [c for c in (rows["data"] if isinstance(rows, dict) else rows) if c["mode"] == mode][0]

    cust = party("Local")
    sold0, split0 = (float(psql(f"select sold from items where id = '{siid}'")) if DB_URL else None), sold_held()
    inv_body = {"customerId": cust["id"], "issueDate": tdate, "issueTime": "10:20", "deliveryAddress": "", "vehicle": "",
                "method": "Cash", "discount": 0, "paid": 0, "vds": False, "issuedBy": "Arif Hossain",
                "designation": "Sales Officer", "narration": f"R5.3 invoice {TAG}", "process": "Created",
                "branchId": branch, "lines": [{"itemId": siid, "qty": 2, "price": 100, "sdRate": 0, "vatRate": 5}]}
    si = arif.post(f"{BASE}/sales", json=inv_body)
    sid, sno = si.json().get("id"), si.json().get("invoiceNo")
    check(si.status_code == 201 and si.json()["process"] == "Created" and "export" not in si.json()
          and str(sno).startswith("S-") and si.json()["challanNo"]
          and [h["action"] for h in si.json()["history"]] == ["created"],
          f"native (R5.3): a sales draft is created, numbered and challaned ({si.status_code} {sno})")
    check(sold_held() == split0, "R5.3: a draft invoice moves no stock")
    if DB_URL:
        check(psql(f"select count(*) from sales where id = '{sid}' and process = 'Created' and export_deemed is null") == "1"
              and psql(f"select count(*) from sale_lines where sale_id = '{sid}'") == "1",
              "R5.3: the draft is a row in sales, and its line a row in sale_lines")
    sa = arif.patch(f"{BASE}/sales/{sid}", json={"process": "Approved"})
    check(sa.status_code == 200 and sa.json()["process"] == "Approved"
          and sold_held() == (split0[0] - 2, split0[1] - 2, split0[2]),
          f"R5.3: approving moves the stock out, and the branch split derived in memory follows ({sa.status_code})")
    led = arif.get(f"{BASE}/items/{siid}/ledger").json()
    check(any(e.get("ref") == sno for e in led["entries"]), "R5.3: …and the item's ledger, still derived from every document, quotes it")
    if DB_URL:
        check(psql(f"select sold = {sold0 + 2} from items where id = '{siid}'") == "t",
              "R5.3: …and the counter it moved is written with it (items.sold)")
        check(psql(f"select jsonb_array_length(history) from sales where id = '{sid}'") == "2",
              "R5.3: the invoice's own history travels with the row")
    sc = arif.patch(f"{BASE}/sales/{sid}", json={"process": "Cancelled", "reason": f"R5.3 cancelled {TAG}"})
    check(sc.status_code == 200 and sold_held() == split0, "R5.3: cancelling brings the stock back")
    if DB_URL:
        check(psql(f"select count(*) from sales where id = '{sid}' and process = 'Cancelled' and cancel_reason is not null") == "1"
              and psql(f"select sold = {sold0} from items where id = '{siid}'") == "t",
              "R5.3: …and the cancellation and the counter are stored on the rows")
    check(arif.patch(f"{BASE}/sales/{sid}", json={"process": "Cancelled", "reason": "again"}).status_code == 409,
          "R5.3: an invoice that is already cancelled refuses a second cancellation (409)")
    # editing a draft replaces its lines; deleting one stamps the row (its number stays retired) and the undo restores it
    s2 = arif.post(f"{BASE}/sales", json={**inv_body, "lines": [{"itemId": siid, "qty": 3, "price": 100, "sdRate": 0, "vatRate": 5}]}).json()
    se = arif.put(f"{BASE}/sales/{s2['id']}", json={**inv_body, "lines": [
        {"itemId": siid, "qty": 4, "price": 100, "sdRate": 0, "vatRate": 5},
        {"itemId": "i19", "qty": 1, "price": 50, "sdRate": 0, "vatRate": 5}]})
    check(se.status_code == 200 and [l["qty"] for l in se.json()["lines"]] == [4, 1]
          and [h["action"] for h in se.json()["history"]][-1] == "edited",
          f"R5.3: editing a draft invoice replaces its lines ({se.status_code})")
    if DB_URL:
        check(psql(f"select string_agg(item_id || ':' || qty::text, ',' order by ord) from sale_lines where sale_id = '{s2['id']}'")
              == f"{siid}:4.000,i19:1.000", "R5.3: …in the child table, in the order they are printed")
    sd = arif.delete(f"{BASE}/sales/{s2['id']}")
    check(sd.status_code == 200 and sd.json().get("ok") is True and arif.get(f"{BASE}/sales/{s2['id']}").status_code == 404,
          "R5.3: a draft invoice is deleted and leaves the register")
    if DB_URL:
        check(psql(f"select count(*) from sales where id = '{s2['id']}' and deleted_at is not null") == "1"
              and psql(f"select count(*) from sale_lines where sale_id = '{s2['id']}'") == "2",
              "R5.3: …as a stamped row that keeps its lines, so its number stays retired")
    s3 = arif.post(f"{BASE}/sales", json=inv_body).json()
    check(s3["invoiceNo"] != s2["invoiceNo"], f"R5.3: the next invoice takes a new number ({s2['invoiceNo']} → {s3['invoiceNo']})")
    sr = arif.post(f"{BASE}/sales/{s2['id']}/restore")
    check(sr.status_code == 200 and sr.json()["process"] == "Created"
          and [h["action"] for h in sr.json()["history"]][-1] == "restored"
          and arif.get(f"{BASE}/sales/{s2['id']}").status_code == 200,
          f"R5.3: the undo restores the draft, with its history ({sr.status_code})")
    if DB_URL:
        check(psql(f"select count(*) from sales where id = '{s2['id']}' and deleted_at is null") == "1",
              "R5.3: …by clearing the stamp on the row")
    # an export invoice carries its shipping documents as columns and takes its proceeds (PRC) entries as rows
    fcust = party("Foreign")
    # dated like the demo's own exports: a proceeds entry has to fall between the invoice and the company's today,
    # which is a fixed demo date, not the day the suite runs
    xdate = arif.get(f"{BASE}/sales", params={"size": 5, "category": "all", "trade": "export,deemed",
                                             "sort": "issueDate.desc"}).json()["data"][0]["issueDate"]
    ex = arif.post(f"{BASE}/sales", json={**inv_body, "customerId": fcust["id"], "issueDate": xdate, "process": "Approved",
                                          "export": {"deemed": False, "lcNo": f"LC{TAG}", "lcDate": xdate, "customsHouse": "CTG",
                                                     "country": "Germany", "billNo": f"BE{TAG}", "billDate": xdate,
                                                     "shippingAddress": "Hamburg", "currency": "USD", "fcValue": 1000,
                                                     "exchangeRate": 119.5}})
    xid = ex.json().get("id")
    check(ex.status_code == 201 and ex.json()["mode"] == "Foreign" and ex.json()["vat"] == 0
          and ex.json()["export"]["lcNo"] == f"LC{TAG}" and "realisations" not in ex.json()["export"],
          f"native (R5.3): an export invoice is zero-rated and carries its shipping documents ({ex.status_code})")
    if DB_URL:
        check(psql(f"select count(*) from sales where id = '{xid}' and export_deemed = false and export_lc_no = 'LC{TAG}'"
                   f" and export_fc_value = 1000 and export_currency = 'USD'") == "1",
              "R5.3: …as columns of its own row, so an LC, a country or an FC value is queryable")
    rz = arif.post(f"{BASE}/sales/{xid}/realisations", json={"date": xdate, "bank": "Sonali Bank", "prcNo": f"prc{TAG}",
                                                            "fcAmount": 400, "rate": 119.5})
    entries = rz.json().get("export", {}).get("realisations", []) if rz.status_code == 201 else []
    rid = entries[-1].get("id") if entries else None
    check(rz.status_code == 201 and len(entries) == 1 and entries[0]["bdt"] == 47800.0
          and entries[0]["prcNo"] == f"PRC{TAG}".upper()
          and [h.get("note") or "" for h in rz.json()["history"]][-1].startswith("Proceeds realised:"),
          f"R5.3: proceeds realised against the invoice, in BDT at the entered rate ({rz.status_code})")
    if DB_URL:
        check(psql(f"select count(*) from sale_realisations where sale_id = '{xid}'"
                   f" and prc_no = upper('PRC{TAG}') and bdt = 47800") == "1",
              "R5.3: …as a row of its own, the PRC number upper-cased")
    dup = arif.post(f"{BASE}/sales/{xid}/realisations", json={"date": xdate, "bank": "Sonali Bank", "prcNo": f"PRC{TAG}",
                                                             "fcAmount": 10, "rate": 119.5})
    check(dup.status_code == 422 and dup.json()["errors"].get("prcNo") == ["duplicate"],
          "R5.3: a PRC already on an invoice is refused (422 duplicate)")
    over = arif.post(f"{BASE}/sales/{xid}/realisations", json={"date": xdate, "bank": "Sonali Bank", "prcNo": f"prc2{TAG}",
                                                              "fcAmount": 5000, "rate": 119.5})
    check(over.status_code == 422 and over.json()["errors"].get("fcAmount") == ["exceedsOutstanding"],
          "R5.3: …and so is more than the invoice's outstanding foreign-currency value")
    rr = arif.delete(f"{BASE}/sales/{xid}/realisations", params={"rid": rid})
    check(rr.status_code == 200 and rr.json()["export"]["realisations"] == []
          and arif.post(f"{BASE}/sales/{xid}/realisations", json={"date": xdate, "bank": "Sonali Bank",
                                                                 "prcNo": f"PRC{TAG}", "fcAmount": 10, "rate": 119.5}).status_code == 201,
          "R5.3: removing an entry leaves the list on the invoice — and frees the PRC number again")
    cr = arif.get(f"{BASE}/sales/{xid}/creditable")
    check(cr.status_code == 200 and cr.json()["sale"]["invoiceNo"] == ex.json()["invoiceNo"]
          and cr.json()["lines"][0]["remaining"] == cr.json()["lines"][0]["soldQty"],
          f"R5.3: what is still returnable on an invoice is served from its rows ({cr.status_code})")
    # a service sale is its own register and its own number series, and moves no stock
    code = arif.get(f"{BASE}/sale-services").json()[0]
    split1 = sold_held()   # the approved export invoice above moved stock out; a service sale must not move any
    ss = arif.post(f"{BASE}/sales", json={**inv_body, "category": "service", "lines": [
        {"itemId": code["id"], "qty": 1, "price": 5000, "sdRate": 0, "vatRate": 15}]})
    check(ss.status_code == 201 and ss.json()["category"] == "service" and str(ss.json()["invoiceNo"]).startswith("SS-")
          and sold_held() == split1, f"native (R5.3): a service sale is numbered in its own series and moves no stock ({ss.status_code})")
    b1 = arif.post(f"{BASE}/sales", json=inv_body).json()
    bk = arif.post(f"{BASE}/sales/bulk", json={"ids": [b1["id"], sid], "action": "approve"})
    check(bk.status_code == 200 and bk.json() == {"done": [b1["id"]], "skipped": [sid]},
          f"R5.3: bulk approve takes the drafts and reports the ones it skipped ({bk.status_code})")
    rows0 = psql("select count(*) from sales") if DB_URL else None
    sh = arif.post(f"{BASE}/sales", json={**inv_body, "process": "Approved", "lines": [
        {"itemId": siid, "qty": 100000, "price": 1, "sdRate": 0, "vatRate": 5}]})
    check(sh.status_code == 422 and "Insufficient stock" in sh.json().get("title", ""),
          f"R5.3: approving more than the branch holds is a 422 ({sh.status_code})")
    if DB_URL:
        check(psql("select count(*) from sales") == rows0, "R5.3: …and the refused invoice left no row behind")
        check(psql("select count(*) from compat_state where data->'db' ? 'sales'") == "0",
              "R5.3: the snapshot carries no sales collection at all")
        check(int(psql("select count(*) from sales")) >= 227 and int(psql("select count(*) from sale_lines")) >= 442
              and int(psql("select count(*) from sales where export_deemed is not null")) >= 16
              and int(psql("select count(*) from sales where category = 'service'")) >= 11
              and int(psql("select count(*) from sale_realisations")) >= 12,
              "R5.3: the demo invoices were seeded into their tables, export headers and proceeds entries included")
        dupno = subprocess.run(["psql", DB_URL, "-At", "-c",
                                "insert into sales (id, invoice_no, challan_no, issue_date, issue_time, process, branch_id, "
                                "branch_name, customer_id, customer_name, customer_bin, customer_address, delivery_address, "
                                "mode, method, vds, subtotal, sd, vat, discount, net_total, paid, due, issued_by, designation, "
                                "created_at) select 'dups" + TAG + "', invoice_no, challan_no, issue_date, issue_time, process, "
                                "branch_id, branch_name, customer_id, customer_name, customer_bin, customer_address, "
                                "delivery_address, mode, method, vds, 0, 0, 0, 0, 0, 0, 0, 'x', 'y', now() from sales limit 1"],
                               capture_output=True, text=True)
        check(dupno.returncode != 0, "R5.3: the database refuses a duplicate invoice number (unique index), not just the API")

    # ── R5.3: the purchases ────────────────────────────────────────────────────────────────────────────────────
    print("R5.3: purchases are rows too — imports with their Bill of Entry and the duty every line cleared")

    def vendors(mode):
        rows = arif.get(f"{BASE}/vendors", params={"size": 100}).json()
        return [v for v in (rows["data"] if isinstance(rows, dict) else rows) if v["mode"] == mode]

    sv = arif.get(f"{BASE}/services").json()[0]
    vend = vendors("Local")[0]
    # a purchase moves `purchased`, so these checks buy demo SKUs of their own: the R5.2 restart check still
    # requires the item this suite created (`iid`) to hold exactly the 40 it opened with
    buyable = [x["id"] for x in arif.get(f"{BASE}/items", params={"size": 200}).json()["data"]
               if x["group"] != "Finished Goods" and x["id"] != iid]
    piid, other_buyable = buyable[0], buyable[1]

    def pheld():
        r = stock_rows()[piid]
        return r["remain"], r["byBranch"].get(branch, 0), r["byBranch"].get(other, 0)

    bought0, split2 = (float(psql(f"select purchased from items where id = '{piid}'")) if DB_URL else None), pheld()
    pur_body = {"vendorId": vend["id"], "issueDate": tdate, "challanNo": f"CH{TAG}", "challanDate": tdate,
                "method": "Cash", "discount": 0, "paid": 0, "issuedBy": "Arif Hossain",
                "designation": "Purchase Officer", "narration": f"R5.3 purchase {TAG}", "process": "Created",
                "branchId": branch, "lines": [{"itemId": piid, "qty": 5, "price": 100, "sdRate": 0, "vatRate": 5}]}
    pi = arif.post(f"{BASE}/purchases", json=pur_body)
    pid, pno = pi.json().get("id"), pi.json().get("invoiceNo")
    check(pi.status_code == 201 and pi.json()["process"] == "Created" and "boe" not in pi.json()
          and str(pno).startswith("P-") and pi.json()["challanNo"] == f"CH{TAG}"
          and [h["action"] for h in pi.json()["history"]] == ["created"],
          f"native (R5.3): a purchase draft is created and numbered ({pi.status_code} {pno})")
    check(pheld() == split2, "R5.3: a draft purchase moves no stock")
    if DB_URL:
        check(psql(f"select count(*) from purchases where id = '{pid}' and process = 'Created' and boe_no is null") == "1"
              and psql(f"select count(*) from purchase_lines where purchase_id = '{pid}'") == "1",
              "R5.3: the draft is a row in purchases, and its line a row in purchase_lines")
    pa = arif.patch(f"{BASE}/purchases/{pid}", json={"process": "Approved"})
    check(pa.status_code == 200 and pa.json()["process"] == "Approved"
          and pheld() == (split2[0] + 5, split2[1] + 5, split2[2]),
          f"R5.3: approving moves the stock in, and the branch split derived in memory follows ({pa.status_code})")
    pled = arif.get(f"{BASE}/items/{piid}/ledger").json()
    check(any(e.get("ref") == pno for e in pled["entries"]),
          "R5.3: …and the item's ledger, still derived from every document, quotes it")
    if DB_URL:
        check(psql(f"select purchased = {bought0 + 5} from items where id = '{piid}'") == "t",
              "R5.3: …and the counter it moved is written with it (items.purchased)")
        check(psql(f"select jsonb_array_length(history) from purchases where id = '{pid}'") == "2",
              "R5.3: the document's own history travels with the row")
    pcan = arif.patch(f"{BASE}/purchases/{pid}", json={"process": "Cancelled", "reason": f"R5.3 cancelled {TAG}"})
    check(pcan.status_code == 200 and pheld() == split2, "R5.3: cancelling takes the stock back out")
    if DB_URL:
        check(psql(f"select count(*) from purchases where id = '{pid}' and process = 'Cancelled'"
                   f" and cancel_reason is not null") == "1"
              and psql(f"select purchased = {bought0} from items where id = '{piid}'") == "t",
              "R5.3: …and the cancellation and the counter are stored on the rows")
    check(arif.patch(f"{BASE}/purchases/{pid}", json={"process": "Cancelled", "reason": "again"}).status_code == 409,
          "R5.3: a purchase that is already cancelled refuses a second cancellation (409)")
    # editing a draft replaces its lines; deleting one stamps the row (its number stays retired) and the undo restores it
    p2 = arif.post(f"{BASE}/purchases", json={**pur_body, "lines": [
        {"itemId": piid, "qty": 3, "price": 100, "sdRate": 0, "vatRate": 5}]}).json()
    pe = arif.put(f"{BASE}/purchases/{p2['id']}", json={**pur_body, "lines": [
        {"itemId": piid, "qty": 4, "price": 100, "sdRate": 0, "vatRate": 5},
        {"itemId": other_buyable, "qty": 1, "price": 50, "sdRate": 0, "vatRate": 5}]})
    check(pe.status_code == 200 and [l["qty"] for l in pe.json()["lines"]] == [4, 1]
          and [h["action"] for h in pe.json()["history"]][-1] == "edited",
          f"R5.3: editing a draft purchase replaces its lines ({pe.status_code})")
    if DB_URL:
        check(psql(f"select string_agg(item_id || ':' || qty::text, ',' order by ord) from purchase_lines"
                   f" where purchase_id = '{p2['id']}'") == f"{piid}:4.000,{other_buyable}:1.000",
              "R5.3: …in the child table, in the order they are printed")
    pdel = arif.delete(f"{BASE}/purchases/{p2['id']}")
    check(pdel.status_code == 200 and pdel.json().get("ok") is True
          and arif.get(f"{BASE}/purchases/{p2['id']}").status_code == 404,
          "R5.3: a draft purchase is deleted and leaves the register")
    if DB_URL:
        check(psql(f"select count(*) from purchases where id = '{p2['id']}' and deleted_at is not null") == "1"
              and psql(f"select count(*) from purchase_lines where purchase_id = '{p2['id']}'") == "2",
              "R5.3: …as a stamped row that keeps its lines, so its number stays retired")
    p3 = arif.post(f"{BASE}/purchases", json=pur_body).json()
    check(p3["invoiceNo"] != p2["invoiceNo"],
          f"R5.3: the next purchase takes a new number ({p2['invoiceNo']} → {p3['invoiceNo']})")
    pr = arif.post(f"{BASE}/purchases/{p2['id']}/restore")
    check(pr.status_code == 200 and pr.json()["process"] == "Created"
          and [h["action"] for h in pr.json()["history"]][-1] == "restored"
          and arif.get(f"{BASE}/purchases/{p2['id']}").status_code == 200,
          f"R5.3: the undo restores the draft, with its history ({pr.status_code})")
    if DB_URL:
        check(psql(f"select count(*) from purchases where id = '{p2['id']}' and deleted_at is null") == "1",
              "R5.3: …by clearing the stamp on the row")
    swap = arif.put(f"{BASE}/purchases/{p3['id']}", json={**pur_body, "category": "service", "lines": [
        {"itemId": sv["id"], "qty": 1, "price": 1000, "sdRate": 0, "vatRate": 10}]})
    check(swap.status_code == 409, f"R5.3: a goods purchase cannot become a service purchase ({swap.status_code})")
    # an import purchase carries its Bill of Entry, and every line's duty breakdown, as columns of its own
    imp = arif.post(f"{BASE}/purchases", json={**pur_body, "vendorId": vendors("Foreign")[0]["id"],
                                              "challanNo": f"BOE{TAG}", "process": "Approved",
                                              "boe": {"lcNo": f"LC{TAG}", "lcDate": tdate, "customsHouse": "CTG",
                                                      "origin": "China", "bonded": False},
                                              "lines": [{"itemId": piid, "qty": 10, "usd": 100, "usdRate": 119.5,
                                                         "cdRate": 25, "rdRate": 5, "sdRate": 0, "vatRate": 15,
                                                         "aitRate": 5, "atRate": 5}]})
    impid = imp.json().get("id")
    duty = imp.json()["lines"][0].get("duty", {}) if imp.status_code == 201 else {}
    check(imp.status_code == 201 and imp.json()["mode"] == "Foreign"
          and imp.json()["boe"]["no"] == f"BOE{TAG}" and imp.json()["boe"]["lcNo"] == f"LC{TAG}"
          and "bonded" not in imp.json()["boe"] and duty.get("av") == 11950 and duty.get("cd") == 2987.5
          and imp.json()["tti"] == 7289.5,
          f"native (R5.3): an import purchase prices its Bill of Entry lines with the duty stack ({imp.status_code})")
    if DB_URL:
        check(psql(f"select count(*) from purchases where id = '{impid}' and boe_no = 'BOE{TAG}'"
                   f" and boe_lc_no = 'LC{TAG}' and boe_origin = 'China' and boe_bonded is null") == "1",
              "R5.3: …the Bill of Entry as columns of its own row, so a BoE, an LC or a country is queryable")
        check(psql(f"select count(*) from purchase_lines where purchase_id = '{impid}' and duty_av = 11950"
                   f" and duty_cd = 2987.5 and duty_at = 776.75 and tti = 7289.5 and foregone_total is null") == "1",
              "R5.3: …and the duty every line cleared as columns, so a BoE's duty is a sum, not a walk")
        bonded = int(psql("select count(*) from purchase_lines where foregone_total is not null"))
        check(bonded >= 4,
              f"R5.3: the bonded (IM-7) entries the bond register reports kept their duty foregone ({bonded} lines)")
    # a service purchase is its own register and its own number series, and moves no stock
    split3 = pheld()
    ps = arif.post(f"{BASE}/purchases", json={**pur_body, "category": "service", "lines": [
        {"itemId": sv["id"], "qty": 1, "price": 5000, "sdRate": 0, "vatRate": 10}]})
    check(ps.status_code == 201 and ps.json()["category"] == "service"
          and str(ps.json()["invoiceNo"]).startswith("PS-") and pheld() == split3,
          f"native (R5.3): a service purchase is numbered in its own series and moves no stock ({ps.status_code})")
    b1 = arif.post(f"{BASE}/purchases", json=pur_body).json()
    bk = arif.post(f"{BASE}/purchases/bulk", json={"ids": [b1["id"], pid], "action": "approve"})
    check(bk.status_code == 200 and bk.json() == {"done": [b1["id"]], "skipped": [pid]},
          f"R5.3: bulk approve takes the drafts and reports the ones it skipped ({bk.status_code})")
    rt = arif.get(f"{BASE}/purchases/{b1['id']}/returnable")
    check(rt.status_code == 200 and rt.json()["purchase"]["invoiceNo"] == b1["invoiceNo"]
          and rt.json()["lines"][0]["remaining"] == rt.json()["lines"][0]["purchasedQty"],
          f"R5.3: what is still returnable on a purchase is served from its rows ({rt.status_code})")
    check(arif.get(f"{BASE}/purchases/{ps.json()['id']}/returnable").status_code == 404,
          "R5.3: …and a service purchase has nothing to return (404)")
    if DB_URL:
        check(psql("select count(*) from compat_state where data->'db' ? 'purchases'") == "0",
              "R5.3: the snapshot carries no purchases collection at all")
        check(int(psql("select count(*) from purchases")) >= 101 and int(psql("select count(*) from purchase_lines")) >= 101
              and int(psql("select count(*) from purchases where boe_no is not null")) >= 40
              and int(psql("select count(*) from purchases where category = 'service'")) >= 18,
              "R5.3: the demo purchases were seeded into their tables, Bills of Entry and duty breakdowns included")
        dupno = subprocess.run(["psql", DB_URL, "-At", "-c",
                                "insert into purchases (id, invoice_no, challan_no, challan_date, issue_date, process, "
                                "branch_id, branch_name, vendor_id, vendor_name, vendor_bin, vendor_address, mode, method, "
                                "subtotal, sd, vat, discount, net_total, paid, due, tti, rebate, issued_by, designation, "
                                "created_at) select 'dupp" + TAG + "', invoice_no, challan_no, challan_date, issue_date, "
                                "process, branch_id, branch_name, vendor_id, vendor_name, vendor_bin, vendor_address, mode, "
                                "method, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'x', 'y', now() from purchases limit 1"],
                               capture_output=True, text=True)
        check(dupno.returncode != 0, "R5.3: the database refuses a duplicate purchase number (unique index), not just the API")

    # ── R5.3: the credit and debit notes ─────────────────────────────────────────────────────────────────────
    print("R5.3: credit and debit notes are rows too — one table, `kind` telling them apart")
    # an approved invoice and an approved purchase to raise notes against, on the SKUs these checks already use
    csale = arif.post(f"{BASE}/sales", json={**inv_body, "process": "Approved", "lines": [
        {"itemId": siid, "qty": 6, "price": 100, "sdRate": 0, "vatRate": 5}]}).json()
    csale2 = arif.post(f"{BASE}/sales", json={**inv_body, "process": "Approved", "lines": [
        {"itemId": siid, "qty": 6, "price": 100, "sdRate": 0, "vatRate": 5}]}).json()
    cpur = arif.post(f"{BASE}/purchases", json={**pur_body, "process": "Approved", "challanNo": f"CHN{TAG}", "lines": [
        {"itemId": piid, "qty": 6, "price": 100, "sdRate": 0, "vatRate": 5}]}).json()
    unsold = arif.post(f"{BASE}/sales", json=inv_body).json()
    cn_body = {"saleId": csale["id"], "issueDate": tdate, "issueTime": "11:00", "reason": "quality",
               "note": f"R5.3 credit {TAG}", "issuedBy": "Arif Hossain", "designation": "Sales Officer",
               "process": "Created", "lines": [{"itemId": siid, "qty": 2}]}
    split4 = sold_held()
    cn = arif.post(f"{BASE}/credit-notes", json=cn_body)
    cnid, cno = cn.json().get("id"), cn.json().get("no")
    cnline = cn.json()["lines"][0] if cn.status_code == 201 else {}
    check(cn.status_code == 201 and cn.json()["process"] == "Created" and str(cno).startswith("CN-")
          and cn.json()["saleNo"] == csale["invoiceNo"] and cnline.get("soldQty") == 6 and cnline.get("price") == 100
          and "tti" not in cn.json() and [h["action"] for h in cn.json()["history"]] == ["created"],
          f"native (R5.3): a credit note is raised against the invoice and priced pro rata ({cn.status_code} {cno})")
    check(sold_held() == split4, "R5.3: a draft note moves no stock")
    if DB_URL:
        check(psql(f"select count(*) from notes where id = '{cnid}' and kind = 'credit' and process = 'Created'"
                   f" and source_id = '{csale['id']}' and party_id = '{csale['customerId']}' and tti is null") == "1"
              and psql(f"select count(*) from note_lines where note_id = '{cnid}' and sold_qty = 6"
                       f" and purchased_qty is null") == "1",
              "R5.3: the draft is a row in notes, and its line a row in note_lines")
    si_sold = float(psql(f"select sold from items where id = '{siid}'")) if DB_URL else None
    cna = arif.patch(f"{BASE}/credit-notes/{cnid}", json={"process": "Approved"})
    check(cna.status_code == 200 and cna.json()["process"] == "Approved"
          and sold_held() == (split4[0] + 2, split4[1] + 2, split4[2]),
          f"R5.3: approving brings the goods back, and the branch split derived in memory follows ({cna.status_code})")
    cnled = arif.get(f"{BASE}/items/{siid}/ledger").json()
    check(any(e.get("ref") == cno for e in cnled["entries"]),
          "R5.3: …and the item's ledger, still derived from every document, quotes the note")
    if DB_URL:
        check(psql(f"select sold = {si_sold - 2} from items where id = '{siid}'") == "t",
              "R5.3: …and the counter it moved is written with it (items.sold)")
        check(psql(f"select jsonb_array_length(history) from notes where id = '{cnid}'") == "2",
              "R5.3: the note's own history travels with the row")
    check(arif.get(f"{BASE}/sales/{csale['id']}/creditable").json()["lines"][0]["remaining"] == 4,
          "R5.3: …and what is still returnable on the invoice is 4 of the 6 it sold")
    cnc = arif.patch(f"{BASE}/credit-notes/{cnid}", json={"process": "Cancelled", "reason": f"R5.3 cancelled {TAG}"})
    check(cnc.status_code == 200 and sold_held() == split4, "R5.3: cancelling sends the goods back out again")
    if DB_URL:
        check(psql(f"select count(*) from notes where id = '{cnid}' and process = 'Cancelled'"
                   f" and cancel_reason is not null") == "1"
              and psql(f"select sold = {si_sold} from items where id = '{siid}'") == "t",
              "R5.3: …and the cancellation and the counter are stored on the rows")
    check(arif.patch(f"{BASE}/credit-notes/{cnid}", json={"process": "Cancelled", "reason": "again"}).status_code == 409,
          "R5.3: a note that is already cancelled refuses a second cancellation (409)")
    # editing a draft replaces its lines; a note stays with the invoice it was raised against
    cn2 = arif.post(f"{BASE}/credit-notes", json=cn_body).json()
    cne = arif.put(f"{BASE}/credit-notes/{cn2['id']}", json={**cn_body, "lines": [{"itemId": siid, "qty": 3}]})
    check(cne.status_code == 200 and [l["qty"] for l in cne.json()["lines"]] == [3]
          and [h["action"] for h in cne.json()["history"]][-1] == "edited",
          f"R5.3: editing a draft note replaces its lines ({cne.status_code})")
    if DB_URL:
        check(psql(f"select qty::text from note_lines where note_id = '{cn2['id']}' and ord = 1") == "3.000",
              "R5.3: …in the child table")
    moved = arif.put(f"{BASE}/credit-notes/{cn2['id']}", json={**cn_body, "saleId": csale2["id"]})
    check(moved.status_code == 409, f"R5.3: a credit note cannot move to another invoice ({moved.status_code})")
    over = arif.post(f"{BASE}/credit-notes", json={**cn_body, "lines": [{"itemId": siid, "qty": 1000}]})
    check(over.status_code == 422 and over.json()["errors"].get("lines.0.qty") == ["exceedsRemaining"],
          "R5.3: returning more than the invoice sold is a 422 (exceedsRemaining)")
    notapp = arif.post(f"{BASE}/credit-notes", json={**cn_body, "saleId": unsold["id"]})
    check(notapp.status_code == 422 and notapp.json()["errors"].get("saleId") == ["notApproved"],
          "R5.3: a note against a draft invoice is a 422 (notApproved)")
    cnd = arif.delete(f"{BASE}/credit-notes/{cn2['id']}")
    check(cnd.status_code == 200 and cnd.json().get("ok") is True
          and arif.get(f"{BASE}/credit-notes/{cn2['id']}").status_code == 404,
          "R5.3: a draft note is deleted and leaves the register")
    if DB_URL:
        check(psql(f"select count(*) from notes where id = '{cn2['id']}' and deleted_at is not null") == "1"
              and psql(f"select count(*) from note_lines where note_id = '{cn2['id']}'") == "1",
              "R5.3: …as a stamped row that keeps its lines, so its id stays retired")
    cn3 = arif.post(f"{BASE}/credit-notes", json=cn_body).json()
    check(cn3["no"] != cn2["no"] and int(cn3["id"][2:]) > int(cn2["id"][2:]),
          f"R5.3: the next note takes a new number and a new id ({cn2['no']} → {cn3['no']})")
    # the debit side: the same table, the other kind, and the two totals only a debit note has
    dn_body = {"purchaseId": cpur["id"], "issueDate": tdate, "issueTime": "11:00", "reason": "damaged",
               "note": f"R5.3 debit {TAG}", "issuedBy": "Arif Hossain", "designation": "Purchase Officer",
               "process": "Created", "lines": [{"itemId": piid, "qty": 2}]}
    split5 = pheld()
    dn = arif.post(f"{BASE}/debit-notes", json=dn_body)
    dnid, dno = dn.json().get("id"), dn.json().get("no")
    dnline = dn.json()["lines"][0] if dn.status_code == 201 else {}
    check(dn.status_code == 201 and str(dno).startswith("DN-") and dn.json()["purchaseNo"] == cpur["invoiceNo"]
          and dnline.get("purchasedQty") == 6 and dn.json()["tti"] == 0 and "rebate" in dn.json()
          and [h["action"] for h in dn.json()["history"]] == ["created"],
          f"native (R5.3): a debit note is raised against the purchase and reverses its input tax ({dn.status_code} {dno})")
    if DB_URL:
        check(psql(f"select count(*) from notes where id = '{dnid}' and kind = 'debit' and source_id = '{cpur['id']}'"
                   f" and tti is not null and rebate is not null") == "1"
              and psql(f"select count(*) from note_lines where note_id = '{dnid}' and purchased_qty = 6"
                       f" and sold_qty is null and rebate is not null") == "1",
              "R5.3: …as a row of the same table, with the two totals only a debit note has")
    check(sold_held() == split4 and pheld() == split5, "R5.3: a draft debit note moves no stock either")
    big = arif.post(f"{BASE}/debit-notes", json={**dn_body, "process": "Approved",
                                                "lines": [{"itemId": piid, "qty": 100000}]})
    check(big.status_code == 422 and big.json()["errors"].get("lines.0.qty") == ["exceedsRemaining"],
          f"R5.3: returning more than the purchase bought is a 422 ({big.status_code})")
    # 4, not 6: the draft above already has 2 of the purchase's 6 units earmarked
    dn3 = arif.post(f"{BASE}/debit-notes", json={**dn_body, "lines": [{"itemId": piid, "qty": 4}]}).json()
    away = pheld()[1]
    out = arif.post(f"{BASE}/transfers", json={"fromBranchId": branch, "toBranchId": other, "date": tdate,
                    "vehicle": "", "note": f"R5.3 stock away {TAG}", "lines": [{"itemId": piid, "qty": away}],
                    "process": "Approved"})
    shortdn = arif.patch(f"{BASE}/debit-notes/{dn3['id']}", json={"process": "Approved"})
    back = arif.post(f"{BASE}/transfers", json={"fromBranchId": other, "toBranchId": branch, "date": tdate,
                     "vehicle": "", "note": f"R5.3 stock back {TAG}", "lines": [{"itemId": piid, "qty": away}],
                     "process": "Approved"})
    check(out.status_code in (200, 201) and back.status_code in (200, 201) and shortdn.status_code == 409
          and "Insufficient stock to return" in shortdn.json().get("title", ""),
          f"R5.3: approving a return the branch no longer holds is a 409 ({shortdn.status_code})")
    pi_pur = float(psql(f"select purchased from items where id = '{piid}'")) if DB_URL else None
    dna = arif.patch(f"{BASE}/debit-notes/{dnid}", json={"process": "Approved"})
    check(dna.status_code == 200 and pheld() == (split5[0] - 2, split5[1] - 2, split5[2]),
          f"R5.3: approving a debit note takes the goods back out ({dna.status_code})")
    if DB_URL:
        check(psql(f"select purchased = {pi_pur - 2} from items where id = '{piid}'") == "t",
              "R5.3: …and the counter it moved is written with it (items.purchased)")
    check(arif.get(f"{BASE}/purchases/{cpur['id']}/returnable").json()["lines"][0]["remaining"] == 0,
          "R5.3: …and what is still returnable on the purchase deducts every note that is not cancelled")
    svc_pur = ps.json()["id"]
    svcdn = arif.post(f"{BASE}/debit-notes", json={**dn_body, "purchaseId": svc_pur})
    check(svcdn.status_code == 422 and svcdn.json()["errors"].get("purchaseId") == ["unknown"],
          "R5.3: a service purchase has no goods to return (422)")
    dnc = arif.patch(f"{BASE}/debit-notes/{dnid}", json={"process": "Cancelled", "reason": f"R5.3 cancelled {TAG}"})
    check(dnc.status_code == 200 and pheld() == split5, "R5.3: cancelling puts the goods back on the books")
    if DB_URL:
        check(psql(f"select count(*) from notes where id = '{dnid}' and process = 'Cancelled'"
                   f" and cancel_reason is not null") == "1"
              and psql(f"select purchased = {pi_pur} from items where id = '{piid}'") == "t",
              "R5.3: …and the cancellation and the counter are stored on the rows")
    dn2 = arif.post(f"{BASE}/debit-notes", json=dn_body).json()
    dnd = arif.delete(f"{BASE}/debit-notes/{dn2['id']}")
    check(dnd.status_code == 200 and arif.get(f"{BASE}/debit-notes/{dn2['id']}").status_code == 404
          and arif.delete(f"{BASE}/debit-notes/{dnid}").status_code == 409,
          "R5.3: a draft debit note is deleted, and an approved one is not (409)")
    if DB_URL:
        check(psql("select count(*) from compat_state where data->'db' ? 'creditNotes'") == "0"
              and psql("select count(*) from compat_state where data->'db' ? 'debitNotes'") == "0",
              "R5.3: the snapshot carries neither note collection at all")
        check(int(psql("select count(*) from notes where kind = 'credit'")) >= 5
              and int(psql("select count(*) from notes where kind = 'debit'")) >= 5
              and int(psql("select count(*) from note_lines")) >= 10,
              "R5.3: the demo notes were seeded into their tables, both kinds with their lines")
        dupno = subprocess.run(["psql", DB_URL, "-At", "-c",
                                "insert into notes (id, kind, no, source_id, source_no, source_date, source_mode, "
                                "challan_no, party_id, party_name, party_bin, party_address, branch_id, branch_name, "
                                "issue_date, issue_time, reason, issued_by, designation, process, subtotal, sd, vat, "
                                "total, created_at) select 'dupn" + TAG + "', kind, no, source_id, source_no, "
                                "source_date, source_mode, challan_no, party_id, party_name, party_bin, party_address, "
                                "branch_id, branch_name, issue_date, issue_time, reason, issued_by, designation, "
                                "process, 0, 0, 0, 0, now() from notes limit 1"],
                               capture_output=True, text=True)
        check(dupno.returncode != 0, "R5.3: the database refuses a duplicate note number (unique index), not just the API")

    # R6: chain verification endpoint
    v = arif.get(f"{BASE}/audit/verify")
    check(v.status_code == 200 and v.json().get("ok") is True and v.json().get("algorithm") == "SHA-256", f"R6: audit chain verifies ({v.json().get('count') if v.ok else v.status_code} events)")
    check(len(v.json().get("head", "")) == 64 if v.ok else False, "R6: chain head is a SHA-256 hex digest")
    check(session("kamal").get(f"{BASE}/audit/verify").status_code == 403, "R6: operators cannot run the verification (audit.view)")

    # R6.2: VAT officer — time-boxed, read-only, every read logged
    print("R6.2: VAT officer + backups")
    import datetime
    admin = session("admin")
    dhaka = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=6)).date()
    oname = f"nbr{TAG}"
    obody = {"username": oname, "name": f"Officer {TAG}", "designation": "Revenue Officer", "email": f"{oname}@nbr.example", "mobile": "", "department": "NBR",
             "role": "vatOfficer", "active": True, "accessUntil": str(dhaka + datetime.timedelta(days=200))}
    r = admin.post(f"{BASE}/users", json=obody)
    check(r.status_code == 422 and r.json()["errors"].get("accessUntil") == ["accessTooLong"], "R6.2: officer access longer than 90 days → 422")
    r = admin.post(f"{BASE}/users", json={**obody, "accessUntil": str(dhaka + datetime.timedelta(days=7))})
    check(r.status_code == 201 and r.json()["user"].get("accessUntil") == str(dhaka + datetime.timedelta(days=7)), "R6.2: officer created with access-until date")
    off = r.json()
    o = session(oname, off["tempPassword"])
    check(o.get(f"{BASE}/vat/exports").status_code == 200 and o.get(f"{BASE}/audit", params={"size": 2}).status_code == 200, "R6.2: officer can read (compat + native)")
    check(o.post(f"{BASE}/units", json={"code": "ZZ", "name": "x", "decimals": 0}).status_code == 403, "R6.2: officer cannot write")
    acc = admin.get(f"{BASE}/audit", params={"entity": "access", "size": 50}).json()["data"]
    refs = {e["ref"] for e in acc if e.get("actorId") == off["user"]["id"]}
    check({"/vat/exports", "/audit"} <= refs, f"R6.2: officer reads are in the audit trail ({sorted(refs)})")
    if DB_URL:
        check(psql(f"select access_until from users where username = '{oname}'") == str(dhaka + datetime.timedelta(days=7)), "R6.2: users.access_until stored")
        psql(f"update users set access_until = '{dhaka - datetime.timedelta(days=1)}' where username = '{oname}'")
        u = admin.get(f"{BASE}/users/{off['user']['id']}").json()
        admin.put(f"{BASE}/users/{off['user']['id']}", json={**u, "designation": "Revenue Officer (expired)"})  # refreshes the server's copy
        check(o.get(f"{BASE}/me").status_code == 401, "R6.2: an expired officer's session stops working")
        r = requests.post(f"{BASE}/auth/login", json={"username": oname, "password": off["tempPassword"]})
        check(r.status_code == 403 and r.json().get("title") == "expired", "R6.2: expired officer cannot sign in (403 expired)")
        check(subprocess.run(["psql", DB_URL, "-At", "-c", f"update users set access_until = null where username = '{oname}'"], capture_output=True, text=True).returncode != 0, "R6.2: the database requires an access date for officers")
    else:
        skipped("officer expiry (DATABASE_URL not set)")

    # R6.2: backups in PostgreSQL
    st = admin.get(f"{BASE}/backups").json()
    check(st.get("storage") == "postgres" and st.get("schedule") == ["02:00", "14:00"] and any(x["kind"] == "scheduled" for x in st.get("rows", [])), "R6.2: backups stored in PostgreSQL; the current slot's scheduled backup exists")
    bk = admin.post(f"{BASE}/backups")
    check(bk.status_code == 201 and len(bk.json().get("sha256", "")) == 64, f"R6.2: manual backup ({round(bk.json().get('size', 0) / 1024)} KB)")
    bid = bk.json()["id"]
    check(admin.post(f"{BASE}/backups/{bid}/verify").json().get("ok") is True, "R6.2: backup checksum verifies")
    d = admin.get(f"{BASE}/backups/{bid}")
    import gzip as _gz
    snap = json.loads(_gz.decompress(d.content)) if d.ok else {}
    check(d.ok and snap.get("format") == "dizivat-backup/1" and "audit_events" in snap.get("tables", {}) and "compat_state" in snap.get("tables", {}), "R6.2: download is a gzip JSON snapshot of the tables")
    check(not any("password_hash" in u for u in snap.get("tables", {}).get("users", [])), "R6.2: password hashes are not in backups")
    check(session("arif").get(f"{BASE}/backups").status_code == 403, "R6.2: backups need settings.manage")
    if DB_URL:
        check(int(psql("select count(*) from backups")) >= 2 and psql(f"select sha256 from backups where id = {bid[2:]}") == bk.json()["sha256"], "R6.2: backups are rows in the backups table")
        dup = subprocess.run(["psql", DB_URL, "-At", "-c", f"insert into backups (kind, slot, by, size, sha256, tables, data) select 'scheduled', slot, 'x', 1, 'x', '{{}}', '\\x00' from backups where kind = 'scheduled' limit 1"], capture_output=True, text=True)
        check(dup.returncode != 0, "R6.2: only one scheduled backup per slot (unique index)")

    # R6.3: RMG demo company, SD on exported inputs + penalty (compat), restore drill into a fresh database
    print("R6.3: RMG company, note 40, penalty, restore drill")
    co = arif.get(f"{BASE}/company").json()
    check("KANCHANJHARA" in co.get("name", "").upper() and co.get("bin") == "004937518-0102", f"R6.3: demo company is {co.get('name')}")
    sde = arif.get(f"{BASE}/vat/sd-eligible").json()
    check(any(r["purchaseId"] == "p95" and r["state"] == "lapsed" for r in sde.get("rows", [])) and sde.get("totals", {}).get("claimable", 0) > 0, "R6.3: SD six-month register served from PostgreSQL")
    q = arif.get(f"{BASE}/vat/penalty", params={"period": "2026-08", "vat": 100000, "sd": 0, "paidOn": "2026-11-20", "filedOn": "2026-11-20"}).json()
    check(q.get("result", {}).get("total") == 13000, "R6.3: penalty quote (3 months × 1 % + Tk 10,000)")
    if DB_URL:
        restore_js = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api", "dist", "restore.js")
        target = DB_URL.split("?")[0].rsplit("/", 1)[0] + f"/dizivat_drill_{TAG}"
        t0 = time.time()
        rp = subprocess.run(["node", restore_js, "--source", DB_URL, "--id", bid, "--target", target, "--create", "--admin-password", f"Drill-{TAG}-pw", "--boot", "--drop-after", "--record", "--report", f"/tmp/drill_{TAG}.json"],
                            capture_output=True, text=True, timeout=600, env={**os.environ, "DRILL_BY": "api_native"})
        rep = json.load(open(f"/tmp/drill_{TAG}.json")) if os.path.exists(f"/tmp/drill_{TAG}.json") else {}
        check(rp.returncode == 0 and rep.get("ok") is True, f"R6.3: restore drill of {bid} passed in {time.time() - t0:.1f} s ({rep.get('tables')} tables, {rep.get('rows')} rows){'' if rp.returncode == 0 else ' — ' + (rp.stderr or rp.stdout)[-300:]}")
        check(rep.get("auditChain") == "ok" and rep.get("boot") == "ok" and not rep.get("mismatches"), "R6.3: drill verified counts, audit chain and a sign-in on the restored copy")
        check(psql(f"select count(*) from pg_database where datname = 'dizivat_drill_{TAG}'") == "0", "R6.3: --drop-after removed the drill database")
        dr = admin.get(f"{BASE}/backups").json().get("drill") or {}
        check(dr.get("ok") is True and dr.get("backupId") == bid and dr.get("by") == "api_native", "R6.3: GET /backups shows the recorded drill")
        t2 = DB_URL.split("?")[0].rsplit("/", 1)[0] + f"/dizivat_twice_{TAG}"
        first = subprocess.run(["node", restore_js, "--source", DB_URL, "--target", t2, "--create"], capture_output=True, text=True, timeout=300)
        again = subprocess.run(["node", restore_js, "--source", DB_URL, "--target", t2], capture_output=True, text=True, timeout=300)
        same = subprocess.run(["node", restore_js, "--source", DB_URL, "--target", DB_URL], capture_output=True, text=True, timeout=120)
        psql(f"drop database if exists dizivat_twice_{TAG}")
        check(first.returncode == 0 and again.returncode == 1 and "not empty" in again.stderr + again.stdout and same.returncode == 1,
              "R6.3: restore refuses a database that already holds data (and the source itself)")
    else:
        skipped("restore drill (DATABASE_URL not set)")

    # R6.4: bond consumption register + drawback (compat), bonded import fields persisted in PostgreSQL
    print("R6.4: bond register, BoE ageing, drawback")
    bond = arif.get(f"{BASE}/vat/bond").json()
    lots = {(l["boeNo"], l["itemId"]): l for l in bond.get("lots", [])}
    check(lots.get(("C-0988415", "i4"), {}).get("state") == "expiring" and lots.get(("C-0979032", "i11"), {}).get("state") == "extension",
          "R6.4: go-live BoEs expiring / in extension (bond register served from PostgreSQL)")
    check(bond.get("totals", {}).get("dutyAtRisk", 0) > 0 and bond.get("drawback", {}).get("totals", {}).get("claimable", 0) > 0, "R6.4: shortfall duty at risk and claimable drawback")
    bp = arif.get(f"{BASE}/purchases/{lots.get(('C-1012264', 'i5'), {}).get('docId', 'p98')}").json()
    check(bp.get("boe", {}).get("bonded") is True and bp.get("vat") == 0 and (bp.get("lines") or [{}])[0].get("duty", {}).get("foregone", {}).get("total", 0) > 0,
          "R6.4: bonded import keeps duty foregone with nothing payable")
    check(arif.get(f"{BASE}/vat/bond", params={"to": "2030-01-01"}).status_code == 422, "R6.4: range validation (422)")

    # R6.5: own UD settlement + drawback claims (compat), persisted in PostgreSQL
    print("R6.5: UD settlement, drawback claims")
    bu = {u["id"]: u for u in arif.get(f"{BASE}/vat/bond-uds").json().get("rows", [])}
    b1, b5 = bu.get("bu1", {}), bu.get("bu5", {})
    check(b1.get("state") == "settled" and abs((b1.get("settlement") or {}).get("lines", [{}])[0].get("dutyPaidQty", 0) - 974.24) < 0.001
          and any(l.get("broughtForward") == 2000 for l in b5.get("lines", [])), "R6.5: seeded settlement + brought forward served from PostgreSQL")
    ud_no = f"BKMEA/UD/2026/N{TAG}".upper()
    r = arif.post(f"{BASE}/vat/bond-uds", json={"kind": "UD", "issuer": "BKMEA", "no": ud_no, "date": "2026-08-01", "expiry": "2026-09-01", "masterLcNo": f"EXP-LC-N-{TAG}",
                                               "inputs": [{"itemId": "i9", "qty": 100}], "garments": [{"itemId": "i18", "qty": 300}]})
    ud_id = r.json().get("id") if r.status_code == 201 else None
    st = arif.post(f"{BASE}/vat/bond-uds/{ud_id}/settle", json={"date": "2026-09-20", "bondRef": f"CBC/N/{TAG}"}) if ud_id else None
    check(ud_id is not None and st is not None and st.status_code == 200 and st.json().get("state") == "settled", "R6.5: an expired UD settles (nothing left over)")
    check(arif.post(f"{BASE}/vat/bond-uds/{ud_id}/settle", json={"date": "2026-09-20", "bondRef": f"CBC/N/{TAG}"}).status_code == 409, "R6.5: a settled UD cannot be settled again (409)")
    drafts = arif.get(f"{BASE}/vat/drawback-claims", params={"status": "draft"}).json().get("rows", [])
    claim_id = drafts[0]["id"] if drafts else None
    fr = arif.post(f"{BASE}/vat/drawback-claims/{claim_id}/action", json={"action": "file", "date": "2026-09-25", "ref": f"DEDO/N/{TAG}"}) if claim_id else None
    check(fr is not None and fr.status_code == 200 and fr.json().get("status") == "filed", "R6.5: a draft drawback claim is filed with DEDO")

    # R6.6: bank PRC file batches + Mushak 9.3 / 9.4 applications (compat), persisted in PostgreSQL
    print("R6.6: PRC batches, return applications")
    pv = arif.get(f"{BASE}/vat/proceeds").json()
    check(pv.get("outstanding", {}).get("count", 0) >= 1 and any(b.get("no") == "PB-09260004" and b.get("status") == "reversed" for b in pv.get("batches", [])), "R6.6: proceeds overview + seeded batches served from PostgreSQL")
    target = next((o for o in pv.get("open", []) if o.get("outstandingFc", 0) >= 2), None)
    prc_no = f"PRC/N/{TAG}".upper()
    pb = arif.post(f"{BASE}/vat/proceeds/batches", json={"fileName": f"native-{TAG}.csv", "rows": [{"line": 2, "date": "2026-09-25", "prcNo": prc_no, "currency": target["currency"], "fcAmount": 1, "rate": target["rate"],
                                                         "allocations": [{"saleId": target["saleId"], "fcAmount": 1, "basis": "manual"}]}]}) if target else None
    pb_id = pb.json().get("id") if pb is not None and pb.status_code == 201 else None
    check(pb_id is not None, f"R6.6: a bank-file batch posts (HTTP {pb.status_code if pb is not None else '-'})")
    check(arif.post(f"{BASE}/vat/proceeds/match", json={"rows": [{"line": 2, "date": "2026-09-25", "prcNo": prc_no, "currency": "USD", "fcAmount": 1, "rate": 122}]}).json().get("rows", [{}])[0].get("state") == "duplicate", "R6.6: the posted PRC is a duplicate on re-import")
    lfs = arif.get(f"{BASE}/vat/late-filings").json()
    check({"lf1", "lf2"} <= {r["id"] for r in lfs.get("rows", [])}, "R6.6: seeded Mushak 9.3 applications served")
    am_id = None
    for per in ("2026-06", "2026-05", "2026-04", "2026-02", "2026-01"):
        r = arif.post(f"{BASE}/vat/return-amendments", json={"period": per, "reasonKind": "clerical", "description": f"Native check {TAG} — transposed digits", "noAudit": True,
                                                            "corrections": [{"note": 1, "field": "value", "to": 1234.56, "explanation": "Transposed digits"}]})
        if r.status_code == 201: am_id = r.json()["id"]; break
    fr = arif.post(f"{BASE}/vat/return-amendments/{am_id}/action", json={"action": "file", "date": "2026-09-25", "ref": f"NBR/N/{TAG}"}) if am_id else None
    check(fr is not None and fr.status_code == 200 and fr.json().get("status") == "filed", "R6.6: a Mushak 9.4 application is created and filed")

    # re-baseline: the R6.2 block above adds audit events for this run's tag (officer, access log, backups)
    before_ids = sorted(e["id"] for e in arif.get(f"{BASE}/audit", params={"q": TAG, "size": 50}).json()["data"])
    if RESTART:
        print("restart: everything survives")
        secs = restart()
        check(True, f"API restarted ({secs:.1f} s)")
        check(arif.get(f"{BASE}/me").status_code == 200, "sessions survive a restart (no re-login)")
        check(a.get(f"{BASE}/me").status_code == 200 and b.get(f"{BASE}/me").status_code == 401, "revocations survive a restart")
        check(arif.get(f"{BASE}/customers/{cid}").status_code == 200, "R5.2: customer still there (read from the parties table)")
        check(arif.get(f"{BASE}/vendors/{gid}").status_code == 404, "R5.2: a deleted party stays deleted across a restart")
        check(any(u["no"] == ud_body["no"] for u in arif.get(f"{BASE}/vat/uds").json().get("rows", [])), "compat: the UD still there")
        check(any(x["code"] == f"R5{TAG[:3]}" for x in arif.get(f"{BASE}/units").json()["data"]), "native: unit still there")
        check(arif.get(f"{BASE}/items/{iid}").json().get("remain") == 40, "R5.2: the SKU's stock survives a restart (counters are columns, not memory)")
        check(arif.get(f"{BASE}/master-items/{mid}").json().get("name") == f"R5 Master Renamed {TAG}", "R5.2: …and the master item kept its rename")
        me = arif.get(f"{BASE}/me").json()
        check(me["preferences"].get("density") == "compact" and me["preferences"].get("accent") == "violet", "preferences still there")
        check(any(x["name"] == f"R5 view {TAG}" for x in arif.get(f"{BASE}/me/views", params={"table": "sales"}).json()), "saved view still there")
        after = arif.get(f"{BASE}/audit", params={"q": TAG, "size": 50}).json()
        check(sorted(e["id"] for e in after["data"]) == before_ids, "audit events unchanged (same ids)")
        r = requests.post(f"{BASE}/auth/login", json={"username": wname, "password": w["tempPassword"]})
        check(r.status_code == 429, "lockout survives a restart")
        check(requests.post(f"{BASE}/auth/login", json={"username": name, "password": new_pw}).status_code == 200, "changed password survives a restart")
        n = arif.post(f"{BASE}/customers", json={"name": f"R5 After Restart {TAG}", "mode": "Foreign", "country": "Japan", "address": "4-5-6 Shibuya, Tokyo"})
        check(n.status_code == 201 and n.json()["id"] != cid, "new records after a restart get fresh ids")
        if DB_URL:
            check(psql(f"select count(*) from parties where id = '{gid}' and deleted_at is not null") == "1", "R5.2: the trash is rebuilt from the table, not from the snapshot")
        check(arif.get(f"{BASE}/vat/bond").json().get("totals") == bond.get("totals"), "R6.4: bond register unchanged after a restart")
        u_after = arif.get(f"{BASE}/vat/bond-uds/{ud_id}").json() if ud_id else {}
        c_after = arif.get(f"{BASE}/vat/drawback-claims/{claim_id}").json() if claim_id else {}
        check((u_after.get("settlement") or {}).get("bondRef") == f"CBC/N/{TAG}" and c_after.get("status") == "filed" and c_after.get("dedoRef") == f"DEDO/N/{TAG}",
              "R6.5: UD settlement and filed claim survive a restart")
        b_after = arif.get(f"{BASE}/vat/proceeds/batches/{pb_id}").json() if pb_id else {}
        a_after = arif.get(f"{BASE}/vat/return-amendments/{am_id}").json() if am_id else {}
        check(b_after.get("status") == "posted" and b_after.get("lines", [{}])[0].get("prcNo") == prc_no and a_after.get("status") == "filed" and a_after.get("filedRef") == f"NBR/N/{TAG}",
              "R6.6: PRC batch and filed 9.4 application survive a restart")
        rv = arif.post(f"{BASE}/vat/proceeds/batches/{pb_id}/reverse", json={"date": "2026-09-25", "reason": f"Native reversal {TAG}"}) if pb_id else None
        check(rv is not None and rv.status_code == 200 and rv.json().get("status") == "reversed", "R6.6: the batch reverses after a restart")
        bl = admin.get(f"{BASE}/backups").json()
        check(any(x["id"] == bid for x in bl.get("rows", [])), "R6.2: backups survive a restart")
        v2 = arif.get(f"{BASE}/audit/verify").json()
        check(v2.get("ok") is True and v2.get("count", 0) > v.json().get("count", 0), "R6: the chain continues across a restart")

        # R6.4.1: Render overlaps the old and the new instance during a deploy. When the new one re-seeds, the old
        # one must refuse to write (its in-memory state is stale) instead of chaining audit events to a replaced head
        # or upserting its snapshot over the fresh demo data.
        print("\nR6.4.1: deploy overlap — the database is re-seeded under a running instance")
        epoch = psql("select value from meta where key = 'seeded_at'")
        events_before = psql("select count(*) from audit_events")
        psql("update meta set value = '2099-01-01T00:00:00.000Z' where key = 'seeded_at'")
        try:
            w = arif.post(f"{BASE}/customers", json={"name": f"R6 Stale Write {TAG}", "mode": "Foreign", "country": "Japan", "address": "1-2-3 Ginza, Tokyo"})
            check(w.status_code == 503, f"stale instance refuses a native party write after a re-seed elsewhere (HTTP {w.status_code})")
            check(psql(f"select count(*) from parties where name like '%R6 Stale Write {TAG}%'") == "0", "R5.2: the refused party never reached the parties table")
            wi = arif.post(f"{BASE}/items", json={**item_body, "name": f"R6 Stale Item {TAG}", "sku": f"R6-SW-{TAG}"})
            check(wi.status_code == 503, f"R5.2: stale instance refuses a native SKU write (HTTP {wi.status_code})")
            check(psql(f"select count(*) from items where sku = 'R6-SW-{TAG}'") == "0", "R5.2: the refused SKU never reached the items table")
            ws = arif.post(f"{BASE}/transfers", json={"fromBranchId": branch, "toBranchId": other, "date": time.strftime("%Y-%m-%d"),
                                                      "note": f"R5.3 stale {TAG}", "lines": [{"itemId": iid, "qty": 1}], "process": "Created"})
            check(ws.status_code == 503, f"R5.3: stale instance refuses a native stock-document write (HTTP {ws.status_code})")
            check(psql(f"select count(*) from stock_documents where note like '%R5.3 stale {TAG}%'") == "0",
                  "R5.3: the refused document never reached stock_documents")
            wu = arif.post(f"{BASE}/vat/uds", json={**ud_body, "no": f"BKMEA/UD/2026/SW{TAG}".upper(), "masterLcNo": f"EXP-LC-SW-{TAG}"})
            check(wu.status_code == 503, f"stale instance refuses a compat write after a re-seed elsewhere (HTTP {wu.status_code})")
            check(psql(f"select count(*) from compat_state where data::text like '%R6 Stale Write {TAG}%'") == "0", "stale snapshot not written over the re-seeded data")
            r = requests.post(f"{BASE}/auth/login", json={"username": "farzana", "password": PW})
            check(r.status_code == 503, f"stale instance refuses to append to the audit chain (HTTP {r.status_code})")
            check(psql("select count(*) from audit_events") == events_before, "no audit event chained to a replaced head")
        finally:
            psql(f"update meta set value = '{epoch}' where key = 'seeded_at'")
        restart()  # drop the diverged in-memory state
        v3 = arif.get(f"{BASE}/audit/verify").json()
        cl = arif.get(f"{BASE}/customers", params={"q": f"R6 Stale Write {TAG}"}).json()
        cl = cl.get("data", []) if isinstance(cl, dict) else cl
        uds_after = arif.get(f"{BASE}/vat/uds").json().get("rows", [])
        stale_items = arif.get(f"{BASE}/items", params={"q": f"R6 Stale Item {TAG}"}).json()
        check(v3.get("ok") is True and not any(f"R6 Stale Write {TAG}" in (c.get("name") or "") for c in cl)
              and not any(f"SW{TAG}".upper() in (u.get("no") or "") for u in uds_after) and stale_items.get("total", 0) == 0,
              "after a restart: chain intact, all three refused writes absent")

        # R5.2: the upgrade a customer installation takes — a database written before the migration still carries its
        # master data inside compat_state, and the first boot on this code has to move it into the tables without
        # losing a record (no re-seed: SEED_VERSION is unchanged, so the data on disk is all there is).
        print("\nR5.2: upgrading a pre-R5.2 database moves the master data into their tables")
        counts = lambda: (psql("select count(*) from parties"), psql("select count(*) from parties where deleted_at is not null"),
                          psql("select count(*) from items"), psql("select count(*) from master_items"))
        registers = lambda: {k: arif.get(f"{BASE}/{k}", params=q).json() for k, q in
                             (("customers", {"view": "table", "size": 200}), ("vendors", {"view": "table", "size": 200}),
                              ("items", {"size": 500}), ("master-items", {"size": 500}))}
        def upgraded_boots():
            if not API_LOG or not os.path.exists(API_LOG):
                return None
            with open(API_LOG, encoding="utf-8", errors="replace") as f:
                return sum(1 for line in f if "R5.2 upgrade:" in line)
        had, before, boots = counts(), registers(), upgraded_boots()
        psql(PRE_R52_COLLECTIONS)
        psql(PRE_R52_TRASH)
        psql("delete from parties")
        psql("delete from items")
        psql("delete from master_items")
        check(counts() == ("0", "0", "0", "0")
              and psql("select count(*) from compat_state where data->'db' ? 'customers' and data->'db' ? 'vendors' "
                       "and data->'db' ? 'items' and data->'db' ? 'masterItems'") == "1",
              f"the database is back in the pre-R5.2 shape ({had[0]} parties, {had[2]} SKUs, {had[3]} master items inside the snapshot)")
        restart()
        check(counts() == had, f"the first boot moved every record into the tables (parties {had[0]} incl. {had[1]} deleted, items {had[2]}, master items {had[3]})")
        check(psql("select count(*) from compat_state where data->'db' ? 'customers' or data->'db' ? 'vendors' "
                   "or data->'db' ? 'items' or data->'db' ? 'masterItems'") == "0",
              "…and rewrote the snapshot without them")
        check(psql(PARTY_TRASH_LEFT) == "0", "…and took the deleted parties out of the undo buffer, keeping its documents")
        check(registers() == before, "…and serves the same four registers, row for row")
        check(psql(f"select count(*) from parties where id = '{gid}' and deleted_at is not null") == "1"
              and arif.get(f"{BASE}/vendors/{gid}").status_code == 404, "a party deleted before the upgrade is still in the trash")
        check(arif.post(f"{BASE}/vendors/{gid}/restore").status_code == 200, "…and its undo still works afterwards")
        boots_after, now = upgraded_boots(), counts()
        restart()
        check(counts() == now and (boots is None or boots_after == boots + 1) and (boots is None or upgraded_boots() == boots_after),
              "a second boot adopts nothing again — the tables are the only copy from then on")
        w = arif.post(f"{BASE}/customers", json={"name": f"R5 Upgraded {TAG}", "mode": "Foreign", "country": "Japan", "address": "1-2-3 Ginza, Tokyo"})
        check(w.status_code == 201 and psql(f"select count(*) from parties where id = '{w.json().get('id')}'") == "1",
              f"and writes land in the tables on the upgraded database ({w.status_code})")

        # R5.3: the same upgrade one release later — a database written before the stock documents had tables holds
        # them (lines included) inside compat_state, and the first boot on this code has to move them out without
        # losing a line or a state.
        print("\nR5.3: upgrading a pre-R5.3 database moves the stock documents into their tables")
        stock_counts = lambda: (psql("select count(*) from stock_documents"), psql("select count(*) from stock_document_lines"))
        stock_registers = lambda: {k: arif.get(f"{BASE}/{k}", params={"size": 200}).json() for k in ("transfers", "damage")}
        def stock_boots():
            if not API_LOG or not os.path.exists(API_LOG):
                return None
            with open(API_LOG, encoding="utf-8", errors="replace") as f:
                return sum(1 for line in f if "R5.3 upgrade:" in line)
        shad, sbefore, ssplit, sboots = stock_counts(), stock_registers(), held(), stock_boots()
        tlines = psql(f"select count(*) from stock_document_lines where doc_id = '{tid}'")
        psql(PRE_R53_COLLECTIONS)
        psql("delete from stock_document_lines")
        psql("delete from stock_documents")
        check(stock_counts() == ("0", "0")
              and psql("select count(*) from compat_state where data->'db' ? 'transfers' and data->'db' ? 'damages'") == "1",
              f"the database is back in the pre-R5.3 shape ({shad[0]} stock documents, {shad[1]} lines inside the snapshot)")
        restart()
        check(stock_counts() == shad, f"the first boot moved every document into the tables ({shad[0]} documents, {shad[1]} lines)")
        check(psql("select count(*) from compat_state where data->'db' ? 'transfers' or data->'db' ? 'damages'") == "0",
              "…and rewrote the snapshot without them")
        check(stock_registers() == sbefore, "…and serves the same two registers, row for row")
        check(psql(f"select count(*) from stock_documents where id = '{tid}' and process = 'Cancelled'") == "1"
              and psql(f"select count(*) from stock_document_lines where doc_id = '{tid}'") == tlines,
              "a document approved and cancelled before the upgrade kept its state and its lines")
        check(held() == ssplit, "…and the stock derived from them is unchanged — the branch split survived the round trip")
        sboots_after, snow = stock_boots(), stock_counts()
        restart()
        check(stock_counts() == snow and (sboots is None or sboots_after == sboots + 1) and (sboots is None or stock_boots() == sboots_after),
              "a second boot adopts nothing again — the tables are the only copy from then on")
        wt = arif.post(f"{BASE}/transfers", json={"fromBranchId": branch, "toBranchId": other, "date": time.strftime("%Y-%m-%d"),
                                                  "lines": [{"itemId": iid, "qty": 1}], "process": "Created"})
        check(wt.status_code == 201 and psql(f"select count(*) from stock_documents where id = '{wt.json().get('id')}'") == "1",
              f"and writes land in the tables on the upgraded database ({wt.status_code})")

        # … and the invoices, which the same release moved out: a database written before them holds them inside
        # compat_state — lines and proceeds entries included, a draft deleted before the upgrade in the undo buffer.
        print("\nR5.3: upgrading a pre-R5.3 database moves the sales invoices into their tables")
        def sale_counts():
            return (psql("select count(*) from sales"), psql("select count(*) from sale_lines"),
                    psql("select count(*) from sale_realisations"))

        def sale_registers():
            return {"sales": arif.get(f"{BASE}/sales", params={"size": 300, "category": "all"}).json(),
                    "services": arif.get(f"{BASE}/sales", params={"size": 100, "category": "service"}).json(),
                    "customers": arif.get(f"{BASE}/customers", params={"size": 100}).json()}

        gone = arif.post(f"{BASE}/sales", json={**inv_body, "narration": f"R5.3 deleted {TAG}"}).json()
        arif.delete(f"{BASE}/sales/{gone['id']}")
        def sale_shapes():
            return (psql("select count(*) from sales where export_deemed is not null"),
                    psql("select count(*) from sales where category = 'service'"),
                    psql("select count(*) from sale_realisations"))

        scounts, sbefore, ssplit, sboots, sshapes = sale_counts(), sale_registers(), sold_held(), stock_boots(), sale_shapes()
        psql(PRE_R53_SALES)
        psql(PRE_R53_SALE_TRASH)
        psql("delete from sale_realisations")
        psql("delete from sale_lines")
        psql("delete from sales")
        check(sale_counts() == ("0", "0", "0") and psql("select count(*) from compat_state where data->'db' ? 'sales'") == "1"
              and psql(SALE_TRASH_LEFT) == "1",
              f"the database is back in the pre-R5.3 shape ({scounts[0]} invoices, {scounts[1]} lines, "
              f"{scounts[2]} proceeds entries inside the snapshot)")
        restart()
        check(sale_counts() == scounts,
              f"the first boot moved every invoice into the tables ({scounts[0]} invoices, {scounts[1]} lines)")
        check(psql("select count(*) from compat_state where data->'db' ? 'sales'") == "0", "…and rewrote the snapshot without them")
        check(psql(SALE_TRASH_LEFT) == "0", "…and took the deleted drafts out of the undo buffer, keeping its documents")
        check(sale_registers() == sbefore, "…and serves the same three registers, row for row")
        check(psql(f"select count(*) from sales where id = '{gone['id']}' and deleted_at is not null") == "1"
              and psql(f"select count(*) from sale_lines where sale_id = '{gone['id']}'") == "1",
              "an invoice deleted before the upgrade is still in the undo buffer, with its lines")
        un = arif.post(f"{BASE}/sales/{gone['id']}/restore")
        check(un.status_code == 200 and psql(f"select count(*) from sales where id = '{gone['id']}' and deleted_at is null") == "1",
              f"…and its undo still works afterwards ({un.status_code})")
        check(sale_shapes() == sshapes,
              f"the export headers ({sshapes[0]}), the service sales ({sshapes[1]}) and the proceeds entries "
              f"({sshapes[2]}) came back with their invoices")
        check(sold_held() == ssplit, "…and the stock derived from them is unchanged — the branch split survived the round trip")
        sboots_after, snow = stock_boots(), sale_counts()
        restart()
        check(sale_counts() == snow and (sboots is None or sboots_after == sboots + 1) and (sboots is None or stock_boots() == sboots_after),
              "a second boot adopts nothing again — the tables are the only copy from then on")
        ws = arif.post(f"{BASE}/sales", json=inv_body)
        check(ws.status_code == 201 and psql(f"select count(*) from sales where id = '{ws.json().get('id')}'") == "1",
              f"and writes land in the tables on the upgraded database ({ws.status_code})")
        # … and the purchases, which the same release moved out: a database written before them holds them inside
        # compat_state — lines, Bills of Entry and the duty every import line cleared included, a draft deleted
        # before the upgrade in the undo buffer.
        print("\nR5.3: upgrading a pre-R5.3 database moves the purchases into their tables")
        def purchase_counts():
            return (psql("select count(*) from purchases"), psql("select count(*) from purchase_lines"))

        def purchase_registers():
            return {"purchases": arif.get(f"{BASE}/purchases", params={"size": 300, "category": "all"}).json(),
                    "services": arif.get(f"{BASE}/purchases", params={"size": 100, "category": "service"}).json(),
                    "vendors": arif.get(f"{BASE}/vendors", params={"size": 100}).json()}

        gonep = arif.post(f"{BASE}/purchases", json={**pur_body, "narration": f"R5.3 deleted {TAG}"}).json()
        arif.delete(f"{BASE}/purchases/{gonep['id']}")
        def purchase_shapes():
            return (psql("select count(*) from purchases where boe_no is not null"),
                    psql("select count(*) from purchases where category = 'service'"),
                    psql("select count(*) from purchase_lines where duty_av is not null"),
                    psql("select count(*) from purchase_lines where foregone_total is not null"))

        pcounts, pbefore, psplit, pboots, pshapes = (purchase_counts(), purchase_registers(), held(),
                                                     stock_boots(), purchase_shapes())
        psql(PRE_R53_PURCHASES)
        psql(PRE_R53_PURCHASE_TRASH)
        psql("delete from purchase_lines")
        psql("delete from purchases")
        check(purchase_counts() == ("0", "0")
              and psql("select count(*) from compat_state where data->'db' ? 'purchases'") == "1"
              and psql(PURCHASE_TRASH_LEFT) == "1",
              f"the database is back in the pre-R5.3 shape ({pcounts[0]} purchases, {pcounts[1]} lines "
              f"inside the snapshot)")
        restart()
        check(purchase_counts() == pcounts,
              f"the first boot moved every purchase into the tables ({pcounts[0]} documents, {pcounts[1]} lines)")
        check(psql("select count(*) from compat_state where data->'db' ? 'purchases'") == "0",
              "…and rewrote the snapshot without them")
        check(psql(PURCHASE_TRASH_LEFT) == "0",
              "…and took the deleted drafts out of the undo buffer, keeping its documents")
        check(purchase_registers() == pbefore, "…and serves the same three registers, row for row")
        check(psql(f"select count(*) from purchases where id = '{gonep['id']}' and deleted_at is not null") == "1"
              and psql(f"select count(*) from purchase_lines where purchase_id = '{gonep['id']}'") == "1",
              "a purchase deleted before the upgrade is still in the undo buffer, with its lines")
        unp = arif.post(f"{BASE}/purchases/{gonep['id']}/restore")
        check(unp.status_code == 200
              and psql(f"select count(*) from purchases where id = '{gonep['id']}' and deleted_at is null") == "1",
              f"…and its undo still works afterwards ({unp.status_code})")
        check(purchase_shapes() == pshapes,
              f"the Bills of Entry ({pshapes[0]}), the service purchases ({pshapes[1]}), the duty breakdowns "
              f"({pshapes[2]}) and the bonded entries ({pshapes[3]}) came back with their documents")
        check(held() == psplit, "…and the stock derived from them is unchanged — the branch split survived the round trip")
        pboots_after, pnow = stock_boots(), purchase_counts()
        restart()
        check(purchase_counts() == pnow and (pboots is None or pboots_after == pboots + 1)
              and (pboots is None or stock_boots() == pboots_after),
              "a second boot adopts nothing again — the tables are the only copy from then on")
        wp = arif.post(f"{BASE}/purchases", json=pur_body)
        check(wp.status_code == 201 and psql(f"select count(*) from purchases where id = '{wp.json().get('id')}'") == "1",
              f"and writes land in the tables on the upgraded database ({wp.status_code})")
        # … and the notes, which the same release moved out: a database written before them holds both families
        # inside compat_state. A draft deleted before the upgrade has no place there — the mock removed it for good
        # — so what has to survive the round trip is the id counter, not the row.
        print("\nR5.3: upgrading a pre-R5.3 database moves the credit and debit notes into their tables")
        def note_counts():
            return (psql("select count(*) from notes where kind = 'credit' and deleted_at is null"),
                    psql("select count(*) from notes where kind = 'debit' and deleted_at is null"),
                    psql("select count(*) from note_lines l join notes n on n.id = l.note_id"
                         " where n.deleted_at is null"))

        def note_registers():
            return {"credit": arif.get(f"{BASE}/credit-notes", params={"size": 100}).json(),
                    "debit": arif.get(f"{BASE}/debit-notes", params={"size": 100}).json(),
                    "sales": arif.get(f"{BASE}/sales", params={"size": 300, "category": "all"}).json()}

        goncn = arif.post(f"{BASE}/credit-notes", json={**cn_body, "note": f"R5.3 deleted {TAG}"}).json()
        arif.delete(f"{BASE}/credit-notes/{goncn['id']}")
        ncounts, nbefore, nsplit, nboots = note_counts(), note_registers(), sold_held(), stock_boots()
        psql(PRE_R53_NOTES)
        psql("delete from note_lines")
        psql("delete from notes")
        check(note_counts() == ("0", "0", "0")
              and psql("select count(*) from compat_state where data->'db' ? 'creditNotes'") == "1"
              and psql("select count(*) from compat_state where data->'db' ? 'debitNotes'") == "1",
              f"the database is back in the pre-R5.3 shape ({ncounts[0]} credit notes, {ncounts[1]} debit notes, "
              f"{ncounts[2]} lines inside the snapshot)")
        restart()
        check(note_counts() == ncounts,
              f"the first boot moved every note into the tables ({ncounts[0]} + {ncounts[1]} notes, {ncounts[2]} lines)")
        check(psql("select count(*) from compat_state where data->'db' ? 'creditNotes'") == "0"
              and psql("select count(*) from compat_state where data->'db' ? 'debitNotes'") == "0",
              "…and rewrote the snapshot without them")
        check(note_registers() == nbefore, "…and serves the same registers, row for row")
        check(psql(f"select count(*) from notes where id = '{goncn['id']}'") == "0",
              "a note deleted before the upgrade stays deleted — the mock kept no row for it either")
        after = arif.post(f"{BASE}/credit-notes", json=cn_body).json()
        check(int(after["id"][2:]) > int(goncn["id"][2:]) and after["no"] != goncn["no"],
              f"…but its id and its number stay retired ({goncn['no']} → {after['no']})")
        check(sold_held() == nsplit, "…and the stock derived from them is unchanged — the branch split survived the round trip")
        nboots_after, nnow = stock_boots(), note_counts()
        restart()
        check(note_counts() == nnow and (nboots is None or nboots_after == nboots + 1)
              and (nboots is None or stock_boots() == nboots_after),
              "a second boot adopts nothing again — the tables are the only copy from then on")
        wn = arif.post(f"{BASE}/debit-notes", json=dn_body)
        check(wn.status_code == 201 and psql(f"select count(*) from notes where id = '{wn.json().get('id')}'") == "1",
              f"and writes land in the tables on the upgraded database ({wn.status_code})")
    else:
        skipped("restart checks (API_RESTART_CMD not set)")

    print(f"\n{ok} passed, {fail} failed, {skip} skipped")
    return fail == 0


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
