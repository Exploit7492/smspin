// Multi-tenant branded transactional email renderer.
//
// Every account — the platform and each white-label store — sends through ONE
// shared Novu environment, but the HTML below is rendered per-sender from the
// store's own row in `businesses` (name, logo, colours, support address). The
// result is passed to Novu as `payload.html`, so Novu only transports it; no
// branding variable ever has to survive Novu's template engine (which rejects
// `tenant.data.*`), and the two dispatchers (edge `email` fn and the Python
// worker) can render byte-identical mail.
//
// The layout is a full email: preheader, brand bar with logo/wordmark, hero
// heading, body copy, an optional detail card, a CTA button, and a branded
// footer with the support address.

export type EmailBrand = {
  brand_name: string;
  from_name?: string | null;
  primary_color?: string | null;
  secondary_color?: string | null;
  support_email?: string | null;
  reply_to?: string | null;
  logo_url?: string | null;
  footer?: string | null;
  site_url?: string | null;
  tagline?: string | null;
};

export type EmailRow = { icon: string; label: string; value: string };

export type EmailContent = {
  subject: string;
  heading: string;
  preheader?: string;
  icon?: string;
  paragraphs: string[];
  rows?: EmailRow[];
  ctaUrl?: string;
  ctaLabel?: string;
};

// Named themes shared with the storefront (site/tenant-brand.js) so a store's
// email palette matches its website palette when only a theme name is set.
const THEMES: Record<string, [string, string]> = {
  crimson: ["#E11D2E", "#F26B7A"],
  ocean: ["#0EA5E9", "#38BDF8"],
  emerald: ["#10B981", "#34D399"],
  violet: ["#7C3AED", "#A78BFA"],
  amber: ["#F59E0B", "#FCD34D"],
  rose: ["#E11D48", "#FB7185"],
  slate: ["#475569", "#94A3B8"],
  midnight: ["#1E293B", "#334155"],
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const INK = "#1f2933";
const MUTED = "#7b8794";
const LINE = "#eceff3";
const PAGE = "#eef1f8";

function hexToRgb(hex: string): [number, number, number] | null {
  const m = String(hex || "").trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function toHex(rgb: number[]): string {
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
function mix(hex: string, pct: number, base: [number, number, number]): string {
  const c = hexToRgb(hex);
  if (!c) return hex;
  return toHex(c.map((v, i) => v + (base[i] - v) * pct));
}
const darken = (hex: string, pct: number) => mix(hex, pct, [0, 0, 0]);
function rgba(hex: string, a: number): string {
  const c = hexToRgb(hex);
  return c ? `rgba(${c[0]},${c[1]},${c[2]},${a})` : `rgba(0,0,0,${a})`;
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function palette(brand: EmailBrand) {
  const primary = (brand.primary_color || "").trim() || THEMES.crimson[0];
  const secondary = (brand.secondary_color || "").trim() || darken(primary, 0.25);
  return {
    primary,
    secondary,
    deep: darken(primary, 0.38),
    tint: mix(primary, 0.9, [255, 255, 255]),
    soft: rgba(primary, 0.08),
    line: LINE,
  };
}

/** Render the full branded HTML for one transactional email. */
export function renderBrandedEmail(brand: EmailBrand, content: EmailContent): string {
  const p = palette(brand);
  const name = brand.brand_name || "SMSPin";
  const support = (brand.support_email || "").trim();
  const site = (brand.site_url || "https://smspin.vercel.app").replace(/\/$/, "");
  const footer = brand.footer || `You are receiving this because you have an account with ${name}.`;
  const preheader = content.preheader || content.heading || content.subject;

  const logo = (brand.logo_url || "").trim();
  const brandMark = logo
    ? `<img src="${esc(logo)}" alt="${esc(name)}" height="34" style="height:34px;max-height:34px;display:block;border:0;outline:none;text-decoration:none">`
    : `<span style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:.3px;line-height:34px">${esc(name)}</span>`;

  const iconChip = content.icon
    ? `<div style="width:52px;height:52px;border-radius:14px;background:${p.soft};text-align:center;line-height:52px;font-size:26px;margin:0 0 16px">${esc(content.icon)}</div>`
    : "";

  const paragraphs = content.paragraphs
    .filter((x) => x != null && x !== "")
    .map((t) => `<p style="margin:0 0 14px;color:${INK};font-size:15px;line-height:1.6">${t}</p>`)
    .join("");

  const rows = (content.rows || []).length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;background:${p.tint};border:1px solid ${p.line};border-radius:12px">
        ${(content.rows || []).map((r) => `
        <tr>
          <td style="padding:12px 16px;width:26px;font-size:16px">${esc(r.icon)}</td>
          <td style="padding:12px 8px;color:${MUTED};font-size:13px;text-transform:uppercase;letter-spacing:.4px">${esc(r.label)}</td>
          <td style="padding:12px 16px;color:${INK};font-size:14px;font-weight:600;text-align:right">${esc(r.value)}</td>
        </tr>`).join("")}
      </table>`
    : "";

  const cta = content.ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr>
         <td style="border-radius:10px;background:${p.primary}">
           <a href="${esc(content.ctaUrl)}" style="display:inline-block;padding:13px 26px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:10px">${esc(content.ctaLabel || "Open")}</a>
         </td>
       </tr></table>`
    : "";

  const footerSupport = support
    ? `Need help? <a href="mailto:${esc(support)}" style="color:${p.deep};text-decoration:none;font-weight:600">${esc(support)}</a>`
    : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};font-family:${FONT};-webkit-font-smoothing:antialiased">
<div style="display:none;font-size:1px;color:${PAGE};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};padding:0;margin:0">
  <tr><td align="center" style="padding:28px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${p.line}">
      <tr>
        <td style="background:${p.primary};background-image:linear-gradient(135deg,${p.primary} 0%,${p.secondary} 100%);padding:22px 28px">
          <table role="presentation" width="100%"><tr>
            <td align="left">${brandMark}</td>
            <td align="right" style="color:#ffffff;opacity:.9;font-size:12px;font-weight:600;letter-spacing:.6px;text-transform:uppercase">${esc(brand.tagline || "")}</td>
          </tr></table>
        </td>
      </tr>
      <tr><td style="padding:30px 28px 26px">
        ${iconChip}
        <h1 style="margin:0 0 16px;color:${INK};font-size:22px;line-height:1.3;font-weight:800">${esc(content.heading)}</h1>
        ${paragraphs}
        ${rows}
        ${cta}
      </td></tr>
      <tr><td style="padding:20px 28px;background:#f7f9fc;border-top:1px solid ${p.line}">
        <p style="margin:0 0 6px;color:${MUTED};font-size:12px;line-height:1.6">${esc(footer)}</p>
        <p style="margin:0;color:${MUTED};font-size:12px;line-height:1.6">${footerSupport}</p>
        <p style="margin:10px 0 0;color:${MUTED};font-size:12px">
          <a href="${esc(site)}" style="color:${p.deep};text-decoration:none;font-weight:600">${esc(name)}</a>
          &middot; <a href="${esc(site)}" style="color:${MUTED};text-decoration:none">${esc(site.replace(/^https?:\/\//, ""))}</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
