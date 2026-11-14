// SMSPin serverless API router.
//
// Vercel rewrites /api/* here (see vercel.json), so this single Edge Function
// replaces the whole HTTP surface of the old Python backend. It authenticates
// the caller, validates input, and delegates every business decision to a
// SECURITY DEFINER RPC — the same RPCs the dashboard already calls directly.
import {
  admin, asUser, authUser, authTenant, bearer, baseUrl, clientIp, cors, json,
  hmacHex, sha256Hex, timingSafeEqual, KORA_MODE, KORA_PUBLIC, KORA_SECRET, SITE_URL,
} from "../_shared/util.ts";
import {
  svc, svcSoft, num, str, rateOk, geoFromIp, fxConvert, fundingQuote, korapay, creditPayment,
  buyReal, rentReal, rentPricesReal, upstreamWebhook, requireAdmin, apiKeyUser, tenantKeyInfo,
  validPayEmail, KORA_CHANNELS, KORA_CHANNEL_IDS, AUP_VERSION_FALLBACK, refundOrder, notifyRefund, provider,
} from "../_shared/core.ts";

type Body = Record<string, unknown>;
const RL: Record<string, [number, number]> = {
  buy: [30, 60], auth: [60, 60], webhook: [600, 60], subscribe: [10, 60],
  consent: [30, 60], review: [10, 60], rpc: [600, 60], default: [240, 60],
};
function one(url: URL, k: string, d: string | null = null) { return url.searchParams.get(k) ?? d; }
// Per-instance process metrics. Edge isolates are short-lived, so these counters
// reset on cold start — the durable ops snapshot lives in the `ops_metrics` RPC.
const METRICS = (() => {
  const started = Date.now();
  let total = 0, errors = 0;
  const statuses: Record<string, number> = {};
  const paths: Record<string, number> = {};
  const latency: number[] = [];
  return {
    record(path: string, status: number, seconds: number) {
      total++; if (status >= 500) errors++;
      statuses[String(status)] = (statuses[String(status)] || 0) + 1;
      paths[path] = (paths[path] || 0) + 1;
      latency.push(seconds); if (latency.length > 500) latency.shift();
    },
    snapshot() {
      const lat = [...latency].sort((a, b) => a - b);
      const pct = (p: number) => lat.length ? Number(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(4)) : 0;
      return {
        uptime_s: Math.round((Date.now() - started) / 100) / 10,
        requests_total: total, errors_5xx: errors, status_counts: { ...statuses },
        top_paths: Object.entries(paths).sort((a, b) => b[1] - a[1]).slice(0, 15),
        latency_p50: pct(0.5), latency_p95: pct(0.95), latency_p99: pct(0.99),
      };
    },
  };
})();
function readJson(req: Request): Promise<Body> {
  return req.json().catch(() => ({})) as Promise<Body>;
}
function aupText(version: string) {
  return {
    policy: "aup", version,
    summary: "SMSPin provides virtual numbers for legitimate account verification and testing. You must not use the service for fraud, spam, harassment, evading lawful sanctions, bulk account farming, or any illegal purpose.",
    rules: [
      "One code per purchase; codes are delivered only to you.",
      "No resale of numbers, codes, or access without written consent.",
      "No use against services you do not own or have permission to test.",
      "Prohibited use leads to suspension and forfeiture of unused balance.",
      "We cooperate with lawful requests from competent authorities.",
    ],
    enforcement: "Automated velocity and blocklist checks run on every purchase. Accounts that breach this policy are suspended; repeated or serious breaches are reported.",
  };
}

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "SMSPin API", version: "1.0.0", description: "Buy virtual numbers and read OTP codes. Authenticate with your own API key from the dashboard (API Keys page)." },
  servers: [{ url: SITE_URL + "/api/v1" }],
  security: [{ ApiKeyAuth: [] }],
  components: { securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" } } },
  paths: {
    "/balance": { get: { summary: "Wallet balance", responses: { 200: { description: "Balance in NGN" } } } },
    "/catalog": { get: { summary: "List available numbers with our prices", parameters: [
      { name: "country", in: "query", schema: { type: "string" } }, { name: "service", in: "query", schema: { type: "string" } }],
      responses: { 200: { description: "Array of {country, service, price_ngn, stock, icon}" } } } },
    "/order": {
      get: { summary: "Get an order and its OTP", parameters: [{ name: "id", in: "query", required: true, schema: { type: "integer" } }], responses: { 200: { description: "Order status and otp" } } },
      post: { summary: "Buy a number (debits your wallet balance)", responses: { 200: { description: "order_id, phone_number, price_ngn, status" }, 402: { description: "insufficient balance or no stock" } } },
    },
  },
};
function postmanCollection() {
  const items: unknown[] = [];
  for (const [path, methods] of Object.entries(OPENAPI.paths)) {
    for (const [verb, op] of Object.entries(methods as Record<string, { summary?: string }>)) {
      items.push({ name: op.summary || path, request: { method: verb.toUpperCase(),
        header: [{ key: "x-api-key", value: "{{api_key}}", type: "text" }],
        url: { raw: "{{base_url}}/api/v1" + path, host: ["{{base_url}}"], path: ("api/v1" + path).split("/") } } });
    }
  }
  return { info: { name: "SMSPin API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description: "Import into Postman. Set base_url and api_key collection variables." },
    variable: [{ key: "base_url", value: SITE_URL }, { key: "api_key", value: "sk_live_your_key" }], item: items };
}

// ============================ GET ============================================
async function handleGet(req: Request, url: URL, path: string): Promise<Response> {
  const ip = clientIp(req);

  if (path === "/api/geo") return json(await geoFromIp(ip));
  if (path === "/api/openapi") return json(OPENAPI);
  if (path === "/api/postman") return json(postmanCollection());
  if (path === "/api/business/manifest") {
    const slug = str(one(url, "slug")).trim();
    if (!slug) return json({ error: "slug required" }, 400);
    const biz = await svcSoft("business_public", { p_slug: slug }) as Record<string, unknown> | null;
    if (!biz) return json({ error: "store not found" }, 404);
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "smspin.io";
    const scheme = (req.headers.get("x-forwarded-proto") || "https").split(",")[0];
    return json({ app_name: biz.name, package: "io.smspin.store." + slug.replace(/-/g, ""),
      store_url: `${scheme}://${host}/${slug}`, theme: biz.theme || "crimson",
      markup_percent: biz.markup_percent || 0, api_base: `${scheme}://${host}/api/v1`, platform: "android",
      build: { format: "apk", min_sdk: 24, target_sdk: 34, version_name: "1.0.0", version_code: 1 } });
  }
  if (path === "/api/fx") {
    const to = (one(url, "to", "NGN") || "NGN").toUpperCase();
    return json(await fxConvert(num(one(url, "amount", "0")), to));
  }
  if (path === "/api/funding/quote") {
    const geo = await geoFromIp(ip);
    const cc = (one(url, "country", geo.country) || geo.country).toUpperCase();
    const cur = (one(url, "currency", geo.currency) || geo.currency).toUpperCase();
    return json(await fundingQuote(num(one(url, "amount", "0")), cc, cur));
  }
  if (path.startsWith("/api/tenant/")) return tenantGet(req, url, path);
  if (path.startsWith("/api/v1/")) return apiV1(req, url, path);
  if (path === "/api/rpc") return rpcBridge(req);
  if (path === "/api/catalog/taxonomy") {
    const cc = str(one(url, "country")).toLowerCase();
    const { data: services } = await admin().from("services").select("code,name,icon").order("name");
    const seen = new Set<string>(); const svcOut: unknown[] = [];
    for (const s of (services || []) as Array<{ code: string; name: string; icon: string }>) {
      const key = (s.name || s.code).toLowerCase();
      if (seen.has(key)) continue; seen.add(key);
      svcOut.push({ code: s.code, name: s.name, icon: s.icon });
    }
    const { data: countries } = await admin().from("countries").select("code,name,flag").order("name");
    return json({ services: svcOut, countries: countries || [], country: cc || null });
  }
  if (path === "/api/catalog/live") {
    const cc = str(one(url, "country")).toLowerCase(); const sv = str(one(url, "service"));
    if (!cc || !sv) return json({ error: "country and service required" }, 400);
    const { data } = await admin().from("number_catalog").select("price,cost_usd,stock,updated_at")
      .eq("country_code", cc).eq("service_code", sv).maybeSingle();
    if (!data) return json({ price_ngn: null, available: 0 });
    const row = data as Record<string, unknown>;
    return json({ price_ngn: num(row.price), available: num(row.stock), updated_at: row.updated_at ?? null });
  }
  if (path === "/api/rent/prices") {
    const cc = str(one(url, "country")).toLowerCase(); const sv = str(one(url, "service"));
    if (!sv) return json({ error: "service required" }, 400);
    try { return json(await rentPricesReal(cc, sv)); }
    catch (e) { return json({ error: e instanceof Error ? e.message : "error" }, 502); }
  }
  if (path === "/api/order/status") {
    const oid = one(url, "id"); if (!oid) return json({ error: "id required" }, 400);
    const { data } = await admin().from("orders").select("id,status,phone_number,price,expires_at,created_at,country_code,service_code").eq("id", num(oid)).maybeSingle();
    if (!data) return json({ error: "not found" });
    const { data: msg } = await admin().from("sms_messages").select("code").eq("order_id", num(oid)).not("code", "is", null).order("received_at", { ascending: false }).limit(1).maybeSingle();
    return json({ ...(data as Record<string, unknown>), otp: (msg as Record<string, unknown> | null)?.code ?? null });
  }
  if (path === "/api/order/detail") return orderDetail(req, url);
  if (path.startsWith("/api/app/download/")) return appDownload(path.split("/").pop() || "");
  if (path === "/api/kb" || path === "/api/articles") {
    const arts = await svc("kb_search", { p_q: str(one(url, "q")), p_category: one(url, "category") });
    return path === "/api/articles" ? json(arts) : json({ articles: arts });
  }
  if (path.startsWith("/api/kb/")) {
    const art = await svcSoft("kb_article", { p_slug: path.split("/").pop() });
    if (!art) return json({ error: "article not found" }, 404);
    return json(art);
  }
  if (path === "/api/rails") return json({ rails: await svcSoft("payment_rails") });
  if (path === "/api/payment-methods") return json({ methods: KORA_CHANNELS, provider: "korapay", mode: KORA_MODE, currency: "NGN", fee_percent: 2.5 });
  if (path === "/api/wallet/export") return walletExport(req);
  if (path === "/api/audit") return auditGet(req, url);
  if (path === "/api/health") {
    let ok = true; try { await admin().from("settings").select("key").limit(1); } catch { ok = false; }
    return json({ ok, checks: { db: ok, upstream_enabled: provider().enabled() }, version: "prod", environment: KORA_MODE === "live" ? "prod" : "test" });
  }
  if (path === "/api/env") return json({ environment: KORA_MODE === "live" ? "prod" : "test", is_prod: KORA_MODE === "live", preview: KORA_MODE !== "live", korapay_mode: KORA_MODE, upstream_enabled: provider().enabled() });
  if (path === "/api/status") return json(await svcSoft("status_report"));
  if (path === "/api/status/uptime") return json(await svcSoft("status_uptime", { p_hours: num(one(url, "hours", "72"), 72) }));
  if (path === "/api/metrics") {
    return json({ process: METRICS.snapshot(), ops: await svcSoft("ops_metrics", { p_window_min: 15 }) });
  }
  if (path === "/api/alerts") {
    const a = await requireAdmin(req);
    if (!a) return json({ error: "admin only" }, 403);
    return json({ events: await svcSoft("alert_events_list", { p_limit: 50 }), rules: await svcSoft("alert_rules_list", {}) });
  }
  if (path === "/api/scheduler") return json({ tasks: await svcSoft("scheduler_status", {}) });
  if (path === "/api/upstream/status") {
    return json({
      enabled: provider().enabled(),
      balance: await svcSoft("provider_state_get", { p_key: "balance" }),
      catalog_sync: await svcSoft("sync_progress", {}),
      dlq: await svcSoft("dlq_list", { p_limit: 10 }),
      reconcile: await svcSoft("reconcile_report", { p_days: 7 }),
    });
  }
  if (path === "/api/pricing") {
    const { data } = await admin().from("settings").select("key,value");
    const s: Record<string, unknown> = {};
    for (const r of (data || []) as Array<{ key: string; value: unknown }>) s[r.key] = r.value;
    return json({ settings: s, korapay_mode: KORA_MODE, korapay_public_key: KORA_PUBLIC });
  }
  if (path === "/api/reviews") return json(await svcSoft("public_reviews", { p_limit: num(one(url, "limit", "20"), 20) }));
  if (path === "/api/policies") {
    const uid = await authUser(req);
    const tenant = req.headers.get("x-tenant-token") ? await authTenant(req) : null;
    const st = (await svcSoft("policy_status", { p_user: uid, p_tenant: tenant?.account_id ?? null })) as Record<string, unknown> || {};
    if (one(url, "policy") === "aup") return json(aupText(str(st.aup_version || AUP_VERSION_FALLBACK)));
    return json(st);
  }
  if (path.startsWith("/api/admin/")) {
    if (req.headers.get("x-tenant-token")) return tenantAdminGet(req, url, path);
    return adminGet(req, url, path);
  }
  if (path.startsWith("/api/payments/verify/")) {
    const ref = path.split("/").pop()!;
    const { status, data } = await korapay(`/charges/${encodeURIComponent(ref)}`, "GET");
    const d = (data.data as Record<string, unknown>) || {};
    if (status === 200 && d.status === "success") {
      const credit = await creditPayment(ref, d.amount, d.channel, d.transaction_reference);
      return json({ verified: true, status: "success", credit });
    }
    return json({ verified: false, status: d.status || "unknown" });
  }
  return json({ error: "not found" }, 404);
}

// ============================ POST ===========================================
async function handlePost(req: Request, url: URL, path: string): Promise<Response> {
  if (path === "/api/rpc") return rpcBridge(req);
  if (path === "/api/payments/initialize") return paymentsInitialize(req);
  if (path === "/api/korapay/webhook") return korapayWebhook(req);
  if (path === "/api/orders/buy") return buyOrder(req);
  if (path === "/api/orders/rent") return rentOrder(req);
  if (path === "/api/orders/cancel") return cancelOrder(req);
  if (path === "/api/upstream/webhook") return upstreamWebhookRoute(req);
  if (path === "/api/policies/accept") return policyAccept(req);
  if (path === "/api/app/builds/request") return appBuildRequest(req);
  if (path === "/api/status/subscribe") return statusSubscribe(req);
  if (path === "/api/consent") return consent(req);
  if (path === "/api/reviews") return submitReview(req);
  if (path.startsWith("/api/admin/")) {
    if (req.headers.get("x-tenant-token")) return tenantAdminPost(req, url, path);
    return adminPost(req, url, path);
  }
  if (path.startsWith("/api/v1/")) return apiV1(req, url, path);
  return json({ error: "not found" }, 404);
}

// --- rpc bridge --------------------------------------------------------------
async function rpcBridge(req: Request): Promise<Response> {
  const body = await readJson(req);
  const fn = str(body.fn).trim();
  const args = (body.args as Body) || {};
  if (!fn || !/^[a-z0-9_]+$/.test(fn)) return json({ error: "invalid rpc name" }, 400);
  if (typeof args !== "object" || Array.isArray(args)) return json({ error: "args must be an object" }, 400);
  if (!(await rateOk(`rpc:${clientIp(req)}`, RL.rpc[0], RL.rpc[1]))) return json({ error: "rate limit exceeded" }, 429);
  const token = bearer(req);
  const client = token && token !== Deno.env.get("SUPABASE_ANON_KEY") ? asUser(token) : admin();
  const { data, error } = await client.rpc(fn, args);
  if (error) return json({ error: error.message }, 400);
  return json(data ?? {});
}

// --- tenant (API-key read surface) ------------------------------------------
async function tenantGet(req: Request, url: URL, path: string): Promise<Response> {
  const info = await tenantKeyInfo(req);
  if (!info) return json({ error: "invalid or missing tenant API key" }, 401);
  const scopes = (info.scopes as string[]) || [];
  if (!scopes.includes("read")) return json({ error: "key lacks 'read' scope" }, 403);
  const biz = info.business_id;
  if (path === "/api/tenant/account") {
    const { data } = await admin().from("businesses").select("slug").eq("id", biz).maybeSingle();
    return json(await svcSoft("business_branding", { p_slug: (data as Record<string, unknown> | null)?.slug ?? null }));
  }
  if (path === "/api/tenant/orders") {
    const limit = Math.max(1, Math.min(num(one(url, "limit", "50"), 50), 200));
    const { data } = await admin().from("orders").select("id,country_code,service_code,phone_number,price,status,created_at")
      .eq("business_id", biz).order("created_at", { ascending: false }).limit(limit);
    return json({ orders: data || [] });
  }
  if (path === "/api/tenant/stats") return json(await svcSoft("my_business_stats_by_id", { p_business: biz }));
  return json({ error: "unknown endpoint" }, 404);
}

// --- public API (developer keys) --------------------------------------------
async function apiV1(req: Request, url: URL, path: string): Promise<Response> {
  const auth = await apiKeyUser(req);
  if (!auth) return json({ error: "invalid or missing API key" }, 401);
  if ("reject" in auth) return json(auth.reject[1], auth.reject[0]);
  const { user: uid, key } = auth;
  const scopes = (key.scopes as string[]) || [];
  let status = 200;
  try {
    if (path === "/api/v1/balance") return json(await svc("api_balance", { p_user: uid }));
    if (path === "/api/v1/catalog" || path === "/api/v1/services")
      return json(await svc("api_catalog", { p_user: uid, p_country: one(url, "country"), p_service: one(url, "service") }));
    if (path === "/api/v1/order" && req.method === "GET") {
      const oid = one(url, "id") || one(url, "order_id");
      if (!oid) return json({ error: "id required" }, 400);
      return json(await svc("api_order", { p_user: uid, p_order_id: num(oid) }));
    }
    if (path === "/api/v1/order" && req.method === "POST") {
      if (scopes.length && !scopes.includes("write")) return json({ error: "key lacks 'write' scope", code: "scope_denied" }, 403);
      const body = await readJson(req);
      const cc = str(body.country), sv = str(body.service);
      if (!cc || !sv) return json({ error: "country and service required" }, 400);
      const idem = str(body.idempotency_key || req.headers.get("Idempotency-Key"));
      if (idem) { const prev = await svcSoft("idempotency_lookup", { p_key: idem, p_user: uid }); if (prev) return json(prev); }
      let res: unknown;
      try { res = await buyReal(cc.toLowerCase(), sv, uid, null, body.operator); }
      catch (e) { status = 402; return json({ error: e instanceof Error ? e.message : "error" }, 402); }
      if (idem) await svcSoft("idempotency_store", { p_key: idem, p_user: uid, p_response: res });
      return json(res);
    }
    return json({ error: "unknown endpoint" }, 404);
  } finally {
    await svcSoft("record_api_usage", { p_user: uid, p_key_id: key.id, p_path: path, p_method: req.method, p_status: status });
  }
}

// --- orders ------------------------------------------------------------------
async function resolveBuyer(req: Request, body: Body): Promise<{ userId: string | null; tenantAccount: string | null } | Response> {
  const tt = str(body.tenant_token || req.headers.get("x-tenant-token"));
  if (tt) {
    const me = await authTenant(req, tt);
    if (!me) return json({ error: "invalid tenant session" }, 401);
    return { userId: null, tenantAccount: me.account_id as string };
  }
  const uid = await authUser(req);
  if (!uid) return json({ error: "missing or invalid session" }, 401);
  return { userId: uid, tenantAccount: null };
}

async function buyOrder(req: Request): Promise<Response> {
  if (!(await rateOk(`buy:${clientIp(req)}`, RL.buy[0], RL.buy[1]))) return json({ error: "rate limit exceeded" }, 429);
  const body = await readJson(req);
  const country = str(body.country).toLowerCase(); const service = str(body.service);
  if (!country || !service) return json({ error: "country and service required" }, 400);
  const b = await resolveBuyer(req, body);
  if (b instanceof Response) return b;
  const ip = clientIp(req);
  const actor = b.tenantAccount ? `tenant:${b.tenantAccount}` : `user:${b.userId}`;
  if (b.userId) {
    if (await svcSoft("is_suspended", { p_user: b.userId })) return json({ error: "account suspended", code: "account_suspended" }, 403);
    if (await aupRequired(b.userId, b.tenantAccount, body)) return json({ error: "acceptable-use policy acceptance required", code: "aup_required" }, 403);
  }
  const decision = (await svcSoft("fraud_check", { p_user: b.userId, p_ip: ip, p_email: str(body.email) || null,
    p_meta: { country, service } })) as Record<string, unknown> | null;
  if (decision && decision.allow === false) {
    await svcSoft("audit_write", { p_actor: actor, p_action: "order.buy_blocked", p_subject: null, p_detail: { reason: "fraud" }, p_ip: ip });
    return json({ error: "request blocked by risk controls", code: "fraud_block", reasons: decision.reasons }, 403);
  }
  try {
    const res = await buyReal(country, service, b.userId, b.tenantAccount, body.operator);
    await svcSoft("audit_write", { p_actor: actor, p_action: "order.buy", p_subject: str(res.order_id), p_detail: { country, service }, p_ip: ip });
    return json(res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    const code = /insufficient|no stock|out of stock|unavailable/i.test(msg) ? 402 : 500;
    return json({ error: msg }, code);
  }
}

async function rentOrder(req: Request): Promise<Response> {
  if (!(await rateOk(`buy:${clientIp(req)}`, RL.buy[0], RL.buy[1]))) return json({ error: "rate limit exceeded" }, 429);
  const body = await readJson(req);
  const country = str(body.country).toLowerCase(); const service = str(body.service);
  const duration = num(body.duration, 24);
  if (!country || !service) return json({ error: "country and service required" }, 400);
  const b = await resolveBuyer(req, body);
  if (b instanceof Response) return b;
  if (b.userId) {
    if (await svcSoft("is_suspended", { p_user: b.userId })) return json({ error: "account suspended", code: "account_suspended" }, 403);
    if (await aupRequired(b.userId, b.tenantAccount, body)) return json({ error: "acceptable-use policy acceptance required", code: "aup_required" }, 403);
  }
  try { return json(await rentReal(country, service, duration, b.userId, b.tenantAccount)); }
  catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    const code = /insufficient|no stock|out of stock|unavailable/i.test(msg) ? 402 : 500;
    return json({ error: msg }, code);
  }
}

async function aupRequired(userId: string | null, tenantAccount: string | null, body: Body): Promise<boolean> {
  if (["1", "true", "yes"].includes(str(body.accept_aup).toLowerCase())) return false;
  const st = (await svcSoft("policy_status", { p_user: userId, p_tenant: tenantAccount })) as Record<string, unknown> | null;
  if (!st || !st.aup_required) return false;
  return !st.aup_accepted;
}

async function cancelOrder(req: Request): Promise<Response> {
  const body = await readJson(req);
  const orderId = num(body.order_id);
  if (!orderId) return json({ error: "order_id required" }, 400);
  const b = await resolveBuyer(req, body);
  if (b instanceof Response) return b;
  const { data } = await admin().from("orders").select("id,user_id,tenant_account_id,upstream_order_id,status").eq("id", orderId).maybeSingle();
  const o = data as Record<string, unknown> | null;
  if (!o) return json({ error: "order not found" }, 404);
  if ((b.userId && o.user_id !== b.userId) || (b.tenantAccount && o.tenant_account_id !== b.tenantAccount)) return json({ error: "forbidden" }, 403);
  if (["refunded", "cancelled"].includes(str(o.status))) return json({ order_id: orderId, status: o.status, already: true });
  if (o.upstream_order_id) { try { await provider().cancelOrder(str(o.upstream_order_id)); } catch { /* ignore */ } }
  return json(await refundOrder(orderId, "user_cancel"));
}

async function orderDetail(req: Request, url: URL): Promise<Response> {
  const uid = await authUser(req);
  if (!uid) return json({ error: "missing or invalid session" }, 401);
  const oid = one(url, "id");
  if (!oid || !/^\d+$/.test(oid)) return json({ error: "id required" }, 400);
  const { data: order } = await admin().from("orders")
    .select("id,country_code,service_code,phone_number,price,status,created_at,expires_at,operator,countries(name,flag),services(name,icon)").eq("id", num(oid)).eq("user_id", uid).maybeSingle();
  if (!order) return json({ error: "order not found" }, 404);
  const o = order as Record<string, unknown>;
  const { data: msgs } = await admin().from("sms_messages").select("id,sender,body,code,received_at").eq("order_id", num(oid)).order("received_at");
  const country = o.countries as Record<string, unknown> | null;
  const service = o.services as Record<string, unknown> | null;
  return json({ ...o, country: country?.name, flag: country?.flag, service: service?.name, service_icon: service?.icon,
    messages: msgs || [], can_cancel: o.status === "waiting", can_extend: ["waiting", "received"].includes(str(o.status)),
    refundable: ["waiting", "expired", "cancelled"].includes(str(o.status)) });
}

async function appDownload(token: string): Promise<Response> {
  const b = (await svcSoft("app_build_by_token", { p_token: token })) as Record<string, unknown> | null;
  if (!b) return json({ error: "link expired or invalid" }, 404);
  const url = str(b.artifact_url);
  if (url.startsWith("http")) return new Response(null, { status: 302, headers: { ...cors, Location: url } });
  const store = (Deno.env.get("APP_ARTIFACT_BASE") || "").replace(/\/$/, "");
  if (store) return new Response(null, { status: 302, headers: { ...cors, Location: `${store}/${b.slug || "app"}-${b.version || "1.0.0"}.apk` } });
  return json({ error: "app artefact not available yet" }, 404);
}

async function walletExport(req: Request): Promise<Response> {
  const uid = await authUser(req);
  if (!uid) return json({ error: "missing or invalid session" }, 401);
  const { data } = await admin().from("transactions").select("created_at,type,amount,method,ref").eq("user_id", uid).order("created_at", { ascending: false });
  const lines = ["date,type,amount,method,reference"];
  for (const r of (data || []) as Array<Record<string, unknown>>) {
    lines.push([str(r.created_at), str(r.type), str(r.amount), str(r.method), '"' + str(r.ref).replace(/"/g, "'") + '"'].join(","));
  }
  return new Response(lines.join("\n") + "\n", { status: 200, headers: { ...cors, "Content-Type": "text/csv",
    "Content-Disposition": 'attachment; filename="smspin-transactions.csv"' } });
}

async function auditGet(req: Request, url: URL): Promise<Response> {
  let actor: string | null = null;
  const tt = req.headers.get("x-tenant-token");
  if (tt) { const me = await authTenant(req); if (!me) return json({ error: "invalid tenant session" }, 401); actor = `tenant:${me.account_id}`; }
  else { const uid = await authUser(req); if (!uid) return json({ error: "missing or invalid session" }, 401); actor = `user:${uid}`; }
  return json(await svcSoft("audit_list", { p_limit: num(one(url, "limit", "100"), 100), p_actor: actor }));
}

// --- payments ----------------------------------------------------------------
async function paymentsInitialize(req: Request): Promise<Response> {
  const body = await readJson(req);
  const amount = num(body.amount);
  if (!(amount > 0)) return json({ error: "invalid amount" }, 400);
  const channel = str(body.channel || body.method || "card").toLowerCase();
  if (!KORA_CHANNEL_IDS.has(channel)) return json({ error: "unsupported payment method", allowed: [...KORA_CHANNEL_IDS] }, 400);
  const inline = !!body.inline;
  const host = baseUrl(req);

  const tt = str(body.tenant_token || req.headers.get("x-tenant-token"));
  if (tt) {
    const me = await authTenant(req, tt);
    if (!me) return json({ error: "invalid tenant session" }, 401);
    const pay = (await svc("tenant_create_payment", { p_token: tt, p_amount: amount })) as Record<string, unknown>;
    const reference = pay.reference as string;
    await setPaymentFee(reference, amount);
    let email = str(me.email);
    if (!validPayEmail(email)) email = `tenant-${me.account_id || "anon"}@smspin.io`;
    const name = str(me.full_name) || "SMSPin Customer";
    const slug = str(me.tenant_slug);
    const redirect_url = `${host}/store/${slug}/?ref=${reference}`;
    const notify_url = `${host}/api/korapay/webhook`;
    if (inline) {
      await admin().from("payments").update({ channel }).eq("reference", reference);
      return json({ reference, public_key: KORA_PUBLIC, mode: KORA_MODE, inline: true, amount: Math.round(amount),
        customer: { name, email }, notification_url: notify_url, narration: "SMSPin wallet top-up" });
    }
    const { status, data } = await korapay("/charges/initialize", "POST", { amount: Math.round(amount), currency: "NGN",
      reference, redirect_url, notification_url: notify_url, customer: { name, email }, narration: "SMSPin wallet top-up", channels: [channel] });
    if (status !== 200 || !data.status) return json({ error: "korapay init failed", detail: data }, 502);
    const checkout = (data.data as Record<string, unknown>).checkout_url as string;
    await svcSoft("tenant_set_payment_checkout", { p_reference: reference, p_checkout_url: checkout, p_provider_ref: (data.data as Record<string, unknown>).reference ?? null });
    await admin().from("payments").update({ channel }).eq("reference", reference);
    return json({ reference, checkout_url: checkout, public_key: KORA_PUBLIC, mode: KORA_MODE });
  }

  const uid = await authUser(req);
  if (!uid) return json({ error: "missing bearer token" }, 401);
  const userClient = asUser(bearer(req));
  const { data: prof } = await userClient.rpc("my_profile");
  let email = str((prof as Record<string, unknown> | null)?.email);
  if (!validPayEmail(email)) email = `user-${(prof as Record<string, unknown> | null)?.id || "anon"}@smspin.io`;
  const name = str((prof as Record<string, unknown> | null)?.full_name) || "SMSPin User";
  // create_payment derives the owner from auth.uid(), so it must run as the
  // signed-in user — a service-role call would have no uid and be rejected.
  const { data: pay, error: payErr } = await userClient.rpc("create_payment", { p_amount: amount });
  if (payErr || !pay) return json({ error: "could not create payment", detail: payErr?.message ?? null }, 400);
  const reference = (pay as Record<string, unknown>).reference as string;
  await setPaymentFee(reference, amount);
  const redirect_url = `${host}/dashboard/wallet/?ref=${reference}`;
  const notify_url = `${host}/api/korapay/webhook`;
  if (inline) {
    await admin().from("payments").update({ channel }).eq("reference", reference);
    return json({ reference, public_key: KORA_PUBLIC, mode: KORA_MODE, inline: true, amount: Math.round(amount),
      customer: { name, email }, notification_url: notify_url, narration: "SMSPin wallet top-up" });
  }
  const { status, data } = await korapay("/charges/initialize", "POST", { amount: Math.round(amount), currency: "NGN",
    reference, redirect_url, notification_url: notify_url, customer: { name, email }, narration: "SMSPin wallet top-up", channels: [channel] });
  if (status !== 200 || !data.status) return json({ error: "korapay init failed", detail: data }, 502);
  const checkout = (data.data as Record<string, unknown>).checkout_url as string;
  await svcSoft("set_payment_checkout", { p_reference: reference, p_checkout_url: checkout, p_provider_ref: (data.data as Record<string, unknown>).reference ?? null });
  await admin().from("payments").update({ channel }).eq("reference", reference);
  return json({ reference, checkout_url: checkout, public_key: KORA_PUBLIC, mode: KORA_MODE });
}

async function setPaymentFee(reference: string, amountNgn: number) {
  const q = await fundingQuote(amountNgn, "NG", "NGN");
  await svcSoft("set_payment_fee", { p_reference: reference, p_fee_ngn: q.fee_ngn,
    p_meta: { usd_ngn: q.usd_ngn, country: "NG", currency: "NGN" } });
}

async function korapayWebhook(req: Request): Promise<Response> {
  const raw = await req.text();
  const sig = req.headers.get("x-korapay-signature") || "";
  const expected = await hmacHex(KORA_SECRET, raw);
  if (!timingSafeEqual(sig, expected)) return json({ error: "invalid signature" }, 401);
  let evt: Record<string, unknown> = {};
  try { evt = JSON.parse(raw || "{}"); } catch { return json({ error: "invalid json" }, 400); }
  const data = (evt.data as Record<string, unknown>) || {};
  if (evt.event === "charge.success" && data.status === "success") {
    const credit = await creditPayment(str(data.reference), data.amount, data.channel, data.transaction_reference);
    return json({ received: true, credit });
  }
  return json({ received: true, ignored: evt.event });
}

async function upstreamWebhookRoute(req: Request): Promise<Response> {
  if (!(await rateOk(`webhook:${clientIp(req)}`, RL.webhook[0], RL.webhook[1]))) return json({ error: "rate limit exceeded" }, 429);
  const secret = Deno.env.get("SMSPIN_WEBHOOK_SECRET") || "";
  if (secret) {
    const given = req.headers.get("x-webhook-secret") || "";
    if (!timingSafeEqual(given, secret)) return json({ error: "invalid signature" }, 401);
  }
  let payload: Body = {};
  try { payload = JSON.parse((await req.text()) || "{}"); } catch { return json({ error: "invalid json" }, 400); }
  try { return json(await upstreamWebhook(payload)); }
  catch (e) { await svcSoft("dlq_enqueue", { p_source: "upstream", p_event: payload.event, p_payload: payload, p_error: str(e).slice(0, 300) }); return json({ error: "handled via dlq" }, 500); }
}

async function policyAccept(req: Request): Promise<Response> {
  const body = await readJson(req);
  const policy = str(body.policy || "aup").toLowerCase();
  const uid = await authUser(req);
  const tenant = req.headers.get("x-tenant-token") ? await authTenant(req) : null;
  if (!uid && !tenant) return json({ error: "missing or invalid session" }, 401);
  const res = (await svc("policy_accept", { p_user: uid, p_tenant: tenant?.account_id ?? null, p_policy: policy, p_ip: clientIp(req) })) as Record<string, unknown>;
  await svcSoft("audit_write", { p_actor: tenant ? `tenant:${tenant.account_id}` : `user:${uid}`, p_action: "policy.accept", p_subject: policy, p_detail: { version: res?.version }, p_ip: clientIp(req) });
  return json(res || {});
}

async function statusSubscribe(req: Request): Promise<Response> {
  if (!(await rateOk(`subscribe:${clientIp(req)}`, RL.subscribe[0], RL.subscribe[1]))) return json({ error: "rate limit exceeded" }, 429);
  const body = await readJson(req);
  const email = str(body.email).trim();
  if (!email) return json({ error: "email required" }, 400);
  try { const res = await svc("status_subscribe", { p_email: email }); await svcSoft("audit_write", { p_actor: "public", p_action: "status.subscribe", p_subject: email, p_detail: {}, p_ip: clientIp(req) }); return json(res || { ok: true }); }
  catch { return json({ error: "invalid email" }, 400); }
}

async function consent(req: Request): Promise<Response> {
  if (!(await rateOk(`consent:${clientIp(req)}`, RL.consent[0], RL.consent[1]))) return json({ error: "rate limit exceeded" }, 429);
  const body = await readJson(req);
  const uid = await authUser(req);
  const c = (body.consent as Body) || body;
  await admin().from("consent_log").insert({ user_id: uid, anon_id: str(body.anon_id).slice(0, 64),
    analytics: !!c.analytics, ads: !!c.ads, functional: c.functional === undefined ? true : !!c.functional,
    policy_ver: str(body.policy || "v1").slice(0, 32), user_agent: str(req.headers.get("User-Agent")).slice(0, 400), ip: clientIp(req) });
  return json({ ok: true });
}

async function submitReview(req: Request): Promise<Response> {
  if (!(await rateOk(`review:${clientIp(req)}`, RL.review[0], RL.review[1]))) return json({ error: "rate limit exceeded" }, 429);
  const uid = await authUser(req);
  if (!uid) return json({ error: "sign in to leave a review" }, 401);
  const body = await readJson(req);
  const rating = num(body.rating);
  if (!(rating >= 1 && rating <= 5)) return json({ error: "rating must be 1..5" }, 400);
  try {
    const res = await svc("submit_review", { p_user: uid, p_rating: rating, p_title: str(body.title).slice(0, 120),
      p_body: str(body.body).slice(0, 4000), p_service: str(body.service).slice(0, 80) || null, p_country: str(body.country).slice(0, 8) || null });
    await svcSoft("audit_write", { p_actor: `user:${uid}`, p_action: "review.submit", p_subject: str((res as Record<string, unknown>)?.id), p_detail: {}, p_ip: clientIp(req) });
    return json(res || { ok: true });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "error" }, 400); }
}

async function appBuildRequest(req: Request): Promise<Response> {
  const uid = await authUser(req);
  if (!uid) return json({ error: "missing or invalid session" }, 401);
  const body = await readJson(req);
  try {
    const res = await svc("request_app_build", { p_version: body.version ?? null });
    return json({ build: res, dispatched: true });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "error" }, 400); }
}

