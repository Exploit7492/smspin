"""Phase 4 "Make it branded & guided": per-tenant branding (C2), payouts (C4),
tenant API keys + scopes + webhooks (C6) and COGS/margin reporting (A8).

These hit the real backend + live Supabase project; they skip automatically when
the required env is not configured.
"""
import hashlib
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


@pytest.fixture
def admin_user(supabase, test_user, db_conn):
    """Promote the throwaway user to admin for the duration of the test."""
    cur = db_conn.cursor()
    cur.execute("insert into admins(email, role) values (%s, 'owner') "
                "on conflict (email) do nothing", (test_user["email"],))
    yield test_user
    cur.execute("delete from admins where email=%s", (test_user["email"],))


@pytest.fixture
def business(db_conn, test_user):
    """An active business owned by the throwaway user; torn down after."""
    cur = db_conn.cursor()
    slug = f"pytest-store-{int(time.time() * 1000)}"
    cur.execute("insert into businesses(user_id, name, slug, theme, markup_percent, status) "
                "values (%s, %s, %s, 'crimson', 20, 'active') returning id",
                (test_user["uid"], "Pytest Store", slug))
    bid = cur.fetchone()[0]
    yield {"id": bid, "slug": slug, "uid": test_user["uid"], "token": test_user["token"]}
    cur.execute("delete from tenant_webhook_events where business_id=%s", (bid,))
    cur.execute("delete from tenant_api_keys where business_id=%s", (bid,))
    cur.execute("delete from tenant_payouts where business_id=%s", (bid,))
    cur.execute("delete from business_earnings where business_id=%s", (bid,))
    cur.execute("delete from businesses where id=%s", (bid,))


# ---------------------------------------------------------------- C2 branding
def test_branding_roundtrip(http, server_up, supabase, business):
    """Owner sets branding; the public helper reflects it."""
    st, r = supabase_auth_rpc(supabase, business, "business_set_branding", {
        "p_logo_url": "https://cdn.example.com/logo.png",
        "p_tagline": "Numbers, fast",
        "p_support_email": "help@pytest.store",
        "p_primary": "#123456",
        "p_secondary": "#654321",
    })
    assert st == 200, r
    assert r["primary_color"] == "#123456"

    st, b = supabase_auth_rpc(supabase, business, "business_branding", {"p_slug": business["slug"]})
    assert st == 200, b
    assert b["logo_url"] == "https://cdn.example.com/logo.png"
    assert b["tagline"] == "Numbers, fast"
    assert b["support_email"] == "help@pytest.store"
    assert b["primary_color"] == "#123456"
    assert b["secondary_color"] == "#654321"


def test_custom_domain_resolves(http, server_up, supabase, business, db_conn):
    domain = business["slug"] + ".example.com"
    st, r = supabase_auth_rpc(supabase, business, "business_set_branding",
                              {"p_domain": domain})
    assert st == 200, r
    assert r["domain"] == domain
    # Public resolver maps the host back to the slug (port stripped).
    assert _rpc(db_conn, "resolve_domain", {"p_host": domain + ":443"}) == business["slug"]
    # The domain routes the storefront on a custom Host header.
    st, _ = http(server_up + "/", headers={"Host": domain})
    assert st == 200


def test_domain_validation_and_uniqueness(http, server_up, supabase, business, db_conn):
    st, r = supabase_auth_rpc(supabase, business, "business_set_branding",
                              {"p_domain": "not a domain"})
    assert st != 200
    # A domain already taken by another business is rejected.
    cur = db_conn.cursor()
    cur.execute("select id, slug from businesses where id <> %s limit 1", (business["id"],))
    other = cur.fetchone()
    if other:
        cur.execute("update businesses set domain='taken.example.com' where id=%s", (other[0],))
        st, r = supabase_auth_rpc(supabase, business, "business_set_branding",
                                  {"p_domain": "taken.example.com"})
        assert st != 200
        cur.execute("update businesses set domain=null where id=%s", (other[0],))


