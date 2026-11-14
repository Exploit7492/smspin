// SMSPin serverless API — the production replacement for backend/server.py's
// HTTP surface. One Edge Function serves every /api/* route; Vercel rewrites
// /api/* here (see vercel.json). All business logic lives in SECURITY DEFINER
// RPCs, so this layer only authenticates, validates, and talks to the provider.
//
// Multi-tenancy: a store customer is an opaque tenant token (x-tenant-token);
// a platform user is a Supabase JWT; a developer is a hashed API key. Every
// outbound email is branded from the tenant the request belongs to.
import {
  admin, asUser, bearer, clientIp, httpJson, sha256Hex, KORA_BASE, KORA_SECRET, FEE_PERCENT,
} from "./util.ts";
import { provider, ProviderError } from "./provider.ts";

const KORA_CHANNELS = [
  { id: "card", label: "Card", note: "Visa, Mastercard, Verve" },
  { id: "bank_transfer", label: "Bank transfer", note: "Instant NGN transfer" },
];
const KORA_CHANNEL_IDS = new Set(KORA_CHANNELS.map((c) => c.id));
const AUP_VERSION_FALLBACK = "1.0";

type Body = Record<string, unknown>;

// --- small helpers -----------------------------------------------------------
async function svc(fn: string, args: Body = {}): Promise<unknown> {
  const { data, error } = await admin().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}
async function svcSoft(fn: string, args: Body = {}): Promise<unknown> {
  try { return await svc(fn, args); } catch { return null; }
}
function num(v: unknown, d = 0): number { const n = Number(v); return Number.isFinite(n) ? n : d; }
function str(v: unknown): string { return v === undefined || v === null ? "" : String(v); }

async function rateOk(key: string, limit: number, window: number): Promise<boolean> {
  const ok = await svcSoft("rate_limit_hit", { p_key: key, p_limit: limit, p_window: window });
  return ok === true;
}

function validPayEmail(email: string): boolean {
  if (!email || !email.includes("@")) return false;
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return false;
  const tld = email.split(".").pop()!.toLowerCase();
  return !["local", "test", "invalid", "example", "localhost"].includes(tld);
}

// --- geo / fx ----------------------------------------------------------------
async function geoFromIp(ip: string): Promise<{ country: string; currency: string; country_name: string }> {
  const clean = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip) ? "" : ip;
  const url = clean ? `https://ipapi.co/${clean}/json/` : "https://ipapi.co/json/";
  try {
    const { status, data } = await httpJson(url);
    if (status === 200 && data.country_code) {
      return { country: str(data.country_code), currency: str(data.currency) || "USD", country_name: str(data.country_name) };
    }
  } catch { /* fall through */ }
  return { country: "NG", currency: "NGN", country_name: "Nigeria" };
}

