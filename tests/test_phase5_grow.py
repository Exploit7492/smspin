"""Phase 5 "Make it grow" (O2-O7, O10-O20): onboarding, tours, notifications,
KB, wallet balances, developer platform (usage/sandbox/key settings/webhooks),
affiliate payouts, ledger, feature flags, admin growth surfaces and app builds.

Hits the real backend + live Supabase project; skips when env is not configured.
"""
import json
import time

import pytest


def _rpc(conn, fn, params=None):
    params = params or {}
    args = ", ".join(f"{k} => %s" for k in params)
    vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in params.values()]
    cur = conn.cursor()
    cur.execute(f"select public.{fn}({args})", vals)
    return cur.fetchone()[0]


def _auth(user):
    return {"Authorization": "Bearer " + user["token"]}


def supabase_auth_rpc(supabase, user, fn, params=None):
    import urllib.request
    import urllib.error
    params = params or {}
    req = urllib.request.Request(
        supabase["url"] + "/rest/v1/rpc/" + fn,
        data=json.dumps(params).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("apikey", supabase["anon"])
    req.add_header("Authorization", "Bearer " + user["token"])
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        body = resp.read()
        return resp.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode("utf-8", "replace")


@pytest.fixture
def admin_user(supabase, test_user, db_conn):
    cur = db_conn.cursor()
    cur.execute("insert into admins(email, role) values (%s, 'owner') "
                "on conflict (email) do nothing", (test_user["email"],))
    yield test_user
    cur.execute("delete from admins where email=%s", (test_user["email"],))


# ---------------------------------------------------------------- O2 onboarding
def test_onboarding_checklist_and_dismiss(http, server_up, supabase, test_user):
    st, d = supabase_auth_rpc(supabase, test_user, "my_onboarding")
    assert st == 200, d
    assert d["total"] >= 4 and isinstance(d["items"], list)
    keys = {i["key"] for i in d["items"]}
    assert {"fund_wallet", "first_number", "api_key"} <= keys

    st, r = supabase_auth_rpc(supabase, test_user, "onboarding_mark",
                              {"p_key": "__dismissed", "p_done": True})
    assert st == 200 and r["done"] is True
    st, d2 = supabase_auth_rpc(supabase, test_user, "my_onboarding")
    assert d2["dismissed"] is True


# ---------------------------------------------------------------- O1/O18 tours
def test_tour_recording_and_funnel(http, server_up, supabase, test_user, db_conn, admin_user):
    st, r = supabase_auth_rpc(supabase, test_user, "tour_record",
                              {"p_key": "dashboard", "p_step": 0, "p_event": "start"})
    assert st == 200, r
    st, _ = supabase_auth_rpc(supabase, test_user, "tour_record",
                              {"p_key": "dashboard", "p_step": 4, "p_event": "complete",
                               "p_complete": True})
    assert st == 200
    funnel = _rpc(db_conn, "tour_funnel", {"p_days": 30})
    row = [f for f in funnel if f["tour_key"] == "dashboard"]
    assert row and row[0]["starts"] >= 1 and row[0]["completes"] >= 1

    st, f = http(server_up + "/api/admin/tours?days=30", headers=_auth(admin_user))
    assert st == 200 and "funnel" in f


# ---------------------------------------------------------------- E6 notifications
def test_notify_and_read(http, server_up, supabase, test_user, db_conn):
    _rpc(db_conn, "notify_user", {"p_user": test_user["uid"], "p_kind": "received",
                                  "p_title": "Code received", "p_body": "WhatsApp 482915"})
    st, d = supabase_auth_rpc(supabase, test_user, "my_notifications", {"p_limit": 10})
    assert st == 200 and d["items"], d
    assert any(n["title"] == "Code received" for n in d["items"])
    st, r = supabase_auth_rpc(supabase, test_user, "notification_read", {"p_all": True})
    assert st == 200
    st, d2 = supabase_auth_rpc(supabase, test_user, "my_notifications", {"p_limit": 10})
    assert all(n["read"] for n in d2["items"])


# ---------------------------------------------------------------- K3/O17 KB
def test_kb_search(http, server_up):
    st, arts = http(server_up + "/api/articles")
    assert st == 200 and isinstance(arts, list) and arts
    st, hits = http(server_up + "/api/articles?q=refund")
    assert st == 200 and isinstance(hits, list)


# ---------------------------------------------------------------- B3 balances
def test_wallet_balances_and_convert(http, server_up, supabase, test_user, db_conn):
    cur = db_conn.cursor()
    cur.execute("insert into wallet_balances(user_id, currency, balance) values (%s,'NGN',5000) "
                "on conflict (user_id, currency) do update set balance=5000", (test_user["uid"],))
    cur.execute("insert into wallet_balances(user_id, currency, balance) values (%s,'USD',10) "
                "on conflict (user_id, currency) do update set balance=10", (test_user["uid"],))
    st, b = supabase_auth_rpc(supabase, test_user, "my_wallet_balances")
    assert st == 200 and any(x["currency"] == "USD" for x in b["balances"])
    st, r = supabase_auth_rpc(supabase, test_user, "convert_balance",
                              {"p_from": "NGN", "p_to": "USD", "p_amount": 1000})
    assert st == 200, r
    assert r["from"] == "NGN" and r["to"] == "USD" and float(r["out"]) > 0


# ---------------------------------------------------------------- H1-H7 developer
def test_api_key_settings_and_sandbox(http, server_up, supabase, test_user, db_conn):
    st, k = supabase_auth_rpc(supabase, test_user, "create_api_key", {"p_name": "phase5"})
    assert st == 200, k
    st, r = supabase_auth_rpc(supabase, test_user, "api_key_settings", {
        "p_id": k["id"], "p_scopes": ["read", "write"], "p_rate_limit": 120,
        "p_quota": 5000, "p_ip_allowlist": ["203.0.113.7"]})
    assert st == 200, r
    cur = db_conn.cursor()
    cur.execute("select rate_limit, quota_month, ip_allowlist from api_keys where id=%s", (k["id"],))
    rl, quota, ips = cur.fetchone()
    assert rl == 120 and quota == 5000 and "203.0.113.7" in list(ips)

    st, sb = supabase_auth_rpc(supabase, test_user, "create_sandbox_key", {"p_name": "sbx"})
    assert st == 200 and sb["key"].startswith("sk_test_")
    st, u = supabase_auth_rpc(supabase, test_user, "api_usage_summary", {"p_days": 30})
    assert st == 200 and "total" in u


def test_api_key_secret_authenticates_but_prefix_does_not(http, server_up, supabase, test_user, db_conn):
    """The gateway authenticates the real secret only.

    The dashboard playground used to send the MASKED key prefix
    (sk_live_9f2c...4a71), which never matches a stored hash — that is the
    "invalid API key" the user hit. Guard both directions.
    """
    st, k = supabase_auth_rpc(supabase, test_user, "create_api_key", {"p_name": "authcheck"})
    assert st == 200, k
    secret = k["secret"]
    assert secret.startswith("sk_live_")

    st, bal = http(server_up + "/api/v1/balance", "GET", headers={"x-api-key": secret}, timeout=20)
    assert st == 200 and "balance" in bal, bal

    prefix = k["key_prefix"]
    st, err = http(server_up + "/api/v1/balance", "GET", headers={"x-api-key": prefix}, timeout=20)
    assert st == 401, (prefix, st, err)


def test_customer_webhook_subscription_lifecycle(http, server_up, supabase, test_user, db_conn):
    st, c = supabase_auth_rpc(supabase, test_user, "create_webhook_sub",
                              {"p_url": "https://hook.example.com/x",
                               "p_events": ["order.received"]})
    assert st == 200 and c.get("secret"), c
    st, subs = supabase_auth_rpc(supabase, test_user, "my_webhook_subs")
    assert any(s["id"] == c["id"] for s in subs)
    n = _rpc(db_conn, "customer_webhook_enqueue", {"p_user": test_user["uid"],
             "p_event": "order.received", "p_payload": {"order_id": 1}})
    assert n == 1
    st, r = supabase_auth_rpc(supabase, test_user, "delete_webhook_sub", {"p_id": c["id"]})
    assert st == 200


# ---------------------------------------------------------------- I2 affiliate
def test_affiliate_payout(http, server_up, supabase, test_user, db_conn):
    cur = db_conn.cursor()
    cur.execute("insert into wallets(user_id, balance, currency) values (%s, 100, 'NGN') "
                "on conflict (user_id) do update set balance=100", (test_user["uid"],))
    st, a = supabase_auth_rpc(supabase, test_user, "my_affiliate_payouts")
    assert st == 200 and "available" in a


# ---------------------------------------------------------------- L3 ledger
def test_ledger_records_transactions(http, server_up, supabase, test_user, db_conn):
    cur = db_conn.cursor()
    ref = "pytest-ledger-" + str(int(time.time() * 1000))
    cur.execute("insert into transactions(user_id, type, amount, method, ref) "
                "values (%s, 'fund', 2500, 'card', %s)", (test_user["uid"], ref))
    cur.execute("select count(*) from ledger where ref=%s", (ref,))
    assert cur.fetchone()[0] == 1


# ---------------------------------------------------------------- F9 flags/settings
def test_admin_flags_and_settings(http, server_up, admin_user):
    st, flags = http(server_up + "/api/admin/flags", headers=_auth(admin_user))
    assert st == 200 and isinstance(flags, list)
    st, _ = http(server_up + "/api/admin/flags/set",
                 method="POST", body={"key": "pytest_flag", "enabled": True}, headers=_auth(admin_user))
    assert st == 200
    st, s = http(server_up + "/api/admin/settings", headers=_auth(admin_user))
    assert st == 200 and isinstance(s, dict)
    st, _ = http(server_up + "/api/admin/settings/set", method="POST",
                 body={"key": "pytest_setting", "value": {"x": 1}}, headers=_auth(admin_user))
    assert st == 200


# ---------------------------------------------------------------- F6/F8 tenants/fraud
def test_admin_tenants_and_fraud(http, server_up, admin_user):
    st, t = http(server_up + "/api/admin/tenants?limit=10", headers=_auth(admin_user))
    assert st == 200 and isinstance(t, list)
    st, f = http(server_up + "/api/admin/fraud?limit=10", headers=_auth(admin_user))
    assert st == 200 and isinstance(f, list)
    st, g = http(server_up + "/api/admin/tax?days=30", headers=_auth(admin_user))
    assert st == 200 and "fees_ngn" in g
    st, led = http(server_up + "/api/admin/ledger", headers=_auth(admin_user))
    assert st == 200 and isinstance(led, list)


# ---------------------------------------------------------------- E8 export
def test_wallet_csv_export(http, server_up, supabase, test_user):
    st, body = http(server_up + "/api/wallet/export", headers=_auth(test_user))
    assert st == 200
    assert "date,type,amount,method,reference" in (body if isinstance(body, str) else body.decode())


# ---------------------------------------------------------------- M5 app builds
def test_app_build_request_and_download(http, server_up, supabase, test_user, db_conn):
    st, r = http(server_up + "/api/app/builds/request", method="POST",
                 body={"version": "1.0.0"}, headers=_auth(test_user))
    assert st in (200, 400), r
    if st == 200:
        from backend.server import dispatch_app_builds  # noqa
