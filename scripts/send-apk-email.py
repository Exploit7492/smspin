#!/usr/bin/env python3
"""Email a tenant their branded APK download link through Novu.

Runs in CI after a successful build. Every store's mail goes through the same
Novu infrastructure, branded for that store (see backend/novu.py).

Env:
  Smspin_novu       Novu API key (secret)
  TO                recipient address
  LINK              download URL (GitHub release asset)
  TENANT_SLUG       store slug (selects the Novu tenant + branding)
  TENANT            store display name (fallback when the slug is unknown)
  VERSION           app version string
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))
import novu  # noqa: E402

to = os.environ.get("TO", "").strip()
link = os.environ.get("LINK", "").strip()
slug = os.environ.get("TENANT_SLUG", "").strip() or None
name = os.environ.get("TENANT", "").strip() or "your store"
version = os.environ.get("VERSION", "1.0.0")

if not to:
    print("TO not set — nothing to email.")
    raise SystemExit(0)

if not novu.configured():
    print("Smspin_novu not set — cannot send the download link.")
    raise SystemExit(1)

tenant = {"tenant_id": slug or "smspin-platform", "brand_name": name,
          "primary_color": os.environ.get("BRAND_PRIMARY", "#E11D2E"),
          "secondary_color": os.environ.get("BRAND_SECONDARY", "#F26B7A"),
          "support_email": os.environ.get("SUPPORT_EMAIL", "")}

# Keep the Novu tenant in step with the build's branding before sending.
novu.upsert_tenant(tenant["tenant_id"], name, {
    "brand_name": name, "primary_color": tenant["primary_color"],
    "secondary_color": tenant["secondary_color"], "support_email": tenant["support_email"],
    "footer": "You are receiving this because you have an account with %s." % name,
})

sub = ("smspin:" + (slug or "platform") + ":" + to).lower()
res = novu.send_event("apk", {"subscriberId": sub, "email": to}, tenant,
                      app_name=name, version=version, download_url=link,
                      base_url=os.environ.get("API_BASE", "https://smspin.io"))
print("apk email:", res)
raise SystemExit(0 if res.get("ok") else 1)
