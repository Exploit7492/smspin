// Upstream SMS provider client — the serverless twin of backend/smspool_api.py
// + backend/smspin_api.py. SMSPool is the default provider; the smspin.io
// client is the fallback. Read methods fall back on error or an empty result;
// write methods fall back only on error, so an order the default provider
// accepted is never double-booked.
import { SMSPOOL_KEY } from "./util.ts";

const SMSPOOL_BASE = Deno.env.get("SMSPOOL_BASE") || "https://api.smspool.net";
const SMSPIN_BASE = Deno.env.get("SMSPIN_BASE") || "https://api.smspin.io";
const SMSPIN_KEY = Deno.env.get("SMSPIN_API_KEY") || "";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const STATUS_PENDING = 1, STATUS_COMPLETE = 3, STATUS_REFUNDED = 6;

export class ProviderError extends Error {
  status: number; body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(`provider ${status}: ${message}`);
    this.status = status; this.body = body;
  }
}

function norm(name: string): string {
  const base = (name || "").split("/")[0];
  return base.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function postForm(base: string, path: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) body.append(k, String(v));
  let last: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const text = await r.text();
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(text || "{}"); } catch { data = { error: text.slice(0, 200) }; }
      if (!r.ok) {
        const msg = (data.message || data.error || `HTTP ${r.status}`) as string;
        if ([429, 500, 502, 503, 504].includes(r.status) && attempt < 3) {
          await new Promise((res) => setTimeout(res, Math.min(2 ** attempt, 8) * 1000));
          last = new ProviderError(r.status, msg, data);
          continue;
        }
        throw new ProviderError(r.status, msg, data);
      }
      return data;
    } catch (e) {
      if (e instanceof ProviderError && ![429, 500, 502, 503, 504].includes(e.status)) throw e;
      last = e;
      if (attempt < 3) {
        await new Promise((res) => setTimeout(res, Math.min(2 ** attempt, 8) * 1000));
        continue;
      }
      throw e instanceof ProviderError ? e : new ProviderError(0, String(e));
    }
  }
  throw last instanceof ProviderError ? last : new ProviderError(0, "request failed");
}

export class SmspoolClient {
  private countries: Record<string, unknown> | null = null;
  private services: Record<string, unknown> | null = null;
  private rentals: Array<Record<string, unknown>> | null = null;
  private names: Record<string, string> = {};

  setServiceNames(m: Record<string, string>) { this.names = m || {}; }

  private post(path: string, fields: Record<string, unknown> = {}) {
    return postForm(SMSPOOL_BASE, path, { key: SMSPOOL_KEY, ...fields });
  }

  private check(resp: Record<string, unknown>) {
    if (resp.success === 0) throw new ProviderError(400, (resp.message as string) || "request failed", resp);
    if ("status" in resp && resp.status === 0 && resp.message) throw new ProviderError(400, resp.message as string, resp);
    return resp;
  }

  private async countryMap(): Promise<Record<string, unknown>> {
    if (this.countries) return this.countries;
    const rows = (await this.post("/country/retrieve_all")) as unknown as Array<Record<string, unknown>>;
    const m: Record<string, unknown> = {};
    for (const c of rows || []) { const sn = String(c.short_name || "").toUpperCase(); if (sn) m[sn] = c.ID; }
    this.countries = m;
    return m;
  }

  private async serviceMap(): Promise<Record<string, unknown>> {
    if (this.services) return this.services;
    const rows = (await this.post("/service/retrieve_all")) as unknown as Array<Record<string, unknown>>;
    const m: Record<string, unknown> = {};
    for (const s of rows || []) { const k = norm(String(s.name || "")); if (k && !(k in m)) m[k] = s.ID; }
    this.services = m;
    return m;
  }

  private async resolve(country: string, service: string): Promise<[unknown, unknown]> {
    const cm = await this.countryMap();
    const sm = await this.serviceMap();
    const cid = cm[(country || "").toUpperCase()];
    const candidates = [this.names[service], service];
    let sid: unknown = undefined;
    for (const cand of candidates) { const k = norm(cand || ""); if (k && k in sm) { sid = sm[k]; break; } }
    return [cid, sid];
  }

  async livePrice(country: string, service: string) {
    const [cid, sid] = await this.resolve(country, service);
    if (cid === undefined || sid === undefined) return { price_usd: null, available: 0 };
    let price: number | null = null;
    try {
      const d = await this.post("/request/price", { country: cid, service: sid });
      if (d && "price" in d) price = Number(d.price);
    } catch { price = null; }
    let stock = 0;
    if (price !== null) {
      try {
        const s = await this.post("/sms/stock", { country: cid, service: sid });
        if (s && s.success === 1) stock = parseInt(String(s.amount || 0)) || 0;
      } catch { stock = 0; }
    }
    return { price_usd: price, available: stock };
  }

