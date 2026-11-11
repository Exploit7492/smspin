#!/usr/bin/env python3
"""SMSPin upstream API client (stdlib only).

Talks to the SMS provider at https://smspin.io/api/v1 with our own API key
(secret `Smspin_apikey`). The provider fronts its API with Cloudflare, which
rejects non-browser user agents (error 1010), so every request carries a
browser User-Agent.

The API exposes no bulk catalog: price and availability are per
(country, service) pair, so callers should query the pairs they need rather
than expecting a full matrix.
"""
from __future__ import annotations

import json
import ssl
import urllib.parse
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "https://smspin.io/api/v1"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


class SmspinError(Exception):
    def __init__(self, status, message, body=None):
        super().__init__(f"SMSPin API {status}: {message}")
        self.status = status
        self.message = message
        self.body = body or {}


class SmspinClient:
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

    def operators(self, country, service):
        return self._get("/operators", {"country": country, "service": service}).get("operators", [])

    def numbers(self, country=None, service=None):
        return self._get("/numbers", {"country": country, "service": service})

    def live_price(self, country, service):
        """Live USD price + stock + operator breakdown for one (country, service)."""
        data = self.numbers(country, service)
        ops = self.operators(country, service)
        cc = (data.get("countries") or [{}])[0]
        available = cc.get("available") or 0
        price = data.get("price")
        if price is None and ops:
            price = min((o.get("price") for o in ops if o.get("price")), default=None)
        return {
            "country": country.upper(),
            "service": service,
            "price_usd": price,
            "available": available,
            "operators": ops,
            "best_operator": (min(ops, key=lambda o: o.get("price") or 1e9) if ops else None),
        }

    # ---- orders ----
    def create_order(self, country, service, operator=None):
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

    c = SmspinClient(os.environ["Smspin_apikey"])
    print("account:", c.account())
    print("countries:", len(c.countries()))
    print("services:", len(c.services()))
    print("live gb/wa:", json.dumps(c.live_price("gb", "wa"))[:300])