async function fxConvert(amountNgn: number, to: string) {
  const { data } = await admin().from("fx_rates").select("code,rate");
  const rates: Record<string, number> = {};
  for (const r of (data || []) as Array<{ code: string; rate: number }>) rates[r.code] = Number(r.rate);
  const ngn = rates["NGN"] || 1600;
  const usd = amountNgn / ngn;
  const val = to === "NGN" ? amountNgn : usd * (rates[to] || ngn);
  const sym = ({ NGN: "₦", USD: "$", GBP: "£", EUR: "€", INR: "₹", JPY: "¥", ZAR: "R", KES: "KSh", GHS: "GH₵", CAD: "C$", AUD: "A$" } as Record<string, string>)[to] || "";
  return { currency: to, amount: Math.round(val * 100) / 100, symbol: sym,
           formatted: `${sym}${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim() };
}

async function fundingQuote(amount: number, country: string, currency: string) {
  const { data } = await admin().from("fx_rates").select("code,rate");
  const rates: Record<string, number> = {};
  for (const r of (data || []) as Array<{ code: string; rate: number }>) rates[r.code] = Number(r.rate);
  const usdNgn = rates["NGN"] || 1600;
  const localPerUsd = (cur: string) => (cur.toUpperCase() === "NGN" ? usdNgn : (rates[cur.toUpperCase()] || usdNgn));
  const toNgn = (a: number, cur: string) => Math.round((a * usdNgn / localPerUsd(cur)) * 100) / 100;
  const cur = (currency || "NGN").toUpperCase();
  const cc = (country || "NG").toUpperCase();
  const feeLocal = Math.round(amount * FEE_PERCENT / 100 * 1e4) / 1e4;
  const netLocal = Math.round((amount - feeLocal) * 1e4) / 1e4;
  const amountNgn = toNgn(amount, cur);
  const feeNgn = toNgn(feeLocal, cur);
  return { country: cc, currency: cur, amount: Math.round(amount * 100) / 100, fee: feeLocal,
           net: netLocal, fee_percent: FEE_PERCENT, amount_ngn: amountNgn, fee_ngn: feeNgn,
           net_ngn: Math.round((amountNgn - feeNgn) * 100) / 100, usd_ngn: Math.round(usdNgn * 1e4) / 1e4 };
}

// --- KoraPay -----------------------------------------------------------------
async function korapay(path: string, method: string, body?: unknown) {
  return httpJson(KORA_BASE + path, method, {
    Authorization: "Bearer " + KORA_SECRET, "Content-Type": "application/json",
  }, body);
}

async function creditPayment(ref: string, amount: unknown, channel: unknown, providerRef: unknown) {
  const { data } = await admin().from("payments").select("tenant_account_id").eq("reference", ref).maybeSingle();
  const fn = data && (data as Record<string, unknown>).tenant_account_id
    ? "tenant_credit_wallet_from_payment" : "credit_wallet_from_payment";
  return svc(fn, { p_reference: ref, p_amount: amount, p_channel: channel, p_provider_ref: providerRef });
}

// --- upstream webhook / order helpers ---------------------------------------
async function refundOrder(orderId: number, reason: string) {
  let res: Record<string, unknown> = {};
  try { res = (await svc("refund_order", { p_order_id: orderId, p_reason: reason })) as Record<string, unknown> || {}; }
  catch { return {}; }
  if (!res.already) await notifyRefund(orderId, res.refunded, reason);
  return res;
}

// Queue a tenant-branded refund email + in-app notification for an order. Used
// by the full-refund path above and by admin partial refunds, which call
// refund_order_partial directly.
async function notifyRefund(orderId: number, refunded: unknown, reason: string) {
  const { data } = await admin().from("orders").select("user_id,tenant_account_id,price").eq("id", orderId).maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (!row) return;
  let email: string | null = null;
  if (row.user_id) {
    const { data: p } = await admin().from("profiles").select("email").eq("id", row.user_id).maybeSingle();
    email = (p as Record<string, unknown> | null)?.email as string | null;
  }
  await svcSoft("refund_notice_create", { p_order_id: orderId, p_user: row.user_id, p_tenant: row.tenant_account_id,
    p_email: email, p_amount: refunded ?? row.price, p_reason: reason });
  if (row.user_id) await notifyUserEvent(row.user_id as string, "order.refunded",
    { order_id: orderId, amount: num(refunded ?? row.price), reason, status: "refunded" });
}

async function notifyUserEvent(userId: string | null, event: string, payload: Body) {
  if (!userId) return;
  await svcSoft("customer_webhook_enqueue", { p_user: userId, p_event: event, p_payload: payload });
  const title = ({ "order.created": "Number ready", "order.received": "SMS code received", "order.refunded": "Order refunded" } as Record<string, string>)[event] || event;
  await svcSoft("notify_user", { p_user: userId, p_kind: event.split(".").pop(), p_title: title,
    p_body: payload.detail ?? null, p_href: "/dashboard/orders/" });
}

async function notifyBusinessOrder(businessId: unknown, payload: Body) {
  if (!businessId) return;
  await svcSoft("tenant_webhook_enqueue", { p_business: businessId, p_event: "order.created", p_payload: payload });
}

async function serviceNameMap(): Promise<Record<string, string>> {
  const { data } = await admin().from("services").select("code,name");
  const m: Record<string, string> = {};
  for (const s of (data || []) as Array<{ code: string; name: string }>) m[s.code] = s.name;
  return m;
}

async function localCharge(country: string, service: string, userId: string | null, tenantAccount: string | null): Promise<number | null> {
  const { data: cat } = await admin().from("number_catalog").select("price")
    .eq("country_code", country).eq("service_code", service).eq("active", true).gt("stock", 0)
    .order("price", { ascending: true }).limit(1).maybeSingle();
  if (!cat) return null;
  let pct = 0;
  if (tenantAccount) {
    const { data: ta } = await admin().from("tenant_accounts").select("business_id").eq("id", tenantAccount).maybeSingle();
    if (ta) {
      const { data: b } = await admin().from("businesses").select("markup_percent").eq("id", (ta as Record<string, unknown>).business_id).maybeSingle();
      pct = num((b as Record<string, unknown> | null)?.markup_percent);
    }
  } else if (userId) {
    const { data: b } = await admin().from("businesses").select("markup_percent")
      .eq("user_id", userId).is("parent_id", null).eq("status", "active").limit(1).maybeSingle();
    pct = num((b as Record<string, unknown> | null)?.markup_percent);
  }
  const { data: rate } = await admin().from("fx_rates").select("rate").eq("code", "NGN").maybeSingle();
  const ngn = num((rate as Record<string, unknown> | null)?.rate, 1600);
  const usd = Math.max(2, Math.round(num((cat as Record<string, unknown>).price) * (1 + pct / 100) / ngn));
  return Math.round(usd * ngn);
}

async function walletBalance(userId: string | null, tenantAccount: string | null): Promise<number> {
  if (tenantAccount) {
    const { data } = await admin().from("tenant_wallets").select("balance").eq("account_id", tenantAccount).maybeSingle();
    return num((data as Record<string, unknown> | null)?.balance);
  }
  const { data } = await admin().from("wallets").select("balance").eq("user_id", userId).maybeSingle();
  return num((data as Record<string, unknown> | null)?.balance);
}

async function buyReal(country: string, service: string, userId: string | null, tenantAccount: string | null, operator: unknown) {
  const p = provider();
  if (!p.enabled()) throw new Error("upstream disabled");
  p.setServiceNames(await serviceNameMap());
  const cc = country.toLowerCase();
  let charge = await localCharge(cc, service, userId, tenantAccount);
  if (charge === null) { await syncPair(cc, service, true); charge = await localCharge(cc, service, userId, tenantAccount); }
  if (charge !== null && await walletBalance(userId, tenantAccount) < charge) throw new Error("insufficient balance");
  const res = (await svc("reserve_number", { p_user: userId, p_country: cc, p_service: service,
    p_tenant_account: tenantAccount, p_operator: operator ?? null })) as Record<string, unknown>;
  const orderId = res.order_id as number;
  let up: Record<string, unknown>;
  try {
    up = await p.createOrder(cc, service) as Record<string, unknown>;
  } catch (e) {
    await refundOrder(orderId, "provider_error");
    throw new Error(e instanceof Error ? e.message : "provider error");
  }
  const phone = str(up.phoneNumber || up.phone_number);
  const upId = str(up.id);
  if (!phone || !upId) { await refundOrder(orderId, "no_number"); throw new Error("provider did not return a number"); }
  await svc("set_order_upstream", { p_order_id: orderId, p_phone: phone, p_upstream_id: upId,
    p_operator: up.operator ?? null, p_cost_usd: up.price ?? null });
  const { data: orow } = await admin().from("orders").select("business_id,user_id").eq("id", orderId).maybeSingle();
  const r = orow as Record<string, unknown> | null;
  await notifyBusinessOrder(r?.business_id, { order_id: orderId, country: cc, service, phone_number: phone, price_ngn: res.price_ngn, status: "waiting" });
  await notifyUserEvent((r?.user_id as string) || null, "order.created", { order_id: orderId, country: cc, service, phone_number: phone, price_ngn: res.price_ngn, status: "waiting" });
  return { order_id: orderId, phone_number: phone, price_ngn: res.price_ngn, base_ngn: res.base_ngn,
           markup_ngn: res.markup_ngn, status: "waiting", upstream_order_id: upId };
}

async function rentPricesReal(country: string, service: string) {
  const p = provider();
  if (!p.enabled()) return { service, country: country || null, countries: [], durations: [] };
  p.setServiceNames(await serviceNameMap());
  const raw = await p.rentPrices(service, country) as Record<string, unknown>;
  const { data: rate } = await admin().from("fx_rates").select("rate").eq("code", "NGN").maybeSingle();
  const ngn = num((rate as Record<string, unknown> | null)?.rate, 1600);
  const { data: mk } = await admin().from("settings").select("value").eq("key", "markup_percent").maybeSingle();
  const markup = num((mk as Record<string, unknown> | null)?.value, 100);
  const shaped = (usd: number) => {
    const priceUsd = Math.round(usd * (1 + markup / 100) * 100) / 100;
    return { price_usd: priceUsd, price_usd_raw: usd, price_ngn: Math.round(priceUsd * ngn) };
  };
  const durations = ((raw.durations as Array<Record<string, unknown>>) || []).map((d) => ({ ...d, ...shaped(num(d.price)) }));
  const countries = ((raw.countries as Array<Record<string, unknown>>) || []).map((c) => ({ ...c, ...shaped(num(c.fromPrice)) }));
  return { service, country: raw.country ?? (country || null), countries, durations };
}

async function rentReal(country: string, service: string, duration: number, userId: string | null, tenantAccount: string | null) {
  const p = provider();
  if (!p.enabled()) throw new Error("upstream disabled");
  p.setServiceNames(await serviceNameMap());
  const cc = country.toLowerCase();
  const quotes = (await rentPricesReal(cc, service)).durations as Array<Record<string, unknown>>;
  const pick = quotes.find((q) => num(q.hours ?? q.durationHours) === duration) || quotes[0];
  if (!pick) throw new Error("rental not available for this pair");
  const charge = num(pick.price_ngn);
  if (await walletBalance(userId, tenantAccount) < charge) throw new Error("insufficient balance");
  const res = (await svc("reserve_rental", { p_user: userId, p_country: cc, p_service: service,
    p_duration: duration, p_price_ngn: charge, p_tenant_account: tenantAccount })) as Record<string, unknown>;
  const orderId = res.order_id as number;
  const cap = pick.price_usd_raw ?? pick.price_usd;
  let up: Record<string, unknown>;
  try { up = await p.createRental(service, cc.toUpperCase(), duration, cap as number) as Record<string, unknown>; }
  catch (e) { await refundOrder(orderId, "provider_error"); throw new Error(e instanceof Error ? e.message : "provider error"); }
  const phone = str(up.phoneNumber || up.phone_number);
  const upId = str(up.id);
  if (!phone || !upId) { await refundOrder(orderId, "no_number"); throw new Error("provider did not return a number"); }
  await svc("set_order_upstream", { p_order_id: orderId, p_phone: phone, p_upstream_id: upId, p_cost_usd: pick.price_usd ?? null });
  return { order_id: orderId, phone_number: phone, price_ngn: charge, price_usd: pick.price_usd,
           duration, status: "waiting", upstream_order_id: upId };
}

async function syncPair(country: string, service: string, force: boolean) {
  const p = provider();
  if (!p.enabled()) return null;
  const { data: known } = await admin().from("countries").select("code").eq("code", country).maybeSingle();
  const { data: svcRow } = await admin().from("services").select("code").eq("code", service).maybeSingle();
  if (!known || !svcRow) return null;
  if (!force) {
    const { data: fresh } = await admin().from("number_catalog").select("updated_at")
      .eq("country_code", country).eq("service_code", service).gt("updated_at", new Date(Date.now() - 15 * 60000).toISOString()).maybeSingle();
    if (fresh) return null;
  }
  p.setServiceNames(await serviceNameMap());
  let live: Record<string, unknown>;
  try { live = await p.livePrice(country, service) as Record<string, unknown>; }
  catch { return null; }
  const cost = live.price_usd as number | null;
  await svcSoft("catalog_upsert", { p_items: [{ country, service, cost_usd: cost ?? 0, stock: cost === null ? 0 : num(live.available) }] });
  return live;
}

async function upstreamWebhook(payload: Body) {
  const upId = str(payload.id || payload.order_id);
  if (!upId) { await svcSoft("dlq_enqueue", { p_source: "upstream", p_event: payload.event, p_payload: payload, p_error: "missing order id" }); return { received: true, matched: false }; }
  const row = (await svcSoft("order_by_upstream", { p_upstream_id: upId })) as Record<string, unknown> | null;
  if (!row) { await svcSoft("dlq_enqueue", { p_source: "upstream", p_event: payload.event, p_payload: payload, p_error: "no local order for " + upId }); return { received: true, matched: false }; }
  const orderId = (row.order_id || row.id) as number;
  const code = payload.otpCode || payload.otp_code || payload.code;
  const status = str(payload.status).toLowerCase();
  if (code) {
    await svc("record_sms", { p_order_id: orderId, p_sender: payload.service || row.service,
      p_body: `Verification code: ${code}`, p_code: str(code), p_received_at: payload.createdAt ?? null });
    await notifyUserEvent((row.user_id as string) || null, "order.received", { order_id: orderId, code: str(code), status: "received" });
    return { received: true, matched: true, otp: true };
  }
  if (["cancelled", "expired", "failed"].includes(status)) { await refundOrder(orderId, `webhook_${status}`); return { received: true, matched: true, refunded: true }; }
  return { received: true, matched: true };
}

// --- auth helpers ------------------------------------------------------------
async function requireAdmin(req: Request): Promise<string | null> {
  const token = bearer(req);
  if (!token) return null;
  const { data } = await asUser(token).rpc("my_profile");
  const email = data ? (data as Record<string, unknown>).email as string : "";
  if (!email) return null;
  const ok = await svcSoft("is_admin", { p_email: email });
  return ok ? email : null;
}
async function apiKeyUser(req: Request): Promise<{ user: string; key: Record<string, unknown> } | { reject: [number, Body] } | null> {
  let key = req.headers.get("x-api-key") || "";
  const auth = req.headers.get("Authorization") || "";
  if (!key && (auth.startsWith("Bearer sk_") || auth.startsWith("Bearer sk_test_"))) key = auth.slice(7);
  if (!key) return null;
  const h = await sha256Hex(key);
  const info = (await svcSoft("api_key_by_hash", { p_hash: h })) as Record<string, unknown> | null;
  if (!info || info.revoked) return null;
  const allow = (info.ip_allowlist as string[]) || [];
  if (allow.length && !allow.includes(clientIp(req))) return { reject: [403, { error: "ip not allowed for this key", code: "ip_denied" }] };
  const quota = num(info.quota_month);
  if (quota && num(info.used_month) >= quota) return { reject: [429, { error: "monthly quota exceeded", code: "quota_exceeded" }] };
  if (!(await rateOk(`apikey:${info.id}`, num(info.rate_limit, 60), 60))) return { reject: [429, { error: "rate limit exceeded", code: "rate_limited" }] };
  await admin().from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("key_hash", h);
  return { user: info.user_id as string, key: info };
}
async function tenantKeyInfo(req: Request): Promise<Record<string, unknown> | null> {
  let key = req.headers.get("x-tenant-key") || "";
  const auth = req.headers.get("Authorization") || "";
  if (!key && auth.startsWith("Bearer tk_")) key = auth.slice(7);
  if (!key) return null;
  const h = await sha256Hex(key);
  const info = (await svcSoft("tenant_resolve_api_key", { p_hash: h })) as Record<string, unknown> | null;
  if (!info) return null;
  await admin().from("tenant_api_keys").update({ last_used_at: new Date().toISOString() }).eq("key_hash", h);
  return info;
}

export { svc, svcSoft, num, str, rateOk, geoFromIp, fxConvert, fundingQuote, korapay, creditPayment,
  refundOrder, notifyRefund, notifyUserEvent, buyReal, rentReal, rentPricesReal, syncPair, upstreamWebhook,
  requireAdmin, apiKeyUser, tenantKeyInfo, validPayEmail, KORA_CHANNELS, KORA_CHANNEL_IDS, AUP_VERSION_FALLBACK,
  provider, ProviderError };
