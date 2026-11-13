#!/usr/bin/env python3
"""Provision the multi-tenant Novu email infrastructure.

Idempotent. Creates (or updates) the ONE transactional email workflow the whole
platform shares — the Novu plan caps the number of workflows, so every event
(welcome, receipt, refund, app link, security, notice) renders through it — plus
one Novu tenant per store so each store's mail carries its own brand. Run after
changing the template:

    Smspin_novu="$Smspin_novu" Smspin_supabase_Postgresql="$Smspin_supabase_Postgresql" \
        python3 scripts/setup-novu.py

The email HTML is rendered per-tenant by the dispatchers (edge `email` function
and backend/novu.py) from the store's own branding row, and handed to Novu as
``payload.html``. Novu therefore only transports the message: it never has to
evaluate a branding variable, and the layout/logo/colours follow the sending
store exactly.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))
import novu  # noqa: E402

WORKFLOW_ID = novu.TRANSACTIONAL_WORKFLOW

# The workflow is a thin transport: subject and a pre-rendered HTML body come
# from the trigger payload. Keeping it dumb means a store's brand can never be
# dropped by the template engine (Novu rejects `tenant.data.*` in the body).
BODY = "{{payload.html}}"

WORKFLOW = {
    "workflowId": WORKFLOW_ID,
    "name": "Transactional",
    "description": "Shared, tenant-branded transactional email (welcome, receipt, refund, app link, security, notice).",
    "steps": [{
        "type": "email",
        "name": "Email",
        "controlValues": {
            "subject": "{{payload.subject}}",
            "editorType": "html",
            "body": BODY,
        },
    }],
}


def upsert_workflow():
    created = False
    try:
        novu._request("/v2/workflows", "POST", WORKFLOW)
        print("workflow created:", WORKFLOW_ID)
        created = True
    except Exception as e:
        # Already exists (or the plan cap is hit): update in place.
        if "maximum number of workflows" not in str(e) and "Payment Required" not in str(e):
            print("workflow create note:", str(e)[:160])
    if not created:
        try:
            novu._request("/v2/workflows/" + WORKFLOW_ID, "PUT", WORKFLOW)
            print("workflow updated:", WORKFLOW_ID)
        except Exception as e:
            print("workflow FAILED:", WORKFLOW_ID, str(e)[:200])
            return


def upsert_tenants():
    """Mirror every active business (and the platform) into a Novu tenant."""
    import psycopg2
    dsn = os.environ.get("Smspin_supabase_Postgresql")
    novu.upsert_tenant("smspin-platform", "SMSPin Platform",
                       {"brand_name": "SMSPin", "primary_color": "#E11D2E",
                        "support_email": "support@smspin.io"})
    print("tenant ensured: smspin-platform")
    if not dsn:
        print("Smspin_supabase_Postgresql unset — only the platform tenant was ensured")
        return
    conn = psycopg2.connect(dsn, connect_timeout=20)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("""
        select slug,
               coalesce(email_from_name, name),
               coalesce(primary_color, '#E11D2E'),
               coalesce(secondary_color, '#F26B7A'),
               coalesce(email_reply_to, support_email, ''),
               coalesce(email_logo_url, logo_url)
          from businesses where coalesce(status,'active') <> 'deleted' order by id""")
    for slug, name, primary, secondary, reply, logo in cur.fetchall():
        novu.upsert_tenant(slug, name, {
            "brand_name": name, "primary_color": primary, "secondary_color": secondary,
            "support_email": reply, "logo_url": logo,
            "footer": "You are receiving this because you have an account with %s." % name,
        })
        print("tenant ensured:", slug)
    conn.close()


def main():
    if not novu.configured():
        print("Smspin_novu is not set — cannot provision Novu.")
        return 1
    upsert_workflow()
    upsert_tenants()
    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
