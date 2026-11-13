#!/usr/bin/env python3
"""Provision the multi-tenant Novu email infrastructure.

Idempotent. Creates (or updates) the ONE transactional email workflow the whole
platform shares — the Novu plan caps the number of workflows, so every event
(welcome, receipt, refund, app link, security, notice) renders through it — plus
one Novu tenant per store so each store's mail carries its own brand. Run after
changing the template:

    Smspin_novu="$Smspin_novu" Smspin_supabase_Postgresql="$Smspin_supabase_Postgresql" \
        python3 scripts/setup-novu.py

The template reads branding from ``tenant.data`` (see email_sender() in the DB)
and the message content from ``payload`` (see novu.send_event()).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))
import novu  # noqa: E402

WORKFLOW_ID = novu.TRANSACTIONAL_WORKFLOW

# Handlebars template: tenant.data carries the brand, payload carries the copy.
BODY = """<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #eceff3;border-radius:12px;overflow:hidden">
  <div style="background:{{tenant.data.primary_color}};padding:20px 24px">
    {% if tenant.data.logo_url %}<img src="{{tenant.data.logo_url}}" alt="{{tenant.data.brand_name}}" height="28" style="height:28px">
    {% else %}<span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.3px">{{tenant.data.brand_name}}</span>{% endif %}
  </div>
  <div style="padding:24px;color:#1f2933;font-size:15px;line-height:1.55">
    <h2 style="margin:0 0 14px;font-size:20px">{{payload.heading}}</h2>
    {% for p in payload.paragraphs %}<p style="margin:0 0 12px">{{p}}</p>{% endfor %}
    {% if payload.ctaUrl %}<p style="margin:22px 0 6px"><a href="{{payload.ctaUrl}}" style="background:{{tenant.data.primary_color}};color:#ffffff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">{{payload.ctaLabel}}</a></p>{% endif %}
  </div>
  <div style="border-top:1px solid #eceff3;padding:16px 24px;color:#7b8794;font-size:12px">
    {{tenant.data.footer}}<br>
    Need help? <a href="mailto:{{tenant.data.support_email}}" style="color:{{tenant.data.primary_color}}">{{tenant.data.support_email}}</a>
  </div>
</div>"""

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
    try:
        novu._request("/v2/workflows", "POST", WORKFLOW)
        print("workflow created:", WORKFLOW_ID)
        return
    except Exception as e:
        # Already exists (or the plan cap is hit): try to update in place.
        if "maximum number of workflows" in str(e) or "Payment Required" in str(e):
            print("workflow cap reached; attempting update of", WORKFLOW_ID)
    try:
        novu._request("/v2/workflows/" + WORKFLOW_ID, "PUT", WORKFLOW)
        print("workflow updated:", WORKFLOW_ID)
    except Exception as e:
        print("workflow FAILED:", WORKFLOW_ID, str(e)[:200])


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
