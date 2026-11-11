"""Phase 2 "Make it safe" tests: fraud/blocklists (D8), email-verify toggle (D1),
acceptable-use acceptance (L4), observability (J4/J5), scheduler + DR (J2/J10)."""
import json

import pytest


def _rpc(conn, fn, params=None):
    """Call a DB function using named parameters: {name: value}."""
    params = params or {}
    args, vals = [], []
    for i, (k, v) in enumerate(params.items()):
        args.append(f"{k} => %s")
        vals.append(json.dumps(v) if isinstance(v, (dict, list)) else v)
    cur = conn.cursor()
    cur.execute(f"select public.{fn}({', '.join(args)})", vals)
    return cur.fetchone()[0]


# ---------------------------------------------------------------- D8 blocklists
def test_blocklist_add_list_remove(db_conn):
    rid = _rpc(db_conn, "blocklist_add",
               {"p_kind": "email", "p_value": "PytestBlock@Example.com", "p_reason": "pytest"})
    assert rid
    listed = _rpc(db_conn, "blocklist_list", {"p_kind": "email"})
    assert any(e["value"] == "pytestblock@example.com" for e in listed)
    _rpc(db_conn, "blocklist_remove", {"p_kind": "email", "p_value": "PytestBlock@Example.com"})
    listed2 = _rpc(db_conn, "blocklist_list", {"p_kind": "email"})
    assert not any(e["value"] == "pytestblock@example.com" for e in listed2)


def test_fraud_check_blocks_disposable_email(db_conn):
    cur = db_conn.cursor()
    cur.execute("select id from profiles limit 1")
    row = cur.fetchone()
    uid = row[0] if row else None
    res = _rpc(db_conn, "fraud_check",
               {"p_user": uid, "p_ip": "198.51.100.9", "p_email": "someone@mailinator.com"})
    assert res["allow"] is False
    assert "disposable_email" in res["reasons"]
    assert res["score"] >= 80


def test_fraud_check_blocks_listed_ip(db_conn):
    _rpc(db_conn, "blocklist_add", {"p_kind": "ip", "p_value": "198.51.100.77", "p_reason": "pytest"})
    try:
        res = _rpc(db_conn, "fraud_check",
                   {"p_user": None, "p_ip": "198.51.100.77", "p_email": "ok@example.com"})
        assert res["allow"] is False
        assert "ip_blocked" in res["reasons"]
    finally:
        _rpc(db_conn, "blocklist_remove", {"p_kind": "ip", "p_value": "198.51.100.77"})


def test_fraud_check_allows_clean_request(db_conn):
    res = _rpc(db_conn, "fraud_check",
               {"p_user": None, "p_ip": "203.0.113.200", "p_email": "clean.user@example.com"})
    assert res["allow"] is True
    assert res["score"] == 0


# ---------------------------------------------------------------- D1 email toggle
def test_email_verification_off_by_default(db_conn):
    assert _rpc(db_conn, "email_verification_required", {}) is False


def test_email_verified_reads_auth_users(db_conn):
    cur = db_conn.cursor()
    cur.execute("select id from auth.users where email_confirmed_at is not null limit 1")
    row = cur.fetchone()
    if not row:
        pytest.skip("no confirmed auth user")
    assert _rpc(db_conn, "email_verified", {"p_user": row[0]}) is True
    assert _rpc(db_conn, "email_verified", {"p_user": "00000000-0000-0000-0000-000000000000"}) is False


# ---------------------------------------------------------------- L4 acceptable use
def test_policy_accept_records_version(db_conn):
    cur = db_conn.cursor()
    cur.execute("select id from profiles limit 1")
    row = cur.fetchone()
    if not row:
        pytest.skip("no profile")
    uid = row[0]
    res = _rpc(db_conn, "policy_accept", {"p_user": uid, "p_tenant": None,
                                          "p_policy": "aup", "p_ip": "203.0.113.5"})
    assert res["accepted"] is True and res["policy"] == "aup"
    st = _rpc(db_conn, "policy_status", {"p_user": uid, "p_tenant": None})
    assert st["aup_accepted"] is True
    # Accepting again is idempotent (unique key on version).
    _rpc(db_conn, "policy_accept", {"p_user": uid, "p_tenant": None,
                                    "p_policy": "aup", "p_ip": "203.0.113.5"})
    cur.execute("select count(*) from policy_acceptances where user_id=%s and policy='aup'", (uid,))
    assert cur.fetchone()[0] == 1
    cur.execute("delete from policy_acceptances where user_id=%s and policy='aup'", (uid,))


