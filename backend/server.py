#!/usr/bin/env python3
"""SMSPin backend: static site + KoraPay payments + geo pricing.

Stdlib only. Secrets come from the environment (never hardcoded):
  Smspin_Supabase_url, Smspin_supabase_annonkey, Smspin_supabase_secretskey,
  Smspin_supabase_Postgresql, Smspin_apikey,
  Kora_public_key, Kora_secrete_key, Kora_test_public_key, Kora_test_secrete_key
"""
import os
import re
import sys
import json
import hmac
import time
import hashlib
import ssl
import threading
import urllib.request
import urllib.error
import psycopg2
from psycopg2.extras import RealDictCursor
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pricing  # real-time FX + PPP funding fees (forex-python + wbdata)
import smspin_api  # upstream SMS provider client

SITE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site")
PORT = int(os.environ.get("PORT", "12000"))

SUPABASE_URL = os.environ["Smspin_Supabase_url"].rstrip("/")
ANON_KEY = os.environ["Smspin_supabase_annonkey"]
SERVICE_KEY = os.environ.get("Smspin_supabase_secretskey", "")
PG_DSN = os.environ["Smspin_supabase_Postgresql"]
SMSPIN_KEY = os.environ.get("Smspin_apikey", "")

KORA_MODE = os.environ.get("KORA_MODE", "test")  # test | live
KORA_SECRET = os.environ["Kora_test_secrete_key"] if KORA_MODE == "test" else os.environ["Kora_secrete_key"]
KORA_PUBLIC = os.environ["Kora_test_public_key"] if KORA_MODE == "test" else os.environ["Kora_public_key"]
KORA_BASE = "https://api.korapay.com/merchant/api/v1"

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"


def db():
    return psycopg2.connect(PG_DSN)


