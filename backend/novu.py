"""Novu transactional-email client (multi-tenant).

One Novu environment serves the whole platform: the platform itself plus every
white-label store. Tenancy is expressed with Novu *tenants* (one per store) and
*subscribers* (one per account, addressed as ``<tenant>:<account>``); the mail
body is rendered per-sender from the store's own branding (``email_template.py``)
and handed to Novu as ``payload.html``, so every store shares one infrastructure
but carries its own name, logo, colours and reply-to.

Only the API key is secret (``Smspin_novu``); everything else is branding data
that the caller passes in. When the key is absent every call is a no-op that
returns ``False``/``None`` so callers can fall back to in-app notices.
"""
import json
import os
import urllib.error
import urllib.request

import email_template

NOVU_BASE = os.environ.get("NOVU_BASE", "https://api.novu.co").rstrip("/")
# Novu's edge (Cloudflare) rejects the default Python UA with error 1010, so
# every request presents a browser User-Agent.
_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
# The Novu environment identifier is public (it appears in the dashboard URL and
# is not a secret); callers may override it with NOVU_ENV_ID.
DEFAULT_ENV_ID = os.environ.get("NOVU_ENV_ID", "6aaea99b1fc38e3c15954e80")

# Transactional email runs through ONE flexible workflow (the Novu plan caps
# the number of workflows); the backend composes the per-event content and Novu
# renders it with the sending tenant's brand. `WORKFLOWS` maps a logical name to
# that shared workflow so callers stay expressive.
TRANSACTIONAL_WORKFLOW = "smspin-transactional"
WORKFLOWS = {
    "welcome": TRANSACTIONAL_WORKFLOW,
    "receipt": TRANSACTIONAL_WORKFLOW,
    "refund": TRANSACTIONAL_WORKFLOW,
    "apk": TRANSACTIONAL_WORKFLOW,
    "notice": TRANSACTIONAL_WORKFLOW,
    "security": TRANSACTIONAL_WORKFLOW,
}


def api_key():
    return os.environ.get("Smspin_novu") or os.environ.get("NOVU_API_KEY") or ""


def configured():
    return bool(api_key())