# ---------------------------------------------------------------- C4 payouts
def test_payouts_flow(http, server_up, supabase, business, db_conn):
    cur = db_conn.cursor()
    cur.execute("insert into business_earnings(business_id, order_id, amount) "
                "values (%s, null, 500)", (business["id"],))
    st, p = supabase_auth_rpc(supabase, business, "my_payouts")
    assert st == 200, p
    assert float(p["earned_ngn"]) == 500
    assert float(p["available_ngn"]) == 500

    st, r = supabase_auth_rpc(supabase, business, "request_payout", {})
    assert st == 200, r
    assert float(r["amount"]) == 500
    assert float(r["available_ngn"]) == 0

    st, p2 = supabase_auth_rpc(supabase, business, "my_payouts")
    assert float(p2["available_ngn"]) == 0
    assert float(p2["paid_ngn"]) == 500
    assert len(p2["payouts"]) == 1
    # The wallet was credited.
    cur.execute("select balance from wallets where user_id=%s", (business["uid"],))
    assert float(cur.fetchone()[0]) >= 500


def test_payout_requires_earnings(http, server_up, supabase, business):
    st, r = supabase_auth_rpc(supabase, business, "request_payout", {"p_amount": 10})
    assert st != 200


# ---------------------------------------------------------------- C6 tenant keys
def test_tenant_api_key_lifecycle(http, server_up, supabase, business, db_conn):
    st, created = supabase_auth_rpc(supabase, business, "tenant_api_key_create",
                                    {"p_name": "prod", "p_scopes": ["read", "write"],
                                     "p_webhook_url": "https://hook.example.com/x"})
    assert st == 200, created
    secret = created["key"]
    assert secret.startswith("tk_live_")

    # The backend resolves the key by its hash (as it does on a real request).
    h = hashlib.sha256(secret.encode()).hexdigest()
    info = _rpc(db_conn, "tenant_resolve_api_key", {"p_hash": h})
    assert info and info["business_id"] == business["id"]
    assert set(info["scopes"]) == {"read", "write"}

    # The tenant API surface answers with a valid key.
    st, acct = http(server_up + "/api/tenant/account", headers={"x-tenant-key": secret})
    assert st == 200 and acct["slug"] == business["slug"]
    st, _ = http(server_up + "/api/tenant/orders", headers={"x-tenant-key": secret})
    assert st == 200
    st, _ = http(server_up + "/api/tenant/account", headers={"x-tenant-key": "tk_live_bogus"})
    assert st == 401

    # Listing + revoke.
    st, keys = supabase_auth_rpc(supabase, business, "tenant_api_keys_list")
    assert st == 200 and any(k["id"] == created["id"] for k in keys)
    st, rv = supabase_auth_rpc(supabase, business, "tenant_api_key_revoke", {"p_id": created["id"]})
    assert rv["revoked"] is True
    assert _rpc(db_conn, "tenant_resolve_api_key", {"p_hash": h}) is None


def test_tenant_webhook_enqueue_and_dispatch(http, server_up, supabase, business, db_conn):
    st, created = supabase_auth_rpc(supabase, business, "tenant_api_key_create",
                                    {"p_name": "hook", "p_scopes": ["read"],
                                     "p_webhook_url": "https://hook.example.com/x"})
    assert st == 200, created
    n = _rpc(db_conn, "tenant_webhook_enqueue",
             {"p_business": business["id"], "p_event": "order.created",
              "p_payload": {"order_id": 1}})
    assert n == 1
    pending = _rpc(db_conn, "tenant_webhook_pending", {"p_limit": 10})
    assert any(e["event"] == "order.created" for e in pending)
    eid = [e for e in pending if e["event"] == "order.created"][0]["id"]
    _rpc(db_conn, "tenant_webhook_mark", {"p_id": eid, "p_ok": True})
    cur = db_conn.cursor()
    cur.execute("select status from tenant_webhook_events where id=%s", (eid,))
    assert cur.fetchone()[0] == "delivered"


# ---------------------------------------------------------------- A8 margin
def test_margin_report_admin_only(http, server_up, test_user):
    st, _ = http(server_up + "/api/admin/margin", headers=_auth(test_user))
    assert st == 403


def test_margin_report(http, server_up, admin_user, db_conn):
    st, d = http(server_up + "/api/admin/margin?days=30", headers=_auth(admin_user))
    assert st == 200, d
    for k in ("revenue_ngn", "cogs_ngn", "gross_margin_ngn", "margin_percent",
              "by_service", "by_day"):
        assert k in d, k
    assert isinstance(d["by_service"], list)
    assert isinstance(d["by_day"], list)


# ---------------------------------------------------------------- helpers
def supabase_auth_rpc(supabase, user, fn, params=None):
    """Call a Supabase RPC as the user (anon key + user bearer token)."""
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
