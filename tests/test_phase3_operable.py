"""Phase 3 "Make it operable": admin console (F1-F5), support threads (K1),
refund notices (K5), ops refunds (B7) and the public status page (J6).

These hit the real backend + live Supabase project; they skip automatically when
the required env is not configured.
"""
import json
import time

import pytest


def _rpc(conn, fn, params=None):
    """Call a service-role RPC with named parameters."""
    params = params or {}
    args = ", ".join(f"{k} => %s" for k in params)
    vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in params.values()]
    cur = conn.cursor()
    cur.execute(f"select public.{fn}({args})", vals)
    return cur.fetchone()[0]


@pytest.fixture
def admin_user(supabase, test_user, db_conn):
    """Promote the throwaway user to admin for the duration of the test."""
    cur = db_conn.cursor()
    cur.execute("insert into admins(email, role) values (%s, 'owner') "
                "on conflict (email) do nothing", (test_user["email"],))
    yield test_user
    cur.execute("delete from admins where email=%s", (test_user["email"],))


def _auth(user):
    return {"Authorization": "Bearer " + user["token"]}


# ---------------------------------------------------------------- F1 overview
def test_admin_endpoints_require_admin(http, server_up, test_user):
    for path in ("/api/admin/overview", "/api/admin/users", "/api/admin/orders",
                 "/api/admin/payments", "/api/admin/tickets", "/api/admin/catalog"):
        st, _ = http(server_up + path, headers=_auth(test_user))
        assert st == 403, path
    st, _ = http(server_up + "/api/admin/users/adjust", "POST",
                 {"user_id": test_user["uid"], "amount": 1, "reason": "x"}, _auth(test_user))
    assert st == 403


def test_admin_overview(http, server_up, admin_user):
    st, d = http(server_up + "/api/admin/overview", headers=_auth(admin_user))
    assert st == 200, d
    for k in ("users_total", "orders_total", "wallets_ngn", "markup_percent", "tickets_open"):
        assert k in d, k
    assert d["users_total"] >= 1


# ---------------------------------------------------------------- F2 users
def test_admin_users_list_and_detail(http, server_up, admin_user):
    st, rows = http(server_up + "/api/admin/users?limit=100", headers=_auth(admin_user))
    assert st == 200 and isinstance(rows, list)
    assert any(u["email"] == admin_user["email"] for u in rows)

    st, d = http(server_up + "/api/admin/users/" + admin_user["uid"], headers=_auth(admin_user))
    assert st == 200
    assert d["profile"]["email"] == admin_user["email"]
    assert "wallet" in d and "orders" in d


def test_admin_balance_adjust_and_suspend(http, server_up, admin_user, db_conn):
    st, before = http(server_up + "/api/admin/users/" + admin_user["uid"], headers=_auth(admin_user))
    bal = float(before["wallet"]["balance"])

    st, r = http(server_up + "/api/admin/users/adjust", "POST",
                 {"user_id": admin_user["uid"], "amount": 1234.5, "reason": "qa credit"},
                 _auth(admin_user))
    assert st == 200, r
    assert float(r["after"]) == bal + 1234.5

    # A debit that would go negative is rejected.
    st, r = http(server_up + "/api/admin/users/adjust", "POST",
                 {"user_id": admin_user["uid"], "amount": -999999, "reason": "too much"},
                 _auth(admin_user))
    assert st == 400

    st, r = http(server_up + "/api/admin/users/suspend", "POST",
                 {"user_id": admin_user["uid"], "suspended": True, "reason": "qa"},
                 _auth(admin_user))
    assert st == 200 and r["suspended"] is True
    assert _rpc(db_conn, "is_suspended", {"p_user": admin_user["uid"]}) is True

    st, r = http(server_up + "/api/admin/users/suspend", "POST",
                 {"user_id": admin_user["uid"], "suspended": False}, _auth(admin_user))
    assert st == 200 and r["suspended"] is False


# ---------------------------------------------------------------- F4 pricing
def test_admin_catalog_and_markup(http, server_up, admin_user, db_conn):
    st, rows = http(server_up + "/api/admin/catalog?limit=5", headers=_auth(admin_user))
    assert st == 200 and isinstance(rows, list)
    assert rows, "catalog should not be empty"

    row = rows[0]
    st, r = http(server_up + "/api/admin/catalog/update", "POST",
                 {"id": row["id"], "stock": (row["stock"] or 0) + 7}, _auth(admin_user))
    assert st == 200
    assert r["stock"] == (row["stock"] or 0) + 7

    orig = _rpc(db_conn, "admin_overview", {}).get("markup_percent")
    st, r = http(server_up + "/api/admin/pricing/markup", "POST", {"percent": 175}, _auth(admin_user))
    assert st == 200 and float(r["markup_percent"]) == 175
    # restore
    http(server_up + "/api/admin/pricing/markup", "POST", {"percent": orig}, _auth(admin_user))


