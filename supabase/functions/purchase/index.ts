// Number purchases — server-side only. The browser only sees "purchase".
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing bearer token" }, 401);

  let body: { country?: string; service?: string; store?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const { country, service, store } = body;
  if (!country || !service) return json({ error: "country and service required" }, 400);

  const user = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { persistSession: false },
  });

  const { data, error } = store
    ? await user.rpc("buy_number_store", { p_slug: store, p_country: country, p_service: service })
    : await user.rpc("buy_number", { p_country: country, p_service: service });

  if (error) {
    const msg = error.message || "purchase failed";
    return json({ error: msg }, 400);
  }
  return json({ ok: true, order: data });
});