// --- admin -------------------------------------------------------------------
async function adminGet(req: Request, url: URL, path: string): Promise<Response> {
  const a = await requireAdmin(req);
  if (!a) return json({ error: "admin only" }, 403);
  const rpc = (fn: string, args: Body) => svcSoft(fn, args).then((d) => json(d));
  if (path === "/api/admin/overview") return rpc("admin_overview", {});
  if (path === "/api/admin/users") return rpc("admin_users_list", { p_q: one(url, "q"), p_limit: num(one(url, "limit", "50"), 50) });
  if (path.startsWith("/api/admin/users/")) return rpc("admin_user_detail", { p_user: path.split("/").pop() });
  if (path === "/api/admin/orders") return rpc("admin_orders_list", { p_status: one(url, "status"), p_q: one(url, "q"), p_limit: num(one(url, "limit", "100"), 100) });
  if (path === "/api/admin/catalog") return rpc("admin_catalog_list", { p_q: one(url, "q"), p_limit: num(one(url, "limit", "100"), 100) });
  if (path === "/api/admin/payments") return rpc("admin_payments_list", { p_status: one(url, "status"), p_limit: num(one(url, "limit", "100"), 100) });
  if (path === "/api/admin/payments/reconcile") return rpc("admin_payment_reconcile", { p_days: num(one(url, "days", "7"), 7) });
  if (path === "/api/admin/tickets") return rpc("admin_tickets_list", { p_status: one(url, "status"), p_limit: num(one(url, "limit", "100"), 100) });
  if (path.startsWith("/api/admin/tickets/")) return rpc("admin_ticket_thread", { p_ticket_id: num(path.split("/").pop()) });
  if (path === "/api/admin/audit") return rpc("audit_list", { p_limit: num(one(url, "limit", "100"), 100), p_actor: one(url, "actor") });
  if (path === "/api/admin/refunds") return rpc("reconcile_report", { p_days: num(one(url, "days", "7"), 7) });
  if (path === "/api/admin/margin") return rpc("margin_report", { p_days: num(one(url, "days", "30"), 30) });
  if (path === "/api/admin/tenants") return rpc("admin_tenants_list", { p_q: one(url, "q"), p_limit: num(one(url, "limit", "100"), 100) });
  if (path === "/api/admin/support/queue") return rpc("admin_support_queue", { p_status: one(url, "status", "open"), p_limit: num(one(url, "limit", "100"), 100) });
  if (path === "/api/admin/fraud") return rpc("admin_fraud_queue", { p_limit: num(one(url, "limit", "100"), 100) });
  if (path === "/api/admin/flags") return rpc("admin_flags_list", {});
  if (path === "/api/admin/settings") return rpc("admin_settings_get", {});
  if (path === "/api/admin/tax") return rpc("tax_report", { p_days: num(one(url, "days", "30"), 30) });
  if (path === "/api/admin/ledger") return rpc("ledger_export", { p_from: one(url, "from"), p_to: one(url, "to") });
  if (path === "/api/admin/experiments") return json({ stats: await svcSoft("experiment_stats", {}) });
  if (path === "/api/admin/tours") return json({ funnel: await svcSoft("tour_funnel", { p_days: num(one(url, "days", "30"), 30) }) });
  if (path === "/api/admin/risk") return rpc("risk_events_list", { p_limit: num(one(url, "limit", "100"), 100), p_user: one(url, "user") });
  return json({ error: "not found" }, 404);
}