  async createOrder(country: string, service: string): Promise<Record<string, unknown>> {
    const [cid, sid] = await this.resolve(country, service);
    if (cid === undefined) throw new ProviderError(400, "COUNTRY_NOT_AVAILABLE");
    if (sid === undefined) throw new ProviderError(400, "SERVICE_NOT_AVAILABLE");
    const resp = this.check(await this.post("/purchase/sms", { country: cid, service: sid }));
    const number = String(resp.number || resp.phonenumber || "");
    const id = String(resp.order_id || "");
    return { id, phoneNumber: number, phone_number: number,
             price: Number(resp.cost || resp.price || 0) || null, status: "waiting" };
  }

  async getOrder(orderId: string): Promise<Record<string, unknown>> {
    const data = await this.post("/sms/check", { orderid: orderId });
    const code = data.status;
    if (code === undefined && data.success === 0) throw new ProviderError(404, (data.message as string) || "order not found", data);
    const otp = data.sms || data.code;
    const status = code === STATUS_COMPLETE ? "received" : code === STATUS_REFUNDED ? "refunded" : "waiting";
    return { id: String(orderId), status, otpCode: otp && String(otp) !== "0" ? otp : null,
             otp_code: otp && String(otp) !== "0" ? otp : null, service: data.service, createdAt: data.timestamp };
  }

  async cancelOrder(orderId: string) { return this.check(await this.post("/sms/cancel", { orderid: orderId })); }
  async resendOrder(orderId: string) { return this.check(await this.post("/sms/resend", { orderid: orderId })); }

  private static countryMatches(short: unknown, want: string): boolean {
    const s = String(short || "").toUpperCase();
    return s === want || s === want + "_V";
  }

  private async rentalOfferings(): Promise<Array<Record<string, unknown>>> {
    if (this.rentals) return this.rentals;
    const d = await this.post("/rental/retrieve_all", { type: 1 });
    this.rentals = (d.data as Array<Record<string, unknown>>) || [];
    return this.rentals;
  }

  async rentPrices(service: string, country?: string): Promise<Record<string, unknown>> {
    const offerings = await this.rentalOfferings();
    const want = (country || "").toUpperCase();
    if (!want) {
      const countries: Array<Record<string, unknown>> = [];
      for (const o of offerings) {
        const pricing = (o.pricing as Record<string, unknown>) || {};
        let best: number | null = null;
        for (const [days, usd] of Object.entries(pricing)) {
          const d = parseInt(days), u = Number(usd);
          if (d > 0 && (best === null || u / d < best)) best = u / d;
        }
        if (best !== null) countries.push({ country: String(o.country_short || "").toUpperCase(), fromPrice: best });
      }
      return { service, country: null, countries, durations: [] };
    }
    const seen: Record<number, Record<string, unknown>> = {};
    for (const o of offerings) {
      if (!SmspoolClient.countryMatches(o.country_short, want)) continue;
      for (const [days, usd] of Object.entries((o.pricing as Record<string, unknown>) || {})) {
        const d = parseInt(days), u = Number(usd);
        if (d <= 0) continue;
        if (seen[d] && Number(seen[d].price) <= u) continue;
        seen[d] = { durationHours: d * 24, duration: d * 24, days: d, price: u, rental_id: o.ID, pool: o.pool };
      }
    }
    const durations = Object.values(seen).sort((a, b) => Number(a.durationHours) - Number(b.durationHours));
    return { service, country: want, countries: [], durations };
  }

  async createRental(_service: string, country: string, duration: number, maxPrice?: number): Promise<Record<string, unknown>> {
    const days = Math.max(1, Math.round((duration || 24) / 24));
    const want = (country || "").toUpperCase();
    let pick: [Record<string, unknown>, number] | null = null;
    for (const o of await this.rentalOfferings()) {
      if (!SmspoolClient.countryMatches(o.country_short, want)) continue;
      for (const [key, usd] of Object.entries((o.pricing as Record<string, unknown>) || {})) {
        const d = parseInt(key), u = Number(usd);
        if (d !== days) continue;
        if (!pick || u < pick[1]) pick = [o, u];
      }
    }
    if (!pick) throw new ProviderError(400, "RENTAL_NOT_AVAILABLE");
    const [offering, usd] = pick;
    if (maxPrice !== undefined && maxPrice !== null && usd > Number(maxPrice)) throw new ProviderError(400, "RENTAL_NOT_AVAILABLE");
    const resp = this.check(await this.post("/purchase/rental", { id: offering.ID, days }));
    const code = String(resp.rental_code || resp.id || resp.order_id || "");
    const number = String(resp.number || resp.phonenumber || "");
    return { id: code, phoneNumber: number, phone_number: number, price: usd, days, status: "waiting" };
  }
}

