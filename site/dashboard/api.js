// SMSPin frontend API client — talks to Supabase auth + RPC.
// Config is injected by the page (window.SMSPIN_CONFIG).
(function () {
  const cfg = window.SMSPIN_CONFIG || {};
  const URL = (cfg.url || "").replace(/\/$/, "");
  const KEY = cfg.anonKey || "";

  const TOKEN_KEY = "smspin_session";

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function setSession(s) {
    if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
    else localStorage.removeItem(TOKEN_KEY);
  }
  function accessToken() {
    const s = getSession();
    return s && s.access_token ? s.access_token : KEY;
  }

  async function raw(path, opts = {}, token) {
    const res = await fetch(URL + path, {
      ...opts,
      headers: {
        apikey: KEY,
        Authorization: "Bearer " + (token || accessToken()),
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = (data && (data.msg || data.message || data.error_description || data.error)) || res.statusText;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }

  const auth = {
    async signIn(email, password) {
      const s = await raw("/auth/v1/token?grant_type=password",
        { method: "POST", body: JSON.stringify({ email, password }) }, KEY);
      setSession(s);
      return s;
    },
    async signUp(email, password, fullName) {
      const s = await raw("/auth/v1/signup",
        { method: "POST", body: JSON.stringify({ email, password, data: { full_name: fullName } }) }, KEY);
      if (s && s.access_token) setSession(s);
      return s;
    },
    async resetPassword(email) {
      return raw("/auth/v1/recover",
        { method: "POST", body: JSON.stringify({ email }) }, KEY);
    },
    async updatePassword(newPassword) {
      return raw("/auth/v1/user",
        { method: "PUT", body: JSON.stringify({ password: newPassword }) }, accessToken());
    },
    async signOut() {
      try { await raw("/auth/v1/logout", { method: "POST" }, accessToken()); } catch (e) {}
      setSession(null);
    },
    user() {
      const s = getSession();
      return s && s.user ? s.user : null;
    },
    isAuthed() {
      return !!getSession();
    },
    requireAuth() {
      if (!this.isAuthed()) { location.href = "/login/"; return false; }
      return true;
    },
  };

  // All RPC goes through our own backend (/api/rpc), which forwards the
  // caller's JWT to Supabase. Same origin → no CORS, one cache policy, and
  // RLS/`auth.uid()` still apply because we pass the token through.
  async function rpc(fn, args = {}) {
    const res = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken() },
      body: JSON.stringify({ fn, args }),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = (data && (data.msg || data.message || data.error)) || res.statusText;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }

  // Server-side edge functions. Business logic (funding, purchases) runs
  // server-side so the browser only sees a friendly action name.
  async function functions(name, payload = {}) {
    const res = await fetch(URL + "/functions/v1/" + name, {
      method: "POST",
      headers: {
        apikey: KEY,
        Authorization: "Bearer " + accessToken(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || res.statusText;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }

  // Remember which tenant storefront the visitor came from, so purchases
  // made later in the dashboard are attributed to that store.
  try {
    const s = new URLSearchParams(location.search).get("store");
    if (s) localStorage.setItem("smspin_store", s);
  } catch (e) {}

  // -------------------------------------------------------------------------
  // Tenant (white-label store) identity. Each tenant keeps its OWN account
  // record, so the SAME email can sign up / sign in on any number of stores.
  // Sessions are opaque tokens stored per tenant slug.
  // -------------------------------------------------------------------------
  const TKEY = slug => "smspin_tenant:" + (slug || "main");
  const TENANT_KEY = "smspin_tenant";

  const tenant = {
    _read(slug) {
      try { return JSON.parse(localStorage.getItem(TKEY(slug)) || "null"); } catch (e) { return null; }
    },
    _write(slug, s) {
      try {
        if (s) { localStorage.setItem(TKEY(slug), JSON.stringify(s)); localStorage.setItem(TENANT_KEY, slug || "main"); }
        else localStorage.removeItem(TKEY(slug));
      } catch (e) {}
    },
    session(slug) { return this._read(slug); },
    token(slug) { const s = this._read(slug); return s && s.token ? s.token : null; },
    isAuthed(slug) { return !!this.token(slug); },
    user(slug) { return this._read(slug); },

    async register({ email, password, fullName, slug, storeName, theme, markup }) {
      const r = await rpc("tenant_register", {
        p_email: email, p_password: password, p_full_name: fullName || null,
        p_slug: slug || null, p_store_name: storeName || null,
        p_theme: theme || "crimson", p_markup: markup || 0,
      });
      return r;
    },
    async login(email, password, slug) {
      const s = await rpc("tenant_login", { p_email: email, p_password: password, p_slug: slug || null });
      if (s && s.token) this._write(slug, s);
      return s;
    },
    async me(slug) {
      const t = this.token(slug);
      if (!t) return null;
      return rpc("tenant_me", { p_token: t });
    },
    async wallet(slug) {
      const t = this.token(slug);
      if (!t) return null;
      return rpc("tenant_wallet", { p_token: t });
    },
    async buy(slug, country, service) {
      const t = this.token(slug);
      if (!t) throw new Error("not signed in");
      return rpc("tenant_buy_number", { p_token: t, p_country: country, p_service: service });
    },
    async orders(slug, limit) {
      const t = this.token(slug);
      if (!t) return [];
      return rpc("tenant_orders", { p_token: t, p_limit: limit || 20 });
    },
    async createPayment(slug, amount) {
      const t = this.token(slug);
      if (!t) throw new Error("not signed in");
      return rpc("tenant_create_payment", { p_token: t, p_amount: amount });
    },
    async logout(slug) {
      const t = this.token(slug);
      if (t) { try { await rpc("tenant_logout", { p_token: t }); } catch (e) {} }
      this._write(slug, null);
    },
    current() {
      try { return localStorage.getItem(TENANT_KEY) || "main"; } catch (e) { return "main"; }
    },
  };

  // Real-time funding-fee quote (live FX + World Bank PPP, computed server-side).
  // `amount` is in the wallet currency; `currency` defaults to the wallet currency.
  async function feeQuote(amount, currency) {
    const g = window.SMSPIN_GEO || {};
    const qs = "?amount=" + encodeURIComponent(amount) +
      (g.country ? "&country=" + encodeURIComponent(g.country) : "") +
      "&currency=" + encodeURIComponent(currency || "NGN");
    const res = await fetch("/api/funding/quote" + qs);
    if (!res.ok) return null;
    try { return await res.json(); } catch (e) { return null; }
  }

  // Real number orders run through our backend (same origin): it reserves the
  // wallet balance, calls the upstream SMS provider, and confirms or refunds.
  async function buyOrder({ country, service, operator, tenantToken }) {
    const headers = { "Content-Type": "application/json" };
    if (tenantToken) headers["x-tenant-token"] = tenantToken;
    else headers["Authorization"] = "Bearer " + accessToken();
    const res = await fetch("/api/orders/buy", {
      method: "POST", headers,
      body: JSON.stringify({ country, service, operator, tenant_token: tenantToken }),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  async function rentPrices({ country, service }) {
    const res = await fetch("/api/rent/prices?country=" + encodeURIComponent(country || "") +
      "&service=" + encodeURIComponent(service || ""));
    if (!res.ok) return { durations: [], countries: [] };
    return res.json().catch(() => ({ durations: [], countries: [] }));
  }

  // Countries the provider actually rents this service in (no country arg),
  // so the picker never offers a country where rentals do not exist.
  async function rentCountries({ service }) {
    const res = await fetch("/api/rent/prices?service=" + encodeURIComponent(service || ""));
    if (!res.ok) return [];
    const d = await res.json().catch(() => ({}));
    return d.countries || [];
  }

  async function rentOrder({ country, service, duration, tenantToken }) {
    const headers = { "Content-Type": "application/json" };
    if (tenantToken) headers["x-tenant-token"] = tenantToken;
    else headers["Authorization"] = "Bearer " + accessToken();
    const res = await fetch("/api/orders/rent", {
      method: "POST", headers,
      body: JSON.stringify({ country, service, duration, tenant_token: tenantToken }),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  async function cancelOrder({ orderId, tenantToken }) {
    const headers = { "Content-Type": "application/json" };
    if (tenantToken) headers["x-tenant-token"] = tenantToken;
    else headers["Authorization"] = "Bearer " + accessToken();
    const res = await fetch("/api/orders/cancel", {
      method: "POST", headers,
      body: JSON.stringify({ order_id: orderId, tenant_token: tenantToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  async function orderStatus(orderId) {
    const res = await fetch("/api/order/status?id=" + encodeURIComponent(orderId));
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  window.SMSPIN = { auth, tenant, rpc, functions, feeQuote, buyOrder, rentPrices, rentCountries, rentOrder, cancelOrder, orderStatus, getSession, setSession, config: cfg, store: () => {
    try { return localStorage.getItem("smspin_store") || ""; } catch (e) { return ""; }
  } };
})();
