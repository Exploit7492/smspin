#!/usr/bin/env python3
"""SMSPool upstream API client (stdlib only).

Talks to the SMSPool API at https://api.smspool.net using our API key (secret
`Smepool_token`). SMSPool is the *default* provider; the smspin.io client in
`smspin_api.py` is kept as a fallback.

SMSPool identifies a country by name/ID/short code and a service by name/ID,
so this client resolves our internal country/service codes to SMSPool ids using
its `/country/retrieve_all` and `/service/retrieve_all` catalogs (cached in
process, refreshed on demand).

Endpoints used:
  POST /request/balance          -> {"balance": "2.25"}
  POST /country/retrieve_all     -> [{ID, name, short_name, cc, region}]
  POST /service/retrieve_all     -> [{ID, name, favourite}]
  POST /pool/retrieve_all        -> [{ID, name}]
  POST /request/price            -> {"price": "0.72", "high_price": .., "success_rate": ..}
  POST /sms/stock                -> {"success":1, "amount": 4736}
  POST /purchase/sms             -> {order_id, number, phonenumber, cc, ...}
  POST /sms/check                -> {status, sms, ...}  (1=pending, 3=complete, 6=refunded)
  POST /sms/resend               -> {success:1, ...}
  POST /sms/cancel               -> {success: 1, ...}
  POST /request/active           -> [ ...active orders... ]
  POST /request/orders           -> [ ...all orders... ]
  POST /request/history          -> [ ...order history with cost/status... ]
  POST /request/status           -> {"activeOrders": bool, "activePreorders": bool}
  POST /rental/retrieve_all      -> {success:1, data:[{ID, country_short, pricing:{days:usd}}]}
  POST /purchase/rental          -> {success, rental_code, number, ...}
  POST /rental/retrieve          -> [ ...active rentals... ]
  POST /rental/retrieve_status   -> {status, ...}
  POST /rental/extend            -> {success, ...}
  POST /rental/refund            -> {success, ...}
"""
from __future__ import annotations

import json
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = "https://api.smspool.net"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

# SMSPool order status codes (POST /sms/check).
STATUS_PENDING = 1
STATUS_COMPLETE = 3
STATUS_REFUNDED = 6


class SmspinError(Exception):
    """Raised for any provider failure. Name kept for call-site compatibility."""

    def __init__(self, status, message, body=None):
        super().__init__(f"SMSPool API {status}: {message}")
        self.status = status
        self.message = message
        self.body = body or {}


def _norm(name):
    """Normalise a service name for matching: drop the '/'-suffix, strip
    punctuation and case. 'Google / YouTube / Gmail' -> 'google'."""
    base = (name or "").split("/")[0]
    return re.sub(r"[^a-z0-9]", "", base.lower())


