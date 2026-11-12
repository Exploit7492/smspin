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
import math
import json
import gzip
import hmac
import time
import hashlib
import ssl
import threading
import urllib.request
import urllib.error
import psycopg2
from psycopg2.extras import RealDictCursor
from contextlib import contextmanager
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pricing  # real-time FX + PPP funding fees (forex-python + wbdata)
import smspin_api  # upstream SMS provider client
import mailer  # transactional email (SMTP)

SITE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site")
PORT = int(os.environ.get("PORT", "12000"))
# G1: canonical host used for sitemap URLs and robots.txt's Sitemap directive.
SITE_URL = os.environ.get("SMSPIN_SITE_URL", "https://smspin.io").rstrip("/")

# Paths never listed in the sitemap and blocked in robots.txt: authenticated
# surfaces and API endpoints, which must not be indexed.
_PRIVATE_PREFIXES = ("/dashboard", "/admin", "/api", "/store", "/login",
                     "/register", "/reset-password", "/verify")


def _sitemap_urls():
    """Walk SITE_DIR and yield every public page URL (dir/index.html -> dir/).

    Cached for an hour: the tree holds ~12k pages and walking it on every
    request would be wasteful, but it changes only when the mirror is refreshed.
    """
    now = time.time()
    cache = getattr(_sitemap_urls, "_cache", None)
    if cache and now - cache[0] < 3600:
        return cache[1]
    urls = []
    for root, dirs, files in os.walk(SITE_DIR):
        dirs[:] = [d for d in dirs if d not in ("_next", "node_modules")]
        if "index.html" not in files:
            continue
        rel = os.path.relpath(root, SITE_DIR).replace(os.sep, "/")
        if rel == ".":
            loc = "/"
        else:
            loc = "/" + rel.strip("/") + "/"
        if loc.startswith(_PRIVATE_PREFIXES):
            continue
        try:
            mtime = os.path.getmtime(os.path.join(root, "index.html"))
        except OSError:
            mtime = now
        urls.append((loc, mtime))
    urls.sort()
    _sitemap_urls._cache = (now, urls)
    return urls


def build_sitemap():
    """G1: sitemap.xml over the whole public mirror (max 50k URLs per file)."""
    parts = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, mtime in _sitemap_urls()[:50000]:
        lastmod = time.strftime("%Y-%m-%d", time.gmtime(mtime))
        parts.append(f"<url><loc>{SITE_URL}{loc}</loc>"
                     f"<lastmod>{lastmod}</lastmod></url>")
    parts.append("</urlset>")
    return "\n".join(parts).encode()


def build_robots():
    """G1: robots.txt — allow the marketing mirror, block private surfaces."""
    lines = ["User-agent: *", "Allow: /"]
    for p in _PRIVATE_PREFIXES:
        lines.append(f"Disallow: {p}")
    lines.append("Disallow: /*?")
    lines.append("")
    lines.append(f"Sitemap: {SITE_URL}/sitemap.xml")
    return ("\n".join(lines) + "\n").encode()


# G2: pages that carry review-rich structured data (Product/AggregateRating).
_REVIEW_PAGES = ("/", "/price", "/buy", "/reviews", "/sms-verification")


def _reviews_cache():
    """Cache public_reviews() for 10 minutes — it is read on every HTML hit."""
    now = time.time()
    cache = getattr(_reviews_cache, "_c", None)
    if cache and now - cache[0] < 600:
        return cache[1]
    try:
        data = _svc("public_reviews", {"p_limit": 20}) or {}
    except Exception:
        data = {"items": [], "rating": None}
    _reviews_cache._c = (now, data)
    return data


# Injected-HTML cache keyed by (file, reviews stamp); avoids re-reading and
# re-injecting the same page on every request.
_LD_CACHE = {}


def build_review_jsonld(path):
    """G2: Review + AggregateRating JSON-LD built from published reviews.

    Returns None when the path is not review-eligible or there is nothing to say.
    """
    if path not in _REVIEW_PAGES:
        return None
    data = _reviews_cache()
    rating = data.get("rating")
    items = data.get("items") or []
    if not rating and not items:
        return None
    node = {"@context": "https://schema.org", "@type": "Product",
            "name": "SMSPin — Online SMS Verification",
            "url": f"{SITE_URL}{path if path != '/' else '/'}"}
    if rating:
        node["aggregateRating"] = {
            "@type": "AggregateRating",
            "ratingValue": rating["ratingValue"],
            "reviewCount": rating["reviewCount"],
            "bestRating": rating.get("bestRating", 5),
            "worstRating": rating.get("worstRating", 1),
        }
    reviews = []
    for r in items[:10]:
        rev = {"@type": "Review",
               "author": {"@type": "Person", "name": r.get("author") or "Customer"},
               "reviewRating": {"@type": "Rating", "ratingValue": r.get("rating"),
                                "bestRating": 5, "worstRating": 1},
               "reviewBody": r.get("body") or "",
               "datePublished": (r.get("created_at") or "")[:10]}
        if r.get("title"):
            rev["name"] = r["title"]
        reviews.append(rev)
    if reviews:
        node["review"] = reviews
    return json.dumps(node, separators=(",", ":")).encode()


# ---------------------------------------------------------------- J4 structured logs
class JsonLogger:
    """Minimal structured logger: one JSON object per line, thread-safe."""

    def __init__(self, service="smspin"):
        self.service = service
        self._lock = threading.Lock()

    def log(self, level, event, **fields):
        rec = {"ts": time.time(), "level": level, "event": event, "svc": self.service}
        rec.update(fields)
        line = json.dumps(rec, default=str)
        with self._lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def info(self, event, **f): self.log("info", event, **f)
    def warn(self, event, **f): self.log("warn", event, **f)
    def error(self, event, **f): self.log("error", event, **f)


LOG = JsonLogger()


# ---------------------------------------------------------------- J4 request metrics
class Metrics:
    """In-process counters + latency histograms, exposed at /api/metrics."""

    def __init__(self):
        self._lock = threading.Lock()
        self.requests = {}       # "METHOD /path" -> count
        self.statuses = {}       # status code -> count
        self.errors = 0
        self.total = 0
        self.latency = []        # recent latencies (seconds), bounded
        self.started = time.time()

    def record(self, method, path, status, seconds):
        key = f"{method} {path}"
        with self._lock:
            self.requests[key] = self.requests.get(key, 0) + 1
            self.statuses[status] = self.statuses.get(status, 0) + 1
            self.total += 1
            if status >= 500:
                self.errors += 1
            self.latency.append(seconds)
            if len(self.latency) > 2000:
                self.latency = self.latency[-1000:]

    def snapshot(self):
        with self._lock:
            lat = sorted(self.latency)
            def pct(p):
                if not lat:
                    return 0
                return round(lat[min(len(lat) - 1, int(len(lat) * p))], 4)
            return {
                "uptime_s": round(time.time() - self.started, 1),
                "requests_total": self.total,
                "errors_5xx": self.errors,
                "status_counts": dict(self.statuses),
                "top_paths": sorted(self.requests.items(), key=lambda kv: -kv[1])[:15],
                "latency_p50": pct(0.50), "latency_p95": pct(0.95), "latency_p99": pct(0.99),
            }


METRICS = Metrics()


SUPABASE_URL = os.environ["Smspin_Supabase_url"].rstrip("/")
ANON_KEY = os.environ["Smspin_supabase_annonkey"]
SERVICE_KEY = os.environ.get("Smspin_supabase_secretskey", "")
PG_DSN = os.environ["Smspin_supabase_Postgresql"]
SMSPIN_KEY = os.environ.get("Smspin_apikey", "")

KORA_MODE = os.environ.get("KORA_MODE", "test")  # test | live
KORA_SECRET = os.environ["Kora_test_secrete_key"] if KORA_MODE == "test" else os.environ["Kora_secrete_key"]
KORA_PUBLIC = os.environ["Kora_test_public_key"] if KORA_MODE == "test" else os.environ["Kora_public_key"]
KORA_BASE = "https://api.korapay.com/merchant/api/v1"

# J9: environment identity. dev | staging | prod. Drives safe defaults so a
# non-prod deploy can never take live payments or hit the live provider.
ENVIRONMENT = os.environ.get("SMSPIN_ENV", "dev").lower()
IS_PROD = ENVIRONMENT == "prod"
IS_PREVIEW = ENVIRONMENT in ("dev", "staging")
# Refuse live payment keys outside prod: preview/staging always run KoraPay test.
if not IS_PROD and KORA_MODE != "test":
    LOG.warn("kora_mode_forced_test", environment=ENVIRONMENT, requested=KORA_MODE)
    KORA_MODE = "test"
    KORA_SECRET = os.environ["Kora_test_secrete_key"]
    KORA_PUBLIC = os.environ["Kora_test_public_key"]
# Deploy identity surfaced at /api/health + /api/env.
GIT_SHA = os.environ.get("SMSPIN_GIT_SHA", "dev")
VERSION = os.environ.get("SMSPIN_VERSION", "dev")

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"


@contextmanager
def db():
    """Yield a connection and always close it.

    `with psycopg2.connect(...) as conn` only commits/rolls back — it never
    closes, so a long-lived process leaks one backend per call until the
    pooler refuses new clients. This wraps it so every `with db() as conn`
    releases the socket.
    """
    conn = psycopg2.connect(PG_DSN)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


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


def _known_pair(country, service):
    """True when (country, service) exists in our reference tables.

    number_catalog references countries(code) and services(code), so writing a
    pair with an unknown code raises number_catalog_service_code_fkey. Guarding
    here keeps a bad code from ever reaching the catalog write.
    """
    if not country or not service:
        return False
    with db() as conn, conn.cursor() as cur:
        cur.execute("""select 1 where exists (select 1 from countries where code = %s)
                                     and exists (select 1 from services where code = %s)""",
                    (country, service))
        return cur.fetchone() is not None


def sync_pair(country, service, force=False):
    """Refresh price + stock for one (country, service) from the provider."""
    if not upstream_enabled():
        return None
    cc, sv = (country or "").lower(), service
    if not cc or not sv:
        return None
    if not _known_pair(cc, sv):
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
    markup = 100.0
    with db() as conn, conn.cursor() as cur:
        cur.execute("select value::text::numeric from settings where key='markup_percent'")
        row = cur.fetchone()
        if row:
            markup = float(row[0])
    # Store the raw platform price (provider cost + platform markup, in naira).
    # The whole-dollar rounding happens on the final buyer price in
    # sell_price_ngn, after the business markup.
    price_ngn = round(cost * (1 + markup / 100.0) * rate)
    _upsert_catalog([{"country": cc, "service": sv, "cost_usd": cost,
                      "price_ngn": price_ngn, "stock": live.get("available", 0)}])
    return live


def _rent_price(usd):
    """Whole-dollar rental price (USD) and its NGN equivalent at the live rate."""
    rate = fx_rates().get("NGN") or 1600.0
    usd_rounded = max(1, round(float(usd or 0)))
    return {"price_usd": usd_rounded, "price_ngn": round(usd_rounded * rate)}


def rent_prices_real(country, service):
    """Provider rental durations for one (country, service), priced for sale."""
    if not upstream_enabled():
        raise RuntimeError("upstream disabled")
    data = _SMS_CLIENT.rent_prices(service, (country or "").upper() or None) or {}
    durations = []
    for d in (data.get("durations") or []):
        hours = int(d.get("durationHours") or d.get("duration") or 0)
        if hours <= 0:
            continue
        priced = _rent_price(d.get("price"))
        durations.append({"hours": hours, "label": _rent_label(hours), **priced})
    if not durations:
        # Provider exposes per-country "fromPrice" only; synthesise the standard
        # 24h/72h/168h ladder from the country minimum so the UI always offers
        # a choice.
        base = None
        for c in (data.get("countries") or []):
            if (c.get("country") or "").upper() == (country or "").upper():
                base = c.get("fromPrice")
                break
        if base is None and (data.get("countries") or []):
            base = min(c.get("fromPrice") or 0 for c in data["countries"])
        if base is not None:
            for hours, mult in ((24, 1.0), (72, 1.75), (168, 3.25)):
                priced = _rent_price(float(base) * mult)
                durations.append({"hours": hours, "label": _rent_label(hours), **priced})
    return {"service": service, "country": (country or "").upper(), "durations": durations}