def _request(path, method="GET", body=None, timeout=20):
    key = api_key()
    if not key:
        raise RuntimeError("novu not configured")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        NOVU_BASE + path, data=data, method=method,
        headers={"Authorization": "ApiKey " + key, "Content-Type": "application/json",
                 "User-Agent": _UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        raise RuntimeError("novu %s %s: %s" % (method, path, raw.decode("utf-8", "replace")[:300]))
    try:
        return json.loads(raw or b"{}")
    except Exception:
        return {}


# ---------------------------------------------------------------- tenants
def upsert_tenant(identifier, name=None, data=None):
    """Create or update a Novu tenant (one per store / the platform)."""
    if not configured() or not identifier:
        return None
    try:
        return _request("/v1/tenants", "POST",
                        {"identifier": identifier, "name": name or identifier,
                         "data": data or {}}).get("data")
    except Exception:
        # Already exists: patch it instead.
        try:
            return _request("/v1/tenants/" + identifier, "PATCH",
                            {"name": name or identifier, "data": data or {}}).get("data")
        except Exception:
            return None


# ---------------------------------------------------------------- subscribers
def upsert_subscriber(subscriber_id, email=None, first_name=None, last_name=None,
                      data=None, tenant=None):
    """Create or update a subscriber, optionally attached to a Novu tenant."""
    if not configured() or not subscriber_id:
        return None
    payload = {"subscriberId": subscriber_id}
    if email:
        payload["email"] = email
    if first_name:
        payload["firstName"] = first_name
    if last_name:
        payload["lastName"] = last_name
    if data:
        payload["data"] = data
    if tenant:
        payload["tenant"] = tenant
    try:
        return _request("/v1/subscribers", "POST", payload).get("data")
    except Exception:
        try:
            return _request("/v1/subscribers/" + subscriber_id, "PATCH", payload).get("data")
        except Exception:
            return None


# ---------------------------------------------------------------- trigger
def trigger(workflow, to, payload=None, tenant=None, transaction_id=None):
    """Trigger a transactional workflow.

    ``to`` is a subscriber dict (``{"subscriberId":..., "email":...}``) or a
    string subscriber id. ``tenant`` is ``{"identifier":..., "data":{...}}``.
    Returns ``{"ok": bool, "id": <transactionId>, "error": <str>}``.
    """
    if not configured():
        return {"ok": False, "error": "novu not configured"}
    wf = WORKFLOWS.get(workflow, workflow)
    body = {"name": wf, "payload": payload or {}}
    body["to"] = {"subscriberId": to} if isinstance(to, str) else dict(to)
    if tenant:
        body["tenant"] = tenant
    if transaction_id:
        body["transactionId"] = transaction_id
    try:
        res = _request("/v1/events/trigger", "POST", body)
        data = res.get("data") or {}
        status = data.get("status")
        # "no_tenant_found" means the tenant row is missing; the platform
        # fallback is to retrigger without a tenant so mail still goes out.
        if status == "no_tenant_found" and tenant:
            return trigger(workflow, to, payload, None, transaction_id)
        ok = status in ("processed", "queued", None) and not res.get("error")
        return {"ok": bool(ok), "id": data.get("transactionId"),
                "status": status, "error": res.get("message") or res.get("error")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


def send(workflow, to, payload=None, tenant=None, transaction_id=None):
    """Trigger and report a single success flag (mirrors ``mailer.send``)."""
    return trigger(workflow, to, payload, tenant, transaction_id).get("ok", False)


# ---------------------------------------------------------------- composition
# The backend composes each event's copy here and renders the full branded HTML
# (email_template.render); the shared Novu workflow only transports it. Keeping
# the copy in code means a wording change ships with the deployment, while the
# *look* comes from the sending store's branding row.


def send_event(event, to, tenant, base_url=None, **kw):
    """Compose and send a branded transactional email.

    ``event`` is one of welcome / receipt / refund / apk / security / notice.
    ``tenant`` is the email_sender() dict for the sending store (or platform).
    ``to`` is ``{"subscriberId": ..., "email": ...}`` or a subscriber id string.
    """
    if not configured():
        return {"ok": False, "error": "novu not configured"}
    base = (base_url or os.environ.get("SMSPIN_SITE_URL", "https://smspin.io")).rstrip("/")
    brand = (tenant or {}).get("brand_name") or "SMSPin"
    currency = kw.get("currency") or "NGN"
    tx = tenant or {}
    tx = dict(tx)
    tx.setdefault("site_url", base)

    def row(icon, label, value):
        return {"icon": icon, "label": label, "value": str("" if value is None else value)}

    if event == "welcome":
        subject = "Welcome to %s" % brand
        content = {"subject": subject, "heading": "Welcome, %s!" % (kw.get("name") or "there"),
                   "icon": "\U0001F44B", "preheader": "Your %s account is ready." % brand,
                   "paragraphs": ["Your %s account is ready. Fund your wallet and get a virtual number in seconds." % brand,
                                  "If you did not create this account you can ignore this email."],
                   "ctaUrl": base + "/dashboard/", "ctaLabel": "Open your dashboard"}
    elif event == "receipt":
        subject = "Your %s receipt — %s %s" % (brand, currency, kw.get("amount"))
        content = {"subject": subject, "heading": "Payment received", "icon": "\U0001F9FE",
                   "preheader": "We credited your %s wallet with %s %s." % (brand, currency, kw.get("amount")),
                   "paragraphs": ["We credited your wallet. Your balance is available for new orders right away."],
                   "rows": [row("\U0001F4B3", "Amount", "%s %s" % (currency, kw.get("amount"))),
                            row("\U0001F3E6", "Method", kw.get("method") or "—"),
                            row("\U0001F516", "Reference", kw.get("ref") or "—")],
                   "ctaUrl": base + "/dashboard/wallet/", "ctaLabel": "View wallet"}
    elif event == "refund":
        subject = "Your %s refund" % brand
        content = {"subject": subject, "heading": "Refund processed", "icon": "\u21A9\uFE0F",
                   "preheader": "We refunded %s %s to your %s wallet." % (currency, kw.get("amount"), brand),
                   "paragraphs": ["We refunded %s %s to your wallet for order #%s." % (currency, kw.get("amount"), kw.get("order_id")),
                                  "The amount is available now and can be used for another number or "
                                  "withdrawn per the refund policy."],
                   "rows": [row("\U0001F4B5", "Amount", "%s %s" % (currency, kw.get("amount"))),
                            row("\U0001F9FE", "Order", "#%s" % kw.get("order_id")),
                            row("\U0001F4DD", "Reason", kw.get("reason") or "order could not be completed")],
                   "ctaUrl": base + "/dashboard/wallet/", "ctaLabel": "View wallet"}
    elif event == "apk":
        subject = "Your %s app is ready" % brand
        content = {"subject": subject, "heading": "%s for Android" % (kw.get("app_name") or brand),
                   "icon": "\U0001F4F1",
                   "preheader": "Your branded %s app build is ready to download." % brand,
                   "paragraphs": ["Your branded app build (v%s) is ready to download and install on any "
                                  "Android device." % kw.get("version", "1.0.0"),
                                  "This link is time-limited. Contact %s if it has expired." % tx.get("support_email", "")],
                   "rows": [row("\U0001F3F7\uFE0F", "App", kw.get("app_name") or brand),
                            row("\U0001F522", "Version", kw.get("version", "1.0.0"))],
                   "ctaUrl": kw.get("download_url"), "ctaLabel": "Download the app"}
    elif event == "security":
        subject = "%s security notice" % brand
        content = {"subject": subject, "heading": kw.get("title") or "Security notice", "icon": "\U0001F510",
                   "preheader": "A security event happened on your %s account." % brand,
                   "paragraphs": [kw.get("body") or "",
                                  "If this was not you, contact %s immediately." % tx.get("support_email", "")],
                   "rows": [row("\U0001F552", "When", kw["when"])] if kw.get("when") else []}
    else:  # notice
        subject = kw.get("subject") or ("%s update" % brand)
        content = {"subject": subject, "heading": kw.get("title") or subject, "icon": "\u2709\uFE0F",
                   "paragraphs": [kw.get("body") or ""],
                   "ctaUrl": kw.get("cta_url"), "ctaLabel": kw.get("cta_label")}

    # Render the full branded HTML here; Novu only transports it.
    content["html"] = email_template.render(tx, content)
    content["brand_name"] = brand
    content["support_email"] = tx.get("support_email") or ""
    novu_tenant = {"identifier": tx.get("tenant_id") or "smspin-platform"}
    return trigger(event, to, content, novu_tenant)