async function adminPost(req: Request, url: URL, path: string): Promise<Response> {
  const a = await requireAdmin(req);
  if (!a) return json({ error: "admin only" }, 403);
  const body = await readJson(req);
  const ip = clientIp(req); const actor = `admin:${a}`;
  const audit = (action: string, subject: unknown, detail: Body) => svcSoft("audit_write", { p_actor: actor, p_action: action, p_subject: subject, p_detail: detail, p_ip: ip });
  if (path === "/api/admin/users/suspend") { const r = await svc("admin_user_suspend", { p_user: body.user_id, p_suspended: !!body.suspended, p_reason: body.reason ?? null }); await audit("admin.user_suspend", body.user_id, { suspended: body.suspended }); return json(r); }
  if (path === "/api/admin/users/adjust") { try { const r = await svc("admin_adjust_balance", { p_user: body.user_id, p_amount: body.amount, p_reason: body.reason }); await audit("admin.balance_adjust", body.user_id, { amount: body.amount }); return json(r); } catch (e) { return json({ error: str(e) }, 400); } }
  if (path === "/api/admin/orders/refund") {
    const orderId = num(body.order_id); const reason = str(body.reason || "admin_refund");
    try {
      let r: Record<string, unknown>;
      if (body.amount === undefined || body.amount === null) r = await refundOrder(orderId, reason);
      else {
        r = (await svc("refund_order_partial", { p_order_id: orderId, p_amount: body.amount, p_reason: reason })) as Record<string, unknown>;
        if (!r.already) await notifyRefund(orderId, r.refunded, reason);
      }
      await audit("admin.refund", orderId, { amount: body.amount, reason }); return json(r);
    } catch (e) { return json({ error: str(e) }, 400); }
  }
  if (path === "/api/admin/orders/mark-received") { const r = await svc("admin_order_mark_received", { p_order_id: num(body.order_id) }); await audit("admin.order_mark_received", body.order_id, {}); return json(r); }
  if (path === "/api/admin/orders/sms") { const r = await svc("admin_sms_inject", { p_order_id: num(body.order_id), p_sender: str(body.sender || "admin"), p_body: str(body.body), p_code: body.code ?? null }); await audit("admin.sms_inject", body.order_id, {}); return json(r); }
  if (path === "/api/admin/catalog/update") { const r = await svc("admin_catalog_update", { p_id: num(body.id), p_price: body.price ?? null, p_stock: body.stock ?? null, p_active: body.active ?? null }); await audit("admin.catalog_update", body.id, body); return json(r); }
  if (path === "/api/admin/pricing/markup") { const r = await svc("admin_set_markup", { p_percent: body.percent }); await audit("admin.markup", null, { percent: body.percent }); return json(r); }
  if (path === "/api/admin/payments/mark") { const r = await svc("admin_payment_mark", { p_reference: body.reference, p_status: body.status }); await audit("admin.payment_mark", body.reference, { status: body.status }); return json(r); }
  if (path === "/api/admin/tickets/reply") { const r = await svc("admin_ticket_reply", { p_ticket_id: num(body.ticket_id), p_body: str(body.body), p_agent: a, p_attachment_url: body.attachment_url ?? null }); await audit("admin.ticket_reply", body.ticket_id, {}); return json(r); }
  if (path === "/api/admin/tickets/update") { const r = await svc("admin_ticket_update", { p_ticket_id: num(body.ticket_id), p_status: body.status ?? null, p_priority: body.priority ?? null, p_assignee: body.assignee ?? null }); await audit("admin.ticket_update", body.ticket_id, body); return json(r); }
  if (path === "/api/admin/incidents") { const r = await svc("admin_incident_create", { p_title: body.title, p_body: body.body, p_severity: str(body.severity || "minor"), p_status: str(body.status || "investigating"), p_affected: body.affected || [] }); await audit("admin.incident_create", str(r), body); return json({ id: r }); }
  if (path === "/api/admin/incidents/update") { const r = await svc("admin_incident_update", { p_id: num(body.id), p_status: body.status ?? null, p_body: body.body ?? null, p_severity: body.severity ?? null }); await audit("admin.incident_update", body.id, body); return json(r); }
  if (path === "/api/admin/checks/run") { const r = await svc("synthetic_check", {}); await audit("admin.synthetic_check", null, r as Body); return json(r); }
  if (path === "/api/admin/tenants/status") { const r = await svc("admin_tenant_set_status", { p_id: num(body.id), p_status: body.status, p_reason: body.reason ?? null }); await audit("admin.tenant_status", body.id, { status: body.status }); return json(r); }
  if (path === "/api/admin/tenants/payouts") return json(await svc("admin_tenant_payouts", { p_id: num(body.id) }));
  if (path === "/api/admin/support/assign") { const r = await svc("admin_ticket_assign", { p_id: num(body.ticket_id), p_agent: str(body.agent || a), p_priority: body.priority ?? null, p_canned: body.canned ?? null }); await audit("admin.ticket_assign", body.ticket_id, body); return json(r); }
  if (path === "/api/admin/flags/set") { const r = await svc("admin_flag_set", { p_key: body.key, p_enabled: !!body.enabled, p_tenant: body.tenant_id ?? null, p_description: body.description ?? null }); await audit("admin.flag_set", body.key, { enabled: body.enabled }); return json(r); }
  if (path === "/api/admin/settings/set") { const r = await svc("admin_setting_set", { p_key: body.key, p_value: body.value }); await audit("admin.setting_set", body.key, { value: body.value }); return json(r); }
  if (path === "/api/admin/blocklist") {
    const action = str(body.action || "list");
    if (action === "list") return json(await svcSoft("blocklist_list", { p_kind: body.kind ?? null }));
    if (action === "add") { if (!body.kind || !body.value) return json({ error: "kind and value required" }, 400); const id = await svc("blocklist_add", { p_kind: body.kind, p_value: str(body.value), p_reason: body.reason ?? null }); await audit("blocklist.add", `${body.kind}:${body.value}`, { reason: body.reason }); return json({ id }); }
    if (action === "remove") { await svc("blocklist_remove", { p_kind: body.kind, p_value: str(body.value) }); await audit("blocklist.remove", `${body.kind}:${body.value}`, {}); return json({ removed: true }); }
    return json({ error: "unknown action" }, 400);
  }
  if (path === "/api/admin/alerts/run") { const fired = await svcSoft("alert_evaluate", {}); return json({ fired, delivered: 0 }); }
  return json({ error: "not found" }, 404);
}

