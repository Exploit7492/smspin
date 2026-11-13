"""Multi-tenant branded transactional email renderer (Python twin).

Mirrors ``supabase/functions/_shared/email_template.ts`` so the backend worker
and the serverless dispatcher produce byte-identical mail. The full HTML is
rendered per-sender from the store's own branding row and handed to Novu as
``payload.html`` — Novu only transports it, so no branding variable has to
survive Novu's template engine.
"""
from __future__ import annotations

import html as _html

THEMES = {
    "crimson": ("#E11D2E", "#F26B7A"),
    "ocean": ("#0EA5E9", "#38BDF8"),
    "emerald": ("#10B981", "#34D399"),
    "violet": ("#7C3AED", "#A78BFA"),
    "amber": ("#F59E0B", "#FCD34D"),
    "rose": ("#E11D48", "#FB7185"),
    "slate": ("#475569", "#94A3B8"),
    "midnight": ("#1E293B", "#334155"),
}

FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"
INK, MUTED, LINE, PAGE = "#1f2933", "#7b8794", "#eceff3", "#eef1f8"


def _hex_to_rgb(value):
    v = str(value or "").strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) != 6:
        return None
    try:
        return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None


def _hex(rgb):
    return "#" + "".join("%02x" % max(0, min(255, round(c))) for c in rgb)


def _mix(color, pct, base):
    c = _hex_to_rgb(color)
    if not c:
        return color
    return _hex([c[i] + (base[i] - c[i]) * pct for i in range(3)])


def _darken(color, pct):
    return _mix(color, pct, (0, 0, 0))


def _rgba(color, a):
    c = _hex_to_rgb(color)
    return "rgba(%d,%d,%d,%s)" % (c[0], c[1], c[2], a) if c else "rgba(0,0,0,%s)" % a


def _esc(s):
    return _html.escape(str("" if s is None else s), quote=True)


def _palette(brand):
    primary = (brand.get("primary_color") or "").strip() or THEMES["crimson"][0]
    secondary = (brand.get("secondary_color") or "").strip() or _darken(primary, 0.25)
    return {
        "primary": primary,
        "secondary": secondary,
        "deep": _darken(primary, 0.38),
        "tint": _mix(primary, 0.9, (255, 255, 255)),
        "soft": _rgba(primary, 0.08),
    }


def render(brand, content):
    """Render the full branded HTML for one transactional email.

    ``brand`` is an email_sender() dict; ``content`` is a dict with subject,
    heading, paragraphs, optional icon/preheader/rows/ctaUrl/ctaLabel.
    """
    p = _palette(brand)
    name = brand.get("brand_name") or "SMSPin"
    support = (brand.get("support_email") or "").strip()
    site = (brand.get("site_url") or "https://smspin.io").rstrip("/")
    footer = brand.get("footer") or ("You are receiving this because you have an account with %s." % name)
    preheader = content.get("preheader") or content.get("heading") or content.get("subject") or ""

    logo = (brand.get("logo_url") or "").strip()
    if logo:
        mark = ('<img src="%s" alt="%s" height="34" style="height:34px;max-height:34px;'
                'display:block;border:0;outline:none;text-decoration:none">' % (_esc(logo), _esc(name)))
    else:
        mark = ('<span style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:.3px;'
                'line-height:34px">%s</span>' % _esc(name))

    icon = content.get("icon")
    icon_chip = ('<div style="width:52px;height:52px;border-radius:14px;background:%s;text-align:center;'
                 'line-height:52px;font-size:26px;margin:0 0 16px">%s</div>' % (p["soft"], _esc(icon))) if icon else ""

    paragraphs = "".join(
        '<p style="margin:0 0 14px;color:%s;font-size:15px;line-height:1.6">%s</p>' % (INK, _esc(t))
        for t in content.get("paragraphs", []) if t)

    rows_html = ""
    rows = content.get("rows") or []
    if rows:
        body = "".join(
            '<tr><td style="padding:12px 16px;width:26px;font-size:16px">%s</td>'
            '<td style="padding:12px 8px;color:%s;font-size:13px;text-transform:uppercase;letter-spacing:.4px">%s</td>'
            '<td style="padding:12px 16px;color:%s;font-size:14px;font-weight:600;text-align:right">%s</td></tr>'
            % (_esc(r.get("icon")), MUTED, _esc(r.get("label")), INK, _esc(r.get("value"))) for r in rows)
        rows_html = ('<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" '
                     'style="margin:6px 0 20px;background:%s;border:1px solid %s;border-radius:12px">%s</table>'
                     % (p["tint"], LINE, body))

    cta = ""
    if content.get("ctaUrl"):
        cta = ('<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr>'
               '<td style="border-radius:10px;background:%s">'
               '<a href="%s" style="display:inline-block;padding:13px 26px;color:#ffffff;font-size:15px;'
               'font-weight:700;text-decoration:none;border-radius:10px">%s</a></td></tr></table>'
               % (p["primary"], _esc(content["ctaUrl"]), _esc(content.get("ctaLabel") or "Open")))

    footer_support = ('Need help? <a href="mailto:%s" style="color:%s;text-decoration:none;font-weight:600">%s</a>'
                      % (_esc(support), p["deep"], _esc(support))) if support else ""

    return """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>%(subject)s</title>
</head>
<body style="margin:0;padding:0;background:%(page)s;font-family:%(font)s;-webkit-font-smoothing:antialiased">
<div style="display:none;font-size:1px;color:%(page)s;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">%(preheader)s</div>
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:%(page)s;padding:0;margin:0">
  <tr><td align="center" style="padding:28px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid %(line)s">
      <tr><td style="background:%(primary)s;background-image:linear-gradient(135deg,%(primary)s 0%%,%(secondary)s 100%%);padding:22px 28px">
        <table role="presentation" width="100%%"><tr>
          <td align="left">%(mark)s</td>
          <td align="right" style="color:#ffffff;opacity:.9;font-size:12px;font-weight:600;letter-spacing:.6px;text-transform:uppercase">%(tagline)s</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:30px 28px 26px">
        %(icon)s
        <h1 style="margin:0 0 16px;color:%(ink)s;font-size:22px;line-height:1.3;font-weight:800">%(heading)s</h1>
        %(paragraphs)s
        %(rows)s
        %(cta)s
      </td></tr>
      <tr><td style="padding:20px 28px;background:#f7f9fc;border-top:1px solid %(line)s">
        <p style="margin:0 0 6px;color:%(muted)s;font-size:12px;line-height:1.6">%(footer)s</p>
        <p style="margin:0;color:%(muted)s;font-size:12px;line-height:1.6">%(support)s</p>
        <p style="margin:10px 0 0;color:%(muted)s;font-size:12px">
          <a href="%(site)s" style="color:%(deep)s;text-decoration:none;font-weight:600">%(name)s</a>
          &middot; <a href="%(site)s" style="color:%(muted)s;text-decoration:none">%(host)s</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>""" % {
        "subject": _esc(content.get("subject")), "page": PAGE, "font": FONT,
        "preheader": _esc(preheader), "line": LINE, "primary": p["primary"],
        "secondary": p["secondary"], "mark": mark, "tagline": _esc(brand.get("tagline")),
        "icon": icon_chip, "ink": INK, "heading": _esc(content.get("heading")),
        "paragraphs": paragraphs, "rows": rows_html, "cta": cta, "muted": MUTED,
        "footer": _esc(footer), "support": footer_support, "deep": p["deep"],
        "site": _esc(site), "name": _esc(name), "host": _esc(site.split("//")[-1]),
    }
