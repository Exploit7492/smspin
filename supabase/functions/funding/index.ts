// Wallet funding — server-side only. The browser never sees RPC names or KoraPay keys.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SITE_URL = (Deno.env.get("SMSPIN_SITE_URL") || "https://smspin.vercel.app").replace(/\/$/, "");
const KORA_BASE = "https://api.korapay.com/merchant/api/v1";
const KORA_MODE = Deno.env.get("KORA_MODE") || "test";
const KORA_SECRET = KORA_MODE === "live"
  ? Deno.env.get("KORA_SECRET_KEY")!
  : Deno.env.get("KORA_TEST_SECRET_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function admin() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function korapay(path: string, method: string, body?: unknown) {
  const r = await fetch(KORA_BASE + path, {
    method,
    headers: { Authorization: "Bearer " + KORA_SECRET, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text || "{}") }; }
  catch { return { status: r.status, data: {} }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing bearer token" }, 401);

  const user = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { persistSession: false },
  });

  let body: { action?: string; amount?: number; reference?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const action = body.action || "initialize";

  if (action === "initialize") {
    const amount = Number(body.amount || 0);
    if (!(amount > 0)) return json({ error: "invalid amount" }, 400);

    const { data: prof, error: perr } = await user.rpc("my_profile");
    if (perr || !prof) return json({ error: "invalid session" }, 401);
    let email = prof.email || "";
    if (!email.includes("@") || email.endsWith(".local")) email = `user-${prof.id || "anon"}@smspin.io`;
    const name = prof.full_name || "SMSPin User";

    const { data: pay, error: cerr } = await user.rpc("create_payment", { p_amount: amount });
    if (cerr || !pay) return json({ error: "could not create payment" }, 400);
    const reference = pay.reference as string;

    const host = SITE_URL;
    const redirect_url = `${host}/dashboard/wallet/?ref=${reference}`;
    const notification_url = `${host}/api/korapay/webhook`;

    const { status, data } = await korapay("/charges/initialize", "POST", {
      amount: Math.round(amount), currency: "NGN", reference,
      redirect_url, notification_url,
      customer: { name, email },
      narration: "SMSPin wallet top-up",
    });
    if (status !== 200 || !data?.status) return json({ error: "checkout unavailable" }, 502);

    const checkout_url = data.data.checkout_url as string;
    await admin().rpc("set_payment_checkout", {
      p_reference: reference, p_checkout_url: checkout_url, p_provider_ref: data.data.reference ?? null,
    });
    return json({ reference, checkout_url });
  }

  if (action === "verify") {
    const reference = String(body.reference || "").trim();
    if (!reference) return json({ error: "reference required" }, 400);
    const { status, data } = await korapay(`/charges/${encodeURIComponent(reference)}`, "GET");
    const d = data?.data || {};
    if (status === 200 && d.status === "success") {
      const { data: credit } = await admin().rpc("credit_wallet_from_payment", {
        p_reference: reference, p_amount: d.amount, p_channel: d.channel ?? null,
        p_provider_ref: d.transaction_reference ?? null,
      });
      return json({ verified: true, status: "success", credit });
    }
    return json({ verified: false, status: d.status || "unknown" });
  }

  return json({ error: "unknown action" }, 400);
});