async function tenantAdminGet(req: Request, url: URL, path: string): Promise<Response> {
  const me = await authTenant(req);
  if (!me) return json({ error: "admin only" }, 403);
  const tok = req.headers.get("x-tenant-token")!;
  if (path === "/api/admin/overview") return json(await svcSoft("tenant_admin_overview", { p_token: tok }));
  if (path === "/api/admin/users") return json(await svcSoft("tenant_admin_customers", { p_token: tok, p_q: one(url, "q"), p_limit: num(one(url, "limit", "100"), 100) }));
  if (path === "/api/admin/orders") return json(await svcSoft("tenant_admin_orders", { p_token: tok, p_status: one(url, "status"), p_q: one(url, "q"), p_limit: num(one(url, "limit", "100"), 100) }));
  if (path === "/api/admin/payments") return json(await svcSoft("tenant_admin_payments", { p_token: tok, p_status: one(url, "status"), p_limit: num(one(url, "limit", "100"), 100) }));
  if (path === "/api/admin/catalog") return json(await svcSoft("tenant_admin_catalog", { p_token: tok, p_q: one(url, "q"), p_limit: num(one(url, "limit", "100"), 100) }));
  if (path === "/api/admin/margin") return json(await svcSoft("tenant_admin_margin", { p_token: tok, p_days: num(one(url, "days", "30"), 30) }));
  if (path === "/api/admin/tenants") { const e = (await svcSoft("tenant_earnings", { p_token: tok })) as Record<string, unknown>; return json(e?.payouts || []); }
  if (path === "/api/admin/flags") return json([]);
  if (path === "/api/admin/settings") return json({ markup_percent: null });
  return json([]);
}

