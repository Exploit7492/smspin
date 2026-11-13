// Multi-tenant transactional email dispatcher (Novu).
//
// Drains the `email_queue` table and sends each message through Novu, branded
// for the store the message belongs to. This is the serverless twin of the
// backend's dispatch_email_queue(): both share one infrastructure (Novu) and
// one tenancy model (`email_queue.tenant_slug` -> `email_sender()`).
//
// The full branded HTML is rendered here (see _shared/email_template.ts) and
// handed to Novu as `payload.html`. Novu only transports the message, so the
// layout, colours, logo and fonts follow the sending store exactly and never
// depend on Novu's own template engine.
//
// Invoke from pg_cron / a schedule, or on demand:
//   curl -X POST "$SUPABASE_URL/functions/v1/email" -H "Authorization: Bearer $SERVICE_ROLE"
//
// Body (optional): { "limit": 20, "requeue": false }
import { createClient } from "npm:@supabase/supabase-js@2";
import { type EmailBrand, type EmailContent, type EmailRow, renderBrandedEmail } from "../_shared/email_template.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOVU_KEY = Deno.env.get("NOVU_API_KEY") || "";
const NOVU_BASE = (Deno.env.get("NOVU_BASE") || "https://api.novu.co").replace(/\/$/, "");
const WORKFLOW = Deno.env.get("NOVU_WORKFLOW") || "smspin-transactional";
const SITE_URL = (Deno.env.get("SMSPIN_SITE_URL") || "https://smspin.io").replace(/\/$/, "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Ident = EmailBrand & { tenant_id: string; theme?: string };

const PLATFORM: Ident = {
  tenant_id: "smspin-platform", brand_name: "SMSPin", primary_color: "#E11D2E",
  secondary_color: "#F26B7A", support_email: "support@smspin.io", logo_url: null,
  footer: "You are receiving this because you have an account with SMSPin.",
  site_url: SITE_URL, tagline: "Virtual numbers",
};

// Compose the workflow payload for one event. Mirrors backend/novu.py:send_event
// so the backend worker and this serverless worker produce identical mail.
function compose(event: string, brand: string, ident: Ident, p: Record<string, unknown>): EmailContent {
  const currency = (p.currency as string) || "NGN";
  const row = (icon: string, label: string, value: unknown): EmailRow =>
    ({ icon, label, value: String(value ?? "—") });
  switch (event) {
    case "welcome":
      return {
        subject: `Welcome to ${brand}`,
        heading: `Welcome, ${p.name || "there"}!`,
        icon: "👋",
        preheader: `Your ${brand} account is ready.`,
        paragraphs: [
          `Your ${brand} account is ready. Fund your wallet and get a virtual number in seconds.`,
          "If you did not create this account you can ignore this email.",
        ],
        ctaUrl: `${SITE_URL}/dashboard/`, ctaLabel: "Open your dashboard",
      };
    case "receipt":
      return {
        subject: `Your ${brand} receipt — ${currency} ${p.amount}`,
        heading: "Payment received",
        icon: "🧾",
        preheader: `We credited your ${brand} wallet with ${currency} ${p.amount}.`,
        paragraphs: ["We credited your wallet. Your balance is available for new orders right away."],
        rows: [
          row("💳", "Amount", `${currency} ${p.amount}`),
          row("🏦", "Method", p.method || "—"),
          row("🔖", "Reference", p.ref || "—"),
        ],
        ctaUrl: `${SITE_URL}/dashboard/wallet/`, ctaLabel: "View wallet",
      };
    case "refund":
      return {
        subject: `Your ${brand} refund`,
        heading: "Refund processed",
        icon: "↩️",
        preheader: `We refunded ${currency} ${p.amount} to your ${brand} wallet.`,
        paragraphs: [
          `We refunded ${currency} ${p.amount} to your wallet for order #${p.order_id}.`,
          "The amount is available now and can be used for another number or withdrawn per the refund policy.",
        ],
        rows: [
          row("💵", "Amount", `${currency} ${p.amount}`),
          row("🧾", "Order", `#${p.order_id}`),
          row("📝", "Reason", p.reason || "order could not be completed"),
        ],
        ctaUrl: `${SITE_URL}/dashboard/wallet/`, ctaLabel: "View wallet",
      };
    case "apk":
      return {
        subject: `Your ${brand} app is ready`,
        heading: `${p.app_name || brand} for Android`,
        icon: "📱",
        preheader: `Your branded ${brand} app build is ready to download.`,
        paragraphs: [
          `Your branded app build (v${p.version || "1.0.0"}) is ready to download and install on any Android device.`,
          `This link is time-limited. Contact ${ident.support_email || brand} if it has expired.`,
        ],
        rows: [
          row("🏷️", "App", p.app_name || brand),
          row("🔢", "Version", p.version || "1.0.0"),
        ],
        ctaUrl: p.download_url as string, ctaLabel: "Download the app",
      };
    case "security":
      return {
        subject: `${brand} security notice`,
        heading: (p.title as string) || "Security notice",
        icon: "🔐",
        preheader: `A security event happened on your ${brand} account.`,
        paragraphs: [
          (p.body as string) || "",
          `If this was not you, contact ${ident.support_email || brand} immediately.`,
        ],
        rows: p.when ? [row("🕒", "When", p.when)] : [],
      };
    default:
      return {
        subject: (p.subject as string) || `${brand} update`,
        heading: (p.heading as string) || (p.subject as string) || `${brand} update`,
        icon: "✉️",
        paragraphs: [(p.body as string) || ""],
        ctaUrl: p.cta_url as string, ctaLabel: p.cta_label as string,
      };
  }
}

async function novuTrigger(body: unknown) {
  const r = await fetch(`${NOVU_BASE}/v1/events/trigger`, {
    method: "POST",
    headers: {
      Authorization: "ApiKey " + NOVU_KEY,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; smspin-email/1.0)",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text || "{}"); } catch { /* non-JSON */ }
  return { status: r.status, data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!NOVU_KEY) return json({ error: "NOVU_API_KEY not configured" }, 500);

  let body: { limit?: number; requeue?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const limit = Math.min(Math.max(Number(body.limit || 20), 1), 100);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (body.requeue) {
    const { data } = await db.rpc("email_requeue_failed", { p_tenant_slug: null });
    return json({ requeued: data ?? 0 });
  }

  const { data: pending, error } = await db.rpc("email_queue_pending", { p_limit: limit });
  if (error) return json({ error: error.message }, 500);

  const identCache = new Map<string, Ident>();
  async function ident(slug: string | null): Promise<Ident> {
    const key = slug || "";
    if (identCache.has(key)) return identCache.get(key)!;
    const { data } = await db.rpc("email_sender", { p_slug: slug });
    const v = (data && data.tenant_id ? { ...data, site_url: SITE_URL } : PLATFORM) as Ident;
    identCache.set(key, v);
    return v;
  }

  let sent = 0, failed = 0;
  const results: unknown[] = [];
  for (const m of (pending || []) as Array<Record<string, unknown>>) {
    const slug = (m.tenant_slug as string) || null;
    const to = m.to_email as string;
    const tpl = (m.template as string) || "notice";
    const id = await ident(slug);
    const event = tpl === "winback" || tpl === "abandoned_fund" ? "notice" : tpl;
    const payload = (m.payload as Record<string, unknown>) || {};
    const content = compose(event, id.brand_name, id, payload);
    const html = renderBrandedEmail(id, content);
    const sub = `smspin:${slug || "platform"}:${to}`.toLowerCase();

    const { status, data } = await novuTrigger({
      name: WORKFLOW,
      to: { subscriberId: sub, email: to, ...(payload.name ? { firstName: String(payload.name).split(" ")[0] } : {}) },
      tenant: { identifier: id.tenant_id },
      payload: {
        subject: content.subject,
        heading: content.heading,
        html,
        // Kept for the plain-text alternative some providers render.
        paragraphs: content.paragraphs,
        brand_name: id.brand_name,
        support_email: id.support_email,
      },
    });

    const d = (data.data as Record<string, unknown>) || {};
    const ok = status >= 200 && status < 300 && !data.error && d.status !== "no_tenant_found";
    const providerRef = (d.transactionId as string) || null;
    await db.rpc("email_queue_mark", {
      p_id: m.id, p_ok: ok, p_error: ok ? null : JSON.stringify(data).slice(0, 300),
      p_provider: "novu", p_ref: providerRef,
    });
    if (ok) sent++; else failed++;
    results.push({ id: m.id, template: tpl, tenant: slug || "platform", ok });
  }

  return json({ processed: results.length, sent, failed, results });
});