// smspin.io fallback client (GET-based JSON API).
class SmspinIOClient {
  private async get(path: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(SMSPIN_BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Authorization: "Bearer " + SMSPIN_KEY } });
    const text = await r.text();
    let data: unknown = {};
    try { data = JSON.parse(text || "{}"); } catch { data = {}; }
    if (!r.ok) throw new ProviderError(r.status, (data as Record<string, unknown>)?.message as string || `HTTP ${r.status}`, data as Record<string, unknown>);
    return data;
  }
  async livePrice(country: string, service: string) {
    const d = (await this.get("/api/v1/price", { country, service })) as Record<string, unknown>;
    return { price_usd: d.price !== undefined ? Number(d.price) : null, available: Number(d.available || d.stock || 0) };
  }
  async createOrder(country: string, service: string) {
    const d = (await this.get("/api/v1/order", { country, service })) as Record<string, unknown>;
    const number = String(d.phone_number || d.phoneNumber || "");
    return { id: String(d.id || d.order_id || ""), phoneNumber: number, phone_number: number,
             price: d.price !== undefined ? Number(d.price) : null, status: "waiting" };
  }
  async getOrder(orderId: string) {
    const d = (await this.get("/api/v1/order", { id: orderId })) as Record<string, unknown>;
    return { id: orderId, status: d.status || "waiting", otpCode: d.code || null, otp_code: d.code || null };
  }
  async cancelOrder(orderId: string) { return this.get("/api/v1/order/cancel", { id: orderId }); }
}

function emptyResult(method: string, r: Record<string, unknown> | null): boolean {
  if (!r) return true;
  if (method === "livePrice") return (r as Record<string, unknown>).price_usd === null || (r as Record<string, unknown>).price_usd === undefined;
  if (method === "rentPrices") return !(r.countries as unknown[])?.length && !(r.durations as unknown[])?.length;
  return false;
}

// Facade: SMSPool first, smspin.io fallback.
export class ProviderClient {
  primary: SmspoolClient | null;
  fallback: SmspinIOClient | null;
  constructor() {
    this.primary = SMSPOOL_KEY ? new SmspoolClient() : null;
    this.fallback = SMSPIN_KEY ? new SmspinIOClient() : null;
  }
  enabled() { return !!(this.primary || this.fallback); }
  setServiceNames(m: Record<string, string>) { this.primary?.setServiceNames(m); }

  private async try<T>(method: string, fn: (p: SmspoolClient | SmspinIOClient) => Promise<T>): Promise<T> {
    const providers = [this.primary, this.fallback].filter(Boolean) as Array<SmspoolClient | SmspinIOClient>;
    let firstErr: unknown = null, empty: T | null = null;
    for (const p of providers) {
      try {
        const r = await fn(p);
        if (emptyResult(method, r as Record<string, unknown>)) { empty = r; continue; }
        return r;
      } catch (e) {
        if (firstErr === null) firstErr = e;
        continue;
      }
    }
    if (empty !== null) return empty;
    if (firstErr) throw firstErr;
    throw new ProviderError(0, `no provider implements ${method}`);
  }

  livePrice(c: string, s: string) { return this.try("livePrice", (p) => p.livePrice(c, s)); }
  createOrder(c: string, s: string) { return this.try("createOrder", (p) => p.createOrder(c, s)); }
  getOrder(id: string) { return this.try("getOrder", (p) => p.getOrder(id)); }
  cancelOrder(id: string) { return this.try("cancelOrder", (p) => p.cancelOrder(id)); }
  rentPrices(s: string, c?: string) {
    return this.try("rentPrices", (p) => p instanceof SmspoolClient ? p.rentPrices(s, c) : Promise.resolve({ service: s, country: c || null, countries: [], durations: [] }));
  }
  createRental(s: string, c: string, d: number, max?: number) {
    return this.try("createRental", (p) => p instanceof SmspoolClient ? p.createRental(s, c, d, max) : Promise.reject(new ProviderError(0, "rentals unavailable")));
  }
}

let _client: ProviderClient | null = null;
export function provider(): ProviderClient {
  if (!_client) _client = new ProviderClient();
  return _client;
}
