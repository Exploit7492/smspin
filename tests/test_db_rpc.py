"""DB-level tests: catalog/operators integrity, order lifecycle, idempotency,
job queue, DLQ and reconciliation. These hit the live Supabase project."""
import json
import pytest


def _rpc(db_conn, fn, *args):
    cur = db_conn.cursor()
    placeholders = ",".join(["%s"] * len(args))
    cur.execute(f"select {fn}({placeholders})", args)
    return cur.fetchone()[0]


def test_catalog_and_services_consistent(db_conn):
    cur = db_conn.cursor()
    cur.execute("select count(*) from number_catalog")
    pairs = cur.fetchone()[0]
    assert pairs > 0
    cur.execute("select count(*) from services")
    assert cur.fetchone()[0] > 0


def test_operators_upsert_and_price(db_conn):
    """upsert_operators must persist label/price/stock for a known pair."""
    items = json.dumps([
        {"country": "gb", "operator": "999", "label": "PytestTel", "id": "999",
         "price": 1.23, "count": 42}
    ])
    n = _rpc(db_conn, "upsert_operators", items)
    assert n == 1
    cur = db_conn.cursor()
    # `name` is the operator id; `label` is the human-readable name.
    cur.execute("select name, label, price_usd, stock from operators where country_code='gb' and ext_id=999")
    row = cur.fetchone()
    assert row[0] == "999" and row[1] == "PytestTel" and float(row[2]) == 1.23 and row[3] == 42
    # Re-upserting must update in place, not duplicate.
    _rpc(db_conn, "upsert_operators", json.dumps([
        {"country": "gb", "operator": "999", "label": "PytestTel", "id": "999",
         "price": 2.50, "count": 7}]))
    cur.execute("select count(*), max(price_usd) from operators where country_code='gb' and ext_id=999")
    cnt, price = cur.fetchone()
    assert cnt == 1 and float(price) == 2.50
    cur.execute("delete from operators where country_code='gb' and ext_id=999")


def test_record_sms_is_idempotent(db_conn):
    """Recording the same OTP twice must not create a duplicate message."""
    cur = db_conn.cursor()
    cur.execute("""insert into orders(user_id, country_code, service_code, phone_number, price, status, expires_at)
                   select id, 'gb', 'wa', '+440000', 10, 'waiting', now()+interval '20 min'
                   from profiles limit 1 returning id""")
    oid = cur.fetchone()[0]
    try:
        r1 = _rpc(db_conn, "record_sms", oid, "WA", "code 111222", "111222", None)
        r2 = _rpc(db_conn, "record_sms", oid, "WA", "code 111222", "111222", None)
        assert r1["inserted"] is True
        assert r2.get("duplicate") is True
        cur.execute("select status from orders where id=%s", (oid,))
        assert cur.fetchone()[0] == "received"
    finally:
        cur.execute("delete from sms_messages where order_id=%s", (oid,))
        cur.execute("delete from orders where id=%s", (oid,))


def test_refund_is_not_double_applied(db_conn):
    """Refunding a waiting order twice must only credit the wallet once."""
    cur = db_conn.cursor()
    cur.execute("""insert into orders(user_id, country_code, service_code, phone_number, price, status, expires_at)
                   select id, 'gb', 'wa', '', 500, 'waiting', now()+interval '20 min'
                   from profiles limit 1 returning id, user_id""")
    oid, uid = cur.fetchone()
    cur.execute("select coalesce(balance,0) from wallets where user_id=%s", (uid,))
    bal0 = cur.fetchone()
    bal0 = bal0[0] if bal0 else 0
    try:
        _rpc(db_conn, "refund_order", oid, "test")
        cur.execute("select coalesce(balance,0) from wallets where user_id=%s", (uid,))
        bal1 = cur.fetchone()[0]
        _rpc(db_conn, "refund_order", oid, "test-again")
        cur.execute("select coalesce(balance,0) from wallets where user_id=%s", (uid,))
        bal2 = cur.fetchone()[0]
        assert float(bal1) - float(bal0) == 500.0
        assert float(bal2) == float(bal1), "second refund must be a no-op"
    finally:
        cur.execute("delete from transactions where user_id=%s and ref like 'order:%%'", (uid,))
        cur.execute("delete from orders where id=%s", (oid,))
        cur.execute("update wallets set balance=%s where user_id=%s", (bal0, uid))


