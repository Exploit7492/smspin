"""Unit tests for the upstream provider client (no network calls)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import smspin_api
import smspool_api


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


def test_facade_requires_at_least_one_key():
    try:
        smspin_api.SmspinClient(primary_key="", fallback_key="")
        assert False, "no keys must raise"
    except smspin_api.SmspinError:
        pass


def test_facade_primary_only():
    c = smspin_api.SmspinClient(primary_key="smspool_test")
    assert c.primary is not None
    assert c.fallback is None


def test_facade_fallback_only():
    c = smspin_api.SmspinClient(fallback_key="smspin_test")
    assert c.primary is None
    assert c.fallback is not None


def test_facade_falls_back_on_empty_primary():
    """An empty primary result (no price) must fall through to the fallback."""
    class Empty:
        def live_price(self, country, service, service_name=None):
            return {"price_usd": None, "available": 0}

    class Good:
        def live_price(self, country, service, service_name=None):
            return {"price_usd": 0.5, "available": 10}

    c = smspin_api.SmspinClient(primary_key="k")
    c.primary, c.fallback = Empty(), Good()
    assert c.live_price("us", "wa")["price_usd"] == 0.5


def test_facade_raises_when_both_error():
    class Boom:
        def live_price(self, country, service, service_name=None):
            raise smspool_api.SmspinError(400, "INVALID_PARAMETER")

    c = smspin_api.SmspinClient(primary_key="k")
    c.primary, c.fallback = Boom(), Boom()
    try:
        c.live_price("us", "wa")
        assert False, "both providers erroring must raise"
    except smspool_api.SmspinError:
        pass


def test_facade_returns_empty_when_no_provider_has_data():
    class Empty:
        def live_price(self, country, service, service_name=None):
            return {"price_usd": None, "available": 0}

    c = smspin_api.SmspinClient(primary_key="k")
    c.primary, c.fallback = Empty(), Empty()
    assert c.live_price("us", "wa")["price_usd"] is None


def test_smspool_client_has_expected_methods():
    c = smspool_api.SmspoolClient("smspool_test")
    for m in ("account", "countries", "services", "operators", "numbers",
              "live_price", "create_order", "get_order", "cancel_order",
              "rent_prices", "create_rental", "list_rentals", "extend_rental",
              "order_history", "resend_order", "pools", "order_status"):
        assert hasattr(c, m), m


def test_smspool_service_name_normalisation():
    # 'Google / YouTube / Gmail' must match on the 'Google' head token.
    assert smspool_api._norm("Google / YouTube / Gmail") == "google"
    assert smspool_api._norm("WhatsApp") == "whatsapp"
    assert smspool_api._norm("TikTok/Douyin") == "tiktok"
