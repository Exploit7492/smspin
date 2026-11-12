// O5 + O20: in-app help widget (floating "?" + searchable KB drawer) and the
// contextual-nudge engine (behaviour-triggered tips). Dependency-free; talks to
// the backend KB + Supabase RPCs when a session is present, and degrades to a
// static help index when offline.
(function () {
  const $ = (s, r = document) => (r || document).querySelector(s);
  const $$ = (s, r = document) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Fallback index shown before (or without) a KB fetch.
  const STATIC = [
    { slug: "getting-started", title: "Getting started", category: "basics", excerpt: "Fund your wallet, buy a number and read your first code." },
    { slug: "auto-refunds", title: "What happens if no SMS arrives?", category: "refunds", excerpt: "Orders expire after 20 minutes and refund automatically." },
    { slug: "api-quickstart", title: "API quickstart", category: "developers", excerpt: "Create a key and place your first order over HTTP." },
    { slug: "webhooks", title: "Receiving webhooks", category: "developers", excerpt: "Get a signed POST on every order event." },
    { slug: "billing", title: "Billing & receipts", category: "billing", excerpt: "Where to find invoices and download your ledger." },
    { slug: "launch-store", title: "Launching your own store", category: "business", excerpt: "White-label SMSPin under your brand and domain." },
  ];

  const NUDGE_LS = "smspin_nudges";
  function nudgeSeen(key) {
    try { return (JSON.parse(localStorage.getItem(NUDGE_LS) || "{}")[key]) === true; } catch (e) { return false; }
  }
  function markNudge(key) {
    try { const m = JSON.parse(localStorage.getItem(NUDGE_LS) || "{}"); m[key] = true; localStorage.setItem(NUDGE_LS, JSON.stringify(m)); } catch (e) {}
  }

  function ensureStyles() {
    if ($("#helpCss")) return;
    const l = document.createElement("link");
    l.id = "helpCss"; l.rel = "stylesheet"; l.href = "/help.css";
    document.head.appendChild(l);
  }

  // O17: short how-to videos (hosted or linked) shown alongside articles.
  const VIDEOS = [
    { slug: "fund-wallet", title: "Fund your wallet", mins: "0:45", desc: "Add money with a card, transfer or crypto." },
    { slug: "buy-number", title: "Buy your first number", mins: "1:10", desc: "Pick a service and country, then read the code." },
    { slug: "api-first-call", title: "Make your first API call", mins: "2:20", desc: "Create a key and place an order over HTTP." },
    { slug: "launch-store", title: "Launch a white-label store", mins: "3:05", desc: "Brand it, set markup and go live on your domain." },
    { slug: "become-operator", title: "Become an operator", mins: "1:50", desc: "Register SIMs and earn revenue share." },
  ];

  // --------------------------------------------------------------- O5 help drawer
  let drawer = null;
  function buildDrawer() {
    const el = document.createElement("div");
    el.className = "help-scrim";
    el.innerHTML =
      '<aside class="help-drawer" role="dialog" aria-modal="true" aria-label="Help">' +
        '<div class="help-head"><h3>Help &amp; guides</h3>' +
          '<button class="help-x" type="button" aria-label="Close help">&times;</button></div>' +
        '<div class="help-tabs">' +
          '<button class="help-tab active" type="button" data-tab="articles">Articles</button>' +
          '<button class="help-tab" type="button" data-tab="videos">Videos</button></div>' +
        '<div class="help-search"><input type="search" id="helpQ" placeholder="Search help articles…" autocomplete="off"></div>' +
        '<div class="help-body" id="helpBody"></div>' +
        '<div class="help-foot"><a href="/docs/api/reference" target="_blank" rel="noopener">API reference</a>' +
          '<a href="/contact">Contact support</a></div>' +
      "</aside>";
    document.body.appendChild(el);
    el.addEventListener("click", e => { if (e.target === el) close(); });
    $(".help-x", el).onclick = close;
    const q = $("#helpQ", el);
    let timer = null;
    q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => load(q.value), 220); });
    let tab = "articles";
    el.querySelectorAll(".help-tab").forEach(b => b.onclick = () => {
      tab = b.dataset.tab;
      el.querySelectorAll(".help-tab").forEach(t => t.classList.toggle("active", t === b));
      q.parentElement.style.display = tab === "videos" ? "none" : "";
      renderTab(tab, q.value);
    });
    el._tab = () => tab;
    document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
    return el;
  }

  function renderVideos() {
    const host = $("#helpBody");
    if (!host) return;
    host.innerHTML = VIDEOS.map(v =>
      '<a class="help-art help-vid" href="/docs/videos#' + encodeURIComponent(v.slug) + '">' +
        '<span class="help-play" aria-hidden="true">▶</span>' +
        '<b>' + esc(v.title) + ' <em>' + esc(v.mins) + '</em></b>' +
        '<span>' + esc(v.desc) + '</span></a>').join("");
  }

  function renderTab(tab, query) {
    if (tab === "videos") renderVideos();
    else load(query);
  }

  async function fetchArticles(query) {
    try {
      const r = await fetch("/api/articles" + (query ? "?q=" + encodeURIComponent(query) : ""));
      if (r.ok) { const d = await r.json(); if (Array.isArray(d) && d.length) return d; }
    } catch (e) {}
    const q = (query || "").toLowerCase();
    return STATIC.filter(a => !q || (a.title + " " + a.excerpt + " " + a.category).toLowerCase().includes(q));
  }

  function renderArticles(list) {
    const host = $("#helpBody");
    if (!host) return;
    host.innerHTML = (list && list.length)
      ? list.map(a =>
        '<a class="help-art" href="/dashboard/support/?kb=' + encodeURIComponent(a.slug) + '">' +
          '<b>' + esc(a.title) + '</b><span>' + esc(a.excerpt || "") + '</span>' +
          '<em>' + esc(a.category || "help") + '</em></a>').join("")
      : '<p class="muted" style="padding:18px">No articles matched. Try another word or contact support.</p>';
  }

  async function load(query) { renderArticles(await fetchArticles(query)); }

  function open() {
    ensureStyles();
    if (!drawer) drawer = buildDrawer();
    drawer.classList.add("in");
    renderTab(drawer._tab ? drawer._tab() : "articles", "");
    setTimeout(() => { const q = $("#helpQ"); if (q && q.parentElement.style.display !== "none") q.focus(); }, 120);
  }
  function close() { if (drawer) drawer.classList.remove("in"); }

  // --------------------------------------------------------------- O20 nudges
  // Behaviour-triggered tips. Each nudge fires at most once per browser and only
  // when its condition holds (e.g. wallet empty, no key, order just placed).
  const RULES = [
    { key: "wallet_empty", when: ctx => ctx.wallet != null && Number(ctx.wallet) <= 0 && !ctx.hasOrders,
      target: 'a[href="/dashboard/wallet/"]', title: "Top up to get started",
      body: "Your wallet is empty. Add funds once and numbers work across every service." },
    { key: "no_key", when: ctx => ctx.hasOrders && !ctx.hasKey, page: "api-keys",
      target: 'a[href="/dashboard/api-keys/"]', title: "Automate your buys",
      body: "You've placed orders by hand — create an API key to do it programmatically." },
    { key: "no_store", when: ctx => ctx.hasOrders && !ctx.hasStore && ctx.page === "overview",
      target: 'a[href="/dashboard/business/"]', title: "Sell numbers yourself",
      body: "Launch a white-label store under your own brand and earn margin on every sale." },
  ];

  function renderNudge(rule) {
    const el = document.createElement("div");
    el.className = "nudge";
    el.setAttribute("role", "status");
    el.innerHTML =
      '<div class="nudge-ico" aria-hidden="true">?</div>' +
      '<div class="nudge-txt"><b>' + esc(rule.title) + '</b><span>' + esc(rule.body) + '</span></div>' +
      '<button class="nudge-x" type="button" aria-label="Dismiss">&times;</button>';
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("in"));
    const target = rule.target ? $(rule.target) : null;
    if (target) { target.classList.add("nudge-pulse"); setTimeout(() => target.classList.remove("nudge-pulse"), 6000); }
    const done = () => { el.classList.remove("in"); setTimeout(() => el.remove(), 220); markNudge(rule.key); };
    $(".nudge-x", el).onclick = done;
    el.onclick = e => { if (e.target !== el && target && target.href) { markNudge(rule.key); } };
    setTimeout(done, 12000);
  }

  async function runNudges() {
    const sess = window.SMSPIN && (SMSPIN.getSession ? SMSPIN.getSession() : null);
    if (!sess || !SMSPIN.rpc) return;
    const page = (document.body.dataset.page || "").trim();
    let ctx = { page, wallet: null, hasOrders: false, hasKey: false, hasStore: false };
    try {
      const [w, orders, keys, onb] = await Promise.all([
        SMSPIN.rpc("wallet_summary").catch(() => null),
        SMSPIN.rpc("my_orders", { p_limit: 1 }).catch(() => []),
        SMSPIN.rpc("my_api_keys").catch(() => []),
        SMSPIN.rpc("my_onboarding").catch(() => null),
      ]);
      ctx.wallet = w && w.balance;
      ctx.hasOrders = Array.isArray(orders) && orders.length > 0;
      ctx.hasKey = (keys || []).some(k => !k.revoked);
      const storeItem = onb && onb.items ? onb.items.find(i => i.key === "store") : null;
      ctx.hasStore = !!(storeItem && storeItem.done);
    } catch (e) { return; }
    const rule = RULES.find(r => !nudgeSeen(r.key) && (!r.page || r.page === page) && r.when(ctx));
    if (rule) renderNudge(rule);
  }

  function mountButton() {
    if ($("#helpFab")) return;
    const b = document.createElement("button");
    b.id = "helpFab";
    b.type = "button";
    b.className = "help-fab";
    b.setAttribute("aria-label", "Open help");
    b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.5-1.2 1-1.2 2"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/></svg>';
    b.onclick = open;
    document.body.appendChild(b);
  }

  // --------------------------------------------------------------- O5 inline tooltips
  // Any element with `data-tip` gets a small "?" affordance and a hover/focus
  // tooltip. Declarative, so pages can add help text without extra JS.
  let tipEl = null;
  function showTip(host, text) {
    hideTip();
    tipEl = document.createElement("div");
    tipEl.className = "tip-bubble";
    tipEl.setAttribute("role", "tooltip");
    tipEl.textContent = text;
    document.body.appendChild(tipEl);
    const r = host.getBoundingClientRect();
    tipEl.style.left = Math.min(window.innerWidth - tipEl.offsetWidth - 10, r.left) + "px";
    tipEl.style.top = (r.bottom + 8) + "px";
    requestAnimationFrame(() => tipEl && tipEl.classList.add("in"));
  }
  function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }

  function wireTooltips(root) {
    $$("[data-tip]", root || document).forEach(el => {
      if (el._tipWired) return;
      el._tipWired = true;
      if (!el.hasAttribute("tabindex") && el.tagName !== "BUTTON" && el.tagName !== "A") el.tabIndex = 0;
      const show = () => showTip(el, el.dataset.tip);
      el.addEventListener("mouseenter", show);
      el.addEventListener("focus", show);
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("blur", hideTip);
      el.addEventListener("keydown", e => { if (e.key === "Escape") hideTip(); });
    });
  }

  // E11 PWA: register the offline-shell service worker once per session.
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
    // updateViaCache:"none" so a changed sw.js is picked up immediately instead
    // of being served from the HTTP cache (which pinned stale asset handlers).
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
      .then(reg => { reg.update().catch(() => {}); })
      .catch(() => {});
  }

  function boot() {
    ensureStyles();
    mountButton();
    wireTooltips();
    runNudges();
    registerSW();
    // Re-scan when pages render dynamic content (dashboards hydrate after load).
    try {
      const mo = new MutationObserver(muts => {
        for (const m of muts) {
          if (m.addedNodes && m.addedNodes.length) { wireTooltips(); break; }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.SMSPINHELP = { open, close, tooltips: wireTooltips, tip: showTip, hideTip };
})();