class SmspoolClient:
    def __init__(self, api_key, base=DEFAULT_BASE, timeout=30, retries=3):
        if not api_key:
            raise SmspinError(0, "missing API key")
        self.api_key = api_key
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self._lock = threading.Lock()
        self._countries = None   # {short_upper: id}
        self._services = None    # {normalised_name: id}
        self._rentals = None     # list of rental offerings

    # ---- transport ----
    def _request(self, method, path, params=None, body=None):
        url = self.base + path
        data = None
        if body is not None:
            data = urllib.parse.urlencode(body).encode()
        elif params:
            data = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}).encode()
        last = None
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("User-Agent", UA)
            req.add_header("Accept", "application/json")
            if data is not None:
                req.add_header("Content-Type", "application/x-www-form-urlencoded")
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
                msg = parsed.get("message") or parsed.get("error") or str(parsed)
                last = SmspinError(e.code, msg, parsed)
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

    def _post(self, path, params=None, body=None):
        merged = {"key": self.api_key}
        if params:
            merged.update({k: v for k, v in params.items() if v is not None})
        if body:
            merged.update(body)
        return self._request("POST", path, body=merged)[1]

    def _check(self, resp):
        """SMSPool reports errors in-band with success:0 / status:0."""
        if isinstance(resp, dict):
            if resp.get("success") == 0:
                raise SmspinError(400, resp.get("message") or "request failed", resp)
            if "status" in resp and resp.get("status") == 0 and resp.get("message"):
                raise SmspinError(400, resp["message"], resp)
        return resp

    # ---- reference data ----
    def _country_map(self):
        if self._countries is None:
            with self._lock:
                if self._countries is None:
                    rows = self._post("/country/retrieve_all") or []
                    m = {}
                    for c in rows:
                        sn = (c.get("short_name") or "").upper()
                        if sn:
                            m[sn] = c.get("ID")
                    self._countries = m
        return self._countries

    def _service_map(self):
        if self._services is None:
            with self._lock:
                if self._services is None:
                    rows = self._post("/service/retrieve_all") or []
                    m = {}
                    for s in rows:
                        k = _norm(s.get("name"))
                        if k and k not in m:
                            m[k] = s.get("ID")
                    self._services = m
        return self._services

    def country_id(self, code):
        """Resolve our ISO country code (e.g. 'gb') to an SMSPool country id."""
        m = self._country_map()
        key = (code or "").upper()
        return m.get(key)

    def service_id(self, code, name=None):
        """Resolve our service code to an SMSPool service id.

        SMSPool keys services by name, so match our service *name* (passed in by
        the caller, which has the services table) first, then fall back to the
        code itself (some SMSPool services are named by short code).
        """
        m = self._service_map()
        for candidate in (name, code):
            k = _norm(candidate)
            if k and k in m:
                return m[k]
        return None

    def _resolve(self, country, service, service_name=None):
        cid = self.country_id(country)
        sid = self.service_id(service, service_name)
        return cid, sid

    # ---- catalog ----
    def account(self):
        """Balance + currency snapshot (SMSPool exposes balance only)."""
        data = self._post("/request/balance")
        return {"balance": float(data.get("balance", 0) or 0), "currency": "USD", "plan": None}

    def countries(self):
        return self._post("/country/retrieve_all") or []

    def services(self, country=None):
        cid = self.country_id(country) if country else None
        return self._post("/service/retrieve_all", {"country": cid}) or []

    def operators(self, country, service, service_name=None):
        """SMSPool has no operator breakdown; expose the pool as a single tier."""
        price = self._price(country, service, service_name)
        if price is None:
            return []
        return [{"operator": None, "label": "SMSPool", "price": price,
                 "count": self._stock(country, service, service_name)}]

    def pools(self):
        """Number pools (name + id) available for purchases/rentals."""
        return self._post("/pool/retrieve_all") or []

    def order_status(self):
        """Whether the account currently holds active orders/preorders."""
        return self._post("/request/status") or {}

    def _price(self, country, service, service_name=None):
        cid, sid = self._resolve(country, service, service_name)
        if cid is None or sid is None:
            return None
        try:
            data = self._post("/request/price", {"country": cid, "service": sid})
        except SmspinError:
            return None
        if not isinstance(data, dict) or "price" not in data:
            return None
        return float(data.get("price"))

    def _stock(self, country, service, service_name=None):
        """Live available number count for a pair (POST /sms/stock)."""
        cid, sid = self._resolve(country, service, service_name)
        if cid is None or sid is None:
            return 0
        try:
            data = self._post("/sms/stock", {"country": cid, "service": sid})
        except SmspinError:
            return 0
        if isinstance(data, dict) and data.get("success") == 1:
            try:
                return int(data.get("amount") or 0)
            except (TypeError, ValueError):
                return 0
        return 0

    def numbers(self, country=None, service=None):
        """Availability + price for one pair (kept for interface parity)."""
        price = self._price(country, service) if (country and service) else None
        stock = self._stock(country, service) if (country and service) else 0
        return {"price": price,
                "countries": [{"country": (country or "").upper(), "available": stock}]}

    def live_price(self, country, service, service_name=None):
        """Live USD price + stock for one (country, service).

        SMSPool publishes the available count at POST /sms/stock, so a pair is
        sellable only when it is both priced and in stock.
        """
        price = self._price(country, service, service_name)
        stock = self._stock(country, service, service_name) if price is not None else 0
        return {
            "country": (country or "").upper(),
            "service": service,
            "price_usd": price,
            "available": stock,
            "operators": ([{"operator": None, "label": "SMSPool", "price": price, "count": stock}]
                          if price is not None else []),
            "best_operator": None,
        }

    # ---- orders (temporary / one-off numbers) ----
    def create_order(self, country, service, operator=None, service_name=None):
        cid, sid = self._resolve(country, service, service_name)
        if cid is None:
            raise SmspinError(400, "COUNTRY_NOT_AVAILABLE")
        if sid is None:
            raise SmspinError(400, "SERVICE_NOT_AVAILABLE")
        body = {"country": cid, "service": sid}
        resp = self._check(self._post("/purchase/sms", body=body))
        number = str(resp.get("number") or resp.get("phonenumber") or "")
        order_id = str(resp.get("order_id") or "")
        return {
            "id": order_id,
            "phoneNumber": number,
            "phone_number": number,
            "price": float(resp.get("cost") or resp.get("price") or 0) or None,
            "operator": None,
            "service": service,
            "status": "waiting",
        }

    def get_order(self, order_id):
        """Map an SMSPool order onto our internal order shape."""
        data = self._post("/sms/check", {"orderid": order_id})
        status_code = data.get("status")
        if status_code is None and data.get("success") == 0:
            # "We could not find this order!" — unknown to SMSPool, so let the
            # facade try the fallback provider.
            raise SmspinError(404, data.get("message") or "order not found", data)
        otp = data.get("sms") or data.get("code")
        if status_code == STATUS_COMPLETE:
            status = "received"
        elif status_code == STATUS_REFUNDED:
            status = "refunded"
        elif status_code == STATUS_PENDING:
            status = "waiting"
        else:
            status = "waiting"
        return {
            "id": str(order_id),
            "status": status,
            "otpCode": otp if (otp and str(otp) not in ("0", "")) else None,
            "otp_code": otp if (otp and str(otp) not in ("0", "")) else None,
            "service": data.get("service"),
            "createdAt": data.get("timestamp"),
        }

    def list_orders(self):
        """Active orders on the account (POST /request/active)."""
        return self._post("/request/active") or []

    def orders(self):
        """All orders on the account (POST /request/orders)."""
        return self._post("/request/orders") or []

    def order_history(self):
        """Full order history with costs and statuses (POST /request/history)."""
        return self._post("/request/history") or []

    def resend_order(self, order_id):
        """Re-request the SMS for an order (POST /sms/resend)."""
        return self._check(self._post("/sms/resend", {"orderid": order_id}))

    def cancel_order(self, order_id):
        return self._check(self._post("/sms/cancel", {"orderid": order_id}))

    # ---- rentals ----
    @staticmethod
    def _country_matches(offering_short, want):
        """SMSPool rents some countries only under a '_V' (virtual) variant."""
        short = (offering_short or "").upper()
        return short == want or short == want + "_V"

    def _rental_offerings(self, force=False):
        if self._rentals is None or force:
            with self._lock:
                data = self._post("/rental/retrieve_all", {"type": 1})
                self._rentals = (data or {}).get("data") or []
        return self._rentals

    def rent_prices(self, service, country=None):
        """Rental offerings, shaped like the smspin.io client's response.

        SMSPool rents whole country pools (not per-service), so `service` is
        accepted for interface parity but the offerings are country-level. With
        no country, returns every country that offers a rental with its cheapest
        per-day-equivalent price. With a country, returns that country's
        duration ladder.
        """
        offerings = self._rental_offerings()
        want = (country or "").upper()

        def cheapest_per_day(pricing):
            best = None
            for days, usd in (pricing or {}).items():
                try:
                    d, u = int(days), float(usd)
                except (TypeError, ValueError):
                    continue
                if d <= 0:
                    continue
                per_day = u / d
                if best is None or per_day < best:
                    best = per_day
            return best

        if not want:
            countries = []
            for o in offerings:
                pricing = o.get("pricing") or {}
                if not pricing:
                    continue
                countries.append({"country": (o.get("country_short") or "").upper(),
                                  "fromPrice": cheapest_per_day(pricing)})
            return {"service": service, "country": None, "countries": countries, "durations": []}

        durations = []
        seen = {}
        for o in offerings:
            if not self._country_matches(o.get("country_short"), want):
                continue
            for days, usd in (o.get("pricing") or {}).items():
                try:
                    d, u = int(days), float(usd)
                except (TypeError, ValueError):
                    continue
                if d <= 0:
                    continue
                # Several pools may offer the same duration; keep the cheapest.
                if d in seen and seen[d]["price"] <= u:
                    continue
                seen[d] = {"durationHours": d * 24,
                           "duration": d * 24,
                           "days": d,
                           "price": u,
                           "rental_id": o.get("ID"),
                           "pool": o.get("pool")}
        durations = sorted(seen.values(), key=lambda x: x["durationHours"])
        return {"service": service, "country": want, "countries": [], "durations": durations}

    def _pick_rental(self, country, days):
        want = (country or "").upper()
        best = None
        for o in self._rental_offerings():
            if not self._country_matches(o.get("country_short"), want):
                continue
            for key, usd in (o.get("pricing") or {}).items():
                try:
                    d, u = int(key), float(usd)
                except (TypeError, ValueError):
                    continue
                if d != days:
                    continue
                if best is None or u < best[1]:
                    best = (o, u)
        return best

    def create_rental(self, service, country, duration, max_price=None):
        """Buy a rental. `duration` is hours; SMSPool sells whole days."""
        days = max(1, round(int(duration or 24) / 24))
        pick = self._pick_rental(country, days)
        if not pick:
            raise SmspinError(400, "RENTAL_NOT_AVAILABLE")
        offering, usd = pick
        if max_price is not None and usd > float(max_price):
            raise SmspinError(400, "RENTAL_NOT_AVAILABLE")
        resp = self._check(self._post("/purchase/rental",
                                      body={"id": offering.get("ID"), "days": days}))
        rental_code = str(resp.get("rental_code") or resp.get("id") or resp.get("order_id") or "")
        number = str(resp.get("number") or resp.get("phonenumber") or "")
        return {
            "id": rental_code,
            "phoneNumber": number,
            "phone_number": number,
            "price": usd,
            "days": days,
            "status": "waiting",
        }

    def get_rental(self, rental_id):
        return self._post("/rental/retrieve_status", {"rental_code": rental_id})

    def list_rentals(self):
        """The account's active rentals (POST /rental/retrieve)."""
        return self._post("/rental/retrieve") or []

    def extend_rental(self, rental_id, days):
        """Add days to a rental (POST /rental/extend)."""
        return self._check(self._post("/rental/extend",
                                      {"rental_code": rental_id, "days": int(days)}))

    def cancel_rental(self, rental_id):
        return self._check(self._post("/rental/refund", {"rental_code": rental_id}))


if __name__ == "__main__":
    import os

    c = SmspoolClient(os.environ["Smepool_token"])
    print("account:", c.account())
    print("countries:", len(c.countries()))
    print("services:", len(c.services()))
    print("live us/whatsapp:", json.dumps(c.live_price("us", "wa", "WhatsApp")))
    print("rentals us:", json.dumps(c.rent_prices("wa", "US"))[:300])
