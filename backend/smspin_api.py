#!/usr/bin/env python3
"""Upstream provider facade (stdlib only).

The site is served by two upstream SMS providers:

  * SMSPool (secret `Smepool_token`) — the DEFAULT provider. Its native client
    lives in `smspool_api.py`.
  * SMSPin (secret `Smspin_apikey`) — the FALLBACK provider. `SmspinIOClient`
    below talks to https://smspin.io/api/v1.

`SmspinClient` is the single entry point server.py uses. It tries the default
provider first and transparently falls back to the other one whenever the
default cannot serve a request (unknown country/service, no price, transport
error). Both speak the same internal interface, so callers stay provider-blind.

The smspin.io API exposes no bulk catalog: price and availability are per
(country, service) pair. It fronts its API with Cloudflare, which rejects
non-browser user agents (error 1010), so every request carries a browser
User-Agent.
"""
from __future__ import annotations

import json
import ssl
import urllib.parse
import time
import urllib.error
import urllib.request

import smspool_api

DEFAULT_BASE = "https://smspin.io/api/v1"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


# Errors are raised as smspool_api.SmspinError by both providers so call sites
# can keep catching a single type.
SmspinError = smspool_api.SmspinError


class SmspinIOClient:
    def __init__(self, api_key, base=DEFAULT_BASE, timeout=30, retries=3):
        if not api_key:
            raise SmspinError(0, "missing API key")
        self.api_key = api_key
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.retries = retries

    # ---- transport ----
    def _request(self, method, path, params=None, body=None):
        url = self.base + path
        if params:
            pairs = [(k, v) for k, v in params.items() if v is not None]
            if pairs:
                url += "?" + urllib.parse.urlencode(pairs)
        data = json.dumps(body).encode() if body is not None else None
        last = None
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("User-Agent", UA)
            req.add_header("Accept", "application/json")
            req.add_header("X-API-Key", self.api_key)
            if data is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout, context=_CTX) as r:
                    raw = r.read() or b"{}"
                    return r.status, json.loads(raw or b"{}")
            except urllib.error.HTTPError as e:
                raw = e.read() or b"{}"
                try:
                    parsed = json.loads(raw or b"{}")
                except Exception:
                    parsed = {"error": raw[:200].decode(errors="replace")}
                last = SmspinError(e.code, parsed.get("error") or str(parsed), parsed)
                if e.code in (429, 500, 502, 503, 504) and attempt < self.retries:
                    time.sleep(min(2 ** attempt, 8))
                    continue
                raise last
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last = SmspinError(0, str(e))
                if attempt < self.retries:
                    time.sleep(min(2 ** attempt, 8))
                    continue
                raise last
        raise last

    def _get(self, path, params=None):
        return self._request("GET", path, params=params)[1]

    # ---- catalog ----
    def account(self):
        return self._get("/account")

    def countries(self):
        return self._get("/countries").get("countries", [])

    def services(self, country=None):
        return self._get("/services", {"country": country}).get("services", [])

    def operators(self, country, service, service_name=None):
        return self._get("/operators", {"country": country, "service": service}).get("operators", [])

    def numbers(self, country=None, service=None):
        return self._get("/numbers", {"country": country, "service": service})

    def live_price(self, country, service, service_name=None):
        """Live USD price + stock + operator breakdown for one (country, service).

        The provider's headline `price` is the *most expensive* operator tier,
        so pricing off it overcharges badly. Price from the cheapest operator
        that actually has stock, falling back to the headline only when there
        is no operator breakdown.
        """
        data = self.numbers(country, service)
        ops = self.operators(country, service)
        cc = (data.get("countries") or [{}])[0]
        available = cc.get("available") or 0
        priced = [(o.get("price"), o.get("count") or 0) for o in ops
                  if isinstance(o, dict) and o.get("price") is not None]
        price = None
        best_op = None
        if priced:
            in_stock = [o for o in ops if (o.get("count") or 0) > 0 and o.get("price") is not None]
            best_op = min(in_stock or ops, key=lambda o: o.get("price") or 1e9)
            price = best_op.get("price")
        if price is None:
            price = data.get("price")
        return {
            "country": country.upper(),
            "service": service,
            "price_usd": price,
            "available": available,
            "operators": ops,
            "best_operator": best_op,
        }

    # ---- orders ----
    def create_order(self, country, service, operator=None, service_name=None):
        body = {"country": country, "service": service}
        if operator is not None:
            body["operator"] = int(operator)
        return self._request("POST", "/orders", body=body)[1]

    def get_order(self, order_id):
        return self._get(f"/orders/{order_id}")

    def list_orders(self):
        return self._get("/orders").get("orders", [])

    def cancel_order(self, order_id):
        return self._request("DELETE", f"/orders/{order_id}")[1]

    # ---- rentals ----
    def rent_prices(self, service, country=None):
        return self._get("/rent/prices", {"service": service, "country": country})

    def create_rental(self, service, country, duration, max_price=None):
        body = {"service": service, "country": country, "duration": int(duration)}
        if max_price is not None:
            body["maxPrice"] = float(max_price)
        return self._request("POST", "/rent", body=body)[1]

    def get_rental(self, rental_id):
        return self._get(f"/rent/{rental_id}")


