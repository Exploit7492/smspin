// Multi-tenant transactional email dispatcher (Novu).
//
// Drains the `email_queue` table and sends each message through Novu, branded
// for the store the message belongs to. This is the serverless twin of the
// backend's dispatch_email_queue(): both share one infrastructure (Novu) and
// one tenancy model (`email_queue.tenant_slug` -> `email_sender()`).
//
// Invoke from pg_cron / a schedule, or on demand:
//   curl -X POST "$SUPABASE_URL/functions/v1/email" -H "Authorization: Bearer $SERVICE_ROLE"
//
// Body (optional): { "limit": 20, "requeue": false }
import { createClient } from "npm:@supabase/supabase-js@2";

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

type Ident = {
  tenant_id: string; brand_name: string; primary_color: string; secondary_color: string;
  support_email: string; logo_url: string | null; footer: string;
};

const PLATFORM: Ident = {
  tenant_id: "smspin-platform", brand_name: "SMSPin", primary_color: "#E11D2E",
  secondary_color: "#F26B7A", support_email: "support@smspin.io", logo_url: null,
  footer: "You are receiving this because you have an account with SMSPin.",
};

// Compose the workflow payload for one event. Mirrors backend/novu.py:send_event
// so the backend worker and this serverless worker produce identical mail.
function compose(event: string, brand: string, ident: Ident, p: Record<string, unknown>) {
  const paragraphs = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x);
  const cta = (url?: string, label?: string) =>
    url ? { ctaUrl: url, ctaLabel: label || "Open" } : {};
  const currency = (p.currency as string) || "NGN";
  switch (event) {
    case "welcome":
      return {
        subject: `Welcome to ${brand}`,
        heading: `Welcome, ${p.name || "there"}!`,
        paragraphs: paragraphs([
          `Your ${brand} account is ready. Fund your wallet and get a virtual number in seconds.`,
          "If you did not create this account you can ignore this email.",
        ]),
        ...cta(`${SITE_URL}/dashboard/`, "Open your dashboard"),
      };
    case "receipt":
      return {
        subject: `Your ${brand} receipt — ${currency} ${p.amount}`,
        heading: "Payment received",
        paragraphs: paragraphs([
          "We credited your wallet.",
          `Amount: ${currency} ${p.amount}`,
          `Method: ${p.method || "—"}`,
          `Reference: ${p.ref || "—"}`,
        ]),
        ...cta(`${SITE_URL}/dashboard/wallet/`, "View wallet"),
      };
    case "refund":
      return {
        subject: `Your ${brand} refund`,
        heading: "Refund processed",
        paragraphs: paragraphs([
          `We refunded ${currency} ${p.amount} to your wallet for order #${p.order_id}.`,
          `Reason: ${p.reason || "order could not be completed"}`,
          "The amount is available now and can be used for another number or withdrawn per the refund policy.",
        ]),
        ...cta(`${SITE_URL}/dashboard/wallet/`, "View wallet"),
      };
    case "apk":
      return {
        subject: `Your ${brand} app is ready`,
        heading: `${p.app_name || brand} for Android`,
        paragraphs: paragraphs([
          `Your branded app build (v${p.version || "1.0.0"}) is ready to download and install on any Android device.`,
          `This link is time-limited. Contact ${ident.support_email} if it has expired.`,
        ]),
        ...cta(p.download_url as string, "Download the app"),
      };
    case "security":
      return {
        subject: `${brand} security notice`,
        heading: (p.title as string) || "Security notice",
        paragraphs: paragraphs([
          (p.body as string) || "",
          p.when ? `When: ${p.when}` : null,
          `If this was not you, contact ${ident.support_email} immediately.`,
        ]),
      };
    default:
      return {
        subject: (p.subject as string) || `${brand} update`,
        heading: (p.heading as string) || (p.subject as string) || `${brand} update`,
        paragraphs: paragraphs([(p.body as string) || JSON.stringify(p)]),
        ...cta(p.cta_url as string, p.cta_label as string),
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
    const v = (data && data.tenant_id ? data : PLATFORM) as Ident;
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
    const sub = `smspin:${slug || "platform"}:${to}`.toLowerCase();

    const { status, data } = await novuTrigger({
      name: WORKFLOW,
      to: { subscriberId: sub, email: to, ...(payload.name ? { firstName: String(payload.name).split(" ")[0] } : {}) },
      tenant: {
        identifier: id.tenant_id,
        data: {
          brand_name: id.brand_name, primary_color: id.primary_color,
          secondary_color: id.secondary_color, support_email: id.support_email,
          logo_url: id.logo_url, footer: id.footer,
        },
      },
      payload: content,
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