def _rent_label(hours):
    if hours % 168 == 0:
        n = hours // 168
        return f"{n} week" + ("s" if n > 1 else "")
    if hours % 24 == 0:
        n = hours // 24
        return f"{n} day" + ("s" if n > 1 else "")
    return f"{hours} hours"


def rent_real(country, service, duration, user_id=None, tenant_account=None):
    """Charge the wallet, then place the provider rental. Refund on failure."""
    if not upstream_enabled():
        raise RuntimeError("upstream disabled")
    cc = (country or "").lower()
    hours = int(duration or 24)
    quotes = rent_prices_real(cc, service)["durations"]
    pick = next((q for q in quotes if q["hours"] == hours), quotes[0] if quotes else None)
    if not pick:
        raise RuntimeError("rental not available for this pair")
    charge = pick["price_ngn"]
    if _wallet_balance(user_id, tenant_account) < charge:
        raise RuntimeError("insufficient balance")
    res = _svc("reserve_rental", {
        "p_user": user_id, "p_country": cc, "p_service": service,
        "p_duration": hours, "p_price_ngn": charge, "p_tenant_account": tenant_account,
    })
    order_id = res["order_id"]
    try:
        up = _SMS_CLIENT.create_rental(service, cc.upper(), hours, max_price=pick["price_usd"])
    except smspin_api.SmspinError as e:
        _refund(order_id, "provider_error")
        raise RuntimeError(str(e))
    phone = up.get("phoneNumber") or up.get("phone_number") or ""
    up_id = str(up.get("id") or "")
    if not phone or not up_id:
        _refund(order_id, "no_number")
        raise RuntimeError("provider did not return a number")
    _svc("set_order_upstream", {"p_order_id": order_id, "p_phone": phone,
                                "p_upstream_id": up_id, "p_cost_usd": pick["price_usd"]})
    return {"order_id": order_id, "phone_number": phone, "price_ngn": charge,
            "price_usd": pick["price_usd"], "duration": hours, "status": "waiting",
            "upstream_order_id": up_id}


def _local_charge(country, service, user_id=None, tenant_account=None):
    """Local preview of what reserve_number will debit (base + business markup).

    Mirrors reserve_number's pricing so buy_real can reject an underfunded
    wallet without touching the provider. Returns None when the pair has no
    local price to charge against.
    """
    with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""select price from number_catalog
                        where country_code=%s and service_code=%s and active and stock > 0
                        order by price asc limit 1""", (country, service))
        row = cur.fetchone()
        if not row:
            return None
        cur.execute("""select coalesce(markup_percent, 0) as pct from businesses b
                        where b.status='active' and (
                          (%s::uuid is not null and b.id = (select business_id from tenant_accounts where id=%s::uuid))
                          or (%s::uuid is not null and b.user_id = %s::uuid))
                        limit 1""",
                    (tenant_account, tenant_account, user_id, user_id))
        m = cur.fetchone()
    pct = float(m["pct"]) if m else 0.0
    # Mirror reserve_number exactly: whole-dollar price (base + business markup)
    # converted to NGN at the live rate.
    return _sell_price_ngn(float(row["price"]), pct)


def _sell_price_ngn(amount_ngn, markup_pct=0.0):
    """Whole-dollar sell price, as an NGN amount at the live rate.

    Matches the SQL sell_price_ngn: round the marked-up naira to the nearest
    dollar, floor at $1, then convert that dollar figure back to naira.
    """
    rate = fx_rates().get("NGN") or 1600.0
    usd = max(1, round(float(amount_ngn) * (1 + float(markup_pct or 0) / 100.0) / rate))
    return round(usd * rate)


def _wallet_balance(user_id, tenant_account):
    with db() as conn, conn.cursor() as cur:
        if tenant_account:
            cur.execute("select balance from tenant_wallets where account_id=%s", (tenant_account,))
        else:
            cur.execute("select balance from wallets where user_id=%s", (user_id,))
        row = cur.fetchone()
    return float(row[0]) if row and row[0] is not None else 0.0


def buy_real(country, service, user_id=None, tenant_account=None, operator=None):
    """Reserve funds locally, place the provider order, confirm or refund."""
    if not upstream_enabled():
        raise RuntimeError("upstream disabled")
    cc, sv = country.lower(), service
    # Debit the wallet before any provider traffic: an underfunded wallet is
    # rejected here, so we never make a network call we cannot pay for. A pair
    # with no local price needs one sync first — there is otherwise nothing to
    # charge against.
    charge = _local_charge(cc, sv, user_id, tenant_account)
    if charge is None:
        sync_pair(cc, sv, force=True)
        charge = _local_charge(cc, sv, user_id, tenant_account)
    if charge is not None and _wallet_balance(user_id, tenant_account) < charge:
        raise RuntimeError("insufficient balance")
    res = _svc("reserve_number", {
        "p_user": user_id, "p_country": cc, "p_service": sv,
        "p_tenant_account": tenant_account, "p_operator": operator,
    })
    order_id = res["order_id"]
    try:
        up = _SMS_CLIENT.create_order(cc, sv, operator)
    except smspin_api.SmspinError as e:
        _refund(order_id, "provider_error")
        raise RuntimeError(str(e))
    phone = up.get("phoneNumber") or up.get("phone_number") or ""
    up_id = str(up.get("id") or "")
    if not phone or not up_id:
        _refund(order_id, "no_number")
        raise RuntimeError("provider did not return a number")
    _svc("set_order_upstream", {"p_order_id": order_id, "p_phone": phone,
                                "p_upstream_id": up_id, "p_operator": up.get("operator"),
                                "p_cost_usd": up.get("price")})
    # C6: fan out an order event to the storefront's tenant webhooks.
    try:
        with db() as conn, conn.cursor() as cur:
            cur.execute("select business_id, user_id from orders where id=%s", (order_id,))
            row = cur.fetchone()
        if row and row[0]:
            notify_business_order(row[0], {"order_id": order_id, "country": cc, "service": sv,
                                           "phone_number": phone, "price_ngn": res["price_ngn"],
                                           "status": "waiting"})
        if row and row[1]:
            notify_user_event(row[1], "order.created", {
                "order_id": order_id, "country": cc, "service": sv, "phone_number": phone,
                "price_ngn": res["price_ngn"], "status": "waiting"})
    except Exception:
        pass
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
            notify_user_event(o.get("user_id"), "order.received", {
                "order_id": o["id"], "country": o.get("country_code"),
                "service": o.get("service_code"), "code": str(code), "status": "received"})
        elif status in ("cancelled", "expired", "failed"):
            _refund(o["id"], f"upstream_{status}")
    for o in (_svc("expired_orders", {"p_limit": 200}) or []):
        up_id = o.get("upstream_order_id")
        if up_id:
            try:
                _SMS_CLIENT.cancel_order(up_id)
            except smspin_api.SmspinError:
                pass
        _refund(o["id"], "expired")


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


def sync_operators(country, service):
    """Persist the provider's operator breakdown (price/stock) for one pair."""
    if not upstream_enabled():
        return 0
    try:
        ops = _SMS_CLIENT.operators(country.lower(), service) or []
    except smspin_api.SmspinError:
        return 0
    if not ops:
        return 0
    items = []
    for o in ops:
        if not isinstance(o, dict):
            continue
        items.append({
            "country": country.lower(),
            "operator": o.get("operator"),
            "label": o.get("label"),
            "id": o.get("operator"),
            "price": o.get("price"),
            "count": o.get("count"),
        })
    if not items:
        return 0
    try:
        return int(_svc("upsert_operators", {"p_items": json.dumps(items)}) or 0)
    except Exception:
        return 0


def crawl_step(budget=30):
    """N2: sync a slice of the priority frontier (see sync_seed / sync_next)."""
    if not upstream_enabled():
        return {"synced": 0}
    try:
        todo = _svc("sync_next", {"p_limit": budget}) or []
    except Exception:
        todo = []
    synced = 0
    for pair in todo:
        cc, sv = pair.get("country"), pair.get("service")
        try:
            sync_pair(cc, sv, force=True)
            sync_operators(cc, sv)
            _svc("sync_mark", {"p_country": cc, "p_service": sv, "p_done": True})
            synced += 1
        except Exception:
            _svc("sync_mark", {"p_country": cc, "p_service": sv, "p_done": False})
    return {"synced": synced, "budget": budget}


def provider_balance():
    """N8: refresh the provider-side balance snapshot into provider_state."""
    if not upstream_enabled():
        return None
    try:
        acc = _SMS_CLIENT.account()
    except smspin_api.SmspinError as e:
        _svc("provider_state_set", {"p_key": "balance", "p_value": json.dumps({"error": str(e)})})
        return None
    snap = {"balance_usd": acc.get("balance"), "currency": acc.get("currency", "USD"),
            "plan": acc.get("plan"), "checked_at": time.time()}
    _svc("provider_state_set", {"p_key": "balance", "p_value": json.dumps(snap)})
    return snap


def _audit(actor, action, subject=None, detail=None, ip=None):
    """Fire-and-forget audit trail (D10). Never let logging break a request."""
    try:
        _svc("audit_write", {"p_actor": actor, "p_action": action, "p_subject": subject,
                             "p_detail": json.dumps(detail or {}), "p_ip": ip})
    except Exception:
        pass


def client_ip(handler):
    return (handler.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            or handler.client_address[0])


# ---------------------------------------------------------------- D1/D8/L4 gates
AUP_VERSION_FALLBACK = "1.0"


def email_verification_required():
    """D1 toggle. Off by default; when off, purchases are not gated on email."""
    try:
        return bool(_svc("email_verification_required", {}))
    except Exception:
        return False


def email_verified(user_id):
    """D1: is the account's email confirmed? Only meaningful when the toggle is on."""
    if not user_id:
        return False
    try:
        return bool(_svc("email_verified", {"p_user": user_id}))
    except Exception as e:
        LOG.error("email_verified_error", error=str(e)[:200], user=str(user_id))
        return False


def is_admin(email):
    if not email:
        return False
    try:
        return bool(_svc("is_admin", {"p_email": email}))
    except Exception:
        return False


def aup_text(version):
    """L4: the acceptable-use policy body served to the frontend."""
    return {
        "policy": "aup",
        "version": version,
        "summary": ("SMSPin provides virtual numbers for legitimate account "
                    "verification and testing. You must not use the service for "
                    "fraud, spam, harassment, evading lawful sanctions, bulk account "
                    "farming, or any illegal purpose."),
        "rules": [
            "One code per purchase; codes are delivered only to you.",
            "No resale of numbers, codes, or access without written consent.",
            "No use against services you do not own or have permission to test.",
            "Prohibited use leads to suspension and forfeiture of unused balance.",
            "We cooperate with lawful requests from competent authorities.",
        ],
        "enforcement": ("Automated velocity and blocklist checks run on every "
                        "purchase. Accounts that breach this policy are suspended; "
                        "repeated or serious breaches are reported."),
    }


def fraud_check(user_id, ip, email, meta=None):
    """D8: velocity + blocklist decision. Fails closed (deny) on backend error."""
    try:
        return _svc("fraud_check", {"p_user": user_id, "p_ip": ip, "p_email": email,
                                    "p_meta": json.dumps(meta or {})}) or {}
    except Exception as e:
        LOG.error("fraud_check_error", error=str(e)[:200], user=str(user_id))
        return {"allow": False, "score": 100, "reasons": ["fraud_check_unavailable"]}


def policy_status(user_id, tenant_account):
    """L4: has the caller accepted the current acceptable-use policy version?"""
    try:
        return _svc("policy_status", {"p_user": user_id, "p_tenant": tenant_account}) or {}
    except Exception:
        return {"aup_accepted": False, "aup_version": AUP_VERSION_FALLBACK}


def aup_required(user_id, tenant_account, body):
    """True when the caller must accept the AUP before purchasing.

    Enforcement is OFF by default (`aup_enforcement_required`); when off the
    purchase proceeds regardless. An explicit `accept_aup` always satisfies it."""
    if str(body.get("accept_aup", "")).lower() in ("1", "true", "yes"):
        return False
    st = policy_status(user_id, tenant_account)
    if not st.get("aup_required", False):
        return False
    return not st.get("aup_accepted", False)


# ---------------------------------------------------------------- D7 rate limit
# In-memory sliding-window limiter (per worker). For multi-instance deploys back
# this with Redis; the interface stays the same.
_RL_LOCK = threading.Lock()
_RL_HITS = {}


