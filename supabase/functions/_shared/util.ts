// Shared helpers for the SMSPin serverless API (Supabase Edge Functions).
//
// One infrastructure, one tenancy model: every function talks to the same
// Postgres (all business logic lives in SECURITY DEFINER RPCs), authenticates
// the same way (Supabase JWT for users, opaque token for store customers,
// hashed key for the public API), and brands every outbound message from the
// tenant the request belongs to.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const SITE_URL = (Deno.env.get("SMSPIN_SITE_URL") || "https://smspin.io").replace(/\/$/, "");

export const KORA_BASE = "https://api.korapay.com/merchant/api/v1";
export const KORA_MODE = Deno.env.get("KORA_MODE") || "test";
export const KORA_SECRET = KORA_MODE === "live"
  ? Deno.env.get("KORA_SECRET_KEY")!
  : Deno.env.get("KORA_TEST_SECRET_KEY")!;
export const KORA_PUBLIC = KORA_MODE === "live"
  ? (Deno.env.get("KORA_PUBLIC_KEY") || "")
  : (Deno.env.get("KORA_TEST_PUBLIC_KEY") || "");
export const SMSPOOL_KEY = Deno.env.get("SMSPOOL_API_KEY") || "";
export const FEE_PERCENT = 2.5;

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-tenant-token, x-api-key, idempotency-key, x-webhook-secret, x-korapay-signature",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body ?? {}), {
    status, headers: { ...cors, "Content-Type": "application/json", ...extra },
  });
}

// Service-role client: bypasses RLS. Only used for RPCs that are themselves
// SECURITY DEFINER and do their own authorization, or for admin-gated reads.
export function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// A client that carries the caller's JWT so RLS + auth.uid() apply.
export function asUser(token: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { persistSession: false },
  });
}

export function bearer(req: Request): string {
  return (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

export function clientIp(req: Request): string {
  // Vercel (which rewrites /api/* to this function) records the true client IP
  // in x-vercel-forwarded-for and overwrites x-forwarded-for with its own edge
  // address. Prefer the Vercel header, fall back to XFF for direct calls.
  const v = req.headers.get("x-vercel-forwarded-for") || "";
  const xf = v || req.headers.get("x-forwarded-for") || "";
  return (xf.split(",")[0] || "").trim() || "0.0.0.0";
}

// Public base URL for redirect/notification links, derived from the request so
// it works on the production domain, a preview URL, or localhost.
export function baseUrl(req: Request): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "smspin.io";
  const proto = (req.headers.get("x-forwarded-proto") || "https").split(",")[0];
  return `${proto}://${host}`;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function httpJson(url: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) {
  const r = await fetch(url, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  return { status: r.status, data: data as Record<string, unknown> };
}

// --- auth resolution ---------------------------------------------------------

export async function authUser(req: Request): Promise<string | null> {
  const token = bearer(req);
  if (!token || token === ANON_KEY) return null;
  const { data, error } = await asUser(token).rpc("my_profile");
  if (error || !data) return null;
  return (data as Record<string, unknown>).id as string;
}

export async function authTenant(req: Request, tokenOverride?: string): Promise<Record<string, unknown> | null> {
  const token = tokenOverride || req.headers.get("x-tenant-token") || "";
  if (!token) return null;
  const { data, error } = await admin().rpc("tenant_me", { p_token: token });
  if (error || !data || data === "null") return null;
  return data as Record<string, unknown>;
}

export async function callerEmail(req: Request): Promise<string | null> {
  const token = bearer(req);
  if (!token) return null;
  const { data } = await asUser(token).rpc("my_profile");
  return data ? ((data as Record<string, unknown>).email as string) : null;
}