def http_json(url, method="GET", headers=None, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", UA)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        r = urllib.request.urlopen(req, timeout=timeout, context=CTX)
        return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def supabase_rpc(fn, params, token=None, key=None):
    url = f"{SUPABASE_URL}/rest/v1/rpc/{fn}"
    hdr = {"apikey": key or ANON_KEY, "Authorization": "Bearer " + (token or key or ANON_KEY),
           "Content-Type": "application/json"}
    return http_json(url, "POST", hdr, params or {})


def _valid_pay_email(email):
    """KoraPay rejects reserved/undeliverable TLDs; only accept a real-looking address."""
    if not email or "@" not in email:
        return False
    tld = email.rsplit(".", 1)[-1].lower()
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", email)) and tld not in {"local", "test", "invalid", "example", "localhost"}


def korapay_init(reference, amount, email, name, redirect_url, notification_url):
    return http_json(
        f"{KORA_BASE}/charges/initialize", "POST",
        {"Authorization": "Bearer " + KORA_SECRET, "Content-Type": "application/json"},
        {"amount": int(round(float(amount))), "currency": "NGN", "reference": reference,
         "redirect_url": redirect_url, "notification_url": notification_url,
         "customer": {"name": name or "SMSPin User", "email": email},
         "narration": "SMSPin wallet top-up"})


def korapay_verify(reference):
    return http_json(f"{KORA_BASE}/charges/{reference}", "GET",
                     {"Authorization": "Bearer " + KORA_SECRET})


# ---- geo / currency ----
def geo_from_ip(ip):
    """Resolve country + currency from visitor IP using a public geo service."""
    if ip in ("127.0.0.1", "localhost", "::1") or ip.startswith("172.") or ip.startswith("10."):
        ip = ""  # let the service use the caller's public IP
    url = f"https://ipapi.co/{ip}/json/" if ip else "https://ipapi.co/json/"
    st, d = http_json(url, timeout=10)
    if st == 200 and d.get("country_code"):
        return d.get("country_code"), d.get("currency") or "USD", d.get("country_name")
    return "NG", "NGN", "Nigeria"


_FX_CACHE = {"t": 0, "rates": {}}
_CURRENCY_SYMBOL = {"NGN": "\u20a6", "USD": "$", "GBP": "\u00a3", "EUR": "\u20ac",
                    "INR": "\u20b9", "JPY": "\u00a5", "BRL": "R$", "ZAR": "R",
                    "KES": "KSh", "GHS": "GH\u20b5", "CAD": "C$", "AUD": "A$"}


def fx_rates():
    if time.time() - _FX_CACHE["t"] < 300 and _FX_CACHE["rates"]:
        return _FX_CACHE["rates"]
    with db() as conn, conn.cursor() as cur:
        cur.execute("select code, rate from fx_rates")
        _FX_CACHE["rates"] = {c: float(r) for c, r in cur.fetchall()}
    _FX_CACHE["t"] = time.time()
    return _FX_CACHE["rates"]


def convert(amount_ngn, to):
    """NGN is our base wallet currency; fx_rates are units per 1 USD."""
    rates = fx_rates()
    ngn = rates.get("NGN") or 1.0
    usd = float(amount_ngn) / ngn
    if to == "NGN":
        val = float(amount_ngn)
    else:
        val = usd * rates.get(to, ngn)
    sym = _CURRENCY_SYMBOL.get(to, "")
    return {"currency": to, "amount": round(val, 2), "symbol": sym,
            "formatted": f"{sym}{val:,.2f}".strip()}


# =========================================================================
# Upstream SMS provider (SMSPin) integration
# =========================================================================
_SMS_CLIENT = smspin_api.SmspinClient(SMSPIN_KEY) if SMSPIN_KEY else None


def upstream_enabled():
    if _SMS_CLIENT is None:
        return False
    try:
        with db() as conn, conn.cursor() as cur:
            cur.execute("select value from settings where key='upstream_live'")
            row = cur.fetchone()
            return bool(row) and row[0] in (True, "true", '"true"')
    except Exception:
        return False


def _svc(fn, params):
    """Call a SECURITY DEFINER function as the service role (backend-only)."""
    with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        placeholders = ",".join(["%s"] * len(params))
        cur.execute(f"select {fn}({placeholders}) as r", tuple(params.values()))
        return cur.fetchone()["r"]


def _upsert_catalog(items):
    if not items:
        return
    _svc("catalog_upsert", {"p_items": json.dumps(items)})


def _stock_for(country, service):
    with db() as conn, conn.cursor() as cur:
        cur.execute("select stock, price from number_catalog where country_code=%s and service_code=%s",
                    (country, service))
        return cur.fetchone()


def sync_pair(country, service, force=False):
    """Refresh price + stock for one (country, service) from the provider."""
    if not upstream_enabled():
        return None
    cc, sv = (country or "").lower(), service
    if not cc or not sv:
        return None
    if not force:
        with db() as conn, conn.cursor() as cur:
            cur.execute("""select 1 from number_catalog
                where country_code=%s and service_code=%s and updated_at > now() - interval '15 minutes'""",
                        (cc, sv))
            if cur.fetchone():
                return None
    try:
        live = _SMS_CLIENT.live_price(cc, sv)
    except smspin_api.SmspinError:
        return None
    cost = live.get("price_usd")
    if cost is None:
        _upsert_catalog([{"country": cc, "service": sv, "cost_usd": 0, "stock": 0}])
        return live
    rate = fx_rates().get("NGN", 1.0)
    markup = 200.0
    with db() as conn, conn.cursor() as cur:
        cur.execute("select value::text::numeric from settings where key='markup_percent'")
        row = cur.fetchone()
        if row:
            markup = float(row[0])
    price_ngn = round(cost * (1 + markup / 100.0) * rate, 2)
    _upsert_catalog([{"country": cc, "service": sv, "cost_usd": cost,
                      "price_ngn": price_ngn, "stock": live.get("available", 0)}])
    return live


def buy_real(country, service, user_id=None, tenant_account=None, operator=None):
    """Reserve funds locally, place the provider order, confirm or refund."""
    if not upstream_enabled():
        raise RuntimeError("upstream disabled")
    cc, sv = country.lower(), service
    live = sync_pair(cc, sv, force=True) or {}
    res = _svc("reserve_number", {
        "p_user": user_id, "p_country": cc, "p_service": sv,
        "p_tenant_account": tenant_account, "p_operator": operator,
    })
    order_id = res["order_id"]
    try:
        up = _SMS_CLIENT.create_order(cc, sv, operator)
    except smspin_api.SmspinError as e:
        _svc("refund_order", {"p_order_id": order_id, "p_reason": "provider_error"})
        raise RuntimeError(str(e))
    phone = up.get("phoneNumber") or up.get("phone_number") or ""
    up_id = str(up.get("id") or "")
    if not phone or not up_id:
        _svc("refund_order", {"p_order_id": order_id, "p_reason": "no_number"})
        raise RuntimeError("provider did not return a number")
    _svc("set_order_upstream", {"p_order_id": order_id, "p_phone": phone,
                                "p_upstream_id": up_id, "p_operator": up.get("operator"),
                                "p_cost_usd": up.get("price")})
    return {"order_id": order_id, "phone_number": phone, "price_ngn": res["price_ngn"],
            "base_ngn": res["base_ngn"], "markup_ngn": res["markup_ngn"],
            "status": "waiting", "upstream_order_id": up_id}


_CODE_RE = re.compile(r"\b(\d{4,8})\b")


def _extract_code(text):
    """Best-effort OTP extraction from a message body (provider fallback)."""
    if not text:
        return None
    m = _CODE_RE.search(text)
    return m.group(1) if m else None


def poll_pending_orders():
    """Fetch OTPs for waiting orders and auto-refund expired ones."""
    if not upstream_enabled():
        return
    for o in (_svc("upstream_pending_orders", {"p_limit": 150}) or []):
        up_id = o.get("upstream_order_id")
        try:
            up = _SMS_CLIENT.get_order(up_id)
        except smspin_api.SmspinError:
            continue
        status = (up.get("status") or "").lower()
        code = up.get("otpCode") or up.get("otp_code")
        if code:
            _svc("record_sms", {"p_order_id": o["id"], "p_sender": up.get("service") or o.get("service_code"),
                                "p_body": f"Verification code: {code}", "p_code": str(code),
                                "p_received_at": up.get("createdAt") or None})
        elif status in ("cancelled", "expired", "failed"):
            _svc("refund_order", {"p_order_id": o["id"], "p_reason": f"upstream_{status}"})
    for o in (_svc("expired_orders", {"p_limit": 200}) or []):
        up_id = o.get("upstream_order_id")
        if up_id:
            try:
                _SMS_CLIENT.cancel_order(up_id)
            except smspin_api.SmspinError:
                pass
        _svc("refund_order", {"p_order_id": o["id"], "p_reason": "expired"})


def warm_popular():
    """Refresh the pairs shown on the homepage so the catalog is never empty."""
    with db() as conn, conn.cursor() as cur:
        cur.execute("select value from settings where key='popular_pairs'")
        row = cur.fetchone()
    pairs = row[0] if row else None
    if isinstance(pairs, str):
        pairs = json.loads(pairs)
    if not pairs:
        pairs = [["gb", "wa"], ["us", "wa"], ["ng", "wa"], ["in", "wa"], ["id", "wa"],
                 ["de", "wa"], ["fr", "wa"], ["br", "wa"], ["gb", "tg"], ["us", "tg"]]
    for cc, sv in pairs:
        try:
            sync_pair(cc, sv, force=True)
        except Exception:
            pass



OPENAPI = {
    "openapi": "3.0.3",
    "info": {"title": "SMSPin API", "version": "1.0.0",
             "description": "Buy virtual numbers and read OTP codes. "
                            "Authenticate with your own API key from the dashboard (API Keys page)."},
    "servers": [{"url": "/"}],
    "security": [{"ApiKeyAuth": []}],
    "components": {"securitySchemes": {"ApiKeyAuth": {
        "type": "apiKey", "in": "header", "name": "x-api-key"}}},
    "paths": {
        "/api/v1/balance": {"get": {"summary": "Wallet balance", "responses": {"200": {"description": "Balance in NGN"}}}},
        "/api/v1/catalog": {"get": {"summary": "List available numbers with our prices",
            "parameters": [
                {"name": "country", "in": "query", "schema": {"type": "string"}, "description": "ISO country code, e.g. gb"},
                {"name": "service", "in": "query", "schema": {"type": "string"}, "description": "Service code, e.g. whatsapp"}],
            "responses": {"200": {"description": "Array of {country, service, price_ngn, stock, icon}"}}}},
        "/api/v1/order": {
            "get": {"summary": "Get an order and its OTP",
                "parameters": [{"name": "id", "in": "query", "required": True, "schema": {"type": "integer"}}],
                "responses": {"200": {"description": "Order status and otp"}}},
            "post": {"summary": "Buy a number (debits your wallet balance)",
                "requestBody": {"required": True, "content": {"application/json": {"schema": {
                    "type": "object", "required": ["country", "service"],
                    "properties": {"country": {"type": "string"}, "service": {"type": "string"}}}}}},
                "responses": {"200": {"description": "order_id, phone_number, price_ngn, status"},
                              "402": {"description": "insufficient balance or no stock"}}}},
    },
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=SITE_DIR, **k)

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj, ctype="application/json"):
        body = json.dumps(obj).encode() if not isinstance(obj, (bytes, bytearray)) else obj
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def _bearer(self):
        a = self.headers.get("Authorization", "")
        return a[7:] if a.startswith("Bearer ") else None

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization,Content-Type")
        self.end_headers()

    # ---------- API ----------
    def do_GET(self):
        path = urlparse(self.path).path
        # Alias legacy marketing links onto the real dashboard routes.
        if path == "/dashboard/referral":
            self.send_response(301)
            self.send_header("Location", "/dashboard/referrals/")
            self.end_headers()
            return
        # White-label storefronts live at /store/<slug>; serve the single store page.
        # Real files (e.g. /store/auth.css) are served as-is.
        if path.startswith("/store/") and not os.path.isfile(os.path.join(SITE_DIR, path.lstrip("/"))):
            parts = [p for p in path.split("/") if p]   # ["store", "<slug>", ...]
            sub = parts[2] if len(parts) > 2 else ""
            if sub == "login":
                self.path = "/store/login.html"
            elif sub == "register":
                self.path = "/store/register.html"
            elif sub == "account":
                self.path = "/store/account.html"
            else:
                self.path = "/store/index.html"
        if path == "/api/geo":
            ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0]
            cc, cur, name = geo_from_ip(ip)
            return self._send(200, {"country": cc, "currency": cur, "country_name": name})
        if path == "/api/openapi":
            return self._send(200, OPENAPI)
        if path == "/api/business/manifest":
            q = parse_qs(urlparse(self.path).query)
            slug = (q.get("slug", [""])[0] or "").strip()
            if not slug:
                return self._send(400, {"error": "slug required"})
            biz = self._rpc_svc("business_public", {"p_slug": slug})
            if not biz or biz == "null":
                return self._send(404, {"error": "store not found"})
            theme = biz.get("theme", "crimson")
            host = self.headers.get("Host", "smspin.io")
            scheme = "https" if self.headers.get("X-Forwarded-Proto", "http") == "https" else "http"
            return self._send(200, {
                "app_name": biz["name"],
                "package": "io.smspin.store." + slug.replace("-", ""),
                "store_url": f"{scheme}://{host}/store/{slug}",
                "theme": theme,
                "markup_percent": biz.get("markup_percent", 0),
                "api_base": f"{scheme}://{host}/api/v1",
                "platform": "android",
                "build": {"format": "apk", "min_sdk": 24, "target_sdk": 34,
                          "version_name": "1.0.0", "version_code": 1},
            })
        if path == "/api/fx":
            q = parse_qs(urlparse(self.path).query)
            to = (q.get("to", ["NGN"])[0] or "NGN").upper()
            amount = float(q.get("amount", ["0"])[0] or 0)
            return self._send(200, convert(amount, to))
        if path == "/api/funding/quote":
            q = parse_qs(urlparse(self.path).query)
            amount = float(q.get("amount", ["0"])[0] or 0)
            cc, cur, _ = geo_from_ip(self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0])
            cc = (q.get("country", [cc])[0] or cc).upper()
            cur = (q.get("currency", [cur])[0] or cur).upper()
            try:
                return self._send(200, pricing.quote(amount, cc, cur))
            except Exception as e:
                return self._send(500, {"error": str(e)})
        if path.startswith("/api/v1/"):
            return self.api_v1(path)
        if path == "/api/catalog/live":
            q = parse_qs(urlparse(self.path).query)
            cc = (q.get("country", [""])[0] or "").lower()
            sv = q.get("service", [""])[0] or ""
            if not cc or not sv:
                return self._send(400, {"error": "country and service required"})
            live = sync_pair(cc, sv) or {}
            with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""select price, cost_usd, stock, updated_at from number_catalog
                                where country_code=%s and service_code=%s""", (cc, sv))
                row = cur.fetchone() or {}
            return self._send(200, {"country": cc, "service": sv,
                                    "price_ngn": float(row["price"]) if row.get("price") is not None else None,
                                    "cost_usd": float(row["cost_usd"]) if row.get("cost_usd") is not None else live.get("price_usd"),
                                    "available": row.get("stock", live.get("available")),
                                    "operators": live.get("operators", [])})
        if path == "/api/order/status":
            q = parse_qs(urlparse(self.path).query)
            oid = q.get("id", [None])[0]
            if not oid:
                return self._send(400, {"error": "id required"})
            return self._send(200, self._order_status(int(oid)))
        if path == "/api/pricing":
            with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("select * from settings")
                s = {r["key"]: r["value"] for r in cur.fetchall()}
            return self._send(200, {"settings": s, "korapay_mode": KORA_MODE, "korapay_public_key": KORA_PUBLIC})
        if path.startswith("/api/payments/verify/"):
            ref = path.rsplit("/", 1)[-1]
            st, d = korapay_verify(ref)
            data = d.get("data") or {}
            if st == 200 and data.get("status") == "success":
                res = self._credit_payment(ref, data.get("amount"), data.get("channel"),
                                           data.get("transaction_reference"))
                return self._send(200, {"verified": True, "status": "success", "credit": res})
            return self._send(200, {"verified": False, "status": data.get("status", "unknown")})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/payments/initialize":
                return self.api_payments_initialize()
            if path == "/api/korapay/webhook":
                return self.api_webhook()
            if path == "/api/orders/buy":
                return self.api_buy_order()
            if path == "/api/orders/cancel":
                return self.api_cancel_order()
            if path.startswith("/api/v1/"):
                return self.api_v1(path)
        except Exception as e:
            return self._send(500, {"error": str(e)})
        return self._send(404, {"error": "not found"})

    # ---------- upstream orders (buy / cancel / status) ----------
    def _auth_user(self):
        """Resolve the caller to a dashboard user id, or None."""
        token = self._bearer()
        if not token:
            return None
        st, prof = supabase_rpc("my_profile", {}, token=token)
        if st != 200 or not prof:
            return None
        return prof.get("id")

    def _auth_tenant(self, token):
        if not token:
            return None
        st, me = supabase_rpc("tenant_me", {"p_token": token})
        if st != 200 or not me:
            return None
        return me.get("account_id")

    def _order_status(self, order_id):
        with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""select o.id, o.status, o.phone_number, o.price, o.expires_at,
                                  o.created_at, o.country_code, o.service_code,
                                  (select m.code from sms_messages m
                                    where m.order_id = o.id and m.code is not null
                                    order by m.received_at desc limit 1) as otp
                             from orders o where o.id = %s""", (order_id,))
            row = cur.fetchone()
        if not row:
            return {"error": "not found"}
        row["price"] = float(row["price"]) if row.get("price") is not None else None
        return row

    def api_buy_order(self):
        body = self._read_json()
        country = (body.get("country") or "").lower()
        service = body.get("service") or ""
        if not country or not service:
            return self._send(400, {"error": "country and service required"})
        operator = body.get("operator")
        if not upstream_enabled():
            return self._send(503, {"error": "ordering temporarily unavailable"})

        user_id = None
        tenant_account = None
        tenant_token = body.get("tenant_token") or self.headers.get("x-tenant-token")
        if tenant_token:
            tenant_account = self._auth_tenant(tenant_token)
            if not tenant_account:
                return self._send(401, {"error": "invalid tenant session"})
        else:
            user_id = self._auth_user()
            if not user_id:
                return self._send(401, {"error": "missing or invalid session"})
        try:
            res = buy_real(country, service, user_id=user_id, tenant_account=tenant_account,
                           operator=int(operator) if operator else None)
            return self._send(200, res)
        except RuntimeError as e:
            return self._send(402, {"error": str(e)})
        except Exception as e:
            return self._send(500, {"error": str(e).split("\n")[0]})

    def api_cancel_order(self):
        body = self._read_json()
        order_id = body.get("order_id")
        if not order_id:
            return self._send(400, {"error": "order_id required"})
        user_id = None
        tenant_account = None
        tenant_token = body.get("tenant_token") or self.headers.get("x-tenant-token")
        if tenant_token:
            tenant_account = self._auth_tenant(tenant_token)
        else:
            user_id = self._auth_user()
        if not user_id and not tenant_account:
            return self._send(401, {"error": "missing or invalid session"})

        with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""select id, user_id, tenant_account_id, upstream_order_id, status
                             from orders where id=%s""", (order_id,))
            o = cur.fetchone()
        if not o:
            return self._send(404, {"error": "order not found"})
        if (user_id and o["user_id"] != user_id) or (tenant_account and o["tenant_account_id"] != tenant_account):
            return self._send(403, {"error": "forbidden"})
        if o["status"] in ("refunded", "cancelled"):
            return self._send(200, {"order_id": order_id, "status": o["status"], "already": True})
        if o["upstream_order_id"]:
            try:
                _SMS_CLIENT.cancel_order(o["upstream_order_id"])
            except smspin_api.SmspinError:
                pass
        return self._send(200, _svc("refund_order", {"p_order_id": order_id, "p_reason": "user_cancel"}))

    # ---------- public API (user-generated keys) ----------
    def _api_user(self):
        """Authenticate a caller via their own x-api-key; returns user uuid or None."""
        key = self.headers.get("x-api-key") or ""
        if not key:
            a = self.headers.get("Authorization", "")
            if a.startswith("Bearer sk_"):
                key = a[7:]
        if not key:
            return None
        h = hashlib.sha256(key.encode()).hexdigest()
        with db() as conn, conn.cursor() as cur:
            cur.execute("select resolve_api_key(%s)", (h,))
            row = cur.fetchone()
        uid = row[0] if row else None
        if uid:
            with db() as conn:
                with conn.cursor() as cur:
                    cur.execute("update api_keys set last_used_at=now() where key_hash=%s", (h,))
        return uid

    def api_v1(self, path):
        uid = self._api_user()
        if not uid:
            return self._send(401, {"error": "invalid or missing API key"})
        q = parse_qs(urlparse(self.path).query)
        one = lambda k, d=None: (q.get(k, [d])[0] if q.get(k) else d)

        if path == "/api/v1/balance":
            return self._send(200, self._rpc_svc("api_balance", {"p_user": uid}))
        if path == "/api/v1/catalog" or path == "/api/v1/services":
            return self._send(200, self._rpc_svc("api_catalog",
                             {"p_user": uid, "p_country": one("country"), "p_service": one("service")}))
        if path == "/api/v1/order" and self.command == "GET":
            oid = one("id") or one("order_id")
            if not oid:
                return self._send(400, {"error": "id required"})
            return self._send(200, self._rpc_svc("api_order", {"p_user": uid, "p_order_id": int(oid)}))
        if path == "/api/v1/order" and self.command == "POST":
            body = self._read_json()
            cc, sv = body.get("country"), body.get("service")
            if not cc or not sv:
                return self._send(400, {"error": "country and service required"})
            if upstream_enabled():
                try:
                    return self._send(200, buy_real(cc.lower(), sv, user_id=uid,
                                                    operator=body.get("operator")))
                except RuntimeError as e:
                    return self._send(402, {"error": str(e)})
            try:
                return self._send(200, self._rpc_svc("api_buy",
                                 {"p_user": uid, "p_country": cc, "p_service": sv}))
            except Exception as e:
                return self._send(402, {"error": str(e).split("\n")[0]})
        return self._send(404, {"error": "unknown endpoint"})

    def _rpc_svc(self, fn, params):
        with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"select {fn}(%s) as r" if len(params) == 1 else
                        f"select {fn}(%s,%s) as r" if len(params) == 2 else
                        f"select {fn}(%s,%s,%s) as r", tuple(params.values()))
            return cur.fetchone()["r"]

    def _credit_payment(self, ref, amount, channel, provider_ref):
        """Credit a payment to the tenant wallet when it belongs to a tenant, else the user wallet."""
        with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("select tenant_account_id from payments where reference=%s", (ref,))
            row = cur.fetchone()
        with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            if row and row["tenant_account_id"]:
                cur.execute("select tenant_credit_wallet_from_payment(%s,%s,%s,%s) as r",
                            (ref, amount, channel, provider_ref))
            else:
                cur.execute("select credit_wallet_from_payment(%s,%s,%s,%s) as r",
                            (ref, amount, channel, provider_ref))
            return cur.fetchone()["r"]

    def api_payments_initialize(self):
        body = self._read_json()
        amount = body.get("amount")
        if not amount or float(amount) <= 0:
            return self._send(400, {"error": "invalid amount"})

        # Tenant (white-label store) payments carry an opaque tenant session token
        # instead of a Supabase bearer token, so the SAME email can fund each tenant.
        tenant_token = body.get("tenant_token") or self.headers.get("x-tenant-token")
        if tenant_token:
            st, me = supabase_rpc("tenant_me", {"p_token": tenant_token})
            if st != 200 or not me:
                return self._send(401, {"error": "invalid tenant session"})
            st, pay = supabase_rpc("tenant_create_payment",
                                   {"p_token": tenant_token, "p_amount": float(amount)})
            if st != 200:
                return self._send(400, {"error": "could not create payment", "detail": pay})
            reference = pay["reference"]
            cc, cur, _ = geo_from_ip(self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0])
            cc = (body.get("country") or cc or "NG").upper()
            cur = (body.get("currency") or cur or "NGN").upper()
            try:
                q = pricing.quote(float(amount), cc, cur)
                with db() as conn, conn.cursor() as cur2:
                    cur2.execute("select set_payment_fee(%s,%s,%s)",
                                 (reference, q["fee_ngn"], json.dumps({"ppp": q["ppp_factor"], "usd_ngn": q["usd_ngn"], "country": cc, "currency": cur})))
            except Exception:
                pass
            email = me.get("email") or ""
            if not _valid_pay_email(email):
                email = f"tenant-{me.get('account_id','anon')}@smspin.io"
            name = me.get("full_name") or "SMSPin Customer"
            slug = me.get("tenant_slug") or ""
            host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or f"localhost:{PORT}"
            proto = "https" if self.headers.get("X-Forwarded-Proto") == "https" else "http"
            redirect_url = f"{proto}://{host}/store/{slug}/?ref={reference}"
            notify_url = f"{proto}://{host}/api/korapay/webhook"
            st, init = korapay_init(reference, amount, email, name, redirect_url, notify_url)
            if st != 200 or not init.get("status"):
                return self._send(502, {"error": "korapay init failed", "detail": init})
            checkout_url = init["data"]["checkout_url"]
            with db() as conn, conn.cursor() as cur:
                cur.execute("select tenant_set_payment_checkout(%s,%s,%s)",
                            (reference, checkout_url, init["data"].get("reference")))
            return self._send(200, {"reference": reference, "checkout_url": checkout_url,
                                    "public_key": KORA_PUBLIC, "mode": KORA_MODE})

        token = self._bearer()
        if not token:
            return self._send(401, {"error": "missing bearer token"})

        st, prof = supabase_rpc("my_profile", {}, token=token)
        if st != 200:
            return self._send(401, {"error": "invalid session"})
        email = prof.get("email") or ""
        # KoraPay rejects reserved TLDs (e.g. .local/.test); fall back to a valid address.
        if not _valid_pay_email(email):
            email = f"user-{prof.get('id','anon')}@smspin.io"
        name = prof.get("full_name") or "SMSPin User"

        st, pay = supabase_rpc("create_payment", {"p_amount": float(amount)}, token=token)
        if st != 200:
            return self._send(400, {"error": "could not create payment", "detail": pay})
        reference = pay["reference"]
        cc, cur, _ = geo_from_ip(self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0])
        cc = (body.get("country") or cc or "NG").upper()
        cur = (body.get("currency") or cur or "NGN").upper()
        try:
            q = pricing.quote(float(amount), cc, cur)
            with db() as conn, conn.cursor() as cur2:
                cur2.execute("select set_payment_fee(%s,%s,%s)",
                             (reference, q["fee_ngn"], json.dumps({"ppp": q["ppp_factor"], "usd_ngn": q["usd_ngn"], "country": cc, "currency": cur})))
        except Exception:
            pass

        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or f"localhost:{PORT}"
        proto = "https" if self.headers.get("X-Forwarded-Proto") == "https" else "http"
        redirect_url = f"{proto}://{host}/dashboard/wallet/?ref={reference}"
        notify_url = f"{proto}://{host}/api/korapay/webhook"

        st, init = korapay_init(reference, amount, email, name, redirect_url, notify_url)
        if st != 200 or not init.get("status"):
            return self._send(502, {"error": "korapay init failed", "detail": init})
        checkout_url = init["data"]["checkout_url"]

        with db() as conn:
            with conn.cursor() as cur:
                cur.execute("select set_payment_checkout(%s,%s,%s)",
                            (reference, checkout_url, init["data"].get("reference")))
        return self._send(200, {"reference": reference, "checkout_url": checkout_url,
                                "public_key": KORA_PUBLIC, "mode": KORA_MODE})

    def api_webhook(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        sig = self.headers.get("x-korapay-signature", "")
        expected = hmac.new(KORA_SECRET.encode(), raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return self._send(401, {"error": "invalid signature"})
        evt = json.loads(raw or b"{}")
        data = evt.get("data") or {}
        if evt.get("event") == "charge.success" and data.get("status") == "success":
            res = self._credit_payment(data.get("reference"), data.get("amount"),
                                       data.get("channel"), data.get("transaction_reference"))
            return self._send(200, {"received": True, "credit": res})
        return self._send(200, {"received": True, "ignored": evt.get("event")})


if __name__ == "__main__":
    print(f"SMSPin backend on :{PORT}  (korapay mode={KORA_MODE}, site={SITE_DIR})", flush=True)

    def _warm_pricing():
        try:
            pricing.usd_ngn()
            pricing.ppp_factor("NG")
            pricing.quote(1000, "NG", "NGN")
            print("pricing: live FX + PPP warmed", flush=True)
        except Exception as e:
            print("pricing warm failed:", e, flush=True)

    threading.Thread(target=_warm_pricing, daemon=True).start()

    def _poller():
        time.sleep(15)
        warm_popular()
        while True:
            try:
                poll_pending_orders()
            except Exception as e:
                print("poll error:", e, flush=True)
            time.sleep(10)

    threading.Thread(target=_poller, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