async function tenantAdminPost(req: Request, url: URL, path: string): Promise<Response> {
  const me = await authTenant(req);
  if (!me) return json({ error: "admin only" }, 403);
  const tok = req.headers.get("x-tenant-token")!;
  const body = await readJson(req);
  if (path === "/api/admin/pricing/markup") return json(await svc("tenant_set_markup", { p_token: tok, p_percent: body.percent }));
  if (path === "/api/admin/tenants/payouts") { const e = (await svcSoft("tenant_earnings", { p_token: tok })) as Record<string, unknown>; return json(e?.payouts || []); }
  return json({ ok: true });
}

// ============================ entrypoint =====================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  // The edge runtime strips the function name, so derive /api/* from the tail:
  // /functions/v1/api/<rest> -> /api/<rest>.
  let path = url.pathname;
  const m = path.match(/\/functions\/v1\/api(\/.*)?$/);
  if (m) path = "/api" + (m[1] || "");
  else if (!path.startsWith("/api")) path = "/api" + path;
  if (path.length > 5 && path.endsWith("/")) path = path.replace(/\/+$/, "");
  try {
    if (req.method === "GET") return await handleGet(req, url, path);
    if (req.method === "POST") return await handlePost(req, url, path);
    return json({ error: "method not allowed" }, 405);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
  }
});