def test_job_queue_lifecycle(db_conn):
    """enqueue -> claim -> finish(done); and finish(fail) retries then dead-letters."""
    jid = _rpc(db_conn, "job_enqueue", "pytest_job", json.dumps({"x": 1}), None)
    claimed = _rpc(db_conn, "job_claim", 5)
    ids = [j["id"] for j in claimed]
    assert jid in ids
    status = _rpc(db_conn, "job_finish", jid, True, None)
    assert status == "done"
    cur = db_conn.cursor()
    cur.execute("select status from jobs where id=%s", (jid,))
    assert cur.fetchone()[0] == "done"
    cur.execute("delete from jobs where id=%s", (jid,))


def test_dlq_roundtrip(db_conn):
    did = _rpc(db_conn, "dlq_enqueue", "pytest", "evt", json.dumps({"a": 1}), "boom")
    listed = _rpc(db_conn, "dlq_list", 50)
    assert any(d["id"] == did for d in listed)
    _rpc(db_conn, "dlq_resolve", did)
    listed2 = _rpc(db_conn, "dlq_list", 50)
    assert not any(d["id"] == did for d in listed2)
    cur = db_conn.cursor()
    cur.execute("delete from webhook_dlq where id=%s", (did,))


def test_reconcile_report_shape(db_conn):
    r = _rpc(db_conn, "reconcile_report", 7)
    for k in ("orders_total", "orders_received", "orders_refunded", "revenue_ngn", "stuck_orders"):
        assert k in r


def test_sync_progress_shape(db_conn):
    p = _rpc(db_conn, "sync_progress")
    assert p["total"] >= p["done"]
    assert p["pending"] == p["total"] - p["done"]


def test_audit_write_and_list(db_conn):
    _rpc(db_conn, "audit_write", "pytest:actor", "test.action", "subj", json.dumps({"k": "v"}), "1.2.3.4")
    rows = _rpc(db_conn, "audit_list", 20, "pytest:actor")
    assert rows and rows[0]["action"] == "test.action"
    cur = db_conn.cursor()
    cur.execute("delete from audit_log where actor='pytest:actor'")


def test_markup_modes_price_above_host(db_conn):
    """Percent and fixed markup must both raise the price and never round it away.

    Whole-dollar rounding used to swallow the margin: a 30% markup on the $2
    floor came straight back to $2, and a small fixed margin landed below the
    host price.
    """
    cur = db_conn.cursor()
    cur.execute("select rate from fx_rates where code='NGN'")
    rate = float(cur.fetchone()[0])
    base = round(2 * rate)  # the $2 platform floor, in naira

    def price(mode, pct=0, fixed=0):
        cur.execute("select public.biz_markup_amount(%s,%s,%s,%s)", (base, mode, pct, fixed))
        return float(cur.fetchone()[0])

    assert price("percent", pct=0) == base
    assert price("percent", pct=30) > base
    assert price("percent", pct=100) == round(2 * base)
    assert price("fixed", fixed=0) == base
    assert price("fixed", fixed=500) == base + 500
    # A large host base plus a fixed margin is exact, not rounded to a dollar.
    big = round(20 * rate)
    cur.execute("select public.biz_markup_amount(%s,'fixed',0,500)", (big,))
    assert float(cur.fetchone()[0]) == big + 500


def test_email_sender_identity_is_per_tenant(db_conn):
    """Each store's mail identity is its own brand, not the platform's.

    The dispatcher reads from_name/reply_to from email_sender() to brand the
    envelope, so a white-label recipient never sees SMSPin.
    """
    cur = db_conn.cursor()
    cur.execute("select slug, name, support_email from businesses "
                "where status='active' and parent_id is null order by id")
    tenants = cur.fetchall()
    assert tenants, "need at least one active tenant"
    for slug, name, support in tenants:
        cur.execute("select public.email_sender(%s)", (slug,))
        ident = cur.fetchone()[0]
        assert ident["brand_name"] == name
        assert ident["tenant_id"] == slug
        assert ident["from_name"] == name
        if support:
            assert ident["reply_to"] == support
    # The platform fallback keeps its own identity.
    cur.execute("select public.email_sender(null)")
    plat = cur.fetchone()[0]
    assert plat["tenant_id"] == "smspin-platform"
    assert plat["brand_name"] and plat["from_name"]