def test_aup_enforcement_off_by_default(db_conn):
    st = _rpc(db_conn, "policy_status", {"p_user": None, "p_tenant": None})
    assert st["aup_required"] is False


# ---------------------------------------------------------------- J4 observability
def test_ops_metrics_shape(db_conn):
    m = _rpc(db_conn, "ops_metrics", {"p_window_min": 60})
    for k in ("orders_total", "payments_failed", "revenue_ngn", "dlq_open",
              "jobs_pending", "users_total", "risk_denied"):
        assert k in m, k


def test_metrics_record_and_series(db_conn):
    mid = _rpc(db_conn, "metrics_record", {"p_window_min": 5})
    assert mid
    series = _rpc(db_conn, "metrics_series", {"p_limit": 5})
    assert isinstance(series, list) and len(series) >= 1
    assert "metrics" in series[0]


def test_backup_verify_checksums(db_conn):
    detail = _rpc(db_conn, "backup_verify", {})
    for k in ("profiles", "orders", "payments", "wallets_sum"):
        assert k in detail


# ---------------------------------------------------------------- J5 alerts
def test_alert_evaluate_runs(db_conn):
    fired = _rpc(db_conn, "alert_evaluate", {})
    assert isinstance(fired, list)
    assert isinstance(_rpc(db_conn, "alert_rules_list", {}), list)


def test_alert_fires_when_rule_trips(db_conn):
    cur = db_conn.cursor()
    # A rule that is guaranteed to trip: dead jobs >= 0.
    cur.execute("insert into alert_rules(key, metric, op, threshold, severity, cooldown_s) "
                "values ('pytest_always','jobs_dead','>=',0,'warning',0) "
                "on conflict (key) do update set enabled=true, cooldown_s=0")
    try:
        fired = _rpc(db_conn, "alert_evaluate", {})
        assert any(f["rule"] == "pytest_always" for f in fired)
        events = _rpc(db_conn, "alert_events_list", {"p_limit": 10})
        ev = [e for e in events if e["rule_key"] == "pytest_always"]
        assert ev and ev[0]["delivered"] is False
        _rpc(db_conn, "alert_mark_delivered", {"p_id": ev[0]["id"]})
        events2 = _rpc(db_conn, "alert_events_list", {"p_limit": 10})
        assert all(e["delivered"] for e in events2 if e["rule_key"] == "pytest_always")
    finally:
        cur.execute("delete from alert_events where rule_key='pytest_always'")
        cur.execute("delete from alert_rules where key='pytest_always'")


# ---------------------------------------------------------------- J2/J10 scheduler
def test_scheduler_mark_and_status(db_conn):
    _rpc(db_conn, "scheduler_mark", {"p_key": "pytest_task", "p_ok": True,
                                     "p_detail": json.dumps({"n": 1})})
    tasks = {t["key"]: t for t in _rpc(db_conn, "scheduler_status", {})}
    assert tasks["pytest_task"]["last_ok"] is True
    cur = db_conn.cursor()
    cur.execute("delete from scheduler_state where key='pytest_task'")


# ---------------------------------------------------------------- HTTP surface
def test_health_endpoint(server_up, http):
    st, d = http(server_up + "/api/health", timeout=10)
    assert st == 200
    assert d["ok"] is True and d["checks"]["db"] is True


def test_metrics_endpoint(server_up, http):
    st, d = http(server_up + "/api/metrics", timeout=10)
    assert st == 200
    assert "process" in d and "ops" in d
    assert "requests_total" in d["process"]


def test_scheduler_endpoint(server_up, http):
    st, d = http(server_up + "/api/scheduler", timeout=10)
    assert st == 200 and "tasks" in d


def test_alerts_require_admin(server_up, http):
    st, d = http(server_up + "/api/alerts", timeout=10)
    assert st == 403


def test_policies_endpoint(server_up, http):
    st, d = http(server_up + "/api/policies", timeout=10)
    assert st == 200
    assert "aup_version" in d and "aup_required" in d


def test_aup_text_endpoint(server_up, http):
    st, d = http(server_up + "/api/policies?policy=aup", timeout=10)
    assert st == 200
    assert d["policy"] == "aup" and len(d["rules"]) >= 3


def test_blocklist_admin_requires_admin(server_up, http):
    st, _ = http(server_up + "/api/admin/blocklist", "POST", {"action": "list"}, timeout=10)
    assert st == 403