# ---------------------------------------------------------------- F5 payments
def test_admin_payments_and_reconcile(http, server_up, admin_user):
    st, rows = http(server_up + "/api/admin/payments?limit=20", headers=_auth(admin_user))
    assert st == 200 and isinstance(rows, list)
    st, recon = http(server_up + "/api/admin/payments/reconcile?days=7", headers=_auth(admin_user))
    assert st == 200
    for k in ("pending", "success", "failed", "gross_ngn", "net_ngn"):
        assert k in recon


# ---------------------------------------------------------------- B7 refunds + K5
def test_admin_partial_refund_creates_notice(http, server_up, admin_user, db_conn):
    cur = db_conn.cursor()
    cur.execute(
        "insert into orders(user_id, country_code, service_code, phone_number, price, status) "
        "values (%s,'ng','wa','+2340000000000',1000,'received') returning id",
        (admin_user["uid"],))
    order_id = cur.fetchone()[0]

    st, r = http(server_up + "/api/admin/orders/refund", "POST",
                 {"order_id": order_id, "amount": 250, "reason": "qa_partial"}, _auth(admin_user))
    assert st == 200, r
    assert float(r["refunded"]) == 250 and r["partial"] is True

    cur.execute("select status from orders where id=%s", (order_id,))
    assert cur.fetchone()[0] == "received"      # partial refund keeps the order live

    cur.execute("select balance from wallets where user_id=%s", (admin_user["uid"],))
    bal = float(cur.fetchone()[0])
    assert bal >= 250

    cur.execute("select count(*) from refund_notices where order_id=%s", (order_id,))
    assert cur.fetchone()[0] >= 1

    cur.execute("delete from refund_notices where order_id=%s", (order_id,))
    cur.execute("delete from orders where id=%s", (order_id,))


def test_user_sees_refund_notice(http, server_up, admin_user, db_conn, supabase):
    cur = db_conn.cursor()
    cur.execute(
        "insert into orders(user_id, country_code, service_code, phone_number, price, status) "
        "values (%s,'ng','wa','+2340000000001',800,'waiting') returning id",
        (admin_user["uid"],))
    order_id = cur.fetchone()[0]

    st, r = http(server_up + "/api/admin/orders/refund", "POST",
                 {"order_id": order_id, "reason": "qa_full"}, _auth(admin_user))
    assert st == 200 and r["status"] == "refunded"

    # The customer reads their notices straight from Supabase (dashboard path).
    st, notices = http(supabase["url"] + "/rest/v1/rpc/my_refund_notices", "POST",
                       {"p_limit": 20},
                       {"apikey": supabase["anon"], "Authorization": "Bearer " + admin_user["token"]})
    assert st == 200 and isinstance(notices, list)
    assert any(n["order_id"] == order_id for n in notices)

    cur.execute("delete from refund_notices where order_id=%s", (order_id,))
    cur.execute("delete from orders where id=%s", (order_id,))


# ---------------------------------------------------------------- K1 support threads
def test_support_thread_roundtrip(http, server_up, admin_user, supabase, db_conn):
    auth = {"apikey": supabase["anon"], "Authorization": "Bearer " + admin_user["token"]}

    st, t = http(supabase["url"] + "/rest/v1/rpc/create_ticket", "POST",
                 {"p_subject": "QA thread", "p_message": "first message"}, auth)
    assert st == 200, t
    ticket_id = t["ticket_id"]

    st, r = http(supabase["url"] + "/rest/v1/rpc/ticket_reply", "POST",
                 {"p_ticket_id": ticket_id, "p_body": "user follow-up"}, auth)
    assert st == 200

    st, thread = http(supabase["url"] + "/rest/v1/rpc/ticket_thread", "POST",
                      {"p_ticket_id": ticket_id}, auth)
    assert st == 200
    assert [m["author_type"] for m in thread["messages"]] == ["user", "user"]

    # agent reply through the admin API
    st, r = http(server_up + "/api/admin/tickets/reply", "POST",
                 {"ticket_id": ticket_id, "body": "agent answer"}, _auth(admin_user))
    assert st == 200

    st, d = http(server_up + "/api/admin/tickets/" + str(ticket_id), headers=_auth(admin_user))
    assert st == 200
    assert [m["author_type"] for m in d["messages"]] == ["user", "user", "agent"]

    st, r = http(server_up + "/api/admin/tickets/update", "POST",
                 {"ticket_id": ticket_id, "status": "resolved"}, _auth(admin_user))
    assert st == 200 and r["status"] == "resolved"

    cur = db_conn.cursor()
    cur.execute("delete from ticket_messages where ticket_id=%s", (ticket_id,))
    cur.execute("delete from support_tickets where id=%s", (ticket_id,))


# ---------------------------------------------------------------- J6 status page
def test_public_status_page(http, server_up):
    st, d = http(server_up + "/api/status")
    assert st == 200
    assert d["overall"] in ("ok", "degraded", "down")
    assert isinstance(d["components"], list) and d["components"]
    assert isinstance(d["incidents"], list)


def test_synthetic_check_records_components(db_conn):
    r = _rpc(db_conn, "synthetic_check", {})
    assert r["checks"] >= 1
    st = _rpc(db_conn, "status_report", {})
    names = {c["name"] for c in st["components"]}
    assert {"database", "sms_provider", "webhooks", "payments"} <= names