if __name__ == "__main__":
    import os
    import urllib.parse  # noqa: F401  (used by _request)

    c = SmspinIOClient(os.environ["Smspin_apikey"])
    print("account:", c.account())
    print("countries:", len(c.countries()))
    print("services:", len(c.services()))
    print("live gb/wa:", json.dumps(c.live_price("gb", "wa"))[:300])


# A provider "answer" that carries no usable data (no price / no rentals) is
# treated like a miss so the facade tries the next provider.
def _is_empty_result(method, result):
    if not result:
        return True
    if method == "live_price":
        return result.get("price_usd") is None
    if method == "rent_prices":
        return not result.get("countries") and not result.get("durations")
    return False


class SmspinClient:
    """Provider-blind facade: SMSPool first, smspin.io as fallback.

    Both providers implement the same method names. Read methods fall back
    whenever the default provider errors or returns nothing useful; write
    methods (create_*/cancel_*) fall back only on error, so we never double-book
    an order that the default provider actually accepted.
    """

    def __init__(self, primary_key=None, fallback_key=None, service_names=None):
        self.primary = smspool_api.SmspoolClient(primary_key) if primary_key else None
        self.fallback = SmspinIOClient(fallback_key) if fallback_key else None
        if self.primary is None and self.fallback is None:
            raise SmspinError(0, "missing API key")
        # Optional {code: name} map so SMSPool can resolve a service by its
        # human name (SMSPool keys services by name, not by our short code).
        self._names = service_names or {}

    def set_service_names(self, mapping):
        self._names = mapping or {}

    def _name_for(self, service):
        return self._names.get(service)

    def _try(self, method, *args, **kwargs):
        """Call `method` on the default provider, then the fallback.

        Returns the first non-empty result. When a provider answers with an
        empty result (no price / no rentals) the facade tries the next one, but
        remembers it: if every provider answers empty, the last empty result is
        returned so callers can still record a zero-stock pair. Only when every
        provider *errors* does this raise.
        """
        providers = [p for p in (self.primary, self.fallback) if p is not None]
        first_err = None
        empty_result = None
        for p in providers:
            fn = getattr(p, method, None)
            if fn is None:
                continue
            try:
                result = fn(*args, **kwargs)
            except SmspinError as e:
                if first_err is None:
                    first_err = e
                continue
            if _is_empty_result(method, result):
                empty_result = result
                continue
            return result
        if empty_result is not None:
            return empty_result
        if first_err is not None:
            raise first_err
        raise SmspinError(0, f"no provider implements {method}")

    # ---- reference data ----
    def account(self):
        return self._try("account")

    def countries(self):
        return self._try("countries")

    def services(self, country=None):
        return self._try("services", country)

    def operators(self, country, service):
        return self._try("operators", country, service, service_name=self._name_for(service))

    def numbers(self, country=None, service=None):
        return self._try("numbers", country, service)

    def pools(self):
        return self._try("pools")

    def order_status(self):
        return self._try("order_status")

    def live_price(self, country, service):
        return self._try("live_price", country, service, service_name=self._name_for(service))

    # ---- orders ----
    def create_order(self, country, service, operator=None):
        return self._try("create_order", country, service, operator,
                         service_name=self._name_for(service))

    def get_order(self, order_id):
        return self._try("get_order", order_id)

    def list_orders(self):
        return self._try("list_orders")

    def orders(self):
        return self._try("orders")

    def order_history(self):
        return self._try("order_history")

    def resend_order(self, order_id):
        return self._try("resend_order", order_id)

    def cancel_order(self, order_id):
        return self._try("cancel_order", order_id)

    # ---- rentals ----
    def rent_prices(self, service, country=None):
        return self._try("rent_prices", service, country)

    def create_rental(self, service, country, duration, max_price=None):
        return self._try("create_rental", service, country, duration, max_price)

    def get_rental(self, rental_id):
        return self._try("get_rental", rental_id)

    def list_rentals(self):
        return self._try("list_rentals")

    def extend_rental(self, rental_id, days):
        return self._try("extend_rental", rental_id, days)
