"""Shared pytest fixtures for the SMSPin backend test suite.

These tests exercise real code paths against the live Supabase project and the
running backend where possible. Tests that need external services (the upstream
provider, KoraPay) are marked so they can be skipped in offline CI.
"""
import os
import sys
import json
import ssl
import time
import urllib.request
import urllib.error

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

BASE = os.environ.get("SMSPIN_TEST_BASE", "http://127.0.0.1:12000")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def _req(url, method="GET", body=None, headers=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)

    def _decode(raw):
        raw = raw or b""
        try:
            return json.loads(raw)
        except Exception:
            return raw.decode("utf-8", "replace")

    try:
        resp = urllib.request.urlopen(r, timeout=timeout, context=CTX)
        return resp.status, _decode(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, _decode(e.read())


@pytest.fixture(scope="session")
def base():
    return BASE


@pytest.fixture(scope="session")
def server_up():
    """Skip the test if the backend is not reachable."""
    try:
        st, _ = _req(BASE + "/api/pricing", timeout=5)
        if st != 200:
            pytest.skip("backend not healthy")
    except Exception:
        pytest.skip("backend not running")
    return BASE


@pytest.fixture(scope="session")
def http():
    """HTTP helper that gives every call a unique client IP by default, so
    rate-limit buckets don't bleed between tests. Pass X-Forwarded-For to pin one."""
    import random

    def _call(url, method="GET", body=None, headers=None, timeout=30):
        h = dict(headers or {})
        if "X-Forwarded-For" not in h:
            h["X-Forwarded-For"] = "10.%d.%d.%d" % (
                random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
        return _req(url, method, body, h, timeout)

    return _call


@pytest.fixture(scope="session")
def db_conn():
    """Direct DB connection using the service Postgres DSN (skips if unset)."""
    dsn = os.environ.get("Smspin_supabase_Postgresql")
    if not dsn:
        pytest.skip("Smspin_supabase_Postgresql not set")
    import psycopg2
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture(scope="session")
def supabase():
    """Supabase project url + anon + service keys (skips if unset)."""
    url = os.environ.get("Smspin_Supabase_url", "").rstrip("/")
    anon = os.environ.get("Smspin_supabase_annonkey", "")
    srk = os.environ.get("Smspin_supabase_secretskey", "")
    if not (url and anon):
        pytest.skip("Supabase env not set")
    return {"url": url, "anon": anon, "srk": srk}


@pytest.fixture
def test_user(supabase):
    """Create a throwaway confirmed user + funded wallet; tear it down after."""
    import psycopg2
    email = f"pytest-{int(time.time()*1000)}@qa.local"
    pw = "Pytest!2026"
    st, created = _req(supabase["url"] + "/auth/v1/admin/users",
                       "POST", {"email": email, "password": pw, "email_confirm": True},
                       {"apikey": supabase["srk"], "Authorization": "Bearer " + supabase["srk"]})
    assert st == 200, created
    uid = created["id"]
    st, tok = _req(supabase["url"] + "/auth/v1/token?grant_type=password",
                   "POST", {"email": email, "password": pw}, {"apikey": supabase["anon"]})
    assert st == 200, tok
    token = tok["access_token"]
    conn = psycopg2.connect(os.environ["Smspin_supabase_Postgresql"])
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("insert into wallets(user_id, balance, currency) values (%s, %s, 'NGN') "
                "on conflict (user_id) do update set balance = excluded.balance", (uid, 50000))
    yield {"uid": uid, "email": email, "token": token, "password": pw}
    cur.execute("delete from orders where user_id=%s", (uid,))
    cur.execute("delete from transactions where user_id=%s", (uid,))
    cur.execute("delete from api_keys where user_id=%s", (uid,))
    cur.execute("delete from wallets where user_id=%s", (uid,))
    cur.execute("delete from audit_log where actor=%s", (f"user:{uid}",))
    cur.execute("delete from profiles where id=%s", (uid,))
    _req(supabase["url"] + "/auth/v1/admin/users/" + uid, "DELETE",
         headers={"apikey": supabase["srk"], "Authorization": "Bearer " + supabase["srk"]})
    conn.close()


@pytest.fixture
def test_tenant(server_up, db_conn, http):
    """Create a throwaway tenant account on a real store and log it in.

    Skips when the store or the RPCs are unavailable, so the suite still runs
    against a project without the white-label layer.
    """
    import random
    slug = "zenith-verify"
    cur = db_conn.cursor()
    cur.execute("select 1 from businesses where slug=%s", (slug,))
    if not cur.fetchone():
        pytest.skip("store %s not seeded" % slug)
    email = "qa-tenant-%d@smspin.io" % random.randint(100000, 999999)
    pw = "QaTenant!2026"
    st, reg = http(server_up + "/api/rpc", "POST",
                   {"fn": "tenant_register",
                    "args": {"p_email": email, "p_password": pw,
                             "p_full_name": "QA Tenant", "p_slug": slug}})
    if st != 200 or not (reg or {}).get("account_id"):
        pytest.skip("tenant_register unavailable: %s" % reg)
    st, tok = http(server_up + "/api/rpc", "POST",
                   {"fn": "tenant_login",
                    "args": {"p_email": email, "p_password": pw, "p_slug": slug}})
    assert st == 200 and tok.get("token"), tok
    yield {"email": email, "token": tok["token"], "slug": slug,
           "account_id": reg["account_id"]}
    cur.execute("delete from payments where tenant_account_id=%s", (reg["account_id"],))
    cur.execute("delete from tenant_wallets where account_id=%s", (reg["account_id"],))
    cur.execute("delete from tenant_accounts where id=%s", (reg["account_id"],))


@pytest.fixture
def published_review(db_conn):
    """Publish one real review so the trust surfaces have genuine data to render.

    Removed on teardown; the suite must never leave fabricated reviews behind
    (the fabricated-review seed was deleted on 2026-11-13).
    """
    cur = db_conn.cursor()
    cur.execute(
        "insert into reviews(user_id, author, rating, title, body, service, country, "
        "status, published_at) values (null, %s, 5, %s, %s, 'WhatsApp', 'US', 'published', now()) "
        "returning id",
        ("QA Reviewer", "End-to-end verified",
         "Published by the test suite to prove the review pipeline renders real data."))
    rid = cur.fetchone()[0]
    yield rid
    cur.execute("delete from reviews where id=%s", (rid,))
