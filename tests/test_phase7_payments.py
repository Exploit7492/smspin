"""KoraPay channel alignment: the top-up page may only offer the payment
channels the merchant account actually has enabled for NGN (card + bank
transfer). These hit the real backend + live Supabase project and skip
automatically when the required env is not configured.
"""
import pytest


def _auth(user):
    return {"Authorization": "Bearer " + user["token"]}


def test_payment_methods_lists_real_channels(http, server_up):
    st, d = http(server_up + "/api/payment-methods")
    assert st == 200, d
    ids = [m["id"] for m in d["methods"]]
    assert ids == ["card", "bank_transfer"], ids
    assert d["provider"] == "korapay"
    assert d["currency"] == "NGN"
    assert d["fee_percent"] == 2.5
    # Every advertised method carries a label + note so the UI can render it.
    for m in d["methods"]:
        assert m["label"] and m["note"]


def test_rails_korapay_has_no_ussd(db_conn):
    cur = db_conn.cursor()
    cur.execute("select payment_rails()")
    rails = {r["id"]: r for r in cur.fetchone()[0]}
    assert rails["korapay"]["kinds"] == ["card", "bank_transfer"]
    assert "ussd" not in rails["korapay"]["kinds"]
    assert rails["korapay"]["enabled"] is True


def test_initialize_rejects_unknown_channel(http, server_up, test_user):
    for bad in ("binance", "crypto", "ussd", "mobile_money", "paypal"):
        st, d = http(server_up + "/api/payments/initialize", "POST",
                     {"amount": 5000, "channel": bad}, _auth(test_user))
        assert st == 400, (bad, d)
        assert d.get("error") == "unsupported payment method"
        assert set(d.get("allowed", [])) == {"card", "bank_transfer"}


@pytest.mark.parametrize("channel", ["card", "bank_transfer"])
def test_initialize_accepts_real_channel_and_stamps_fee(http, server_up, test_user, db_conn, channel):
    st, d = http(server_up + "/api/payments/initialize", "POST",
                 {"amount": 5000, "channel": channel}, _auth(test_user))
    assert st == 200, d
    assert d.get("checkout_url"), d
    ref = d["reference"]

    cur = db_conn.cursor()
    cur.execute("select channel, fee_ngn, status from payments where reference=%s", (ref,))
    row = cur.fetchone()
    assert row is not None, ref
    assert row[0] == channel, row
    assert row[1] == 125, row  # flat 2.5% of 5000
    assert row[2] == "pending"


def test_initialize_defaults_to_card(http, server_up, test_user, db_conn):
    st, d = http(server_up + "/api/payments/initialize", "POST",
                 {"amount": 1000}, _auth(test_user))
    assert st == 200, d
    cur = db_conn.cursor()
    cur.execute("select channel from payments where reference=%s", (d["reference"],))
    assert cur.fetchone()[0] == "card"


def _tenant_token(http, server_up):
    """Log into the demo tenant (skips when it is not seeded)."""
    st, d = http(server_up + "/api/rpc", "POST",
                 {"fn": "tenant_login", "args": {"p_email": "demo@smspin.local",
                                                 "p_password": "StoreDemo123!",
                                                 "p_slug": "zenith-verify"}})
    if st != 200 or not (d or {}).get("token"):
        pytest.skip("demo tenant not seeded")
    return d["token"]


@pytest.mark.parametrize("channel", ["card", "bank_transfer"])
def test_tenant_fee_is_2_5_percent_of_ngn(http, server_up, db_conn, channel):
    """A store top-up is charged in NGN, so the fee must be 2.5% of the NGN
    amount regardless of the caller's geo. A US-geolocated browser previously
    stamped a fee on a USD figure (e.g. NGN 101,875 on a NGN 3,000 charge)."""
    tok = _tenant_token(http, server_up)
    st, d = http(server_up + "/api/payments/initialize", "POST",
                 {"amount": 3000, "channel": channel, "tenant_token": tok,
                  "country": "US", "currency": "USD"})
    assert st == 200, d
    cur = db_conn.cursor()
    cur.execute("select channel, fee_ngn, tenant_account_id from payments where reference=%s",
                (d["reference"],))
    row = cur.fetchone()
    assert row is not None, d
    assert row[0] == channel, row
    assert float(row[1]) == 75.0, row
    assert row[2], "tenant payment must be attributed to the tenant account"


def test_tenant_initialize_rejects_unknown_channel(http, server_up):
    tok = _tenant_token(http, server_up)
    st, d = http(server_up + "/api/payments/initialize", "POST",
                 {"amount": 3000, "channel": "binance", "tenant_token": tok})
    assert st == 400, d
    assert d.get("error") == "unsupported payment method"