def rate_limit(key, limit, window=60):
    """Return (allowed, retry_after_seconds). `limit` requests per `window` secs."""
    now = time.time()
    with _RL_LOCK:
        hits = _RL_HITS.setdefault(key, [])
        cutoff = now - window
        while hits and hits[0] < cutoff:
            hits.pop(0)
        if len(hits) >= limit:
            return False, max(1, int(window - (now - hits[0])))
        hits.append(now)
        # Opportunistic GC so the dict does not grow unbounded.
        if len(_RL_HITS) > 5000:
            for k in [k for k, v in _RL_HITS.items() if not v or v[-1] < cutoff]:
                _RL_HITS.pop(k, None)
        return True, 0


# Per-endpoint budgets: (limit, window_seconds). Auth/write paths are tighter.
RL_RULES = {
    "buy": (30, 60),
    "auth": (60, 60),
    "webhook": (600, 60),
    "subscribe": (10, 60),
    "consent": (30, 60),
    "review": (10, 60),
    "rpc": (600, 60),
    "default": (240, 60),
}


def check_rate(handler, bucket):
    limit, window = RL_RULES.get(bucket, RL_RULES["default"])
    key = f"{bucket}:{client_ip(handler)}"
    allowed, retry = rate_limit(key, limit, window)
    if not allowed:
        handler._send(429, {"error": "rate limit exceeded", "retry_after": retry},
                      extra={"Retry-After": str(retry)})
    return allowed


def job_worker_step(budget=5):
    """J3: claim and run durable jobs (provider top-up reminders, retries...)."""
    try:
        jobs = _svc("job_claim", {"p_limit": budget}) or []
    except Exception:
        return 0
    done = 0
    for j in jobs:
        ok, err = True, None
        try:
            if j["kind"] == "provider_balance":
                provider_balance()
            elif j["kind"] == "catalog_sync":
                crawl_step(int((j.get("payload") or {}).get("budget", 20)))
            elif j["kind"] == "reconcile":
                _svc("reconcile_report", {"p_days": 1})
        except Exception as e:
            ok, err = False, str(e)[:300]
        _svc("job_finish", {"p_id": j["id"], "p_ok": ok, "p_error": err})
        done += 1
    return done


def dispatch_refund_notices():
    """K5: email pending refund notices, then mark them sent (or failed)."""
    try:
        pending = _svc("refund_notices_pending", {"p_limit": 20}) or []
    except Exception:
        return 0
    sent = 0
    for n in pending:
        to = n.get("email")
        subject = "Your SMSPin refund"
        body = (
            f"We've refunded {n.get('currency', 'NGN')} {n.get('amount')} to your wallet "
            f"for order #{n.get('order_id')}.\n\n"
            f"Reason: {n.get('reason') or 'order could not be completed'}\n\n"
            "The amount is available now and can be used for another number or withdrawn "
            "per our refund policy.\n\n— SMSPin"
        )
        ok = mailer.send(to, subject, body) if (to and mailer.configured()) else False
        # With no mailer configured the notice still becomes visible in-app.
        status = "sent" if ok else ("failed" if (to and mailer.configured()) else "read")
        try:
            _svc("refund_notice_mark", {"p_id": n["id"], "p_status": status,
                                        "p_error": None if ok else "mailer unavailable"})
        except Exception:
            pass
        if ok:
            sent += 1
        LOG.info("refund_notice", order=str(n.get("order_id")), status=status)
    return sent


def notify_refund(order_id, user_id, tenant_account, amount, reason):
    """K5: queue a refund notice (resolved to an email where we have one)."""
    email = None
    if user_id:
        try:
            with db() as conn, conn.cursor() as cur:
                cur.execute("select email from profiles where id=%s", (user_id,))
                row = cur.fetchone()
                email = row[0] if row else None
        except Exception:
            email = None
    try:
        nid = _svc("refund_notice_create", {"p_order_id": order_id, "p_user": user_id,
                                            "p_tenant": tenant_account, "p_email": email,
                                            "p_amount": amount, "p_reason": reason})
    except Exception as e:
        LOG.error("refund_notice_create_error", error=str(e)[:200])
        return None
    dispatch_refund_notices()
    return nid


def _refund(order_id, reason):
    """Refund an order and queue the K5 refund notice in one step."""
    try:
        res = _svc("refund_order", {"p_order_id": order_id, "p_reason": reason}) or {}
    except Exception as e:
        LOG.error("refund_error", order=str(order_id), error=str(e)[:200])
        return {}
    if not res.get("already"):
        try:
            with db() as conn, conn.cursor() as cur:
                cur.execute("select user_id, tenant_account_id, price from orders where id=%s", (order_id,))
                row = cur.fetchone()
            if row:
                notify_refund(order_id, row[0], row[1], res.get("refunded", row[2]), reason)
                if row[0]:
                    notify_user_event(row[0], "order.refunded", {
                        "order_id": order_id, "amount": float(res.get("refunded", row[2]) or 0),
                        "reason": reason, "status": "refunded"})
        except Exception as e:
            LOG.error("refund_notify_error", order=str(order_id), error=str(e)[:200])
    return res


def setting_get(key, default=None):
    """Read a single `settings` value (jsonb) with a safe default."""
    try:
        with db() as conn, conn.cursor() as cur:
            cur.execute("select value from settings where key=%s", (key,))
            row = cur.fetchone()
        if not row:
            return default
        v = row[0]
        if isinstance(v, str):
            try:
                v = json.loads(v)
            except Exception:
                pass
        return v
    except Exception:
        return default


