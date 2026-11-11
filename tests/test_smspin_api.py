"""Unit tests for the upstream provider client (no network calls)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import smspin_api


def test_client_requires_key():
    try:
        smspin_api.SmspinClient("")
        assert False, "empty key must raise"
    except smspin_api.SmspinError:
        pass


def test_smspin_error_is_exception():
    e = smspin_api.SmspinError(402, "NO_BALANCE")
    assert e.status == 402
    assert "NO_BALANCE" in str(e)


def test_client_has_expected_methods():
    c = smspin_api.SmspinClient("sk_live_test")
    for m in ("account", "countries", "services", "operators", "numbers",
              "live_price", "create_order", "get_order", "cancel_order",
              "rent_prices", "create_rental"):
        assert hasattr(c, m), m
