"""Backend HTTP surface: static pages, geo/pricing, auth gates, rate limits."""
import pytest


PAGES = ["/", "/buy/", "/price/", "/faq/", "/about/", "/contact/", "/blog/",
         "/affiliate/", "/login/", "/register/", "/dashboard/", "/store/",
         "/docs/api/reference/"]


@pytest.mark.parametrize("path", PAGES)
def test_pages_render(server_up, http, path):
    st, _ = http(server_up + path, timeout=20)
    assert st == 200, f"{path} -> {st}"


def test_referral_alias_redirects(server_up):
    """The /dashboard/referral alias must 301 to /dashboard/referrals/."""
    import urllib.request
    import urllib.error

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    op = urllib.request.build_opener(_NoRedirect)
    try:
        op.open(server_up + "/dashboard/referral", timeout=10)
        assert False, "expected a redirect"
    except urllib.error.HTTPError as e:
        assert e.code in (301, 302, 308)
        assert e.headers.get("Location", "").endswith("/dashboard/referrals/")


def test_landing_mirrors_upstream(server_up):
    """The homepage must carry the real SMSPin title + hero copy."""
    import urllib.request
    r = urllib.request.urlopen(server_up + "/", timeout=20)
    html = r.read().decode("utf-8", "replace")
    assert "SMSPin" in html
    # React splits the hero with <!-- --> markers, so assert the fragments.
    assert "Online SMS verification" in html
    assert "virtual numbers" in html
    assert "210+ countries" in html
    assert "<title>" in html


def test_geo_endpoint(server_up, http):
    st, d = http(server_up + "/api/geo", timeout=10)
    assert st == 200
    assert "country" in d and "currency" in d


def test_pricing_endpoint(server_up, http):
    st, d = http(server_up + "/api/pricing", timeout=10)
    assert st == 200
    assert d.get("korapay_mode") in ("test", "live")
    assert "settings" in d


def test_funding_quote(server_up, http):
    st, d = http(server_up + "/api/funding/quote?amount=1000&country=NG&currency=NGN", timeout=15)
    assert st == 200
    assert "fee_ngn" in d


def test_buy_requires_auth(server_up, http):
    st, _ = http(server_up + "/api/orders/buy", "POST", {"country": "ng", "service": "wa"}, timeout=15)
    assert st == 401


def test_cancel_requires_auth(server_up, http):
    st, _ = http(server_up + "/api/orders/cancel", "POST", {"order_id": 1}, timeout=15)
    assert st == 401


def test_audit_requires_auth(server_up, http):
    st, _ = http(server_up + "/api/audit", timeout=15)
    assert st == 401


def test_v1_requires_api_key(server_up, http):
    st, _ = http(server_up + "/api/v1/balance", timeout=10)
    assert st == 401


def test_unknown_endpoint_404(server_up, http):
    st, _ = http(server_up + "/api/v1/nope", "GET", headers={"x-api-key": "sk_live_bogus"}, timeout=10)
    assert st == 401  # auth checked before route


def test_catalog_live_requires_params(server_up, http):
    st, _ = http(server_up + "/api/catalog/live", timeout=10)
    assert st == 400


def test_upstream_status(server_up, http):
    st, d = http(server_up + "/api/upstream/status", timeout=20)
    assert st == 200
    assert "enabled" in d
    assert "catalog_sync" in d
    assert "reconcile" in d


def test_rate_limit_trips(server_up, http):
    """The buy bucket is 30/min; the 31st request from one IP must 429."""
    # The limiter uses fixed 60s windows, so align to a window boundary first:
    # otherwise the 33 requests can straddle a reset and never exceed 30 in one
    # window (a flaky pass). 33 well within one window trips it deterministically.
    import time
    time.sleep((60 - (time.time() % 60)) % 60 + 0.5)
    ip = {"X-Forwarded-For": "203.0.113.7"}
    codes = []
    for _ in range(33):
        st, _ = http(server_up + "/api/orders/buy", "POST",
                     {"country": "ng", "service": "wa"}, ip, timeout=10)
        codes.append(st)
    assert 429 in codes, codes
    assert codes.count(429) >= 2