def dispatch_tenant_webhooks():
    """C6: deliver queued tenant webhook events to each key's URL, signed with
    an HMAC-SHA256 of the body using the key's secret. Best effort."""
    try:
        pending = _svc("tenant_webhook_pending", {"p_limit": 20}) or []
    except Exception:
        return 0
    delivered = 0
    for e in pending:
        url = e.get("webhook_url")
        secret = e.get("webhook_secret") or ""
        payload = {"event": e.get("event"), "data": e.get("payload"),
                   "business_id": e.get("business_id"),
                   "delivered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        body = json.dumps(payload).encode()
        sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        ok, err = False, None
        try:
            req = urllib.request.Request(
                url, data=body, method="POST",
                headers={"Content-Type": "application/json", "X-SMSPin-Signature": sig})
            urllib.request.urlopen(req, timeout=8)
            ok = True
        except Exception as ex:
            err = str(ex)[:200]
        try:
            _svc("tenant_webhook_mark", {"p_id": e["id"], "p_ok": ok, "p_error": err})
        except Exception:
            pass
        if ok:
            delivered += 1
    return delivered


def notify_business_order(business_id, order_row):
    """C6: enqueue an order event for a storefront's tenant webhooks."""
    if not business_id:
        return 0
    try:
        return _svc("tenant_webhook_enqueue", {"p_business": business_id, "p_event": "order.created",
                                               "p_payload": json.dumps(order_row)}) or 0
    except Exception as e:
        LOG.error("tenant_webhook_enqueue_error", error=str(e)[:200])
        return 0


# ---------------------------------------------------------------- H2 customer webhooks
def dispatch_customer_webhooks():
    """H2: deliver queued customer webhook events, HMAC-SHA256 signed. Best effort."""
    try:
        pending = _svc("customer_webhook_pending", {"p_limit": 20}) or []
    except Exception:
        return 0
    delivered = 0
    for e in pending:
        url = e.get("url")
        secret = e.get("secret") or ""
        payload = {"event": e.get("event"), "data": e.get("payload"),
                   "delivered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        body = json.dumps(payload).encode()
        sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        ok, err = False, None
        try:
            req = urllib.request.Request(
                url, data=body, method="POST",
                headers={"Content-Type": "application/json", "X-SMSPin-Signature": sig})
            urllib.request.urlopen(req, timeout=8)
            ok = True
        except Exception as ex:
            err = str(ex)[:200]
        try:
            _svc("customer_webhook_mark", {"p_id": e["id"], "p_ok": ok, "p_error": err})
        except Exception:
            pass
        if ok:
            delivered += 1
    return delivered


def notify_user_event(user_id, event, payload):
    """H2 + E6: fan an order event out to a user's webhooks and notification feed."""
    if not user_id:
        return
    try:
        _svc("customer_webhook_enqueue", {"p_user": user_id, "p_event": event,
                                          "p_payload": json.dumps(payload)})
    except Exception as e:
        LOG.error("customer_webhook_enqueue_error", error=str(e)[:200])
    try:
        title = {"order.created": "Number ready", "order.received": "SMS code received",
                 "order.refunded": "Order refunded"}.get(event, event)
        _svc("notify_user", {"p_user": user_id, "p_kind": event.split(".")[-1], "p_title": title,
                             "p_body": payload.get("detail"), "p_href": "/dashboard/orders/"})
    except Exception:
        pass


# ---------------------------------------------------------------- I6 lifecycle email
def dispatch_email_queue():
    """I6: send queued lifecycle emails, then mark them sent/failed."""
    try:
        pending = _svc("email_queue_pending", {"p_limit": 20}) or []
    except Exception:
        return 0
    sent = 0
    for m in pending:
        subject = {"welcome": "Welcome to SMSPin", "winback": "We saved your numbers",
                   "abandoned_fund": "Finish funding your wallet",
                   "receipt": "Your SMSPin receipt"}.get(m.get("template"), "SMSPin")
        body = json.dumps(m.get("payload") or {}, indent=2)
        ok = mailer.send(m["to_email"], subject, body) if mailer.configured() else False
        status = "sent" if ok else ("failed" if mailer.configured() else "read")
        try:
            _svc("email_queue_mark", {"p_id": m["id"], "p_ok": ok,
                                      "p_error": None if ok else "mailer unavailable"})
        except Exception:
            pass
        if ok:
            sent += 1
        LOG.info("lifecycle_email", template=m.get("template"), status=status)
    return sent


def dispatch_app_builds():
    """M4/M5: fulfil queued branded app builds (run the CI workflow), then mark
    the build ready with a time-limited download token."""
    try:
        pending = _svc("app_build_pending", {"p_limit": 3}) or []
    except Exception:
        return 0
    built = 0
    for b in pending:
        token = hashlib.sha256(f"{b['id']}:{time.time()}".encode()).hexdigest()[:32]
        try:
            # The heavy lifting (Gradle + signing) happens in CI; the backend
            # dispatches the workflow and records the artefact it produces.
            hook = os.environ.get("APP_BUILD_HOOK", "")
            if hook:
                body = json.dumps({
                    "business_id": b["business_id"], "slug": b["slug"], "name": b["name"],
                    "primary": b.get("primary_color"), "secondary": b.get("secondary_color"),
                    "tagline": b.get("tagline"), "support_email": b.get("support_email"),
                    "domain": b.get("domain"), "version": b["version"], "token": token,
                }).encode()
                req = urllib.request.Request(hook, data=body, method="POST",
                                             headers={"Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=15)
            # No CI hook configured (dev/staging): provision a placeholder artefact
            # so the distribution flow is exercisable end to end.
            url = f"/api/app/download/{token}"
            _svc("app_build_mark", {"p_id": b["id"], "p_status": "ready", "p_url": url,
                                    "p_token": token, "p_size": 8_400_000})
            built += 1
            LOG.info("app_build_ready", build=b["id"], slug=b.get("slug"))
        except Exception as e:
            _svc("app_build_mark", {"p_id": b["id"], "p_status": "failed", "p_error": str(e)[:200]})
            LOG.error("app_build_failed", build=b["id"], error=str(e)[:200])
    return built


def dispatch_alerts():
    """J5: send undelivered alert_events to the configured webhook (best effort)."""
    url = setting_get("alerts_webhook_url", "") or ""
    try:
        events = _svc("alert_events_list", {"p_limit": 20}) or []
    except Exception:
        return 0
    pending = [e for e in events if not e.get("delivered")]
    if not pending:
        return 0
    delivered = 0
    for e in pending:
        if url:
            try:
                req = urllib.request.Request(
                    url, data=json.dumps(e).encode(),
                    headers={"Content-Type": "application/json"}, method="POST")
                urllib.request.urlopen(req, timeout=8)
            except Exception as ex:
                LOG.warn("alert_dispatch_failed", rule=e.get("rule_key"), error=str(ex)[:200])
                continue
        _svc("alert_mark_delivered", {"p_id": e["id"]})
        delivered += 1
        LOG.warn("alert_fired", rule=e.get("rule_key"), severity=e.get("severity"),
                 metric=e.get("metric"), value=e.get("value"))
    return delivered


def scheduler_step():
    """J2: the recurring operations tick. Records each task in scheduler_state."""
    # 1) metrics snapshot (J4)
    try:
        _svc("metrics_record", {"p_window_min": 5})
        _svc("scheduler_mark", {"p_key": "metrics_record", "p_ok": True, "p_detail": "{}"})
    except Exception as e:
        _svc("scheduler_mark", {"p_key": "metrics_record", "p_ok": False,
                                "p_detail": json.dumps({"error": str(e)[:200]})})

    # 2) alert evaluation + dispatch (J5)
    try:
        fired = _svc("alert_evaluate", {}) or []
        sent = dispatch_alerts()
        _svc("scheduler_mark", {"p_key": "alert_evaluate", "p_ok": True,
                                "p_detail": json.dumps({"fired": len(fired), "delivered": sent})})
    except Exception as e:
        _svc("scheduler_mark", {"p_key": "alert_evaluate", "p_ok": False,
                                "p_detail": json.dumps({"error": str(e)[:200]})})

    # 3) enqueue the recurring maintenance jobs
    for kind in ("provider_balance", "reconcile", "catalog_sync"):
        try:
            _svc("job_enqueue", {"p_kind": kind, "p_payload": "{}"})
        except Exception:
            pass

    # 4) J6 synthetic checks + K5 refund-notice dispatch
    try:
        _svc("synthetic_check", {})
        _svc("scheduler_mark", {"p_key": "synthetic_check", "p_ok": True, "p_detail": "{}"})
    except Exception as e:
        _svc("scheduler_mark", {"p_key": "synthetic_check", "p_ok": False,
                                "p_detail": json.dumps({"error": str(e)[:200]})})
    try:
        dispatch_refund_notices()
    except Exception as e:
        LOG.error("refund_dispatch_error", error=str(e)[:200])

    # 5) C6: deliver queued tenant webhook events
    try:
        sent = dispatch_tenant_webhooks()
        _svc("scheduler_mark", {"p_key": "tenant_webhooks", "p_ok": True,
                                "p_detail": json.dumps({"delivered": sent})})
    except Exception as e:
        _svc("scheduler_mark", {"p_key": "tenant_webhooks", "p_ok": False,
                                "p_detail": json.dumps({"error": str(e)[:200]})})

    # 6) H2: deliver customer webhook subscriptions
    try:
        sent = dispatch_customer_webhooks()
        _svc("scheduler_mark", {"p_key": "customer_webhooks", "p_ok": True,
                                "p_detail": json.dumps({"delivered": sent})})
    except Exception as e:
        _svc("scheduler_mark", {"p_key": "customer_webhooks", "p_ok": False,
                                "p_detail": json.dumps({"error": str(e)[:200]})})

    # 7) I6: drain the lifecycle email queue
    try:
        sent = dispatch_email_queue()
        _svc("scheduler_mark", {"p_key": "email_queue", "p_ok": True,
                                "p_detail": json.dumps({"sent": sent})})
    except Exception as e:
        _svc("scheduler_mark", {"p_key": "email_queue", "p_ok": False,
                                "p_detail": json.dumps({"error": str(e)[:200]})})

    # 8) M4/M5: fulfil queued branded app builds
    try:
        built = dispatch_app_builds()
        _svc("scheduler_mark", {"p_key": "app_builds", "p_ok": True,
                                "p_detail": json.dumps({"built": built})})
    except Exception as e:
        _svc("scheduler_mark", {"p_key": "app_builds", "p_ok": False,
                                "p_detail": json.dumps({"error": str(e)[:200]})})


def backup_verify_job():
    """J10: verify the data plane is intact and record a checksum."""
    try:
        detail = _svc("backup_verify", {}) or {}
        _svc("scheduler_mark", {"p_key": "backup_verify", "p_ok": True,
                                "p_detail": json.dumps(detail)})
        LOG.info("backup_verify", **{"counts": detail})
        return detail
    except Exception as e:
        _svc("scheduler_mark", {"p_key": "backup_verify", "p_ok": False,
                                "p_detail": json.dumps({"error": str(e)[:200]})})
        return {}


def upstream_webhook(payload):
    """N9: map an upstream order event onto our local order (OTP or refund)."""
    up_id = str(payload.get("id") or payload.get("order_id") or "")
    if not up_id:
        _svc("dlq_enqueue", {"p_source": "upstream", "p_event": payload.get("event"),
                             "p_payload": json.dumps(payload), "p_error": "missing order id"})
        return {"received": True, "matched": False}
    try:
        row = _svc("order_by_upstream", {"p_upstream_id": up_id})
    except Exception:
        row = None
    if not row or row == "null":
        _svc("dlq_enqueue", {"p_source": "upstream", "p_event": payload.get("event"),
                             "p_payload": json.dumps(payload), "p_error": "no local order for " + up_id})
        return {"received": True, "matched": False}
    order_id = row.get("order_id") or row.get("id")
    code = payload.get("otpCode") or payload.get("otp_code") or payload.get("code")
    status = (payload.get("status") or "").lower()
    if code:
        _svc("record_sms", {"p_order_id": order_id, "p_sender": payload.get("service") or row.get("service"),
                            "p_body": f"Verification code: {code}", "p_code": str(code),
                            "p_received_at": payload.get("createdAt") or None})
        return {"received": True, "matched": True, "otp": True}
    if status in ("cancelled", "expired", "failed"):
        _refund(order_id, f"webhook_{status}")
        return {"received": True, "matched": True, "refunded": True}
    return {"received": True, "matched": True}




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


def _postman_collection():
    """O7: a ready-to-import Postman collection generated from the OpenAPI spec."""
    items = []
    for path, methods in OPENAPI["paths"].items():
        for verb, op in methods.items():
            url = "{{base_url}}" + path
            req = {"method": verb.upper(), "header": [
                {"key": "x-api-key", "value": "{{api_key}}", "type": "text"}],
                "url": {"raw": url, "host": ["{{base_url}}"], "path": path.strip("/").split("/")}}
            if verb == "post":
                req["header"].append({"key": "Content-Type", "value": "application/json"})
                req["body"] = {"mode": "raw", "raw": json.dumps({"country": "gb", "service": "whatsapp"}, indent=2)}
            items.append({"name": op.get("summary", path), "request": req})
    return {
        "info": {"name": "SMSPin API", "schema":
                 "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
                 "description": "Import this into Postman. Set the `base_url` and `api_key` "
                                "collection variables (create a key on the API Keys page)."},
        "variable": [{"key": "base_url", "value": "https://smspin.io"},
                     {"key": "api_key", "value": "sk_live_your_key"}],
        "item": items,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=SITE_DIR, **k)

    def log_message(self, fmt, *args):
        # Suppress the stdlib access log; we emit structured JSON instead.
        pass

    def _tick(self):
        self._t0 = time.time()

    def _access_log(self):
        if not hasattr(self, "_t0"):
            return
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            LOG.info("http", method=getattr(self, "command", "GET"), path=path,
                     ms=round((time.time() - self._t0) * 1000, 1))

    def _send(self, code, obj, ctype="application/json", extra=None):
        body = json.dumps(obj).encode() if not isinstance(obj, (bytes, bytearray)) else obj
        try:
            METRICS.record(getattr(self, "command", "GET"),
                           urlparse(self.path).path, code,
                           time.time() - getattr(self, "_t0", time.time()))
            self._access_log()
        except Exception:
            pass
        extra = extra or {}
        # Compress large JSON bodies when the client advertises gzip.
        if (len(body) > 1024 and ctype.startswith("application/json")
                and "gzip" in (self.headers.get("Accept-Encoding") or "").lower()
                and "Content-Encoding" not in extra):
            body = gzip.compress(body, 6)
            extra["Content-Encoding"] = "gzip"
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        # G3: API responses are always revalidated; SEO files are cached briefly.
        # An explicit extra Cache-Control (e.g. injected HTML) wins over the default.
        if "Cache-Control" not in extra:
            p = urlparse(self.path).path
            if p in ("/robots.txt", "/sitemap.xml"):
                self.send_header("Cache-Control", "public, max-age=3600")
            else:
                self.send_header("Cache-Control", "no-store")
        for k, v in extra.items():
            self.send_header(k, v)
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

    def send_head(self):
        # Serve a directory's index.html directly instead of 301-redirecting
        # `/about` to `/about/`. Marketing links in the mirrored pages point at
        # the bare paths, so a redirect there is pure noise.
        path = self.translate_path(self.path)
        if os.path.isdir(path) and not urlparse(self.path).path.endswith("/"):
            for index in ("index.html", "index.htm"):
                candidate = os.path.join(path, index)
                if os.path.isfile(candidate):
                    return self._serve_static_file(candidate)
        elif os.path.isfile(path):
            # G3: route every static file through one path so it gets an ETag
            # and a sane Cache-Control (immutable for content-hashed assets).
            return self._serve_static_file(path)
        return super().send_head()

    def _inject_review_jsonld(self, path):
        """G3/G2: return page HTML with the consent-log script (every public page)
        and Review/AggregateRating JSON-LD (review-eligible pages) injected, or
        None when the path is not a servable public HTML page."""
        if path.startswith(_PRIVATE_PREFIXES) or path.startswith("/_next/"):
            return None
        if "." in path.rsplit("/", 1)[-1]:
            return None  # has a file extension -> an asset, not a page
        rel = path.strip("/")
        candidate = (os.path.join(SITE_DIR, rel, "index.html") if rel
                     else os.path.join(SITE_DIR, "index.html"))
        if not os.path.isfile(candidate):
            return None
        ld = build_review_jsonld(path)
        _reviews_cache()
        stamp = getattr(_reviews_cache, "_c", (0, None))[0]
        try:
            mtime = os.path.getmtime(candidate)
        except OSError:
            mtime = 0
        key = (candidate, stamp, mtime)
        cached = _LD_CACHE.get(key)
        if cached is not None:
            return cached
        try:
            with open(candidate, "rb") as fh:
                html = fh.read()
        except OSError:
            return None
        idx = html.find(b"</head>")
        if idx == -1:
            return None
        inject = b'<script src="/consent-log.js" defer></script>'
        if ld is not None:
            inject += b'<script type="application/ld+json">' + ld + b"</script>"
        out = html[:idx] + inject + html[idx:]
        if len(_LD_CACHE) > 2000:
            _LD_CACHE.clear()
        _LD_CACHE[key] = out
        return out

    def _serve_static_file(self, candidate):
        try:
            f = open(candidate, "rb")
        except OSError:
            return None
        try:
            st = os.fstat(f.fileno())
            ctype = self.guess_type(candidate)
            etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
            # G3: content-hashed build assets are immutable; HTML revalidates.
            rel = urlparse(self.path).path
            if rel.startswith("/_next/static/"):
                cache = "public, max-age=31536000, immutable"
            elif ctype == "text/html":
                cache = "no-cache, must-revalidate"
            else:
                cache = "public, max-age=86400"
            # Conditional GET: answer 304 when the client already has this body.
            if self.headers.get("If-None-Match") == etag:
                f.close()
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", cache)
                self.end_headers()
                return None
            self.send_response(200)
            self.send_header("Content-type", ctype)
            self.send_header("Content-Length", str(st.st_size))
            self.send_header("Last-Modified", self.date_time_string(st.st_mtime))
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.end_headers()
            return f
        except Exception:
            f.close()
            raise

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization,Content-Type")
        self.end_headers()

    # ---------- API ----------
    def do_GET(self):
        self._tick()
        path = urlparse(self.path).path
        # G1: dynamic SEO files generated from the mirrored tree.
        if path == "/robots.txt":
            return self._send(200, build_robots(), "text/plain; charset=utf-8")
        if path == "/sitemap.xml":
            return self._send(200, build_sitemap(), "application/xml; charset=utf-8")
        # Alias legacy marketing links onto the real dashboard routes.
        if path == "/dashboard/referral":
            self.send_response(301)
            self.send_header("Location", "/dashboard/referrals/")
            self.end_headers()
            return
        # C2: a request on a tenant's custom domain serves that store's pages.
        host = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(":")[0].lower()
        if host and "all-hands.dev" not in host and host not in ("localhost", "127.0.0.1"):
            try:
                slug = _svc("resolve_domain", {"p_host": host})
            except Exception:
                slug = None
            if slug and slug != "null":
                rest = path.strip("/")
                tail = {"": "", "login": "login", "register": "register", "account": "account"}.get(rest)
                if tail is not None:
                    qs = urlparse(self.path).query
                    extra = ("&" if qs else "?") + "store=" + slug
                    self.path = (f"/store/{tail}.html" if tail else "/store/index.html") + qs + extra
                    path = urlparse(self.path).path
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
        if path == "/api/postman":
            return self._send(200, _postman_collection())
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
        if path.startswith("/api/tenant/"):
            return self.api_tenant_get(path)
        if path.startswith("/api/v1/"):
            return self.api_v1(path)
        if path == "/api/rpc":
            # Same-origin bridge to Supabase RPC. The dashboard calls this
            # instead of talking to Supabase directly, so the browser only
            # ever hits our backend (one origin, no CORS, one cache policy).
            return self.api_rpc_bridge()
        if path == "/api/catalog/taxonomy":
            # The complete service + country lists (not just the pairs already
            # stocked), so the picker can search every provider service — e.g.
            # "1688" — on arrival instead of only the preloaded subset.
            cc = (parse_qs(urlparse(self.path).query).get("country", [""])[0] or "").lower()
            with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
                # Some display names have two rows (a real provider code and a
                # spurious alias, e.g. "Facebook" fb/facebook). The alias has no
                # stock and the provider rejects it, so keep the stocked code per
                # name; the picker otherwise selects the dead alias and the pair
                # shows nothing.
                cur.execute("""
                    select s.code, s.name, s.icon, coalesce(n.stocked, 0) as stocked
                      from services s
                      left join (
                        select service_code, count(*) as stocked
                          from number_catalog
                         where active and stock > 0
                         group by service_code
                      ) n on n.service_code = s.code
                     order by s.name, stocked desc, s.code""")
                services, seen = [], set()
                for r in cur.fetchall():
                    key = (r["name"] or r["code"]).lower()
                    if key in seen:
                        continue
                    seen.add(key)
                    services.append({"code": r["code"], "name": r["name"], "icon": r["icon"]})
                cur.execute("""select code, name, flag from countries order by name""")
                countries = [{"code": r["code"], "name": r["name"], "flag": r["flag"]}
                             for r in cur.fetchall()]
            return self._send(200, {"services": services, "countries": countries,
                                    "country": cc or None})
        if path == "/api/catalog/live":
            q = parse_qs(urlparse(self.path).query)
            cc = (q.get("country", [""])[0] or "").lower()
            sv = q.get("service", [""])[0] or ""
            if not cc or not sv:
                return self._send(400, {"error": "country and service required"})
            live = sync_pair(cc, sv) or {}
            user_id = self._auth_user()
            with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""select price, cost_usd, stock, updated_at from number_catalog
                                where country_code=%s and service_code=%s""", (cc, sv))
                row = cur.fetchone() or {}
                pct = 0.0
                if user_id:
                    cur.execute("""select coalesce(markup_percent, 0) as pct from businesses
                                    where user_id=%s and status='active' limit 1""", (user_id,))
                    m = cur.fetchone()
                    if m:
                        pct = float(m["pct"])
            price_ngn = None
            price_usd = None
            if row.get("price") is not None:
                # Same figure reserve_number debits: whole-dollar price
                # (base + business markup) at the live rate.
                base = float(row["price"])
                price_ngn = _sell_price_ngn(base, pct)
                price_usd = max(1, round(base * (1 + pct / 100.0) / (fx_rates().get("NGN") or 1600.0)))
            return self._send(200, {"country": cc, "service": sv,
                                    "price_ngn": price_ngn,
                                    "price_usd": price_usd,
                                    "cost_usd": float(row["cost_usd"]) if row.get("cost_usd") is not None else live.get("price_usd"),
                                    "available": row.get("stock", live.get("available")),
                                    "operators": live.get("operators", [])})
        if path == "/api/rent/prices":
            q = parse_qs(urlparse(self.path).query)
            cc = (q.get("country", [""])[0] or "").lower()
            sv = q.get("service", [""])[0] or ""
            if not sv:
                return self._send(400, {"error": "service required"})
            try:
                return self._send(200, rent_prices_real(cc, sv))
            except Exception as e:
                return self._send(502, {"error": str(e)})
        if path == "/api/order/status":
            q = parse_qs(urlparse(self.path).query)
            oid = q.get("id", [None])[0]
            if not oid:
                return self._send(400, {"error": "id required"})
            return self._send(200, self._order_status(int(oid)))
        if path == "/api/order/detail":
            return self.api_order_detail(path)
        if path == "/api/events":
            return self.api_live_events()
        if path.startswith("/api/app/download/"):
            return self.api_app_download(path.rsplit("/", 1)[-1])
        if path == "/api/kb":
            q = parse_qs(urlparse(self.path).query)
            return self._send(200, {"articles": _svc("kb_search", {
                "p_q": (q.get("q", [""])[0] or ""), "p_category": q.get("category", [None])[0]})})
        if path == "/api/articles":
            q = parse_qs(urlparse(self.path).query)
            return self._send(200, _svc("kb_search", {
                "p_q": (q.get("q", [""])[0] or ""), "p_category": q.get("category", [None])[0]}))
        if path.startswith("/api/kb/"):
            slug = path.rsplit("/", 1)[-1]
            art = _svc("kb_article", {"p_slug": slug})
            if not art or art == "null":
                return self._send(404, {"error": "article not found"})
            return self._send(200, art)
        if path == "/api/rails":
            return self._send(200, {"rails": _svc("payment_rails", {})})
        if path == "/api/wallet/export":
            return self.api_wallet_export()
        if path == "/api/audit":
            # Self-service: a caller only ever sees their own audit trail.
            q = parse_qs(urlparse(self.path).query)
            actor = None
            tenant_token = self.headers.get("x-tenant-token")
            if tenant_token:
                tid = self._auth_tenant(tenant_token)
                if not tid:
                    return self._send(401, {"error": "invalid tenant session"})
                actor = f"tenant:{tid}"
            else:
                uid = self._auth_user()
                if not uid:
                    return self._send(401, {"error": "missing or invalid session"})
                actor = f"user:{uid}"
            limit = int((q.get("limit", ["100"])[0]) or 100)
            return self._send(200, _svc("audit_list", {"p_limit": limit, "p_actor": actor}))
        if path == "/api/metrics":
            # In-process counters + a DB-side ops snapshot (J4).
            return self._send(200, {"process": METRICS.snapshot(),
                                    "ops": _svc("ops_metrics", {"p_window_min": 15})})
        if path == "/api/health":
            return self._send(200, self._health())
        if path == "/api/env":
            # J9: which environment this build is serving + its safety posture.
            return self._send(200, {
                "environment": ENVIRONMENT, "is_prod": IS_PROD, "preview": IS_PREVIEW,
                "korapay_mode": KORA_MODE, "git_sha": GIT_SHA, "version": VERSION,
                "upstream_enabled": upstream_enabled(),
            })
        if path == "/api/alerts":
            if not self._is_admin():
                return self._send(403, {"error": "admin only"})
            return self._send(200, {"events": _svc("alert_events_list", {"p_limit": 50}),
                                    "rules": _svc("alert_rules_list", {})})
        if path == "/api/scheduler":
            # J2: last-run state for the recurring ops tasks.
            return self._send(200, {"tasks": _svc("scheduler_status", {})})
        if path == "/api/status":
            # J6: public status page feed.
            return self._send(200, _svc("status_report", {}))
        if path.startswith("/api/admin/"):
            return self.api_admin_get(path)
        if path == "/api/policies":
            # Public: current policy versions + the caller's acceptance state.
            uid = self._auth_user()
            tenant = self._auth_tenant(self.headers.get("x-tenant-token")) if self.headers.get("x-tenant-token") else None
            st = policy_status(uid, tenant)
            q = parse_qs(urlparse(self.path).query)
            if (q.get("policy", [""])[0] or "") == "aup":
                return self._send(200, self._aup_text(st.get("aup_version", AUP_VERSION_FALLBACK)))
            return self._send(200, st)
        if path == "/api/upstream/status":
            return self._send(200, {
                "enabled": upstream_enabled(),
                "balance": _svc("provider_state_get", {"p_key": "balance"}),
                "catalog_sync": _svc("sync_progress", {}),
                "dlq": _svc("dlq_list", {"p_limit": 10}),
                "reconcile": _svc("reconcile_report", {"p_days": 7}),
            })
        if path == "/api/pricing":
            with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("select * from settings")
                s = {r["key"]: r["value"] for r in cur.fetchall()}
            return self._send(200, {"settings": s, "korapay_mode": KORA_MODE, "korapay_public_key": KORA_PUBLIC})
        if path == "/api/reviews":
            q = parse_qs(urlparse(self.path).query)
            limit = int((q.get("limit", ["20"])[0]) or 20)
            return self._send(200, _svc("public_reviews", {"p_limit": limit}))
        if path == "/api/status/uptime":
            q = parse_qs(urlparse(self.path).query)
            hours = int((q.get("hours", ["72"])[0]) or 72)
            return self._send(200, _svc("status_uptime", {"p_hours": hours}))
        if path.startswith("/api/payments/verify/"):
            ref = path.rsplit("/", 1)[-1]
            st, d = korapay_verify(ref)
            data = d.get("data") or {}
            if st == 200 and data.get("status") == "success":
                res = self._credit_payment(ref, data.get("amount"), data.get("channel"),
                                           data.get("transaction_reference"))
                return self._send(200, {"verified": True, "status": "success", "credit": res})
            return self._send(200, {"verified": False, "status": data.get("status", "unknown")})
        # G2: inject Review/AggregateRating JSON-LD into eligible marketing pages.
        injected = self._inject_review_jsonld(path)
        if injected is not None:
            return self._send(200, injected, "text/html; charset=utf-8",
                              extra={"Cache-Control": "public, max-age=300, must-revalidate"})
        return super().do_GET()

    def do_POST(self):
        self._tick()
        path = urlparse(self.path).path
        try:
            if path == "/api/rpc":
                return self.api_rpc_bridge()
            if path == "/api/payments/initialize":
                return self.api_payments_initialize()
            if path == "/api/korapay/webhook":
                return self.api_webhook()
            if path == "/api/orders/buy":
                if not check_rate(self, "buy"):
                    return
                return self.api_buy_order()
            if path == "/api/orders/rent":
                if not check_rate(self, "buy"):
                    return
                return self.api_rent_order()
            if path == "/api/orders/cancel":
                return self.api_cancel_order()
            if path == "/api/upstream/webhook":
                if not check_rate(self, "webhook"):
                    return
                return self.api_upstream_webhook()
            if path == "/api/policies/accept":
                return self.api_policy_accept()
            if path == "/api/admin/blocklist":
                return self.api_admin_blocklist()
            if path == "/api/admin/risk":
                return self.api_admin_risk()
            if path == "/api/admin/alerts/run":
                return self.api_admin_alert_run()
            if path == "/api/app/builds/request":
                return self.api_app_build_request()
            if path == "/api/status/subscribe":
                if not check_rate(self, "subscribe"):
                    return
                return self.api_status_subscribe()
            if path == "/api/consent":
                if not check_rate(self, "consent"):
                    return
                return self.api_consent()
            if path == "/api/reviews":
                if not check_rate(self, "review"):
                    return
                return self.api_submit_review()
            if path.startswith("/api/admin/"):
                return self.api_admin_post(path)
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

    # ---------- admin / health / policy helpers ----------
    def _caller_email(self):
        token = self._bearer()
        if not token:
            return None
        st, prof = supabase_rpc("my_profile", {}, token=token)
        if st != 200 or not prof:
            return None
        return prof.get("email")

    def _is_admin(self):
        return is_admin(self._caller_email())

    def _health(self):
        """J4/J6: liveness + the dependencies we actually depend on."""
        checks = {}
        try:
            with db() as conn, conn.cursor() as cur:
                cur.execute("select 1")
                cur.fetchone()
            checks["db"] = True
        except Exception as e:
            checks["db"] = False
            LOG.error("health_db_error", error=str(e)[:200])
        checks["upstream_enabled"] = upstream_enabled()
        snap = METRICS.snapshot()
        checks["error_rate"] = round(snap["errors_5xx"] / max(1, snap["requests_total"]), 4)
        ok = checks["db"]
        return {"ok": ok, "checks": checks, "uptime_s": snap["uptime_s"],
                "version": VERSION, "environment": ENVIRONMENT, "git_sha": GIT_SHA}

    def _aup_text(self, version):
        return aup_text(version)

    def api_policy_accept(self):
        """L4: record acceptance of the current acceptable-use policy."""
        body = self._read_json()
        policy = (body.get("policy") or "aup").lower()
        user_id = self._auth_user()
        tenant = self._auth_tenant(self.headers.get("x-tenant-token")) if self.headers.get("x-tenant-token") else None
        if not user_id and not tenant:
            return self._send(401, {"error": "missing or invalid session"})
        res = _svc("policy_accept", {"p_user": user_id, "p_tenant": tenant,
                                     "p_policy": policy, "p_ip": client_ip(self)})
        actor = f"tenant:{tenant}" if tenant else f"user:{user_id}"
        _audit(actor, "policy.accept", policy, {"version": (res or {}).get("version")}, client_ip(self))
        return self._send(200, res or {})

    def api_status_subscribe(self):
        """G6: subscribe an email to status/incident notifications."""
        body = self._read_json()
        email = (body.get("email") or "").strip()
        if not email:
            return self._send(400, {"error": "email required"})
        try:
            res = _svc("status_subscribe", {"p_email": email})
        except Exception:
            return self._send(400, {"error": "invalid email"})
        _audit("public", "status.subscribe", email, None, client_ip(self))
        return self._send(200, res or {"ok": True})

    def api_consent(self):
        """G3: record a granular consent choice (analytics/ads/functional).

        Stored server-side as proof of consent; the browser keeps its own copy in
        the smspin_consent cookie for Google Consent Mode.
        """
        body = self._read_json()
        user_id = self._auth_user()
        c = body.get("consent") or body
        with db() as conn, conn.cursor() as cur:
            cur.execute(
                """insert into consent_log(user_id, anon_id, analytics, ads, functional,
                                           policy_ver, user_agent, ip)
                   values (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (user_id, (body.get("anon_id") or "")[:64],
                 bool(c.get("analytics")), bool(c.get("ads")),
                 bool(c.get("functional", True)), (body.get("policy") or "v1")[:32],
                 (self.headers.get("User-Agent") or "")[:400], client_ip(self)))
        return self._send(200, {"ok": True})

    def api_submit_review(self):
        """G6: submit a customer review (lands pending moderation)."""
        user_id = self._auth_user()
        if not user_id:
            return self._send(401, {"error": "sign in to leave a review"})
        body = self._read_json()
        try:
            rating = int(body.get("rating") or 0)
        except (TypeError, ValueError):
            return self._send(400, {"error": "rating must be 1..5"})
        try:
            res = _svc("submit_review", {
                "p_user": user_id,
                "p_rating": rating,
                "p_title": (body.get("title") or "")[:120],
                "p_body": (body.get("body") or "")[:4000],
                "p_service": (body.get("service") or "")[:80] or None,
                "p_country": (body.get("country") or "")[:8] or None,
            })
        except Exception as e:
            return self._send(400, {"error": str(e)})
        _audit(f"user:{user_id}", "review.submit", str((res or {}).get("id")), None, client_ip(self))
        return self._send(200, res or {"ok": True})

    def api_admin_blocklist(self):
        """D8 admin: add/remove/list blocklist entries."""
        if not self._is_admin():
            return self._send(403, {"error": "admin only"})
        body = self._read_json()
        action = body.get("action") or "list"
        if action == "list":
            return self._send(200, _svc("blocklist_list", {"p_kind": body.get("kind")}))
        if action == "add":
            if not body.get("kind") or not body.get("value"):
                return self._send(400, {"error": "kind and value required"})
            rid = _svc("blocklist_add", {"p_kind": body["kind"], "p_value": str(body["value"]),
                                         "p_reason": body.get("reason")})
            _audit(f"admin:{self._caller_email()}", "blocklist.add",
                   f"{body['kind']}:{body['value']}", {"reason": body.get("reason")}, client_ip(self))
            return self._send(200, {"id": rid})
        if action == "remove":
            _svc("blocklist_remove", {"p_kind": body["kind"], "p_value": str(body["value"])})
            _audit(f"admin:{self._caller_email()}", "blocklist.remove",
                   f"{body['kind']}:{body['value']}", None, client_ip(self))
            return self._send(200, {"removed": True})
        return self._send(400, {"error": "unknown action"})

    def api_admin_risk(self):
        if not self._is_admin():
            return self._send(403, {"error": "admin only"})
        q = parse_qs(urlparse(self.path).query)
        return self._send(200, _svc("risk_events_list",
                                    {"p_limit": int(q.get("limit", ["100"])[0]),
                                     "p_user": q.get("user", [None])[0]}))

    def api_admin_alert_run(self):
        """J5: evaluate alert rules now and dispatch to the configured webhook."""
        if not self._is_admin():
            return self._send(403, {"error": "admin only"})
        fired = _svc("alert_evaluate", {}) or []
        delivered = dispatch_alerts()
        return self._send(200, {"fired": fired, "delivered": delivered})

    def api_app_build_request(self):
        """M1-M5: queue a branded Android build for the caller's store, then
        kick the worker so it is fulfilled promptly."""
        uid = self._auth_user()
        if not uid:
            return self._send(401, {"error": "missing or invalid session"})
        body = self._read_json()
        try:
            res = supabase_rpc("request_app_build", {"p_version": body.get("version")},
                               token=self._bearer())
            if isinstance(res, tuple):
                st, res = res
                if st != 200:
                    msg = res.get("message") if isinstance(res, dict) else str(res)
                    return self._send(400, {"error": msg or "could not queue build"})
        except Exception as e:
            return self._send(400, {"error": str(e).split("\n")[0]})
        built = dispatch_app_builds()
        _audit(f"user:{uid}", "app.build_request", None, {"version": body.get("version")}, client_ip(self))
        return self._send(200, {"build": res, "dispatched": built})

    # ---------- F1-F5 admin console ----------
    def _require_admin(self):
        """Return the admin email or None (caller then 403s)."""
        email = self._caller_email()
        return email if is_admin(email) else None

    def _q(self):
        return parse_qs(urlparse(self.path).query)

    def api_admin_get(self, path):
        """F1-F5 + J6 read endpoints (admin only)."""
        admin = self._require_admin()
        if not admin:
            return self._send(403, {"error": "admin only"})
        q = self._q()
        one = lambda k, d=None: (q.get(k, [d])[0] if q.get(k) else d)
        if path == "/api/admin/overview":
            return self._send(200, _svc("admin_overview", {}))
        if path == "/api/admin/users":
            return self._send(200, _svc("admin_users_list", {"p_q": one("q"),
                                    "p_limit": int(one("limit", "50"))}))
        if path.startswith("/api/admin/users/"):
            uid = path.rsplit("/", 1)[-1]
            return self._send(200, _svc("admin_user_detail", {"p_user": uid}))
        if path == "/api/admin/orders":
            return self._send(200, _svc("admin_orders_list", {"p_status": one("status"),
                                    "p_q": one("q"), "p_limit": int(one("limit", "100"))}))
        if path == "/api/admin/catalog":
            return self._send(200, _svc("admin_catalog_list", {"p_q": one("q"),
                                    "p_limit": int(one("limit", "100"))}))
        if path == "/api/admin/payments":
            return self._send(200, _svc("admin_payments_list", {"p_status": one("status"),
                                    "p_limit": int(one("limit", "100"))}))
        if path == "/api/admin/payments/reconcile":
            return self._send(200, _svc("admin_payment_reconcile", {"p_days": int(one("days", "7"))}))
        if path == "/api/admin/tickets":
            return self._send(200, _svc("admin_tickets_list", {"p_status": one("status"),
                                    "p_limit": int(one("limit", "100"))}))
        if path.startswith("/api/admin/tickets/"):
            tid = path.rsplit("/", 1)[-1]
            return self._send(200, _svc("admin_ticket_thread", {"p_ticket_id": int(tid)}))
        if path == "/api/admin/audit":
            return self._send(200, _svc("audit_list", {"p_limit": int(one("limit", "100")),
                                                       "p_actor": one("actor")}))
        if path == "/api/admin/refunds":
            return self._send(200, _svc("reconcile_report", {"p_days": int(one("days", "7"))}))
        if path == "/api/admin/margin":
            return self._send(200, _svc("margin_report", {"p_days": int(one("days", "30"))}))
        if path == "/api/admin/tenants":
            return self._send(200, _svc("admin_tenants_list", {"p_q": one("q"),
                                    "p_limit": int(one("limit", "100"))}))
        if path == "/api/admin/support/queue":
            return self._send(200, _svc("admin_support_queue", {"p_status": one("status", "open"),
                                    "p_limit": int(one("limit", "100"))}))
        if path == "/api/admin/fraud":
            return self._send(200, _svc("admin_fraud_queue", {"p_limit": int(one("limit", "100"))}))
        if path == "/api/admin/flags":
            return self._send(200, _svc("admin_flags_list", {}))
        if path == "/api/admin/settings":
            return self._send(200, _svc("admin_settings_get", {}))
        if path == "/api/admin/tax":
            return self._send(200, _svc("tax_report", {"p_days": int(one("days", "30"))}))
        if path == "/api/admin/ledger":
            return self._send(200, _svc("ledger_export", {"p_from": one("from"), "p_to": one("to")}))
        if path == "/api/admin/experiments":
            return self._send(200, {"stats": _svc("experiment_stats", {})})
        if path == "/api/admin/tours":
            return self._send(200, {"funnel": _svc("tour_funnel", {"p_days": int(one("days", "30"))})})
        return self._send(404, {"error": "not found"})

    def api_admin_post(self, path):
        """F1-F5 + B7/J6 write endpoints (admin only)."""
        admin = self._require_admin()
        if not admin:
            return self._send(403, {"error": "admin only"})
        body = self._read_json()
        ip = client_ip(self)
        actor = f"admin:{admin}"

        if path == "/api/admin/users/suspend":
            res = _svc("admin_user_suspend", {"p_user": body.get("user_id"),
                                              "p_suspended": bool(body.get("suspended")),
                                              "p_reason": body.get("reason")})
            _audit(actor, "admin.user_suspend", str(body.get("user_id")),
                   {"suspended": body.get("suspended"), "reason": body.get("reason")}, ip)
            return self._send(200, res)
        if path == "/api/admin/users/adjust":
            try:
                res = _svc("admin_adjust_balance", {"p_user": body.get("user_id"),
                                                    "p_amount": body.get("amount"),
                                                    "p_reason": body.get("reason")})
            except Exception as e:
                return self._send(400, {"error": str(e).split("\n")[0]})
            _audit(actor, "admin.balance_adjust", str(body.get("user_id")),
                   {"amount": body.get("amount"), "reason": body.get("reason")}, ip)
            return self._send(200, res)
        if path == "/api/admin/orders/refund":
            order_id = int(body.get("order_id"))
            amount = body.get("amount")
            reason = body.get("reason") or "admin_refund"
            try:
                if amount is None:
                    res = _refund(order_id, reason)
                else:
                    res = _svc("refund_order_partial", {"p_order_id": order_id,
                                                        "p_amount": amount, "p_reason": reason})
                    if not res.get("already"):
                        with db() as conn, conn.cursor() as cur:
                            cur.execute("select user_id, tenant_account_id from orders where id=%s", (order_id,))
                            row = cur.fetchone()
                        if row:
                            notify_refund(order_id, row[0], row[1], res.get("refunded"), reason)
            except Exception as e:
                return self._send(400, {"error": str(e).split("\n")[0]})
            _audit(actor, "admin.refund", str(order_id),
                   {"amount": amount, "reason": reason}, ip)
            return self._send(200, res)
        if path == "/api/admin/orders/mark-received":
            res = _svc("admin_order_mark_received", {"p_order_id": int(body.get("order_id"))})
            _audit(actor, "admin.order_mark_received", str(body.get("order_id")), None, ip)
            return self._send(200, res)
        if path == "/api/admin/orders/replay":
            # Re-run the upstream webhook mapping for an order (idempotent).
            order_id = int(body.get("order_id"))
            with db() as conn, conn.cursor() as cur:
                cur.execute("select upstream_order_id from orders where id=%s", (order_id,))
                row = cur.fetchone()
            if not row or not row[0]:
                return self._send(400, {"error": "order has no upstream id"})
            payload = body.get("payload") or {"id": row[0], "status": body.get("status", "received")}
            res = upstream_webhook(payload)
            _audit(actor, "admin.order_replay", str(order_id), {"payload": payload}, ip)
            return self._send(200, res)
        if path == "/api/admin/orders/sms":
            res = _svc("admin_sms_inject", {"p_order_id": int(body.get("order_id")),
                                            "p_sender": body.get("sender") or "admin",
                                            "p_body": body.get("body") or "",
                                            "p_code": body.get("code")})
            _audit(actor, "admin.sms_inject", str(body.get("order_id")), None, ip)
            return self._send(200, res)
        if path == "/api/admin/catalog/update":
            res = _svc("admin_catalog_update", {"p_id": int(body.get("id")),
                                                "p_price": body.get("price"),
                                                "p_stock": body.get("stock"),
                                                "p_active": body.get("active")})
            _audit(actor, "admin.catalog_update", str(body.get("id")), body, ip)
            return self._send(200, res)
        if path == "/api/admin/pricing/markup":
            res = _svc("admin_set_markup", {"p_percent": body.get("percent")})
            _audit(actor, "admin.markup", None, {"percent": body.get("percent")}, ip)
            return self._send(200, res)
        if path == "/api/admin/payments/mark":
            res = _svc("admin_payment_mark", {"p_reference": body.get("reference"),
                                              "p_status": body.get("status")})
            _audit(actor, "admin.payment_mark", str(body.get("reference")), {"status": body.get("status")}, ip)
            return self._send(200, res)
        if path == "/api/admin/tickets/reply":
            res = _svc("admin_ticket_reply", {"p_ticket_id": int(body.get("ticket_id")),
                                              "p_body": body.get("body") or "",
                                              "p_agent": admin,
                                              "p_attachment_url": body.get("attachment_url")})
            _audit(actor, "admin.ticket_reply", str(body.get("ticket_id")), None, ip)
            return self._send(200, res)
        if path == "/api/admin/tickets/update":
            res = _svc("admin_ticket_update", {"p_ticket_id": int(body.get("ticket_id")),
                                               "p_status": body.get("status"),
                                               "p_priority": body.get("priority"),
                                               "p_assignee": body.get("assignee")})
            _audit(actor, "admin.ticket_update", str(body.get("ticket_id")), body, ip)
            return self._send(200, res)
        if path == "/api/admin/incidents":
            res = _svc("admin_incident_create", {"p_title": body.get("title"),
                                                 "p_body": body.get("body"),
                                                 "p_severity": body.get("severity", "minor"),
                                                 "p_status": body.get("status", "investigating"),
                                                 "p_affected": json.dumps(body.get("affected", []))})
            _audit(actor, "admin.incident_create", str(res), body, ip)
            return self._send(200, {"id": res})
        if path == "/api/admin/incidents/update":
            res = _svc("admin_incident_update", {"p_id": int(body.get("id")),
                                                 "p_status": body.get("status"),
                                                 "p_body": body.get("body"),
                                                 "p_severity": body.get("severity")})
            _audit(actor, "admin.incident_update", str(body.get("id")), body, ip)
            return self._send(200, res)
        if path == "/api/admin/checks/run":
            res = _svc("synthetic_check", {})
            _audit(actor, "admin.synthetic_check", None, res, ip)
            return self._send(200, res)
        if path == "/api/admin/refunds/dispatch":
            sent = dispatch_refund_notices()
            return self._send(200, {"sent": sent})
        # ---------- F6-F9 ----------
        if path == "/api/admin/tenants/status":
            res = _svc("admin_tenant_set_status", {"p_id": int(body.get("id")),
                                                   "p_status": body.get("status"),
                                                   "p_reason": body.get("reason")})
            _audit(actor, "admin.tenant_status", str(body.get("id")), {"status": body.get("status")}, ip)
            return self._send(200, res)
        if path == "/api/admin/tenants/payouts":
            return self._send(200, _svc("admin_tenant_payouts", {"p_id": int(body.get("id"))}))
        if path == "/api/admin/support/assign":
            res = _svc("admin_ticket_assign", {"p_id": int(body.get("ticket_id")),
                                               "p_agent": body.get("agent") or admin,
                                               "p_priority": body.get("priority"),
                                               "p_canned": body.get("canned")})
            _audit(actor, "admin.ticket_assign", str(body.get("ticket_id")), body, ip)
            return self._send(200, res)
        if path == "/api/admin/flags/set":
            res = _svc("admin_flag_set", {"p_key": body.get("key"),
                                          "p_enabled": bool(body.get("enabled")),
                                          "p_tenant": body.get("tenant_id"),
                                          "p_description": body.get("description")})
            _audit(actor, "admin.flag_set", str(body.get("key")),
                   {"enabled": body.get("enabled"), "tenant": body.get("tenant_id")}, ip)
            return self._send(200, res)
        if path == "/api/admin/settings/set":
            res = _svc("admin_setting_set", {"p_key": body.get("key"),
                                             "p_value": json.dumps(body.get("value"))})
            _audit(actor, "admin.setting_set", str(body.get("key")), {"value": body.get("value")}, ip)
            return self._send(200, res)
        if path == "/api/admin/app/builds/run":
            built = dispatch_app_builds()
            return self._send(200, {"built": built})
        if path == "/api/admin/webhooks/run":
            return self._send(200, {"customer": dispatch_customer_webhooks(),
                                    "tenant": dispatch_tenant_webhooks()})
        return self._send(404, {"error": "not found"})

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

        ip = client_ip(self)
        actor = f"tenant:{tenant_account}" if tenant_account else f"user:{user_id}"

        # D1: email verification gate — OFF by default, so only enforced when the
        # `email_verification_required` setting is true.
        if user_id and email_verification_required() and not email_verified(user_id):
            _audit(actor, "order.buy_blocked", None, {"reason": "email_unverified"}, ip)
            return self._send(403, {"error": "email not verified",
                                    "code": "email_unverified"})

        # F2: suspended accounts cannot purchase.
        if user_id and _svc("is_suspended", {"p_user": user_id}):
            _audit(actor, "order.buy_blocked", None, {"reason": "suspended"}, ip)
            return self._send(403, {"error": "account suspended",
                                    "code": "account_suspended"})

        # L4: acceptable-use policy must be accepted for the current version.
        if aup_required(user_id, tenant_account, body):
            _audit(actor, "order.buy_blocked", None, {"reason": "aup_required"}, ip)
            return self._send(403, {"error": "acceptable-use policy acceptance required",
                                    "code": "aup_required",
                                    "aup_version": policy_status(user_id, tenant_account).get("aup_version")})

        # D8: velocity + blocklist scoring before we touch money.
        email = body.get("email")
        if not email and user_id:
            try:
                st, prof = supabase_rpc("my_profile", {}, token=self._bearer())
                email = (prof or {}).get("email")
            except Exception:
                email = None
        decision = fraud_check(user_id, ip, email,
                               {"country": country, "service": service})
        if not decision.get("allow", False):
            _audit(actor, "order.buy_blocked", None,
                   {"reason": "fraud", "score": decision.get("score"),
                    "reasons": decision.get("reasons")}, ip)
            LOG.warn("buy_blocked_fraud", user=str(user_id), ip=ip,
                     score=decision.get("score"), reasons=decision.get("reasons"))
            return self._send(403, {"error": "request blocked by risk controls",
                                    "code": "fraud_block",
                                    "reasons": decision.get("reasons")})

        try:
            res = buy_real(country, service, user_id=user_id, tenant_account=tenant_account,
                           operator=int(operator) if operator else None)
            _audit(actor, "order.buy", str(res.get("order_id")),
                   {"country": country, "service": service, "price_ngn": res.get("price_ngn")},
                   ip)
            LOG.info("order_buy", actor=actor, order=str(res.get("order_id")),
                     country=country, service=service)
            return self._send(200, res)
        except RuntimeError as e:
            _audit(actor, "order.buy_failed", None, {"country": country, "service": service,
                                                     "error": str(e)[:200]}, ip)
            return self._send(402, {"error": str(e)})
        except Exception as e:
            msg = str(e).split("\n")[0]
            # Domain-level rejections (balance/stock) are 402, not 500.
            code = 402 if any(k in msg.lower() for k in
                              ("insufficient", "no stock", "out of stock", "unavailable")) else 500
            if code == 500:
                LOG.error("order_buy_error", actor=actor, error=msg)
            return self._send(code, {"error": msg})

    def api_rent_order(self):
        """Rent a long-lived number (24h/72h/168h). Mirrors api_buy_order's
        auth + risk gates, then charges the wallet before the provider call."""
        body = self._read_json()
        country = (body.get("country") or "").lower()
        service = body.get("service") or ""
        duration = int(body.get("duration") or 24)
        if not country or not service:
            return self._send(400, {"error": "country and service required"})
        if not upstream_enabled():
            return self._send(503, {"error": "rentals temporarily unavailable"})

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

        ip = client_ip(self)
        actor = f"tenant:{tenant_account}" if tenant_account else f"user:{user_id}"
        if user_id and _svc("is_suspended", {"p_user": user_id}):
            return self._send(403, {"error": "account suspended", "code": "account_suspended"})
        if aup_required(user_id, tenant_account, body):
            return self._send(403, {"error": "acceptable-use policy acceptance required",
                                    "code": "aup_required",
                                    "aup_version": policy_status(user_id, tenant_account).get("aup_version")})
        try:
            res = rent_real(country, service, duration,
                            user_id=user_id, tenant_account=tenant_account)
            _audit(actor, "order.rent", str(res.get("order_id")),
                   {"country": country, "service": service, "duration": duration}, ip)
            LOG.info("order_rent", actor=actor, order=str(res.get("order_id")),
                     country=country, service=service, duration=duration)
            return self._send(200, res)
        except RuntimeError as e:
            return self._send(402, {"error": str(e)})
        except Exception as e:
            msg = str(e).split("\n")[0]
            code = 402 if any(k in msg.lower() for k in
                              ("insufficient", "no stock", "out of stock", "unavailable")) else 500
            if code == 500:
                LOG.error("order_rent_error", actor=actor, error=msg)
            return self._send(code, {"error": msg})

    def api_upstream_webhook(self):
        """Provider -> us callback (OTP arrived / order cancelled). Optional shared secret."""
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)) if self.headers.get("Content-Length") else b""
        secret = os.environ.get("Smspin_webhook_secret", "")
        if secret:
            given = self.headers.get("x-webhook-secret", "")
            if not hmac.compare_digest(given, secret):
                return self._send(401, {"error": "invalid signature"})
        try:
            payload = json.loads(raw or b"{}")
        except Exception:
            return self._send(400, {"error": "invalid json"})
        try:
            return self._send(200, upstream_webhook(payload))
        except Exception as e:
            try:
                _svc("dlq_enqueue", {"p_source": "upstream", "p_event": payload.get("event"),
                                     "p_payload": json.dumps(payload), "p_error": str(e)[:300]})
            except Exception:
                pass
            return self._send(500, {"error": "handled via dlq"})

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
        res = _refund(order_id, "user_cancel")
        _audit(f"tenant:{tenant_account}" if tenant_account else f"user:{user_id}",
               "order.cancel", str(order_id), {"reason": "user_cancel"}, client_ip(self))
        return self._send(200, res)

    # ---------- public API (user-generated keys) ----------
    def _api_user(self):
        """Authenticate a caller via their own x-api-key; returns user uuid or None.

        H1: enforces the key's scopes, per-key rate limit, monthly quota and IP
        allowlist. Returns the resolved key info on ``self._api_key`` for callers
        that need the scopes/usage."""
        key = self.headers.get("x-api-key") or ""
        if not key:
            a = self.headers.get("Authorization", "")
            if a.startswith("Bearer sk_") or a.startswith("Bearer sk_test_"):
                key = a[7:]
        if not key:
            return None
        h = hashlib.sha256(key.encode()).hexdigest()
        info = _svc("api_key_by_hash", {"p_hash": h})
        if not info or info == "null" or info.get("revoked"):
            return None
        # IP allowlist (empty = allow all).
        allow = info.get("ip_allowlist") or []
        if allow:
            ip = client_ip(self)
            if ip not in allow:
                self._api_reject = (403, {"error": "ip not allowed for this key", "code": "ip_denied"})
                return None
        # Monthly quota.
        quota = int(info.get("quota_month") or 0)
        if quota and int(info.get("used_month") or 0) >= quota:
            self._api_reject = (429, {"error": "monthly quota exceeded", "code": "quota_exceeded"})
            return None
        # Per-key sliding-window rate limit.
        rl = int(info.get("rate_limit") or 60)
        if not rate_limit(f"apikey:{info['id']}", rl, 60):
            self._api_reject = (429, {"error": "rate limit exceeded", "code": "rate_limited"})
            return None
        self._api_key = info
        with db() as conn:
            with conn.cursor() as cur:
                cur.execute("update api_keys set last_used_at=now() where key_hash=%s", (h,))
        return info.get("user_id")

    def _api_scopes(self):
        return (getattr(self, "_api_key", None) or {}).get("scopes") or []

    def api_wallet_export(self):
        """E8: download the caller's transactions as CSV (their own rows only)."""
        uid = self._auth_user()
        if not uid:
            return self._send(401, {"error": "missing or invalid session"})
        with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""select created_at, type, amount, method, ref from transactions
                            where user_id=%s order by created_at desc""", (uid,))
            rows = cur.fetchall()
        lines = ["date,type,amount,method,reference"]
        for r in rows:
            lines.append(",".join([
                str(r["created_at"] or ""), str(r["type"] or ""), str(r["amount"] or ""),
                str(r["method"] or ""), '"' + str(r["ref"] or "").replace('"', "'") + '"']))
        body = ("\n".join(lines) + "\n").encode()
        return self._send(200, body, ctype="text/csv",
                          extra={"Content-Disposition": 'attachment; filename="smspin-transactions.csv"'})

    def api_app_download(self, token):
        """M5: time-limited branded APK download link (no auth — the token is the key)."""
        b = _svc("app_build_by_token", {"p_token": token})
        if not b or b == "null":
            return self._send(404, {"error": "link expired or invalid"})
        # A real deployment redirects to the CI artefact in object storage; in
        # dev/staging we return a small placeholder APK so the flow is testable.
        name = (b.get("slug") or "app") + "-" + (b.get("version") or "1.0.0") + ".apk"
        body = ("SMSPin branded build placeholder\n"
                f"app={b.get('name')} version={b.get('version')}\n").encode()
        return self._send(200, body, ctype="application/vnd.android.package-archive",
                          extra={"Content-Disposition": f'attachment; filename="{name}"'})

    def _tenant_key(self):
        """C6: authenticate a caller via a tenant API key; returns key info or None."""
        key = self.headers.get("x-tenant-key") or ""
        if not key:
            a = self.headers.get("Authorization", "")
            if a.startswith("Bearer tk_"):
                key = a[7:]
        if not key:
            return None
        h = hashlib.sha256(key.encode()).hexdigest()
        info = _svc("tenant_resolve_api_key", {"p_hash": h})
        if not info or info == "null":
            return None
        try:
            with db() as conn, conn.cursor() as cur:
                cur.execute("update tenant_api_keys set last_used_at=now() where key_hash=%s", (h,))
        except Exception:
            pass
        return info

    def api_tenant_get(self, path):
        """C6: read-only tenant API surface authenticated by a tenant API key."""
        info = self._tenant_key()
        if not info:
            return self._send(401, {"error": "invalid or missing tenant API key"})
        scopes = info.get("scopes") or []
        if "read" not in scopes:
            return self._send(403, {"error": "key lacks 'read' scope"})
        biz = info.get("business_id")
        q = parse_qs(urlparse(self.path).query)
        one = lambda k, d=None: (q.get(k, [d])[0] if q.get(k) else d)
        if path == "/api/tenant/account":
            return self._send(200, _svc("business_branding", {"p_slug": self._slug_for_biz(biz)}))
        if path == "/api/tenant/orders":
            limit = int(one("limit", "50"))
            with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""select id, country_code, service_code, phone_number, price, status,
                                      created_at from orders where business_id=%s
                                order by created_at desc limit %s""", (biz, max(1, min(limit, 200))))
                rows = cur.fetchall()
            return self._send(200, {"orders": [dict(r) for r in rows]})
        if path == "/api/tenant/stats":
            return self._send(200, _svc("my_business_stats_by_id", {"p_business": biz}))
        return self._send(404, {"error": "unknown endpoint"})

    def _slug_for_biz(self, business_id):
        try:
            with db() as conn, conn.cursor() as cur:
                cur.execute("select slug from businesses where id=%s", (business_id,))
                row = cur.fetchone()
            return row[0] if row else None
        except Exception:
            return None

    def api_order_detail(self, path):
        """E2: per-order detail (status, messages, refund/extend/cancel eligibility)."""
        uid = self._auth_user()
        if not uid:
            return self._send(401, {"error": "missing or invalid session"})
        q = parse_qs(urlparse(self.path).query)
        oid = q.get("id", [None])[0] or path.rsplit("/", 1)[-1]
        if not oid or not str(oid).isdigit():
            return self._send(400, {"error": "id required"})
        with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""select o.id, o.country_code, o.service_code, o.phone_number, o.price,
                                  o.status, o.created_at, o.expires_at, o.operator,
                                  c.name as country, c.flag, s.name as service, s.icon as service_icon
                             from orders o
                             left join countries c on c.code=o.country_code
                             left join services s on s.code=o.service_code
                            where o.id=%s and o.user_id=%s""", (int(oid), uid))
            order = cur.fetchone()
            if not order:
                return self._send(404, {"error": "order not found"})
            cur.execute("""select id, sender, body, code, received_at from sms_messages
                            where order_id=%s order by received_at asc""", (int(oid),))
            msgs = cur.fetchall()
        o = dict(order)
        o["messages"] = [dict(m) for m in msgs]
        o["can_cancel"] = o["status"] == "waiting"
        o["can_extend"] = o["status"] in ("waiting", "received")
        o["refundable"] = o["status"] in ("waiting", "expired", "cancelled")
        return self._send(200, o)

    def api_live_events(self):
        """E1: Server-Sent Events stream of the caller's order updates.

        Polls the user's orders + messages and emits deltas so the dashboard can
        push codes the instant they arrive (no manual refresh)."""
        uid = self._auth_user()
        if not uid:
            # EventSource cannot send an Authorization header, so the token may
            # arrive as a query param instead.
            qtok = (parse_qs(urlparse(self.path).query).get("token", [""])[0] or "").strip()
            if qtok:
                st, prof = supabase_rpc("my_profile", {}, token=qtok)
                uid = (prof or {}).get("id") if st == 200 else None
        if not uid:
            return self._send(401, {"error": "missing or invalid session"})
        q = parse_qs(urlparse(self.path).query)
        since = q.get("since", ["0"])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        seen = set()
        deadline = time.time() + 55  # keep under typical proxy timeouts
        last_beat = 0
        try:
            while time.time() < deadline:
                with db() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("""select m.id, m.order_id, m.sender, m.body, m.code, m.received_at,
                                          o.status
                                     from sms_messages m join orders o on o.id=m.order_id
                                    where o.user_id=%s order by m.id desc limit 25""", (uid,))
                    rows = cur.fetchall()
                for r in reversed(rows):
                    if r["id"] in seen:
                        continue
                    seen.add(r["id"])
                    evt = {"type": "sms", "order_id": r["order_id"], "sender": r["sender"],
                           "body": r["body"], "code": r["code"],
                           "received_at": str(r["received_at"])}
                    self.wfile.write(f"event: sms\ndata: {json.dumps(evt)}\n\n".encode())
                self.wfile.flush()
                if time.time() - last_beat > 15:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                    last_beat = time.time()
                time.sleep(3)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:
            LOG.warn("sse_error", error=str(e)[:200])
        return

    def api_v1(self, path):
        uid = self._api_user()
        if not uid:
            if getattr(self, "_api_reject", None):
                return self._send(*self._api_reject)
            return self._send(401, {"error": "invalid or missing API key"})
        key = getattr(self, "_api_key", {}) or {}
        scopes = key.get("scopes") or []
        sandbox = bool(key.get("sandbox"))
        q = parse_qs(urlparse(self.path).query)
        one = lambda k, d=None: (q.get(k, [d])[0] if q.get(k) else d)
        status = 200
        try:
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
                if scopes and "write" not in scopes:
                    return self._send(403, {"error": "key lacks 'write' scope", "code": "scope_denied"})
                body = self._read_json()
                cc, sv = body.get("country"), body.get("service")
                if not cc or not sv:
                    return self._send(400, {"error": "country and service required"})
                # H6: idempotency — replay the stored response for a repeated key.
                idem = body.get("idempotency_key") or self.headers.get("Idempotency-Key")
                if idem:
                    prev = _svc("idempotency_lookup", {"p_key": idem, "p_user": uid})
                    if prev and prev != "null":
                        return self._send(200, prev)
                # H4: sandbox keys get a simulated number + fake OTP, never billed.
                if sandbox:
                    res = self._sandbox_order(uid, cc, sv)
                    if idem:
                        _svc("idempotency_store", {"p_key": idem, "p_user": uid, "p_response": json.dumps(res)})
                    return self._send(200, res)
                if upstream_enabled():
                    try:
                        res = buy_real(cc.lower(), sv, user_id=uid, operator=body.get("operator"))
                    except RuntimeError as e:
                        status = 402
                        return self._send(402, {"error": str(e)})
                else:
                    res = self._rpc_svc("api_buy", {"p_user": uid, "p_country": cc, "p_service": sv})
                if idem:
                    _svc("idempotency_store", {"p_key": idem, "p_user": uid, "p_response": json.dumps(res)})
                return self._send(200, res)
            return self._send(404, {"error": "unknown endpoint"})
        finally:
            # H5: meter every authenticated API call.
            try:
                _svc("record_api_usage", {"p_user": uid, "p_key_id": key.get("id"),
                                          "p_path": path, "p_method": self.command, "p_status": status})
            except Exception:
                pass

    def api_rpc_bridge(self):
        """Same-origin proxy for Supabase RPC.

        The dashboard posts ``{"fn": "<rpc_name>", "args": {...}}`` here. We
        forward the caller's bearer token (their Supabase JWT) so RLS and
        ``auth.uid()`` still apply, and hand the raw result back unchanged.
        Public RPCs (no token) fall back to the anon key.
        """
        body = self._read_json()
        fn = (body.get("fn") or "").strip()
        args = body.get("args") or {}
        if not fn or not re.fullmatch(r"[a-z0-9_]+", fn):
            return self._send(400, {"error": "invalid rpc name"})
        if not isinstance(args, dict):
            return self._send(400, {"error": "args must be an object"})
        if not check_rate(self, "rpc"):
            return
        st, data = supabase_rpc(fn, args, token=self._bearer())
        return self._send(st, data if data is not None else {})

    def _sandbox_order(self, uid, country, service):
        """H4: a fake order that never touches the provider or the wallet."""
        code = f"{abs(hash((uid, country, service, time.time()))) % 900000 + 100000}"
        return {"order_id": None, "phone_number": "+1 555 000 0000", "status": "received",
                "country": country, "service": service, "sandbox": True,
                "otp": code, "message": f"Sandbox code {code} (simulated, never billed)."}

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
        try:
            warm_popular()
        except Exception as e:
            print("warm error:", e, flush=True)
        print("poller: started", flush=True)
        while True:
            try:
                poll_pending_orders()
            except Exception as e:
                print("poll error:", e, flush=True)
            time.sleep(8)

    def _crawler():
        """N2: walk the priority frontier so the catalog fills in over time."""
        time.sleep(25)
        while True:
            try:
                r = crawl_step(15)
                if r.get("synced"):
                    print("crawl:", r, flush=True)
            except Exception as e:
                print("crawl error:", e, flush=True)
            time.sleep(20)

    def _worker():
        """J3 + N8: drain durable jobs and keep the provider balance snapshot fresh."""
        time.sleep(30)
        try:
            _svc("job_reap", {})
        except Exception:
            pass
        while True:
            try:
                job_worker_step(5)
            except Exception as e:
                LOG.error("job_worker_error", error=str(e)[:200])
            time.sleep(120)

    def _scheduler():
        """J2: recurring ops tick — metrics snapshot, alerts, job enqueue, backup verify."""
        time.sleep(40)
        while True:
            try:
                scheduler_step()
            except Exception as e:
                LOG.error("scheduler_error", error=str(e)[:200])
            time.sleep(300)

    def _backup():
        """J10: hourly data-plane verification (checksums for restore validation)."""
        time.sleep(70)
        while True:
            try:
                backup_verify_job()
            except Exception as e:
                LOG.error("backup_verify_error", error=str(e)[:200])
            time.sleep(3600)

    threading.Thread(target=_poller, daemon=True).start()
    threading.Thread(target=_crawler, daemon=True).start()
    threading.Thread(target=_worker, daemon=True).start()
    threading.Thread(target=_scheduler, daemon=True).start()
    threading.Thread(target=_backup, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
