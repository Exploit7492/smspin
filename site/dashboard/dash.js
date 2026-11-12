// Dashboard hydration — pulls live data from Supabase RPC and renders it.
(function () {
  let page = document.body.dataset.page;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const UI = window.SMSPINUI || { alert: async () => {}, confirm: async () => "ok", reveal: async () => {}, modal: async () => null, select: async () => null };

  const CURRENCY_SYMBOL = { NGN: "\u20a6", USD: "$", GBP: "\u00a3", EUR: "\u20ac", INR: "\u20b9",
    JPY: "\u00a5", BRL: "R$", ZAR: "R", KES: "KSh", GHS: "GH\u20b5", CAD: "C$", AUD: "A$" };
  function money(n, cur) {
    const v = Number(n || 0);
    const c = cur || SITE.currency || "NGN";
    const sym = CURRENCY_SYMBOL[c] || (c + " ");
    return sym + " " + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Service prices are shown as whole numbers: a 1.56 price displays as 2.
  const price = n => Math.ceil(Number(n || 0));
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Brand/currency come from the tenant's settings row (site_config RPC), never hardcoded.
  let SITE = { brand_name: "SMSPin", brand_short: "SMSPin", currency: "NGN", commission: 10, support_email: "" };
  async function loadSite() {
    try { const d = await SMSPIN.rpc("site_config"); if (d) Object.assign(SITE, d); } catch (e) {}
    applyBrand();
  }
  function applyBrand() {
    const name = SITE.brand_name || "SMSPin";
    const short = SITE.brand_short || name;
    document.title = document.title.replace(/SMSPin/g, name);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(n => {
      if (/SMSPin/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/SMSPin/g, name);
    });
    const side = document.querySelector(".side-brand > span:last-child");
    if (side) side.textContent = short;
    const top = document.querySelector(".dash-topbrand .tb-name");
    if (top) top.textContent = name;
    const el = document.querySelector('meta[name="application-name"]');
    if (el) el.setAttribute("content", name);
    mountTopBrand();
  }
  // Fixed top-left brand bar: app logo + tenant name (matches the side panel logo).
  function mountTopBrand() {
    if (document.querySelector(".dash-topbrand")) return;
    const name = SITE.brand_name || "SMSPin";
    const bar = document.createElement("a");
    bar.className = "dash-topbrand";
    bar.href = "/dashboard/";
    bar.setAttribute("aria-label", name + " home");
    bar.innerHTML =
      '<span class="tb-mark" aria-hidden="true">' +
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
          '<path d="M4 5C4 3.9 4.9 3 6 3H18C19.1 3 20 3.9 20 5V14C20 15.1 19.1 16 18 16H13L9.5 19.5C9 20 8 19.6 8 18.9V16H6C4.9 16 4 15.1 4 14V5Z" fill="#FFFFFF"/>' +
          '<rect x="7.5" y="8.5" width="2.5" height="3.5" rx="0.8" fill="currentColor"/>' +
          '<rect x="10.8" y="8.5" width="2.5" height="3.5" rx="0.8" fill="currentColor"/>' +
          '<rect x="14.1" y="8.5" width="2.5" height="3.5" rx="0.8" fill="currentColor"/>' +
        "</svg></span>" +
      '<span class="tb-name">' + esc(name) + "</span>";
    document.body.appendChild(bar);
  }

  // Scale each stat-card value to the largest size that fits its (square) box,
  // so short numbers read big while long money strings never overflow.
  function fitStatValues() {
    document.querySelectorAll(".cards .card").forEach(card => {
      const v = card.querySelector(".v");
      if (!v) return;
      const cs = getComputedStyle(card);
      const avail = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (avail <= 0) return;
      v.style.fontSize = "100px";
      const w = v.scrollWidth;
      let size = w > 0 ? Math.floor(100 * avail / w) : 40;
      size = Math.max(13, Math.min(size, 46));
      v.style.fontSize = size + "px";
    });
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + fmtTime(iso);
  }
  function fmtTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const STATUS = { received: "ok", waiting: "wait", refunded: "err", expired: "err", cancelled: "err" };
  function badge(status) {
    return '<span class="badge ' + (STATUS[status] || "info") + '">' + esc(status) + "</span>";
  }
  function td(label, val, cls) {
    return '<td data-l="' + esc(label) + '"' + (cls ? ' class="' + cls + '"' : "") + ">" + val + "</td>";
  }
  // Platform icon: services.icon is either an emoji or an image URL.
  function serviceIcon(icon, fallback) {
    const v = String(icon || "").trim();
    if (/^https?:\/\//i.test(v) || v.startsWith("/")) {
      return '<span class="sms-ico"><img src="' + esc(v) + '" alt="" loading="lazy" onerror="this.remove()"></span>';
    }
    return '<span class="sms-ico">' + esc(v || fallback || "\u2709") + "</span>";
  }
  // One SMS row for the flat, full-width SMS board.
  function smsRow(m) {
    return '<div class="num-item sms-row">' +
      serviceIcon(m.service_icon, "\u2709") +
      '<div class="sms-main">' +
        '<div class="sms-head"><b>' + esc(m.service || m.sender || "SMS") + "</b>" +
          (m.phone_number ? '<span class="muted">' + esc(m.phone_number) + "</span>" : "") + "</div>" +
        (m.body ? '<div class="sms-body">' + esc(m.body) + "</div>" : "") +
        (m.code ? '<span class="sms-code">' + esc(m.code) + "</span>" : "") +
      "</div>" +
      (m.received_at ? '<span class="sms-time">' + esc(fmtDate(m.received_at)) + "</span>" : "") +
    "</div>";
  }
  function toast(msg, cls) {
    let el = $("#toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99;padding:12px 18px;border-radius:10px;font-size:14px;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,.18)";
      document.body.appendChild(el);
    }
    el.style.background = cls === "err" ? "var(--red-light)" : "var(--emerald-light)";
    el.style.color = cls === "err" ? "var(--red)" : "var(--emerald)";
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.remove(), 3500);
  }

  // O6: teaching empty state — every empty page tells the user the next action.
  function emptyState({ icon, title, body, cta, href }) {
    return '<div class="empty-state"><span class="empty-ico" aria-hidden="true">' + (icon || "\u25CB") + "</span>" +
      '<b class="empty-title">' + esc(title) + "</b>" +
      '<span class="empty-body">' + esc(body) + "</span>" +
      (cta ? '<a class="btn btn-primary empty-cta" href="' + esc(href || "#") + '">' + esc(cta) + "</a>" : "") +
      "</div>";
  }

  // Detect visitor region/currency so prices show in the local currency.
  let GEO = { country: null, currency: "NGN", country_name: null };
  async function loadGeo() {
    try {
      const r = await fetch("/api/geo");
      if (r.ok) GEO = await r.json();
    } catch (e) { /* keep defaults */ }
    window.SMSPIN_GEO = GEO;
    const c = document.getElementById("cy");
    if (c && GEO.country_name && !c.value) c.value = GEO.country_name;
    return GEO;
  }

  // Convert an NGN amount to the visitor's currency (best effort, display only).
  async function localMoney(ngn) {
    if (!GEO || !GEO.currency || GEO.currency === "NGN") return money(ngn, "NGN");
    try {
      const r = await fetch("/api/fx?to=" + GEO.currency + "&amount=" + ngn);
      if (r.ok) { const d = await r.json(); return d.formatted || money(ngn, "NGN"); }
    } catch (e) {}
    return money(ngn, "NGN");
  }

  async function guard() {
    if (!window.SMSPIN) return false;
    if (!SMSPIN.auth.isAuthed()) { location.href = "/login/"; return false; }
    const u = SMSPIN.auth.user();
    if (u && u.email) {
      const local = u.email.split("@")[0];
      const name = (u.user_metadata && u.user_metadata.full_name) || local;
      const av = $(".dash-avatar"); if (av) av.textContent = name[0].toUpperCase();
      const nm = $(".dash-user-name"); if (nm) nm.textContent = name;
      const em = $(".dash-user-email"); if (em) em.textContent = u.email;
      const hi = $("#ovWelcome");
      if (hi) {
        const first = local.split(/[._\-+]+/).filter(Boolean)[0] || local;
        hi.textContent = "Welcome back, " + first.charAt(0).toUpperCase() + first.slice(1);
      }
    }
    return true;
  }

  // Wallet balance pinned in the glass side panel.
  async function fillSideBalance() {
    const el = $("#sideBalance"); if (!el) return;
    try { const w = await SMSPIN.rpc("wallet_summary"); el.textContent = money(w.balance, w.currency); }
    catch (e) {}
  }

  // Service icon: real image if the service has one, else its emoji, else a letter.
  function svcIcon(o, cls) {
    const icon = (o && (o.service_icon || o.icon)) || "";
    const c = "svc-ico" + (cls ? " " + cls : "");
    if (/^https?:\/\//i.test(icon)) return '<span class="' + c + '"><img src="' + esc(icon) + '" alt="" loading="lazy"></span>';
    if (icon) return '<span class="' + c + '">' + esc(icon) + "</span>";
    const letter = String((o && (o.service || o.service_code)) || "?").trim().slice(0, 1).toUpperCase();
    return '<span class="' + c + '">' + esc(letter) + "</span>";
  }

  // Recent orders shown inside the glass side panel.
  async function fillSideOrders() {
    const host = $("#sideOrders"); if (!host) return;
    try {
      const d = await SMSPIN.rpc("my_orders", { p_limit: 4 });
      if (!d || !d.length) { host.innerHTML = '<p class="muted side-empty">No orders yet</p>'; return; }
      host.innerHTML = d.map(o =>
        '<a class="side-order" href="/dashboard/orders/">' +
        svcIcon(o) +
        '<span class="so-svc">' + esc(o.service || "Order") + "</span>" +
        badge(o.status).replace('class="badge', 'class="badge so-badge') +
        '<span class="so-num">' + esc(o.phone_number || "") + "</span></a>").join("");
    } catch (e) { host.innerHTML = '<p class="muted side-empty">Unavailable</p>'; }
  }

  // Active numbers shown inside the glass side panel.
  async function fillSideNumbers() {
    const host = $("#sideNums"); if (!host) return;
    try {
      const d = await SMSPIN.rpc("my_orders", { p_limit: 30 });
      const live = (d || []).filter(o => o.status === "waiting" || o.status === "received").slice(0, 3);
      if (!live.length) { host.innerHTML = '<p class="muted side-empty">No active numbers</p>'; return; }
      host.innerHTML = live.map(o =>
        '<a class="side-order" href="/dashboard/numbers/">' +
        svcIcon(o) +
        '<span class="so-svc">' + esc((o.flag || "") + " " + (o.service || "Number")) + "</span>" +
        badge(o.status).replace('class="badge', 'class="badge so-badge') +
        '<span class="so-num">' + esc(o.phone_number || "") + "</span></a>").join("");
    } catch (e) { host.innerHTML = '<p class="muted side-empty">Unavailable</p>'; }
  }

  // Collapsible glass side panel (mobile).
  function wireSidePanel() {
    const side = $("#dashSide"), btn = $("#dashToggle"), scrim = $("#dashScrim");
    if (!side || !btn) return;
    const close = () => { side.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); if (scrim) scrim.classList.remove("on"); };
    btn.addEventListener("click", () => {
      const open = side.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (scrim) scrim.classList.toggle("on", open);
    });
    if (scrim) scrim.addEventListener("click", close);
    side.addEventListener("click", e => { if (e.target.closest("a")) close(); });
  }

  const CARD_LINKS = {
    overview: ["/dashboard/wallet/", "/dashboard/numbers/", "/dashboard/orders/", "/dashboard/sms/"],
    wallet: ["/dashboard/wallet/", "/dashboard/transactions/", "/dashboard/transactions/", "/dashboard/transactions/"],
    referrals: ["/dashboard/referrals/", "/dashboard/wallet/", "/dashboard/wallet/", "/dashboard/referrals/"],
    profile: ["/dashboard/settings/", "/dashboard/wallet/", "/dashboard/settings/", "/dashboard/referrals/"],
  };
  function wireCardLinks() {
    const links = CARD_LINKS[page];
    if (!links) return;
    $$(".cards .card").forEach((card, i) => {
      if (!links[i]) return;
      if (card.querySelector(".card-fab")) return; // this card opens the funding sheet
      card.classList.add("card-link");
      card.setAttribute("role", "link");
      card.tabIndex = 0;
      card.addEventListener("click", () => { location.href = links[i]; });
      card.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); location.href = links[i]; }
      });
    });
  }

  async function renderOverview() {
    const d = await SMSPIN.rpc("dashboard_overview");
    const cur = d.currency;
    const cards = $$(".cards .card");
    if (cards[0]) $(".v", cards[0]).textContent = money(d.balance, cur);
    if (cards[1]) $(".v", cards[1]).textContent = d.active_numbers;
    if (cards[2]) $(".v", cards[2]).textContent = d.total_orders;
    if (cards[3]) $(".v", cards[3]).textContent = d.sms_received;
    const tb = $("table.tbl tbody");
    if (tb) tb.innerHTML = (d.recent_orders || []).map(o =>
      "<tr>" + td("Service", '<span class="svc-cell">' + svcIcon(o) + esc(o.service || "") + "</span>") +
      td("Number", '<span class="mono">' + esc(o.phone_number) + "</span>") +
      td("Status", badge(o.status)) + td("Price", money(o.price, cur)) + td("Date", fmtDate(o.created_at)) + "</tr>").join("");

    // Quick actions — dynamic speed dial of the services this user buys most,
    // falling back to globally popular services (WhatsApp, X, Facebook, ...).
    const qa = $("#ovQuickActions");
    if (qa) {
      const items = d.quick_actions || [];
      qa.innerHTML = items.length
        ? items.map(s => {
            const icon = s.icon && /^(https?:|data:|\/)/.test(s.icon)
              ? '<img src="' + esc(s.icon) + '" alt="' + esc(s.name) + '" loading="lazy" onerror="this.remove()">'
              : '<span class="qa-emoji">' + esc(s.icon || (s.name || "?").charAt(0)) + "</span>";
            return '<button class="qa-tile" type="button" data-svc="' + esc(s.code) + '" title="Buy ' + esc(s.name) + '">' +
              '<span class="qa-ico">' + icon + "</span></button>";
          }).join("")
        : '<p class="muted">No services available right now.</p>';
      $$("[data-svc]", qa).forEach(b => b.addEventListener("click", () =>
        location.href = "/dashboard/buy/?service=" + encodeURIComponent(b.dataset.svc)));
    }

    // Incoming messages board — latest SMS landing on the user's numbers.
    const grid = $("#ovMsgGrid");
    if (grid) {
      const msgs = d.recent_messages || [];
      const cnt = $("#ovMsgCount"); if (cnt) cnt.textContent = msgs.length ? msgs.length + " recent" : "None yet";
      grid.innerHTML = msgs.length
        ? msgs.map(smsRow).join("")
        : emptyState({ icon: "\u2709", title: "No messages yet",
            body: "Codes land here the moment they arrive. Buy a number and keep this page open.",
            cta: "Buy a number", href: "/dashboard/buy/" });
    }

    // E6: notification centre.
    await renderNotifications();
    // O16: what's-new announcement banner + feature tour.
    await renderWhatsNew();
  }

  // O16: surface the latest changelog entry once, with a "show me" tour.
  const WN_LS = "smspin_seen_release";
  async function renderWhatsNew() {
    const panel = $("#ovWhatsNew");
    if (!panel) return;
    let items = [];
    try { items = await SMSPIN.rpc("changelog_list", { p_limit: 1 }); } catch (e) { return; }
    const latest = items && items[0];
    if (!latest) { panel.hidden = true; return; }
    let seen = null;
    try { seen = localStorage.getItem(WN_LS); } catch (e) {}
    if (seen === latest.version) { panel.hidden = true; return; }
    panel.hidden = false;
    $("#ovWnTitle").textContent = latest.title || "What's new";
    $("#ovWnBody").textContent = latest.body || "";
    $("#ovWnVer").textContent = latest.version || "";
    $("#ovWnClose").onclick = () => {
      try { localStorage.setItem(WN_LS, latest.version); } catch (e) {}
      panel.hidden = true;
    };
    const tour = $("#ovWnTour");
    if (tour) tour.onclick = () => {
      try { localStorage.setItem(WN_LS, latest.version); } catch (e) {}
      panel.hidden = true;
      if (window.TOUR) TOUR.dashboard(true);
    };
  }

  // ---------------------------------------------------------------- E6 notifications
  async function renderNotifications() {
    const panel = $("#ovNotifPanel"), list = $("#ovNotifList");
    if (!panel || !list) return;
    let d;
    try { d = await SMSPIN.rpc("my_notifications", { p_limit: 20 }); } catch (e) { return; }
    if (!d || !d.items || !d.items.length) { panel.hidden = true; return; }
    panel.hidden = false;
    list.innerHTML = d.items.map(n =>
      '<a class="notif-item' + (n.read ? "" : " unread") + '" href="' + esc(n.href || "#") + '">' +
        '<span class="notif-dot ' + esc(n.kind || "info") + '"></span>' +
        '<span class="notif-text"><b>' + esc(n.title) + "</b>" +
        (n.body ? '<span class="notif-sub">' + esc(n.body) + "</span>" : "") + "</span>" +
        '<span class="notif-time">' + esc(fmtDate(n.created_at)) + "</span></a>").join("");
    const rb = $("#ovNotifRead");
    if (rb) rb.onclick = async (e) => {
      e.preventDefault();
      try { await SMSPIN.rpc("notification_read", { p_all: true }); } catch (err) {}
      renderNotifications();
    };
  }

  async function renderNumbers() {
    const d = await SMSPIN.rpc("my_orders", { p_limit: 100 });
    const host = $("#numCards");
    if (!host) return;
    const cnt = $("#numCount");
    if (cnt) cnt.textContent = (d || []).length + " number" + ((d || []).length === 1 ? "" : "s");
    if (!d || !d.length) { host.innerHTML = emptyState({ icon: "\u260E", title: "No numbers yet",
      body: "A number is reserved the second you buy it. Pick a service and country to begin.",
      cta: "Buy your first number", href: "/dashboard/buy/" }); return; }
    host.innerHTML = d.map(numCard).join("");
    wireFlip(host);
  }

  // One flip card: front shows only the number; tap to flip for full details.
  function numCard(o) {
    return '<div class="num-flip">' +
      '<div class="num-flip-inner">' +
        '<div class="num-face num-front">' +
          '<span class="num-svc-badge">' + svcIcon(o) + esc(o.service || "\u2014") + "</span>" +
          '<span class="num-tap">Tap for details</span>' +
          '<span class="mono num-front-num">' + esc(o.phone_number || "\u2014") + "</span>" +
        "</div>" +
        '<div class="num-face num-back">' +
          '<div class="num-row"><span>Country</span><b>' + esc((o.flag ? o.flag + " " : "") + (o.country || "\u2014")) + "</b></div>" +
          '<div class="num-row"><span>Service</span><b><span class="svc-cell">' + svcIcon(o) + esc(o.service || "\u2014") + "</span></b></div>" +
          '<div class="num-row"><span>Status</span><b>' + badge(o.status) + "</b></div>" +
          '<div class="num-row"><span>Expires</span><b>' + esc(o.expires_at ? fmtDate(o.expires_at) : "\u2014") + "</b></div>" +
          '<div class="num-actions"><a class="btn btn-secondary" href="/dashboard/sms/">Inbox</a>' +
          '<button class="btn btn-ghost" type="button" data-copy="' + esc(o.phone_number || "") + '">Copy</button></div>' +
        "</div>" +
      "</div></div>";
  }

  async function renderOrders() {
    const d = await SMSPIN.rpc("my_orders", { p_limit: 100 });
    const host = $("#orderCards");
    if (!host) return;
    const b = $(".panel-h .badge");
    if (b) b.textContent = (d || []).length + " total";
    if (!d || !d.length) { host.innerHTML = emptyState({ icon: "\u25A4", title: "No orders yet",
      body: "Your purchases show up here with the number, status and price.",
      cta: "Start an order", href: "/dashboard/buy/" }); return; }
    host.innerHTML = d.map(orderCard).join("");
    wireFlip(host);
  }

  // One flip card for an order: front shows only the number; tap to flip for details.
  function orderCard(o) {
    return '<div class="num-flip">' +
      '<div class="num-flip-inner">' +
        '<div class="num-face num-front">' +
          '<span class="num-svc-badge">' + svcIcon(o) + esc(o.service || "\u2014") + "</span>" +
          '<span class="num-tap">Tap for details</span>' +
          '<span class="mono num-front-num">' + esc(o.phone_number || "\u2014") + "</span>" +
        "</div>" +
        '<div class="num-face num-back">' +
          '<div class="num-row"><span>Service</span><b><span class="svc-cell">' + svcIcon(o) + esc(o.service || "\u2014") + "</span></b></div>" +
          '<div class="num-row"><span>Country</span><b>' + esc((o.flag ? o.flag + " " : "") + (o.country || "\u2014")) + "</b></div>" +
          '<div class="num-row"><span>Status</span><b>' + badge(o.status) + "</b></div>" +
          '<div class="num-row"><span>Price</span><b>' + money(o.price) + "</b></div>" +
          '<div class="num-row"><span>Date</span><b>' + esc(fmtDate(o.created_at)) + "</b></div>" +
          '<div class="num-actions"><a class="btn btn-secondary" href="/dashboard/sms/">Inbox</a>' +
          '<button class="btn btn-ghost" type="button" data-copy="' + esc(o.phone_number || "") + '">Copy</button></div>' +
        "</div>" +
      "</div></div>";
  }

  // Wire tap-to-flip + copy on a set of flip cards.
  function wireFlip(host) {
    $$(".num-flip", host).forEach(c => c.addEventListener("click", e => {
      if (e.target.closest("a,button")) return;
      c.classList.toggle("flipped");
    }));
    $$("[data-copy]", host).forEach(b => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast("Number copied", "ok"); }
      catch (e) { toast("Copy failed", "err"); }
    }));
  }

  // ---- Wallet: analytics + funding flow ----
  const PAY_METHODS = [
    { id: "card", label: "Card", note: "Visa, Mastercard, Verve", icon: "💳" },
    { id: "bank", label: "Bank transfer", note: "Instant NGN transfer", icon: "🏦" },
    { id: "ussd", label: "USSD", note: "Pay from your phone", icon: "📱" },
  ];
  let WALLET = null, payMethod = "card";

  async function renderWallet() {
    const d = await SMSPIN.rpc("wallet_summary");
    WALLET = d;
    const cur = d.currency || "NGN";
    drawFlow(d.daily || [], cur);
    drawBars("#walletSvc", d.by_category || [], cur, "name", "icon");
    drawBars("#walletCtry", d.by_country || [], cur, "country", "flag");
    drawActivity(d.activity || [], cur);
    drawFunding(d, cur);
    // B3: multi-currency balances + instant conversion.
    await renderBalances(cur);
  }

  // B3: per-currency balances with a convert panel.
  async function renderBalances(cur) {
    const host = $("#walletBalances");
    if (!host) return;
    let b = null;
    try { b = await SMSPIN.rpc("my_wallet_balances"); } catch (e) { return; }
    if (!b || !b.balances) return;
    host.innerHTML = b.balances.map(x =>
      '<div class="wbal"><span class="wbal-cur">' + esc(x.currency) + "</span>" +
      '<span class="wbal-amt">' + Number(x.balance || 0).toLocaleString(undefined,
        { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "</span></div>").join("")
      || '<p class="muted">No balances yet.</p>';
    const from = $("#wcFrom"), to = $("#wcTo");
    const currs = (b.balances || []).map(x => x.currency);
    if (from) from.innerHTML = currs.map(c => '<option>' + esc(c) + "</option>").join("");
    if (to) to.innerHTML = ["NGN", "USD", "GBP", "EUR"].map(c => '<option>' + esc(c) + "</option>").join("");
    if (to && currs.length) to.value = currs.find(c => c !== (from && from.value)) || "USD";
    const toggle = $("#walletConvertToggle");
    if (toggle) toggle.onclick = () => { const c = $("#walletConvert"); if (c) c.hidden = !c.hidden; };
    const go = $("#wcGo");
    if (go) go.onclick = async () => {
      go.disabled = true;
      try {
        const r = await SMSPIN.rpc("convert_balance", { p_from: from.value, p_to: to.value,
          p_amount: Number($("#wcAmt").value || 0) });
        $("#wcNote").textContent = "Converted to " + Number(r.out).toLocaleString() + " " + r.to;
        renderWallet();
      } catch (e) { $("#wcNote").textContent = e.message; }
      finally { go.disabled = false; }
    };
  }

  // 14-day cash-flow column chart (in vs out), built with divs (no chart lib).
  // Smooth running-balance curve laid over the flow bars (SVG overlay, animated draw-in).
  function drawFlowCurve(host, daily) {
    const old = host.querySelector("svg.wcurve");
    if (old) old.remove();
    if (!daily.length) return;
    // running balance across the window
    let run = 0;
    const series = daily.map(x => { run += (Number(x.in) || 0) - (Number(x.out) || 0); return run; });
    const lo = Math.min(0, ...series), hi = Math.max(1, ...series);
    const span = (hi - lo) || 1;
    const W = 1000, H = 100;
    const n = series.length;
    const xAt = i => (n === 1 ? W / 2 : (i / (n - 1)) * W);
    const yAt = v => H - ((v - lo) / span) * (H * 0.82) - H * 0.09;
    const pts = series.map((v, i) => [xAt(i), yAt(v)]);
    // Catmull-Rom → cubic bezier for a smooth, monotone-looking curve.
    let d = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += "C" + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " +
                 c2x.toFixed(1) + " " + c2y.toFixed(1) + " " +
                 p2[0].toFixed(1) + " " + p2[1].toFixed(1);
    }
    const area = d + "L" + W + " " + H + "L0 " + H + "Z";
    const dots = pts.map(p => '<circle class="wcurve-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2.4"></circle>').join("");
    host.insertAdjacentHTML("afterbegin",
      '<svg class="wcurve" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs><linearGradient id="wcurveFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="var(--brand)" stop-opacity=".28"/>' +
      '<stop offset="100%" stop-color="var(--brand)" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path class="wcurve-area" d="' + area + '"/>' +
      '<path class="wcurve-line" d="' + d + '" style="--len:1"/>' +
      dots + "</svg>");
    // measure once mounted so the dash-draw animation runs the full length
    const svg = host.querySelector("svg.wcurve");
    const line = svg.querySelector(".wcurve-line");
    const len = line.getTotalLength ? line.getTotalLength() : 0;
    line.style.setProperty("--len", len || 1);
  }

  function drawFlow(daily, cur) {
    const host = $("#walletFlow");
    if (!host) return;
    if (!daily.length) { host.innerHTML = '<p class="muted">No activity yet.</p>'; return; }
    const max = Math.max(1, ...daily.map(x => Math.max(x.in, x.out)));
    host.innerHTML = daily.map(x => {
      const hi = (x.in / max) * 100;
      const ho = (x.out / max) * 100;
      const dt = new Date(x.d + "T00:00:00");
      const lbl = dt.toLocaleDateString(undefined, { day: "numeric", month: "short" });
      const tip = lbl + " · in " + money(x.in, cur) + " · out " + money(x.out, cur);
      return '<div class="wcol" tabindex="0" data-tip="' + esc(tip) + '">' +
        '<div class="wcol-bars">' +
        '<span class="wbar in" data-h="' + hi.toFixed(2) + '" style="height:0"></span>' +
        '<span class="wbar out" data-h="' + ho.toFixed(2) + '" style="height:0"></span>' +
        '</div>' +
        '<span class="wcol-l">' + dt.getDate() + "</span></div>";
    }).join("");

    drawFlowCurve(host, daily);

    // Grow the bars in on the next frame so the chart animates to life.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      host.querySelectorAll(".wbar").forEach(b => { b.style.height = b.dataset.h + "%"; });
      host.classList.add("wcurve-in");
    }));

    // Floating hover tooltip.
    const wrap = host.parentElement;
    if (wrap) {
      wrap.classList.add("wchart-wrap");
      let tip = wrap.querySelector(".wchart-tip");
      if (!tip) { tip = document.createElement("div"); tip.className = "wchart-tip"; wrap.appendChild(tip); }
      host.querySelectorAll(".wcol").forEach(col => {
        col.addEventListener("mouseenter", () => { tip.textContent = col.dataset.tip; tip.classList.add("on"); });
        col.addEventListener("mousemove", e => {
          const r = wrap.getBoundingClientRect();
          tip.style.left = (e.clientX - r.left) + "px";
          tip.style.top = (e.clientY - r.top - 10) + "px";
        });
        col.addEventListener("mouseleave", () => tip.classList.remove("on"));
      });
    }
  }

  // Horizontal ranked bars for spend-by-service / spend-by-country.
  function drawBars(sel, rows, cur, labelKey, iconKey) {
    const host = $(sel);
    if (!host) return;
    if (!rows.length) { host.innerHTML = '<p class="muted">Nothing in the last 30 days.</p>'; return; }
    const max = Math.max(1, ...rows.map(r => Number(r.total) || 0));
    host.innerHTML = rows.map(r => {
      const v = Number(r.total) || 0;
      const pct = Math.round((v / max) * 100);
      const icon = r[iconKey] || "";
      const iconHtml = /^https?:\/\//i.test(icon) ? '<img src="' + esc(icon) + '" alt="" loading="lazy">'
        : '<span class="wb-emoji">' + esc(icon || "•") + "</span>";
      return '<div class="wbar-row"><span class="wb-ico">' + iconHtml + "</span>" +
        '<div class="wb-main"><div class="wb-top"><b>' + esc(r[labelKey] || "—") + "</b>" +
        "<span>" + money(v, cur) + "</span></div>" +
        '<div class="wb-track"><span style="width:' + pct + '%"></span></div></div></div>';
    }).join("");
  }

  // Bank-app style activity ledger: grouped by day, icon + title + subtitle + signed amount.
  const TX_LABEL = { topup: "Wallet top-up", purchase: "Number purchase", refund: "Auto refund",
    fee: "Funding fee", referral: "Referral bonus", business_earning: "Store earning" };
  function txMeta(a) {
    const label = TX_LABEL[a.type] || (a.type ? a.type[0].toUpperCase() + a.type.slice(1) : "Transaction");
    let title = label, sub = a.service_name || a.method || "";
    if (a.type === "purchase" && a.service_name) { title = a.service_name + " number"; sub = "Number purchase"; }
    return { title, sub };
  }
  function txIcon(a) {
    const icon = a.service_icon || "";
    if (/^https?:\/\//i.test(icon)) return '<img src="' + esc(icon) + '" alt="" loading="lazy">';
    if (icon) return '<span class="wb-emoji">' + esc(icon) + "</span>";
    if (a.amount >= 0) return '<span class="wb-emoji">⬇</span>';
    return '<span class="wb-emoji">⬆</span>';
  }
  function drawActivity(rows, cur) {
    const host = $("#walletAct");
    if (!host) return;
    if (!rows.length) { host.innerHTML = '<p class="muted">No wallet activity yet.</p>'; return; }
    const groups = [];
    rows.forEach(a => {
      const key = new Date(a.created_at).toDateString();
      let g = groups.find(x => x.key === key);
      if (!g) { g = { key, date: a.created_at, items: [] }; groups.push(g); }
      g.items.push(a);
    });
    host.innerHTML = groups.map(g => {
      const d = new Date(g.date);
      const today = new Date().toDateString() === g.key;
      const yest = new Date(Date.now() - 864e5).toDateString() === g.key;
      const head = today ? "Today" : yest ? "Yesterday"
        : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
      return '<div class="act-day"><div class="act-day-h">' + head + "</div>" +
        g.items.map(a => {
          const m = txMeta(a);
          const pos = a.amount >= 0;
          return '<div class="act-row"><span class="act-ico ' + (pos ? "in" : "out") + '">' + txIcon(a) + "</span>" +
            '<div class="act-main"><b>' + esc(m.title) + "</b>" +
            (m.sub ? "<span>" + esc(m.sub) + "</span>" : "") + "</div>" +
            '<div class="act-amt ' + (pos ? "in" : "out") + '">' + (pos ? "+" : "−") + money(Math.abs(a.amount), cur) +
            '<span class="act-time">' + esc(fmtTime(a.created_at)) + "</span></div></div>";
        }).join("") + "</div>";
    }).join("");
  }

  // Full funding flow: quick amounts + method + summary -> edge function -> checkout.
  function drawFunding(d, cur) {
    const quick = $("#fundQuick");
    if (quick) {
      const amounts = [1000, 2000, 5000, 10000, 20000, 50000];
      quick.innerHTML = amounts.map(a =>
        '<button type="button" class="fund-chip" data-amt="' + a + '">' + money(a, cur) + "</button>").join("");
      $$(".fund-chip", quick).forEach(b => b.addEventListener("click", () => {
        const amt = $("#amt"); if (amt) amt.value = b.dataset.amt;
        $$(".fund-chip", quick).forEach(x => x.classList.remove("on")); b.classList.add("on");
        updateFundSummary(cur);
      }));
    }
    const methods = $("#fundMethods");
    if (methods) {
      methods.innerHTML = PAY_METHODS.map(m =>
        '<button type="button" class="fund-m' + (m.id === payMethod ? " on" : "") + '" data-m="' + m.id + '">' +
        '<span class="fm-ico">' + m.icon + '</span><span class="fm-txt"><b>' + m.label + "</b><span>" + m.note + "</span></span></button>").join("");
      $$(".fund-m", methods).forEach(b => b.addEventListener("click", () => {
        payMethod = b.dataset.m;
        $$(".fund-m", methods).forEach(x => x.classList.remove("on")); b.classList.add("on");
        updateFundSummary(cur);
      }));
    }
    const amt = $("#amt");
    if (amt) amt.addEventListener("input", () => updateFundSummary(cur));
    updateFundSummary(cur);
  }

  let fundFee = null, fundFeeAmt = 0;
  function updateFundSummary(cur) {
    const sum = $("#fundSummary");
    const btn = $("#fundBtn");
    if (!sum) return;
    const amt = Number((document.getElementById("amt") || {}).value || 0);
    const m = PAY_METHODS.find(x => x.id === payMethod) || PAY_METHODS[0];
    const fee = (fundFee && fundFeeAmt === amt) ? fundFee : null;
    sum.innerHTML =
      '<div class="fs-row"><span>Amount</span><b>' + money(amt, cur) + "</b></div>" +
      '<div class="fs-row"><span>Method</span><b>' + esc(m.label) + "</b></div>" +
      (fee
        ? '<div class="fs-row"><span>Fee <span class="fs-pct">' + (fee.fee_percent || 0) + '%</span></span><b>-' + money(fee.fee, cur) + "</b></div>" +
          '<div class="fs-row"><span>You pay</span><b>' + money(amt, cur) + "</b></div>" +
          '<div class="fs-row fs-total"><span>Wallet credit</span><b>' + money(fee.net, cur) + "</b></div>"
        : '<div class="fs-row fs-total"><span>You pay</span><b>' + money(amt, cur) + "</b></div>");
    if (btn) { btn.textContent = amt > 0 ? "Top up " + money(amt, cur) : "Enter an amount"; btn.disabled = !(amt > 0); }
    if (amt > 0 && SMSPIN.feeQuote && fundFeeAmt !== amt) {
      fundFeeAmt = amt;
      SMSPIN.feeQuote(amt, cur).then(q => { if (q && Number((document.getElementById("amt")||{}).value||0) === amt) { fundFee = q; updateFundSummary(cur); } });
    }
  }

  async function renderSettings() {
    const d = await SMSPIN.rpc("wallet_summary");
    const on = $("#atOn"), th = $("#atThreshold"), am = $("#atAmount"), st = $("#atStatus");
    if (on) on.checked = !!d.auto_topup;
    if (th) th.value = d.auto_topup_threshold || 1000;
    if (am) am.value = d.auto_topup_amount || 5000;
    if (st) { st.textContent = d.auto_topup ? "On" : "Off"; st.className = "badge " + (d.auto_topup ? "ok" : "info"); }
    await renderGrowthSettings();
  }

  // I4/I5/B7/L4: coupons, saved payment methods and the product changelog.
  async function renderGrowthSettings() {
    const redeem = $("#stRedeem");
    if (redeem) redeem.onclick = async () => {
      const code = ($("#stCoupon").value || "").trim();
      if (!code) return;
      redeem.disabled = true;
      try {
        const r = await SMSPIN.rpc("redeem_coupon", { p_code: code });
        $("#stRedeemNote").textContent = "Added " + money(r.credited || r.value || 0, SITE.currency);
        toast("Coupon applied", "ok");
        if (typeof fillSideBalance === "function") fillSideBalance();
      } catch (e) { $("#stRedeemNote").textContent = e.message; }
      finally { redeem.disabled = false; }
    };
    const payHost = $("#stPayList");
    if (payHost) {
      let m = [];
      try { m = await SMSPIN.rpc("my_payment_methods"); } catch (e) {}
      payHost.innerHTML = (m && m.length) ? m.map(p =>
        '<div class="num-item"><div class="meta"><b>' + esc(p.brand || "Card") + " •••• " + esc(p.last4 || "") +
        "</b><span>" + esc(p.expiry || "") + " · " + esc(p.method || "card") + "</span></div></div>").join("")
        : '<p class="muted">No saved methods. Your last successful top-up is remembered here.</p>';
    }
    const newsHost = $("#stChangelog");
    if (newsHost) {
      let items = [];
      try { items = await SMSPIN.rpc("changelog_list", { p_limit: 10 }); } catch (e) {}
      newsHost.innerHTML = (items && items.length) ? items.map(c =>
        '<div class="num-item"><div class="meta"><b>' + esc(c.title) + "</b><span>" +
        esc(c.version) + " · " + esc(fmtDate(c.released_at)) + "</span></div></div>").join("")
        : '<p class="muted">No announcements yet.</p>';
    }
    await renderOperator();
  }

  // O14: operator onboarding wizard — SIM registration, device pairing, revenue.
  async function renderOperator() {
    const badge = $("#opStatus");
    if (!badge) return;
    const panes = $$(".op-pane");
    const steps = $$("#opSteps li");
    const next = $("#opNext"), back = $("#opBack");
    let cur = 1;
    function show(n) {
      cur = Math.max(1, Math.min(3, n));
      panes.forEach(p => { p.hidden = Number(p.dataset.opPane) !== cur; });
      steps.forEach(s => {
        const k = Number(s.dataset.opStep);
        s.classList.toggle("active", k === cur);
        s.classList.toggle("done", k < cur);
      });
      if (back) back.hidden = cur === 1;
      if (next) next.textContent = cur === 3 ? "Submit application" : "Continue";
    }
    function lock() {
      ["opMsisdn", "opCountry", "opDevice", "opCarrier"].forEach(id => {
        const el = document.getElementById(id); if (el) el.disabled = true;
      });
      if (next) next.disabled = true;
      if (back) back.hidden = true;
      $$("#opSteps li").forEach(s => s.classList.add("done"));
    }

    let o = null;
    try { o = await SMSPIN.rpc("my_operator_status"); } catch (e) { return; }
    if (o && o.id) {
      badge.textContent = o.status;
      badge.className = "badge " + (o.status === "active" ? "ok" : o.status === "rejected" ? "err" : "wait");
      $("#opMsisdn").value = o.msisdn || ""; $("#opCountry").value = o.country || "";
      $("#opDevice").value = o.device || ""; $("#opCarrier").value = o.carrier || "";
      lock();
      $("#opNote").textContent = "Revenue share " + (o.revenue_share || 60) + "%. Applied " + fmtDate(o.created_at) + ".";
      if (o.status === "active" && o.pairing_code) {
        const p = $("#opPair"); if (p) { p.hidden = false; const c = $("#opPairCode"); if (c) c.textContent = o.pairing_code; }
      }
      const econ = $("#opEcon");
      if (econ) econ.innerHTML =
        '<div class="wbal"><span class="wbal-cur">Revenue share</span><span class="wbal-amt">' + (o.revenue_share || 60) + '%</span></div>' +
        '<div class="wbal"><span class="wbal-cur">Status</span><span class="wbal-amt" style="text-transform:capitalize">' + esc(o.status) + "</span></div>" +
        '<div class="wbal"><span class="wbal-cur">Payouts</span><span class="wbal-amt">Weekly</span></div>';
      return;
    }
    badge.textContent = "Not applied";
    show(1);
    if (back) back.onclick = () => show(cur - 1);
    if (next) next.onclick = async () => {
      if (cur === 1) {
        if (!($("#opMsisdn").value || "").trim()) { $("#opNote").textContent = "Enter your SIM number."; return; }
        show(2); return;
      }
      if (cur === 2) { show(3); return; }
      next.disabled = true;
      try {
        await SMSPIN.rpc("apply_operator", { p_msisdn: $("#opMsisdn").value.trim(),
          p_country: $("#opCountry").value.trim() || null, p_device: $("#opDevice").value.trim() || null,
          p_carrier: $("#opCarrier").value.trim() || null });
        toast("Application submitted", "ok");
        await renderOperator();
      } catch (e) { $("#opNote").textContent = e.message; next.disabled = false; }
    };
  }


  let TX_ROWS = [], TX_FILTER = "all";

  const TXP_LABEL = {
    topup: "Top-up", purchase: "Number purchase", refund: "Refund",
    fee: "Funding fee", business_earning: "Business earning", referral: "Referral payout",
  };
  const TX_STATUS = {
    success: { label: "Success", cls: "ok" },
    pending: { label: "Pending", cls: "wait" },
    waiting: { label: "Waiting", cls: "wait" },
  };
  function txStatus(row) {
    const s = row.status || "success";
    return TX_STATUS[s] ? s : "success";
  }

  function drawTxTabs() {
    const counts = { all: TX_ROWS.length, success: 0, pending: 0, waiting: 0 };
    TX_ROWS.forEach(r => { counts[txStatus(r)]++; });
    $$(".tx-tab").forEach(t => {
      const st = t.dataset.st;
      t.classList.toggle("on", st === TX_FILTER);
      t.setAttribute("aria-selected", st === TX_FILTER ? "true" : "false");
      const c = $('[data-count="' + st + '"]', t); if (c) c.textContent = counts[st] || 0;
    });
    return counts;
  }

  function drawTxRows() {
    const tb = $("table.tbl tbody");
    if (!tb) return;
    const rows = TX_FILTER === "all" ? TX_ROWS : TX_ROWS.filter(r => txStatus(r) === TX_FILTER);
    const title = $("#txPanelTitle");
    if (title) title.textContent = TX_FILTER === "all" ? "All transactions"
      : TX_STATUS[TX_FILTER].label + " transactions";
    const sum = $("#txSum");
    if (sum) {
      const net = rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);
      sum.textContent = rows.length + " entr" + (rows.length === 1 ? "y" : "ies") + " · net " +
        (net >= 0 ? "+ " : "- ") + money(Math.abs(net));
    }
    tb.innerHTML = rows.length ? rows.map(a => {
      const badge = TX_STATUS[txStatus(a)];
      return "<tr>" +
        td("Type", esc(TXP_LABEL[a.type] || a.type)) +
        td("Amount", '<span class="badge ' + (a.amount >= 0 ? "ok" : "err") + '">' + (a.amount >= 0 ? "+ " : "- ") + money(Math.abs(a.amount)) + "</span>") +
        td("Method", esc(a.method || "")) +
        td("Status", '<span class="badge ' + badge.cls + '">' + badge.label + "</span>") +
        td("Date", fmtDate(a.created_at)) + "</tr>";
    }).join("") : '<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">No ' +
      (TX_FILTER === "all" ? "" : TX_STATUS[TX_FILTER].label.toLowerCase() + " ") + "transactions yet.</td></tr>";
  }

  async function renderTransactions() {
    const d = await SMSPIN.rpc("my_transactions", { p_limit: 100 });
    TX_ROWS = d || [];
    drawTxTabs();
    drawTxRows();
    $$(".tx-tab").forEach(t => t.addEventListener("click", () => {
      TX_FILTER = t.dataset.st;
      drawTxTabs();
      drawTxRows();
    }));
  }

  const REF_TIER_BASE = { Starter: 0, Bronze: 5, Silver: 15, Gold: 30, Platinum: 50 };
  const REF_TIER_NEXT = { Starter: 5, Bronze: 15, Silver: 30, Gold: 50, Platinum: 50 };

  async function renderReferrals() {
    const d = await SMSPIN.rpc("referral_summary");
    const cards = $$(".cards .card");
    if (cards[0]) $(".v", cards[0]).textContent = d.count;
    if (cards[1]) $(".v", cards[1]).textContent = money(d.earned, SITE.currency);
    if (cards[2]) $(".v", cards[2]).textContent = money(d.earned_month, SITE.currency);
    if (cards[3]) $(".v", cards[3]).textContent = (d.commission || SITE.commission) + "%";

    const link = location.origin + "/register?ref=" + (d.code || "");
    const setTxt = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    setTxt("#refLink", link); setTxt("#refCode", d.code || "—"); setTxt("#refPct", (d.commission || SITE.commission) + "%");
    setTxt("#refTier", d.tier || "Starter");
    setTxt("#refTierNext", d.next_tier ? d.to_next + " more to " + d.next_tier : "Top tier reached");
    setTxt("#refAvail", money(d.available || 0, SITE.currency));

    const base = REF_TIER_BASE[d.tier] || 0, next = REF_TIER_NEXT[d.tier] || 5;
    const pct = next > base ? Math.min(100, Math.round(((d.count - base) / (next - base)) * 100)) : 100;
    const fill = $("#refTierFill"); if (fill) fill.style.width = pct + "%";

    drawRefChart(d.monthly || []);
    drawRefList(d.recent || []);

    const copyBtn = $("#refCopy");
    if (copyBtn) copyBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(link); copyBtn.textContent = "Copied!"; }
      catch (e) { copyBtn.textContent = "Copy failed"; }
      setTimeout(() => (copyBtn.textContent = "Copy link"), 1600);
    });
    const shareBtn = $("#refShare");
    if (shareBtn) shareBtn.addEventListener("click", async () => {
      const data = { title: "Join " + SITE.brand_name, text: "Get instant virtual numbers on " + SITE.brand_name + " with my link.", url: link };
      if (navigator.share) { try { await navigator.share(data); } catch (e) {} }
      else { try { await navigator.clipboard.writeText(link); toast("Link copied to share", "ok"); } catch (e) {} }
    });
    const claim = $("#refClaim");
    if (claim) claim.addEventListener("click", async () => {
      claim.disabled = true;
      try {
        const r = await SMSPIN.rpc("claim_referral_earnings");
        toast("Claimed " + money(r.claimed, SITE.currency) + " to wallet", "ok");
        await renderReferrals();
        if (typeof fillSideBalance === "function") fillSideBalance();
      } catch (e) { toast(e.message, "err"); }
      finally { claim.disabled = false; }
    });
    await renderAffiliatePayouts();
  }

  // I2: affiliate payout panel — withdraw referral earnings to wallet.
  async function renderAffiliatePayouts() {
    const host = document.getElementById("refPayoutPanel");
    if (!host) return;
    let d = null;
    try { d = await SMSPIN.rpc("my_affiliate_payouts"); } catch (e) { return; }
    if (!d) return;
    const when = iso => { try { return new Date(iso).toLocaleDateString(); } catch (e) { return "—"; } };
    host.innerHTML = '<div class="panel"><div class="panel-h"><h2>Affiliate payouts</h2><span class="spacer"></span>' +
      '<button class="btn btn-primary" type="button" id="refPayoutGo">Withdraw ' + money(d.available, SITE.currency) + "</button></div>" +
      '<div class="panel-b"><div class="cards" style="margin-bottom:12px">' +
      '<div class="card"><div class="k">Earned</div><div class="v">' + money(d.earned, SITE.currency) + "</div></div>" +
      '<div class="card"><div class="k">Paid out</div><div class="v">' + money(d.paid, SITE.currency) + "</div></div>" +
      '<div class="card"><div class="k">Available</div><div class="v">' + money(d.available, SITE.currency) + "</div></div></div>" +
      '<div class="list-num">' + ((d.payouts || []).length ? d.payouts.map(p =>
        '<div class="num-item"><div class="meta"><b>' + money(p.amount, SITE.currency) + "</b><span>" +
        esc(p.method) + " · " + esc(p.status) + " · " + esc(when(p.created_at)) + "</span></div></div>").join("")
        : '<p class="muted">No payouts yet.</p>') + "</div></div></div>";
    const go = document.getElementById("refPayoutGo");
    if (go) go.onclick = async () => {
      go.disabled = true;
      try {
        const r = await SMSPIN.rpc("request_affiliate_payout", { p_method: "wallet" });
        toast("Paid " + money(r.amount, SITE.currency) + " to wallet", "ok");
        await renderAffiliatePayouts();
      } catch (e) { toast(e.message, "err"); }
      finally { go.disabled = false; }
    };
  }

  function drawRefChart(monthly) {
    const host = $("#refChart");
    if (!host) return;
    if (!monthly.length) { host.innerHTML = '<p class="muted">No earnings yet.</p>'; return; }
    const max = Math.max(1, ...monthly.map(m => Number(m.v) || 0));
    host.innerHTML = monthly.map(m => {
      const h = Math.round(((Number(m.v) || 0) / max) * 100);
      return '<div class="wcol" title="' + esc(m.m) + " · " + money(m.v, SITE.currency) + '">' +
        '<div class="wcol-bars"><span class="wbar in" style="height:' + Math.max(h, 2) + '%"></span></div>' +
        '<span class="wcol-l">' + esc(m.m) + "</span></div>";
    }).join("");
  }

  function drawRefList(rows) {
    const host = $("#refList");
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<p class="muted">No referrals yet. Share your link to get started.</p>';
      return;
    }
    host.innerHTML = rows.map(r => {
      const initial = esc((r.email || "?").charAt(0).toUpperCase());
      return '<div class="act-row"><span class="act-ico in">' + initial + "</span>" +
        '<div class="act-main"><b>' + esc(r.email || "Hidden user") + "</b><span>Joined " + esc(fmtDate(r.created_at)) + "</span></div>" +
        '<div class="act-amt in">+' + money(r.earned, SITE.currency) +
        '<span class="act-time">' + (r.claimed ? "Claimed" : "Available") + "</span></div></div>";
    }).join("");
  }


  async function renderProfile() {
    const d = await SMSPIN.rpc("my_profile");
    if (!d) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
    set("fn", d.full_name); set("em", d.email); set("ph", d.phone); set("cy", d.country);

    const name = d.full_name || "Account holder";
    const txt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    txt("pfName", name);
    txt("pfEmail", d.email || "you@example.com");
    txt("pfSince", d.created_at ? "Member since " + new Date(d.created_at).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "Member");
    txt("pfCode", d.referral_code ? "Code " + d.referral_code : "No referral code");
    txt("pfCodeCard", d.referral_code || "—");
    txt("pfCountry", d.country || "—");
    txt("pfVerifyEmail", d.email || "—");
    txt("pfVerifyPhone", d.phone ? d.phone : "Not added yet");
    const av = document.getElementById("pfAvatar");
    if (av) av.textContent = (name.trim()[0] || "A").toUpperCase();
  }

  async function renderApiKeys() {
    const wrap = $(".panel-b");
    if (!wrap) return;
    const head = $(".panel-h .btn-primary");
    let activeId = null;

    async function draw() {
      const d = await SMSPIN.rpc("my_api_keys");
      const active = (d || []).filter(k => !k.revoked);
      activeId = active.length ? active[0].id : null;

      if (head) {
        head.textContent = activeId ? "Regenerate key" : "Generate key";
        head.disabled = false;
      }

      if (!d || !d.length) {
        wrap.innerHTML = '<p class="muted">No API key yet. Generate one to get started. ' +
          'You can hold one active key at a time.</p>';
        return;
      }

      const current = active[0];
      let html = "";
      if (current) {
        html += '<div class="copyrow" style="margin-bottom:10px"><span class="mono">' + esc(current.key_prefix) + "</span>" +
          '<span class="badge ok">Active</span>' +
          '<button class="btn btn-ghost" type="button" data-copy="' + esc(current.key_prefix) + '">Copy</button>' +
          '<button class="btn btn-danger-ghost" type="button" data-revoke="' + current.id + '">Revoke</button>' +
          "</div>";
      } else {
        html += '<p class="muted">No active key. Generate a new one to continue.</p>';
      }

      const revoked = d.filter(k => k.revoked);
      if (revoked.length) {
        html += '<p class="muted" style="margin-top:16px">History</p>';
        html += revoked.slice(0, 5).map(k =>
          '<div class="copyrow" style="margin-bottom:8px;opacity:.7"><span class="mono">' + esc(k.key_prefix) + "</span>" +
          '<span class="badge err">Revoked</span></div>').join("");
      }
      wrap.innerHTML = html;

      $$("[data-copy]", wrap).forEach(b => b.addEventListener("click", () => {
        navigator.clipboard?.writeText(b.dataset.copy).catch(() => {});
        toast("Key prefix copied", "ok");
      }));
      $$("[data-revoke]", wrap).forEach(b => b.addEventListener("click", async () => {
        const ok = await UI.confirm({
          title: "Revoke API key",
          message: "Apps using this key stop working immediately.",
          tone: "warn",
          actions: [{ id: "cancel", label: "Keep key", variant: "ghost" },
                    { id: "ok", label: "Revoke", variant: "danger" }],
        });
        if (ok !== "ok") return;
        try { await SMSPIN.rpc("revoke_api_key", { p_id: Number(b.dataset.revoke) }); toast("Key revoked", "ok"); draw(); }
        catch (e) { toast(e.message, "err"); }
      }));
    }

    if (head) head.addEventListener("click", async () => {
      const isRegen = !!activeId;
      if (isRegen) {
        const ok = await UI.confirm({
          title: "Regenerate API key",
          message: "Your current key stops working the moment a new one is created.",
          tone: "warn",
          actions: [{ id: "cancel", label: "Cancel", variant: "ghost" },
                    { id: "ok", label: "Regenerate", variant: "primary" }],
        });
        if (ok !== "ok") return;
      }
      head.disabled = true;
      try {
        const r = isRegen
          ? await SMSPIN.rpc("regenerate_api_key", { p_name: "key-" + Date.now().toString(36) })
          : await SMSPIN.rpc("create_api_key", { p_name: "key-" + Date.now().toString(36) });
        await navigator.clipboard?.writeText(r.secret).catch(() => {});
        await UI.reveal({
          title: "Your new API key",
          note: "Copy it now — it is shown only once and cannot be recovered later.",
          value: r.secret,
        });
        draw();
      } catch (e) { toast(e.message, "err"); head.disabled = false; }
    });

    // Base URL + example use this deployment's own origin, not the upstream host.
    const base = location.origin + "/api/v1";
    const ep = document.getElementById("ep");
    const curl = document.getElementById("curl");
    if (ep) ep.value = base;
    if (curl) curl.value =
      'curl ' + base + '/catalog -H "x-api-key: sk_live_..."\n' +
      'curl ' + base + '/order -H "x-api-key: sk_live_..." -d "service=whatsapp&country=gb"';

    await draw();
    await devPlatform();
  }

  // H1-H7: developer platform — usage, sandbox, key settings, customer webhooks.
  async function devPlatform() {
    // H5 usage metering.
    const usage = document.getElementById("devUsage");
    if (usage) {
      let u = null;
      try { u = await SMSPIN.rpc("api_usage_summary", { p_days: 30 }); } catch (e) {}
      if (u) {
        const q = document.getElementById("devQuota");
        if (q) q.textContent = u.total + " calls · quota " + (u.quota || 0) + "/mo";
        usage.innerHTML = '<div class="wbal"><span class="wbal-cur">Calls (30d)</span><span class="wbal-amt">' +
          Number(u.total || 0).toLocaleString() + "</span></div>";
        const paths = document.getElementById("devUsagePaths");
        if (paths && u.by_path) {
          const max = Math.max(1, ...u.by_path.map(p => p.count));
          paths.innerHTML = u.by_path.map(p =>
            '<div class="wbar-row"><div class="wb-main"><div class="wb-top"><b>' + esc(p.path) + "</b>" +
            "<span>" + p.count + "</span></div>" +
            '<div class="wb-track"><span style="width:' + Math.round(p.count / max * 100) + '%"></span></div></div></div>').join("");
        }
      }
    }
    // H4 sandbox key.
    const sb = document.getElementById("devSandbox");
    if (sb) sb.onclick = async () => {
      try {
        const r = await SMSPIN.rpc("create_sandbox_key", { p_name: "sandbox-" + Date.now().toString(36) });
        const rev = document.getElementById("devSandboxReveal");
        rev.hidden = false;
        rev.innerHTML = "<b>Sandbox key (never billed):</b><code>" + esc(r.key) + "</code>";
      } catch (e) { toast(e.message, "err"); }
    };
    // H1 key settings for the active key.
    const save = document.getElementById("ksSave");
    if (save) save.onclick = async () => {
      const keys = await SMSPIN.rpc("my_api_keys");
      const active = (keys || []).find(k => !k.revoked);
      if (!active) { toast("Create a key first", "err"); return; }
      try {
        const scopes = (document.getElementById("ksScopes").value || "read").split(",");
        const ips = (document.getElementById("ksIps").value || "").split(",").map(s => s.trim()).filter(Boolean);
        await SMSPIN.rpc("api_key_settings", {
          p_id: active.id, p_scopes: scopes,
          p_rate_limit: Number(document.getElementById("ksRate").value || 60),
          p_quota: Number(document.getElementById("ksQuota").value || 10000),
          p_ip_allowlist: ips,
        });
        toast("Key settings saved", "ok");
      } catch (e) { toast(e.message, "err"); }
    };
    // H2 customer webhooks.
    await drawWebhooks();
    // O7 developer onboarding: playground + SDK snippets.
    devPlayground();
  }

  // O7: a live API playground that calls the deployment's own /api/v1 with the
  // caller's key, plus copy-ready snippets in four languages.
  function devPlayground() {
    const run = document.getElementById("pgRun");
    const out = document.getElementById("pgOut");
    const base = location.origin;
    const key = ($(".copyrow .mono") && $(".copyrow .mono").textContent.trim()) || "sk_live_...";

    const SNIPPETS = {
      curl: 'curl "' + base + '/api/v1/catalog?service=whatsapp&country=gb" \\\n  -H "x-api-key: ' + key + '"',
      node: 'const res = await fetch("' + base + '/api/v1/catalog?service=whatsapp&country=gb", {\n' +
            '  headers: { "x-api-key": "' + key + '" },\n});\nconst catalog = await res.json();\nconsole.log(catalog);',
      python: 'import requests\n\nr = requests.get(\n    "' + base + '/api/v1/catalog",\n' +
              '    params={"service": "whatsapp", "country": "gb"},\n' +
              '    headers={"x-api-key": "' + key + '"},\n)\nprint(r.json())',
      php: '$ch = curl_init("' + base + '/api/v1/catalog?service=whatsapp&country=gb");\n' +
           'curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n' +
           'curl_setopt($ch, CURLOPT_HTTPHEADER, ["x-api-key: ' + key + '"]);\n' +
           '$catalog = json_decode(curl_exec($ch), true);',
    };
    function drawSnippet(lang) {
      const host = document.getElementById("devSnippet");
      if (host) host.textContent = SNIPPETS[lang] || SNIPPETS.curl;
      $$("#devSnipTabs .dev-tab").forEach(t => t.classList.toggle("active", t.dataset.lang === lang));
    }
    if (document.getElementById("devSnippet")) {
      $$("#devSnipTabs .dev-tab").forEach(t => t.onclick = () => drawSnippet(t.dataset.lang));
      drawSnippet("curl");
    }
    if (!run) return;
    run.onclick = async () => {
      const spec = document.getElementById("pgMethod").value;
      const sp = spec.indexOf(" ");
      const method = spec.slice(0, sp), path = spec.slice(sp + 1);
      out.textContent = "Running…";
      try {
        const r = await fetch(base + path, { method, headers: { "x-api-key": key } });
        const txt = await r.text();
        let pretty = txt;
        try { pretty = JSON.stringify(JSON.parse(txt), null, 2); } catch (e) {}
        out.textContent = "HTTP " + r.status + "\n\n" + pretty;
      } catch (e) { out.textContent = "Request failed: " + e.message; }
    };
  }

  async function drawWebhooks() {
    const tb = document.querySelector("#whTbl tbody");
    if (!tb) return;
    let subs = [];
    try { subs = await SMSPIN.rpc("my_webhook_subs"); } catch (e) { return; }
    const when = iso => { try { return new Date(iso).toLocaleDateString(); } catch (e) { return "—"; } };
    tb.innerHTML = (subs && subs.length) ? subs.map(s =>
      "<tr><td class=\"mono\">" + esc(s.url) + "</td><td>" + esc((s.events || []).join(", ")) + "</td><td>" +
      esc(when(s.created_at)) + '</td><td><button class="btn btn-danger-ghost" data-whdel="' + s.id + '">Remove</button></td></tr>').join("")
      : '<tr><td colspan="4" class="muted" style="text-align:center;padding:18px">No webhooks yet. Add an endpoint above to get a signed POST on every order event.</td></tr>';
    tb.querySelectorAll("[data-whdel]").forEach(b => b.onclick = async () => {
      try { await SMSPIN.rpc("delete_webhook_sub", { p_id: Number(b.dataset.whdel) }); toast("Webhook removed", "ok"); drawWebhooks(); }
      catch (e) { toast(e.message, "err"); }
    });
    const create = document.getElementById("whCreate");
    if (create) create.onclick = async () => {
      const url = document.getElementById("whUrl").value.trim();
      if (!url) { toast("Enter a URL", "err"); return; }
      try {
        const events = (document.getElementById("whEvents").value || "").split(",").map(s => s.trim()).filter(Boolean);
        const r = await SMSPIN.rpc("create_webhook_sub", { p_url: url, p_events: events });
        const rev = document.getElementById("whReveal");
        rev.hidden = false;
        rev.innerHTML = "<b>Signing secret (store it securely):</b><code>" + esc(r.secret) + "</code>";
        document.getElementById("whUrl").value = "";
        drawWebhooks();
      } catch (e) { toast(e.message, "err"); }
    };
  }

  function pickerIco(el, icon) {
    if (!el) return;
    if (!icon) { el.innerHTML = ""; return; }
    if (/^(https?:|data:|\/)/.test(icon)) el.innerHTML = '<img src="' + esc(icon) + '" alt="" onerror="this.remove()">';
    else el.textContent = icon;
  }

  // Catalog snapshot: cache the stocked catalog + taxonomy in localStorage so
  // the buy picker paints instantly instead of refetching the whole catalog on
  // every visit. The stock counts are advisory; the server re-checks at buy.
  const CAT_SNAP_TTL = 6 * 60 * 60 * 1000;
  // Bump when the snapshot shape changes so old cached snapshots (e.g. ones
  // saved before the full service taxonomy was cached) are discarded.
  const CAT_SNAP_V = 2;
  function catSnapKey(store) { return "smspin_cat_snap:" + CAT_SNAP_V + ":" + (store || "public"); }
  function readCatalogSnapshot(store) {
    try {
      const raw = localStorage.getItem(catSnapKey(store));
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || Date.now() - (s.t || 0) > CAT_SNAP_TTL) return null;
      return s;
    } catch (e) { return null; }
  }
  function writeCatalogSnapshot(store, cat, taxonomy) {
    try {
      localStorage.setItem(catSnapKey(store), JSON.stringify({ t: Date.now(), cat, taxonomy }));
    } catch (e) { /* quota — snapshot is best effort */ }
  }

  async function renderBuy() {
    const store = window.SMSPIN.store && SMSPIN.store();
    let cat = [];
    let taxonomy = null;
    // The picker renders from a cached snapshot so it never blocks on the
    // network on every visit. The snapshot refreshes in the background.
    const SNAP = readCatalogSnapshot(store);
    if (SNAP) { cat = SNAP.cat || []; taxonomy = SNAP.taxonomy || null; }
    const loadCatalog = async () => {
      if (store) {
        const b = await SMSPIN.rpc("business_public", { p_slug: store });
        cat = (b && b.catalog || []).map(c => ({
          country: c.country, country_name: c.country_name, flag: c.flag,
          service: c.service, service_name: c.service_name, service_icon: c.service_icon || c.icon,
          price: c.price_ngn, price_usd: c.price_usd, stock: c.stock,
        }));
      } else {
        cat = await SMSPIN.rpc("browse_catalog", {});
        try { taxonomy = await SMSPIN.rpc("catalog_taxonomy", {}); } catch (e) {}
      }
      if (cat && cat.length) writeCatalogSnapshot(store, cat, taxonomy);
      return { cat, taxonomy };
    };
    if (!SNAP) { try { await loadCatalog(); } catch (e) {} }
    const btn = document.getElementById("buyBtn");
    const svcBtn = document.getElementById("svcPick"), ctryBtn = document.getElementById("ctryPick");
    if (!cat) cat = [];
    if ((!cat || !cat.length) && !(taxonomy && taxonomy.services && taxonomy.services.length)) {
      if (btn) { btn.disabled = true; btn.textContent = "Catalog unavailable"; }
      const t = document.getElementById("svcPickTxt"); if (t) t.textContent = "Unavailable";
      const t2 = document.getElementById("ctryPickTxt"); if (t2) t2.textContent = "Unavailable";
      return;
    }

    // Rebuilt from the (possibly refreshed) catalog + taxonomy. Kept in a
    // function because a stale snapshot paints a short list first; once the
    // live taxonomy lands we rebuild so newly added services (e.g. GitHub)
    // become selectable without a hard reload.
    let countries = [], services = [];
    const seenC = {}, seenS = {}, codeToService = {};
    function buildLists() {
      countries = []; services = [];
      for (const k in seenC) delete seenC[k];
      for (const k in seenS) delete seenS[k];
      for (const k in codeToService) delete codeToService[k];
      if (taxonomy) {
        (taxonomy.services || []).forEach(s => {
          const key = (s.name || s.code).toLowerCase();
          codeToService[s.code] = key;
          if (!seenS[key]) seenS[key] = { value: key, label: s.name, icon: s.icon, code: s.code };
          else if (!seenS[key].icon && s.icon) seenS[key].icon = s.icon;
        });
        (taxonomy.countries || []).forEach(c => {
          if (!seenC[c.code]) { seenC[c.code] = 1; countries.push({ value: c.code, label: c.name, icon: c.flag }); }
        });
      }
      cat.forEach(c => {
        if (!seenC[c.country]) { seenC[c.country] = 1; countries.push({ value: c.country, label: c.country_name, icon: c.flag }); }
        const key = (c.service_name || c.service).toLowerCase();
        codeToService[c.service] = key;
        if (!seenS[key]) { seenS[key] = { value: key, label: c.service_name, icon: c.service_icon, code: c.service }; }
        else { if (!seenS[key].icon && c.service_icon) seenS[key].icon = c.service_icon;
               if (!seenS[key].code) seenS[key].code = c.service; }
      });
      services.push(...Object.values(seenS));
      countries.sort((a, b) => a.label.localeCompare(b.label));
      services.sort((a, b) => a.label.localeCompare(b.label));
    }
    buildLists();

    // Smart defaults: honour ?country/?service deep links (resolving service
    // aliases), else fall back to the last country this user bought in, else
    // their geo country, else the first in the list.
    const params = new URLSearchParams(location.search);
    const wantSvc = params.get("service"), wantCtry = params.get("country");
    const resolveSvc = v => {
      if (!v) return null;
      const lv = v.toLowerCase();
      if (services.some(s => s.value === lv)) return lv;
      return codeToService[v] || null;
    };
    let defCountry = (wantCtry && countries.some(c => c.value === wantCtry)) ? wantCtry : null;
    let last = {};
    try { last = JSON.parse(localStorage.getItem("smspin_last:buy") || "{}"); } catch (e) {}
    if (!defCountry && last.country && countries.some(c => c.value === last.country)) defCountry = last.country;
    const geoC = (GEO.country || "").toLowerCase();
    if (!defCountry && geoC && countries.some(c => c.value === geoC)) defCountry = geoC;
    const country = defCountry || (countries[0] && countries[0].value);
    const MAINSTREAM = ["whatsapp", "telegram", "google", "facebook", "instagram", "tiktok", "twitter / x", "x", "discord", "uber"];
    const svcReach = {};
    cat.forEach(c => { const k = codeToService[c.service]; if (k) svcReach[k] = (svcReach[k] || 0) + 1; });
    const inCountry = new Set(cat.filter(c => c.country === country).map(c => codeToService[c.service]));
    const defSvc = MAINSTREAM.find(v => inCountry.has(v))
      || services.map(s => s.value).filter(v => inCountry.has(v)).sort((a, b) => (svcReach[b] || 0) - (svcReach[a] || 0))[0];
    const state = {
      mode: "temp",
      duration: 24,
      durations: [],
      country,
      service: resolveSvc(wantSvc) || resolveSvc(last.service) || defSvc || (services[0] && services[0].value),
    };
    function svcCode(key) {
      const s = services.find(x => x.value === key);
      return (s && s.code) || key;
    }

    function paintService() {
      const s = services.find(x => x.value === state.service);
      const t = document.getElementById("svcPickTxt");
      if (t) t.textContent = s ? s.label : "Choose a service";
      pickerIco(document.getElementById("svcPickIco"), s && s.icon);
    }
    function paintCountry() {
      const c = countries.find(x => x.value === state.country);
      const t = document.getElementById("ctryPickTxt");
      if (t) t.textContent = c ? c.label : "Choose a country";
      pickerIco(document.getElementById("ctryPickIco"), c && c.icon);
    }
    function remember() {
      try { localStorage.setItem("smspin_last:buy", JSON.stringify({ country: state.country, service: state.service })); } catch (e) {}
    }

    // ---- Mode switch (Temp / Rent) ----
    function paintMode() {
      $$("#buyModes .buy-mode").forEach(b => {
        const on = b.dataset.mode === state.mode;
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      const rent = document.getElementById("buyRent");
      if (rent) rent.hidden = state.mode !== "rent";
    }
    $$("#buyModes .buy-mode").forEach(b => b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      paintMode();
      if (state.mode === "rent") loadDurations(); else updatePrice();
    }));

    // ---- Duration picker (rent mode) ----
    async function loadDurations() {
      const host = document.getElementById("rentDurations");
      if (!host) return;
      host.innerHTML = '<p class="muted">Loading durations…</p>';
      const code = svcCode(state.service);
      let d = [];
      try { d = (await SMSPIN.rentPrices({ country: state.country, service: code })).durations || []; } catch (e) {}
      state.durations = d;
      if (!d.length) { host.innerHTML = '<p class="muted">Rentals are not available for this pair. Try another service or country.</p>'; updatePrice(); return; }
      if (!d.some(x => x.hours === state.duration)) state.duration = d[0].hours;
      host.innerHTML = d.map(x =>
        '<button type="button" class="rent-dur' + (x.hours === state.duration ? " on" : "") + '" data-h="' + x.hours + '">' +
        '<b>' + esc(x.label) + '</b><span>' + money(price(x.price_ngn), "NGN") + '</span></button>').join("");
      $$(".rent-dur", host).forEach(b => b.addEventListener("click", () => {
        state.duration = Number(b.dataset.h);
        $$(".rent-dur", host).forEach(x => x.classList.toggle("on", Number(x.dataset.h) === state.duration));
        updatePrice();
      }));
      updatePrice();
    }

    // Available stock for the currently selected pair, shown on the card.
    const stockEl = document.getElementById("buyStock");
    let curPrice = null, curStock = 0, curCode = null;
    async function updatePrice() {
      if (!btn) return;
      const code = svcCode(state.service);
      curCode = code;

      if (state.mode === "rent") {
        if (!state.durations.length) {
          if (stockEl) { stockEl.textContent = "Rental pricing unavailable"; stockEl.classList.add("is-out"); }
          btn.disabled = true; btn.textContent = "Unavailable"; return;
        }
        const pick = state.durations.find(x => x.hours === state.duration) || state.durations[0];
        curPrice = Number(pick.price_ngn);
        if (stockEl) { stockEl.textContent = pick.label + " rental · whole-dollar price"; stockEl.classList.remove("is-out"); }
        btn.disabled = false;
        btn.textContent = "Rent " + pick.label + " · " + money(price(curPrice), "NGN");
        return;
      }

      // Temp (one-shot OTP) mode.
      let row = cat.find(c => c.country === state.country &&
                              (c.service === code || codeToService[c.service] === state.service));
      if (!row || !Number(row.stock)) {
        try {
          const hdrs = {};
          try { const s = SMSPIN.getSession && SMSPIN.getSession(); if (s && s.access_token) hdrs.Authorization = "Bearer " + s.access_token; } catch (e) {}
          const rr = await fetch("/api/catalog/live?country=" + encodeURIComponent(state.country) +
                                 "&service=" + encodeURIComponent(code), { headers: hdrs });
          if (rr.ok) {
            const d = await rr.json();
            if (d.price_ngn) row = { price: d.price_ngn, stock: d.available || 0 };
          }
        } catch (e) { /* fall back to what we have */ }
      }
      curPrice = row ? Number(row.price) : null;
      curStock = row ? Number(row.stock || 0) : 0;
      if (stockEl) {
        stockEl.textContent = curStock ? curStock.toLocaleString() + " in stock" : "Out of stock";
        stockEl.classList.toggle("is-out", !curStock);
      }
      if (!row || !curPrice) { btn.textContent = "Unavailable"; btn.disabled = true; return; }
      if (!curStock) { btn.textContent = "Out of stock"; btn.disabled = true; return; }
      btn.disabled = false;
      let label = money(price(curPrice), "NGN");
      if (GEO.currency && GEO.currency !== "NGN" && row && row.price_usd) {
        label += " (\u2248 " + (GEO.currency === "USD" ? "$" : "") + Number(row.price_usd).toLocaleString() + ")";
      }
      btn.textContent = "Buy number \u00b7 " + label;
    }

    if (svcBtn) svcBtn.addEventListener("click", async () => {
      const v = await UI.select({ title: "Choose a service", items: services, value: state.service,
        searchPlaceholder: "Search " + services.length + " services\u2026", tone: "info" });
      if (v) { state.service = v; remember(); paintService(); if (state.mode === "rent") loadDurations(); else updatePrice(); }
    });
    if (ctryBtn) ctryBtn.addEventListener("click", async () => {
      const v = await UI.select({ title: "Choose a country", items: countries, value: state.country,
        searchPlaceholder: "Search countries\u2026", tone: "info" });
      if (v) { state.country = v; remember(); paintCountry(); if (state.mode === "rent") loadDurations(); else updatePrice(); }
    });

    paintService(); paintCountry(); paintMode();
    await updatePrice();
    if (SNAP) {
      loadCatalog().then(() => {
        buildLists();
        if (wantSvc) state.service = resolveSvc(wantSvc) || state.service;
        if (!services.some(s => s.value === state.service) && services[0]) state.service = services[0].value;
        if (wantCtry && countries.some(c => c.value === wantCtry)) state.country = wantCtry;
        if (!countries.some(c => c.value === state.country) && countries[0]) state.country = countries[0].value;
        paintService(); paintCountry(); updatePrice();
      }).catch(() => {});
    }

    // O4: first-purchase tutorial + sample OTP demo (hidden once the user has ordered).
    const tut = document.getElementById("buyTutorial");
    if (tut) {
      let hasOrders = false;
      try { const o = await SMSPIN.rpc("my_orders", { p_limit: 1 }); hasOrders = !!(o && o.length); } catch (e) {}
      let hidden = false;
      try { hidden = localStorage.getItem("smspin_buy_tut_hidden") === "1"; } catch (e) {}
      tut.hidden = hasOrders || hidden;
      const dis = document.getElementById("buyTutDismiss");
      if (dis) dis.onclick = () => { tut.hidden = true; try { localStorage.setItem("smspin_buy_tut_hidden", "1"); } catch (e) {} };
      const demo = document.getElementById("buyDemoOtp");
      if (demo) demo.onclick = () => {
        const out = document.getElementById("buyDemoOut");
        const code = String(Math.floor(100000 + Math.random() * 900000));
        out.hidden = false;
        out.textContent =
          "Sample inbox (simulated, nothing is charged)\n\n" +
          "From:  WhatsApp\n" +
          "To:    +44 7•• ••• 214\n" +
          "Code:  " + code + "\n" +
          "Time:  " + new Date().toLocaleTimeString() + "\n\n" +
          "Copy the code into the app you are verifying. Real codes arrive the same way.";
      };
    }

    if (btn) btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.classList.add("is-busy");
      const prevLabel = btn.textContent;
      btn.innerHTML = '<span class="btn-spin" aria-hidden="true"></span><span>' +
        (state.mode === "rent" ? "Reserving rental…" : "Reserving number…") + "</span>";
      remember();
      const restore = () => { btn.classList.remove("is-busy"); btn.textContent = prevLabel; };
      try {
        const code = curCode || svcCode(state.service);
        const res = state.mode === "rent"
          ? await SMSPIN.rentOrder({ country: state.country, service: code, duration: state.duration })
          : await SMSPIN.buyOrder({ country: state.country, service: code });
        const r = res || {};
        toast("Number " + (r.phone_number || "") + " reserved", "ok");
        location.href = "/dashboard/sms/?order=" + encodeURIComponent(r.order_id || "");
      } catch (e) { toast(e.message, "err"); restore(); updatePrice(); }
    });

    // ---- Success rates (collapsible) ----
    const srToggle = document.getElementById("srToggle");
    const srBody = document.getElementById("srBody");
    if (srToggle && srBody) srToggle.onclick = async () => {
      const open = srBody.hidden;
      srBody.hidden = !open;
      srToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) await renderSuccessRates();
    };
    async function renderSuccessRates() {
      const host = document.getElementById("srList");
      if (!host || host._done) return;
      let orders = [];
      try { orders = await SMSPIN.rpc("my_orders", { p_limit: 200 }); } catch (e) {}
      host._done = true;
      const done = orders.filter(o => o.status !== "waiting");
      const ok = orders.filter(o => o.status === "received").length;
      const rate = done.length ? Math.round(100 * ok / done.length) : null;
      const bySvc = {};
      orders.forEach(o => {
        const k = o.service || o.service_code || "—";
        bySvc[k] = bySvc[k] || { ok: 0, n: 0 };
        if (o.status !== "waiting") { bySvc[k].n++; if (o.status === "received") bySvc[k].ok++; }
      });
      const top = Object.entries(bySvc).filter(([, v]) => v.n).sort((a, b) => b[1].n - a[1].n).slice(0, 6);
      host.innerHTML =
        '<div class="sr-total"><b>' + (rate == null ? "—" : rate + "%") + '</b><span>overall success rate · ' +
          ok + " of " + done.length + " completed</span></div>" +
        (top.length ? top.map(([name, v]) =>
          '<div class="sr-row"><span>' + esc(name) + '</span><span class="sr-bar"><i style="width:' +
          Math.round(100 * v.ok / v.n) + '%"></i></span><b>' + Math.round(100 * v.ok / v.n) + "%</b></div>").join("")
          : '<p class="muted">Buy a few numbers and your per-service success rates appear here.</p>');
    }

    // ---- My orders: tabs, search, status filters, CSV ----
    let MYORDERS = [], oTab = "temp", oFilter = "all", oQuery = "";
    const FILTERS = [
      ["all", "All"], ["waiting", "Active"], ["received", "Completed"],
      ["cancelled", "Cancelled"], ["refunded", "Expired"],
    ];
    function normStatus(s) { return s === "expired" ? "refunded" : s; }
    function paintOrderTabs() {
      $$("#orderTabs .buy-mode").forEach(b => b.classList.toggle("on", b.dataset.otab === oTab));
    }
    function paintFilters() {
      const host = document.getElementById("orderFilters");
      if (!host) return;
      const base = MYORDERS.filter(o => (oTab === "rent" ? o.is_rental : !o.is_rental));
      const counts = { all: base.length, waiting: 0, received: 0, cancelled: 0, refunded: 0 };
      base.forEach(o => { const s = normStatus(o.status); if (counts[s] != null) counts[s]++; });
      host.innerHTML = FILTERS.map(([k, lbl]) =>
        '<button type="button" class="tx-tab' + (k === oFilter ? " on" : "") + '" data-f="' + k + '">' +
        lbl + ' <span class="tx-count">' + (counts[k] || 0) + "</span></button>").join("");
      $$("[data-f]", host).forEach(b => b.addEventListener("click", () => { oFilter = b.dataset.f; paintFilters(); paintMyOrders(); }));
    }
    function filteredOrders() {
      return MYORDERS.filter(o => (oTab === "rent" ? o.is_rental : !o.is_rental))
        .filter(o => oFilter === "all" || normStatus(o.status) === oFilter)
        .filter(o => !oQuery || String(o.phone_number || "").toLowerCase().includes(oQuery));
    }
    function paintMyOrders() {
      const host = document.getElementById("myOrders");
      if (!host) return;
      const rows = filteredOrders();
      if (!rows.length) {
        host.innerHTML = '<div class="buy-empty"><span class="buy-empty-ico" aria-hidden="true">📬</span>' +
          '<b>' + (oTab === "rent" ? "No rent orders" : "No active orders") + '</b>' +
          '<span>Pick a service and country to buy your first number.</span></div>';
        return;
      }
      host.innerHTML = rows.map(o =>
        '<div class="num-item my-order"><span class="my-order-ico">' + svcIcon(o) + "</span>" +
        '<div class="meta"><b>' + esc(o.service || "—") + "</b>" +
          '<span class="mono">' + esc(o.phone_number || "—") + "</span></div>" +
        '<div class="my-order-meta">' + badge(o.status) +
          '<span class="my-order-price">' + money(price(o.price)) + "</span>" +
          '<span class="muted">' + esc(fmtDate(o.created_at)) + "</span></div></div>").join("");
    }
    function csv() {
      const rows = filteredOrders();
      const head = ["id", "service", "phone_number", "country", "status", "price_ngn", "created_at"];
      const body = rows.map(o => [o.id, o.service, o.phone_number, o.country, o.status, o.price, o.created_at]
        .map(v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"').join(","));
      const blob = new Blob([head.join(",") + "\n" + body.join("\n")], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "smspin-orders-" + new Date().toISOString().slice(0, 10) + ".csv";
      a.click(); URL.revokeObjectURL(a.href);
    }
    try { MYORDERS = (await SMSPIN.rpc("my_orders", { p_limit: 100 })) || []; } catch (e) { MYORDERS = []; }
    paintOrderTabs(); paintFilters(); paintMyOrders();
    $$("#orderTabs .buy-mode").forEach(b => b.addEventListener("click", () => {
      oTab = b.dataset.otab; oFilter = "all"; paintOrderTabs(); paintFilters(); paintMyOrders();
    }));
    const searchEl = document.getElementById("myOrderSearch");
    if (searchEl) searchEl.addEventListener("input", () => { oQuery = searchEl.value.trim().toLowerCase(); paintMyOrders(); });
    const csvBtn = document.getElementById("exportCsv");
    if (csvBtn) csvBtn.addEventListener("click", csv);
    const alertsBtn = document.getElementById("enableAlerts");
    if (alertsBtn) alertsBtn.addEventListener("click", async () => {
      try {
        if (!("Notification" in window)) { toast("Alerts are not supported here", "err"); return; }
        const p = await Notification.requestPermission();
        toast(p === "granted" ? "Alerts enabled" : "Alerts not enabled", p === "granted" ? "ok" : "err");
      } catch (e) { toast("Could not enable alerts", "err"); }
    });
  }

  async function renderSupport() {
    const btn = document.querySelector(".panel-b .btn-primary");
    if (btn) btn.addEventListener("click", async () => {
      const sub = document.getElementById("s1").value.trim() || "Support request";
      const ref = document.getElementById("s2").value.trim();
      const msg = document.getElementById("s3").value.trim();
      if (!msg) { toast("Please enter a message", "err"); return; }
      btn.disabled = true;
      try {
        await SMSPIN.rpc("create_ticket", { p_subject: sub, p_message: msg, p_order_ref: ref || null });
        toast("Ticket created. We will be in touch.", "ok");
        document.getElementById("s3").value = "";
        await loadTickets();
      } catch (e) { toast(e.message, "err"); }
      finally { btn.disabled = false; }
    });
    await loadTickets();
    await loadRefunds();
    await loadKb();
  }

  // K3/O17: searchable knowledge base.
  async function loadKb(q) {
    const host = document.getElementById("kbList");
    if (!host) return;
    let arts = [];
    try { arts = await SMSPIN.rpc("kb_search", { p_q: q || null }); } catch (e) {}
    const search = document.getElementById("kbSearch");
    if (search && !search._wired) {
      search._wired = true;
      let t; search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => loadKb(search.value.trim()), 250); });
    }
    host.innerHTML = (arts && arts.length) ? arts.map(a =>
      '<div class="num-item"><div class="meta"><b>' + esc(a.title) + "</b><span>" + esc(a.category) +
      "</span></div></div>").join("")
      : '<p class="muted">No matching articles.</p>';
  }

  async function loadTickets() {
    const host = document.getElementById("ticketList");
    if (!host) return;
    let tickets = [];
    try { tickets = (await SMSPIN.rpc("my_tickets")) || []; } catch (e) {}
    if (!tickets.length) { host.innerHTML = '<p class="muted">No tickets yet. Send us a message and it will appear here.</p>'; return; }
    host.innerHTML = '<div class="list-num">' + tickets.map(t =>
      '<div class="num-item"><div class="meta"><b>' + esc(t.subject) + "</b><span>" +
      esc(t.status) + " \u00b7 " + t.messages + " message" + (t.messages === 1 ? "" : "s") +
      (t.agent_replies ? ' \u00b7 <b>' + t.agent_replies + " repl" + (t.agent_replies === 1 ? "y" : "ies") + "</b>" : "") +
      "</span></div><button class='btn btn-secondary' type='button' data-ticket='" + t.id + "'>Open</button></div>").join("") + "</div>";
    $$("[data-ticket]", host).forEach(b => b.addEventListener("click", () => openThread(b.dataset.ticket)));
  }

  async function openThread(id) {
    const panel = document.getElementById("ticketThreadPanel");
    const msgs = document.getElementById("threadMsgs");
    if (!panel || !msgs) return;
    panel.hidden = false;
    msgs.innerHTML = '<p class="muted">Loading\u2026</p>';
    let d = null;
    try { d = await SMSPIN.rpc("ticket_thread", { p_ticket_id: Number(id) }); } catch (e) { msgs.innerHTML = '<p class="muted">' + esc(e.message) + "</p>"; return; }
    document.getElementById("threadSubject").textContent = "#" + id + " \u00b7 " + ((d.ticket && d.ticket.subject) || "Ticket");
    msgs.innerHTML = (d.messages || []).map(m =>
      '<div class="adm-msg ' + (m.author_type === "agent" ? "agent" : "") + '" style="border:1px solid var(--glass-border);border-radius:12px;padding:10px 12px;margin:6px 0;max-width:82%' +
      (m.author_type === "agent" ? ";margin-left:auto;background:color-mix(in srgb, var(--accent) 10%, transparent)" : "") + '">' +
      '<div class="muted" style="font-size:11px">' + esc(m.author_type === "agent" ? (m.author_name || "support") : "you") +
      " \u00b7 " + new Date(m.created_at).toLocaleString() + "</div>" +
      '<div style="font-size:13.5px;white-space:pre-wrap">' + esc(m.body) + "</div></div>").join("");
    const send = document.getElementById("threadSend");
    send.onclick = async () => {
      const body = document.getElementById("threadReply").value.trim();
      if (!body) return;
      send.disabled = true;
      try {
        await SMSPIN.rpc("ticket_reply", { p_ticket_id: Number(id), p_body: body });
        document.getElementById("threadReply").value = "";
        await openThread(id); await loadTickets();
      } catch (e) { toast(e.message, "err"); }
      finally { send.disabled = false; }
    };
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function loadRefunds() {
    const host = document.getElementById("refundList");
    if (!host) return;
    let rows = [];
    try { rows = (await SMSPIN.rpc("my_refund_notices", { p_limit: 20 })) || []; } catch (e) {}
    if (!rows.length) { host.innerHTML = '<p class="muted">No refunds yet. Anything we refund lands back in your wallet instantly.</p>'; return; }
    host.innerHTML = '<div class="list-num">' + rows.map(r =>
      '<div class="num-item"><div class="meta"><b>' + money(r.amount, r.currency) + " \u00b7 order #" + esc(r.order_id) + "</b><span>" +
      esc(r.reason || "refund") + " \u00b7 " + new Date(r.created_at).toLocaleDateString() + "</span></div>" +
      '<span class="badge">' + esc(r.status) + "</span></div>").join("") + "</div>";
  }

  async function renderInbox() {
    const orders = await SMSPIN.rpc("my_orders", { p_limit: 1 });
    const host = document.querySelector(".panel .panel-b");
    if (!orders || !orders.length) {
      if (host) host.innerHTML = emptyState({ icon: "\u260E", title: "No active number",
        body: "Buy a number and incoming SMS codes appear on this page automatically.",
        cta: "Buy a number", href: "/dashboard/buy/" });
      return;
    }
    const order = orders[0];
    const msgs = await SMSPIN.rpc("order_messages", { p_order_id: order.id });
    if (!host) return;
    host.innerHTML =
      '<div class="sms-timer" data-exp="' + esc(order.expires_at || "") + '">' +
        '<div class="sms-timer-top"><span class="sms-timer-label">Number active</span>' +
          '<span class="mono" id="smsTimerNum">' + esc(order.phone_number || "") + "</span>" +
          '<span class="sms-timer-left" id="smsTimerLeft">\u2014</span></div>' +
        '<div class="sms-bar"><span id="smsBarFill" style="width:100%"></span></div>' +
      "</div>" +
      '<div class="sms-list" id="smsList">' +
        (msgs && msgs.length
          ? msgs.map(smsRow).join("")
          : emptyState({ icon: "\u2709", title: "Waiting for your first code",
              body: "Codes usually arrive within 2 minutes. This page updates on its own." })) +
      "</div>" +
      '<div class="sms-actions"><button class="btn btn-secondary" id="smsCancelBtn" type="button">Cancel &amp; refund</button></div>';
    startExpiryCountdown(order.created_at, order.expires_at);
    watchOrder(order);

    const cancel = document.getElementById("smsCancelBtn");
    if (cancel) cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      try {
        await SMSPIN.cancelOrder({ orderId: order.id });
        toast("Number cancelled and refunded", "ok");
        setTimeout(() => location.reload(), 800);
      } catch (e) { toast(e.message, "err"); cancel.disabled = false; }
    });
  }

  // Poll for incoming codes (the backend fetches them from the provider).
  function watchOrder(order) {
    clearInterval(window.__smsPoll);
    let seen = 0;
    const tick = async () => {
      try {
        const msgs = await SMSPIN.rpc("order_messages", { p_order_id: order.id });
        if (msgs && msgs.length !== seen) {
          seen = msgs.length;
          const list = document.getElementById("smsList");
          if (list) list.innerHTML = msgs.map(smsRow).join("");
        }
        const st = await SMSPIN.orderStatus(order.id);
        if (st && (st.status === "refunded" || st.status === "received")) {
          clearInterval(window.__smsPoll);
          if (st.status === "refunded") setTimeout(() => location.reload(), 1500);
        }
      } catch (e) { /* keep polling */ }
    };
    window.__smsPoll = setInterval(tick, 6000);
  }

  // Gamified countdown: the bar drains as the number approaches expiry.
  function startExpiryCountdown(createdAt, expiresAt) {
    const fill = document.getElementById("smsBarFill");
    const left = document.getElementById("smsTimerLeft");
    if (!fill || !left) return;
    const end = expiresAt ? new Date(expiresAt).getTime() : 0;
    const start = createdAt ? new Date(createdAt).getTime() : 0;
    if (!end) { left.textContent = "No expiry"; fill.style.width = "100%"; return; }
    const total = Math.max(1, end - (start || Date.now()));
    clearInterval(window.__smsTimer);
    const tick = () => {
      const now = Date.now();
      let ms = end - now;
      if (ms <= 0) {
        fill.style.width = "0%"; fill.classList.add("expired");
        left.textContent = "Expired";
        clearInterval(window.__smsTimer);
        return;
      }
      const frac = Math.min(1, Math.max(0, ms / total));
      fill.style.width = (frac * 100).toFixed(1) + "%";
      fill.classList.toggle("warn", frac < .25);
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      left.textContent = (h ? h + "h " : "") + m + "m " + String(sec).padStart(2, "0") + "s left";
    };
    tick();
    window.__smsTimer = setInterval(tick, 1000);
  }

  async function renderTopUp() {
    const cur = (WALLET && WALLET.currency) || "NGN";
    try { WALLET = await SMSPIN.rpc("wallet_summary"); } catch (e) {}
    const c = (WALLET && WALLET.currency) || cur;
    const balBadge = document.getElementById("tuBalanceBadge");
    if (balBadge) balBadge.textContent = "Balance " + money((WALLET && WALLET.balance) || 0, c);

    const amtEl = document.getElementById("tuAmt");
    const curEl = document.getElementById("tuCurrency");
    if (curEl && !curEl.options.length) {
      ["NGN", "USD", "GHS", "KES", "ZAR"].forEach(x => {
        const o = document.createElement("option"); o.value = x; o.textContent = x; curEl.appendChild(o);
      });
      curEl.value = c;
    }
    let method = "card";
    const quick = document.getElementById("tuQuick");
    if (quick) {
      const amounts = [1000, 2000, 5000, 10000, 20000, 50000];
      quick.innerHTML = amounts.map(a =>
        '<button type="button" class="fund-chip" data-amt="' + a + '">' + money(a, c) + "</button>").join("");
      $$(".fund-chip", quick).forEach(b => b.addEventListener("click", () => {
        if (amtEl) amtEl.value = b.dataset.amt;
        $$(".fund-chip", quick).forEach(x => x.classList.remove("on")); b.classList.add("on");
        summary();
      }));
    }
    const methods = document.getElementById("tuMethods");
    if (methods) {
      methods.innerHTML = PAY_METHODS.map(m =>
        '<button type="button" class="fund-m' + (m.id === method ? " on" : "") + '" data-m="' + m.id + '">' +
        '<span class="fm-ico">' + m.icon + '</span><span class="fm-txt"><b>' + m.label + "</b><span>" + m.note + "</span></span></button>").join("");
      $$(".fund-m", methods).forEach(b => b.addEventListener("click", () => {
        method = b.dataset.m;
        $$(".fund-m", methods).forEach(x => x.classList.remove("on")); b.classList.add("on");
        summary();
      }));
    }
    let quote = null, quoteAmt = 0;
    function summary() {
      const sum = document.getElementById("tuSummary");
      const btn = document.getElementById("tuBtn");
      if (!sum) return;
      const amt = Number((amtEl || {}).value || 0);
      const m = PAY_METHODS.find(x => x.id === method) || PAY_METHODS[0];
      const fee = (quote && quoteAmt === amt) ? quote : null;
      sum.innerHTML =
        '<div class="fs-row"><span>Amount</span><b>' + money(amt, c) + "</b></div>" +
        '<div class="fs-row"><span>Method</span><b>' + esc(m.label) + "</b></div>" +
        (fee
          ? '<div class="fs-row"><span>Fee <span class="fs-pct">' + (fee.fee_percent || 0) + '%</span></span><b>-' + money(fee.fee, c) + "</b></div>" +
            '<div class="fs-row fs-total"><span>Wallet credit</span><b>' + money(fee.net, c) + "</b></div>"
          : '<div class="fs-row fs-total"><span>You pay</span><b>' + money(amt, c) + "</b></div>");
      if (btn) { btn.textContent = amt > 0 ? "Top up " + money(amt, c) : "Enter an amount"; btn.disabled = !(amt > 0); }
      if (amt > 0 && SMSPIN.feeQuote && quoteAmt !== amt) {
        quoteAmt = amt;
        SMSPIN.feeQuote(amt, c).then(q => { if (q && Number((amtEl || {}).value || 0) === amt) { quote = q; summary(); } });
      }
    }
    if (amtEl) amtEl.addEventListener("input", summary);
    summary();

    const btn = document.getElementById("tuBtn");
    if (btn) btn.addEventListener("click", async () => {
      const amt = Number((amtEl || {}).value || 0);
      if (!(amt > 0)) { toast("Enter an amount", "err"); return; }
      btn.disabled = true; btn.textContent = "Redirecting to checkout…";
      try {
        const sess = SMSPIN.getSession();
        const res = await fetch("/api/payments/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + (sess && sess.access_token || "") },
          body: JSON.stringify({ amount: amt, currency: (curEl && curEl.value) || c,
            country: (GEO && GEO.country) || undefined }),
        });
        const d = await res.json();
        if (!res.ok || !d.checkout_url) throw new Error((d && d.error) || "Could not start payment");
        location.href = d.checkout_url;
      } catch (e) { toast(e.message, "err"); btn.disabled = false; summary(); }
    });

    async function paintPayments() {
      const host = document.getElementById("tuPayList");
      if (!host) return;
      let rows = [];
      try { rows = await SMSPIN.rpc("my_payments", { p_limit: 25 }); } catch (e) {}
      if (!rows || !rows.length) {
        host.innerHTML = '<p class="muted">No top-ups yet. Your payment history will appear here.</p>';
        return;
      }
      host.innerHTML = rows.map(p =>
        '<div class="num-item"><div class="meta"><b>' + esc((p.provider || "Payment")) +
        " · " + esc(p.reference || "") + "</b><span>" + esc(fmtDate(p.created_at)) +
        (p.fee_ngn ? " · fee " + money(p.fee_ngn, "NGN") : "") + "</span></div>" +
        '<div class="my-order-meta">' + badge(p.status === "success" ? "received" : p.status === "pending" ? "waiting" : "cancelled") +
        '<span class="my-order-price">' + money(p.amount, p.currency || c) + "</span></div></div>").join("");
    }
    const refresh = document.getElementById("tuRefresh");
    if (refresh) refresh.addEventListener("click", paintPayments);
    await paintPayments();
  }

  async function renderHistory() {
    const cur = (WALLET && WALLET.currency) || "NGN";
    let orders = [], pays = [];
    try { orders = (await SMSPIN.rpc("my_orders", { p_limit: 200 })) || []; } catch (e) {}
    try { pays = (await SMSPIN.rpc("my_payments", { p_limit: 200 })) || []; } catch (e) {}

    const done = orders.filter(o => o.status !== "waiting");
    const ok = orders.filter(o => o.status === "received").length;
    const spent = orders.filter(o => o.status !== "refunded").reduce((s, o) => s + Number(o.price || 0), 0);
    const refunded = orders.filter(o => o.status === "refunded").reduce((s, o) => s + Number(o.price || 0), 0);
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set("hOrders", String(orders.length));
    set("hSpent", money(spent, cur));
    set("hRate", done.length ? Math.round(100 * ok / done.length) + "%" : "—");
    set("hRateSub", ok + " of " + done.length + " completed");
    set("hRefund", money(refunded, cur));

    let tab = "all", filter = "all", query = "", range = "all";
    const FILTERS = [
      ["all", "All"], ["waiting", "Active"], ["received", "Completed"],
      ["cancelled", "Cancelled"], ["refunded", "Expired"],
    ];
    const norm = s => s === "expired" ? "refunded" : s;
    const tabs = document.getElementById("hTabs");
    if (tabs) {
      tabs.innerHTML = [["all", "Everything"], ["temp", "Temp orders"], ["rent", "Rent orders"]].map(([k, l]) =>
        '<button type="button" class="tx-tab' + (k === tab ? " on" : "") + '" data-t="' + k + '">' + l + "</button>").join("");
      $$("[data-t]", tabs).forEach(b => b.addEventListener("click", () => {
        tab = b.dataset.t;
        $$("[data-t]", tabs).forEach(x => x.classList.toggle("on", x === b));
        paint();
      }));
    }
    function rows() {
      const cutoff = range === "all" ? 0 : Date.now() - Number(range) * 86400000;
      return orders
        .filter(o => tab === "all" || (tab === "rent" ? o.is_rental : !o.is_rental))
        .filter(o => filter === "all" || norm(o.status) === filter)
        .filter(o => !query || String(o.phone_number || "").toLowerCase().includes(query))
        .filter(o => !cutoff || new Date(o.created_at).getTime() >= cutoff);
    }
    function paint() {
      const host = document.getElementById("hList");
      if (!host) return;
      const list = rows();
      if (!list.length) {
        host.innerHTML = emptyState({ icon: "\u{1F4EC}", title: "Nothing here yet",
          body: "Orders you place will show up here with their status and price.",
          cta: "Buy a number", href: "/dashboard/buy/" });
        return;
      }
      host.innerHTML = list.map(o =>
        '<div class="num-item my-order"><span class="my-order-ico">' + svcIcon(o) + "</span>" +
        '<div class="meta"><b>' + esc(o.service || "—") + (o.is_rental ? ' <span class="badge info">rent</span>' : "") + "</b>" +
          '<span class="mono">' + esc(o.phone_number || "—") + " · " + esc(o.country || "") + "</span></div>" +
        '<div class="my-order-meta">' + badge(o.status) +
          '<span class="my-order-price">' + money(price(o.price)) + "</span>" +
          '<span class="muted">' + esc(fmtDate(o.created_at)) + "</span></div></div>").join("");
    }
    const search = document.getElementById("hSearch");
    if (search) search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); paint(); });
    const rangeEl = document.getElementById("hRange");
    if (rangeEl) rangeEl.addEventListener("change", () => { range = rangeEl.value; paint(); });
    const refresh = document.getElementById("hRefresh");
    if (refresh) refresh.addEventListener("click", () => renderHistory());
    const exp = document.getElementById("hExport");
    if (exp) exp.addEventListener("click", () => {
      const list = rows();
      const head = ["id", "service", "phone_number", "country", "status", "is_rental", "price_ngn", "created_at"];
      const body = list.map(o => [o.id, o.service, o.phone_number, o.country, o.status, o.is_rental, o.price, o.created_at]
        .map(v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"').join(","));
      const blob = new Blob([head.join(",") + "\n" + body.join("\n")], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "smspin-history-" + new Date().toISOString().slice(0, 10) + ".csv";
      a.click(); URL.revokeObjectURL(a.href);
    });
    paint();
  }

  const RENDER = {
    overview: renderOverview, numbers: renderNumbers, orders: renderOrders,
    wallet: renderWallet, transactions: renderTransactions, referrals: renderReferrals,
    profile: renderProfile, "api-keys": renderApiKeys, buy: renderBuy,
    support: renderSupport, sms: renderInbox, settings: renderSettings,
    topup: renderTopUp, history: renderHistory,
  };

  // Wallet funding goes through the server-side `funding` edge function:
  // the browser never calls Supabase RPCs or sees KoraPay keys directly.
  function wireTopup() {
    const btn = document.getElementById("fundBtn");
    const sheet = document.getElementById("fundSheet");
    if (!btn || !sheet) return;

    // Build the funding form (quick amounts, methods, live summary).
    drawFunding(WALLET || {}, (WALLET && WALLET.currency) || "NGN");

    // Slide-up "Add funds" sheet — opened from the balance-card "+" (and the card itself).
    let lastFocus = null;
    const open = () => {
      lastFocus = document.activeElement;
      sheet.classList.add("open");
      sheet.setAttribute("aria-hidden", "false");
      document.body.classList.add("sheet-lock");
      const amt = document.getElementById("amt"); if (amt) amt.focus();
    };
    const close = () => {
      sheet.classList.remove("open");
      sheet.setAttribute("aria-hidden", "true");
      document.body.classList.remove("sheet-lock");
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    };
    const fab = document.getElementById("ovAddFunds");
    const card = fab && fab.closest(".card");
    if (fab) fab.addEventListener("click", e => { e.stopPropagation(); open(); });
    if (card) { card.classList.add("card-link"); card.setAttribute("role", "button"); card.tabIndex = 0;
      card.addEventListener("click", open);
      card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }); }
    $$("[data-open-funds], #addFundsBtn").forEach(b => b.addEventListener("click", open));
    sheet.addEventListener("click", e => { if (e.target === sheet) close(); });
    $$("[data-close]", sheet).forEach(b => b.addEventListener("click", close));
    document.addEventListener("keydown", e => { if (e.key === "Escape" && sheet.classList.contains("open")) close(); });

    btn.addEventListener("click", async () => {
      const amt = Number((document.getElementById("amt") || {}).value || 0);
      if (!(amt > 0)) { toast("Enter an amount", "err"); return; }
      btn.disabled = true;
      btn.textContent = "Redirecting to checkout…";
      try {
        const sess = SMSPIN.getSession();
        const res = await fetch("/api/payments/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + (sess && sess.access_token || "") },
          body: JSON.stringify({ amount: amt, country: (GEO && GEO.country) || undefined, currency: (GEO && GEO.currency) || undefined }),
        });
        const d = await res.json();
        if (!res.ok || !d.checkout_url) throw new Error((d && d.error) || "Could not start payment");
        location.href = d.checkout_url;
      } catch (e) {
        toast(e.message, "err");
        btn.disabled = false;
        updateFundSummary((WALLET && WALLET.currency) || "NGN");
      }
    });
  }

  // On return from checkout (?ref=...), verify server-side and credit the wallet.
  async function settlePayment() {
    const ref = new URLSearchParams(location.search).get("ref");
    if (!ref) return;
    try {
      const d = await SMSPIN.functions("funding", { action: "verify", reference: ref });
      if (d && d.verified) { toast("Payment confirmed. Wallet credited.", "ok"); await renderWallet(); }
      else toast("Payment " + ((d && d.status) || "pending") + "…", "err");
    } catch (e) { toast("Could not verify payment", "err"); }
    history.replaceState({}, "", location.pathname);
  }

  function wireSettings() {
    if (page !== "settings") return;
    const btn = document.getElementById("atSave");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const on = !!document.getElementById("atOn").checked;
      const am = Number((document.getElementById("atAmount") || {}).value || 0);
      const th = Number((document.getElementById("atThreshold") || {}).value || 0);
      btn.disabled = true;
      try {
        await SMSPIN.rpc("set_auto_topup", { p_enabled: on, p_amount: am, p_threshold: th });
        toast("Auto top-up saved", "ok");
        await renderSettings();
      } catch (e) { toast(e.message, "err"); }
      finally { btn.disabled = false; }
    });
  }


  function wireProfileSave() {
    if (page !== "profile") return;
    const g = id => (document.getElementById(id) || {}).value || "";

    const save = document.getElementById("pfSave");
    if (save) save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await SMSPIN.rpc("update_profile", { p_full_name: g("fn"), p_phone: g("ph"), p_country: g("cy") });
        toast("Profile saved", "ok");
        await renderProfile();
      } catch (e) { toast(e.message, "err"); }
      finally { save.disabled = false; }
    });

    const pw = document.getElementById("pw");
    const bar = document.getElementById("pfStrengthBar");
    if (pw && bar) pw.addEventListener("input", () => {
      const v = pw.value; let score = 0;
      if (v.length >= 8) score++; if (/[A-Z]/.test(v)) score++;
      if (/[0-9]/.test(v)) score++; if (/[^A-Za-z0-9]/.test(v)) score++;
      const colors = ["#EF4444", "#F59E0B", "#0EA5E9", "#10B981"];
      bar.style.width = (score * 25) + "%";
      bar.style.background = colors[Math.max(0, score - 1)] || "transparent";
    });

    const pwBtn = document.getElementById("pfPw");
    if (pwBtn) pwBtn.addEventListener("click", async () => {
      const p1 = g("pw"), p2 = g("pw2");
      if (p1.length < 8) { toast("Password must be at least 8 characters", "err"); return; }
      if (p1 !== p2) { toast("Passwords do not match", "err"); return; }
      pwBtn.disabled = true;
      try {
        await SMSPIN.auth.updatePassword(p1);
        toast("Password updated", "ok");
        const a = document.getElementById("pw"), b = document.getElementById("pw2");
        if (a) a.value = ""; if (b) b.value = "";
        if (bar) bar.style.width = "0%";
      } catch (e) { toast(e.message, "err"); }
      finally { pwBtn.disabled = false; }
    });
  }

  // Lightweight page preloader so slow RPCs never show an empty shell.
  function showLoader(msg) {
    if (document.getElementById("dashLoader")) return;
    const el = document.createElement("div");
    el.id = "dashLoader";
    el.className = "dash-loader";
    el.innerHTML = '<span class="dl-spin" aria-hidden="true"></span><span class="dl-txt">' + esc(msg || "Loading\u2026") + "</span>";
    document.body.appendChild(el);
  }
  function hideLoader() {
    const el = document.getElementById("dashLoader");
    if (el) { el.classList.add("out"); setTimeout(() => el.remove(), 220); }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!(await guard())) return;
    await loadSite();
    // One-time startup: panel, links and sidebar data are wired once; every
    // subsequent navigation only re-renders <main> from the client-side router.
    wireSidePanel();
    fillSideBalance();
    fillSideNumbers();
    fillSideOrders();
    await loadGeo();
    await renderPage();
    fitStatValues();
    let fitT;
    window.addEventListener("resize", () => { clearTimeout(fitT); fitT = setTimeout(fitStatValues, 150); });
    wireLiveEvents();
    const out = document.querySelector('a[href="/login"]');
    if (out) out.addEventListener("click", async (e) => { e.preventDefault(); await SMSPIN.auth.signOut(); location.href = "/login/"; });
    await settlePayment();
    await maybeWelcome();
    maybeStartTour();
    wireRouter();
  });

  // ---------------------------------------------------------------------
  // SPA router. Internal dashboard links swap <main> in place instead of
  // triggering a full page reload, so the app loads and populates once at
  // startup and every route change is just a re-render.
  // ---------------------------------------------------------------------
  const ROUTES = {
    "/dashboard/": "overview", "/dashboard/buy/": "buy", "/dashboard/numbers/": "numbers",
    "/dashboard/orders/": "orders", "/dashboard/sms/": "sms", "/dashboard/wallet/": "wallet",
    "/dashboard/transactions/": "transactions", "/dashboard/api-keys/": "api-keys",
    "/dashboard/business/": "business", "/dashboard/referrals/": "referrals",
    "/dashboard/profile/": "profile", "/dashboard/settings/": "settings",
    "/dashboard/support/": "support", "/dashboard/topup/": "topup",
    "/dashboard/history/": "history",
  };
  const pageFor = path => ROUTES[path.replace(/\/index\.html$/, "/")] || null;

  function applyActiveNav() {
    const cur = location.pathname.replace(/\/index\.html$/, "/");
    $$(".dash-side a[href^='/dashboard/']").forEach(a => {
      const href = a.getAttribute("href");
      a.classList.toggle("active", href === cur || (cur === "/dashboard/" && href === "/dashboard/"));
    });
  }

  async function renderPage() {
    const fn = RENDER[page];
    applyActiveNav();
    if (!fn) return;
    showLoader(page === "buy" ? "Loading catalog\u2026" : "Loading\u2026");
    try { await fn(); } catch (e) { console.warn("render " + page + ":", e.message); }
    finally { hideLoader(); }
    wireCardLinks();
    wireTopup();
    wireSettings();
    wireProfileSave();
  }

  async function swapRoute(path, push) {
    let html;
    try {
      const res = await fetch(path, { headers: { "X-Requested-With": "fetch" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      html = await res.text();
    } catch (e) { location.href = path; return; }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const nextMain = doc.querySelector("main.dash-main");
    const curMain = document.querySelector("main.dash-main");
    if (!nextMain || !curMain) { location.href = path; return; }
    const np = doc.body.dataset.page;
    const newPage = RENDER[np] ? np : pageFor(path);
    if (!newPage) { location.href = path; return; }
    if (push) history.pushState({ smspin: 1, page: newPage }, "", path);
    curMain.innerHTML = nextMain.innerHTML;
    page = newPage;
    document.body.dataset.page = np || page;
    document.title = doc.title || document.title;
    if (page === "overview") { try { localStorage.setItem("smspin_welcomed", "1"); } catch (e) {} }
    window.scrollTo(0, 0);
    await renderPage();
    fitStatValues();
  }

  function wireRouter() {
    document.addEventListener("click", e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      if (a.target && a.target !== "_self") return;
      if (a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || href.charAt(0) !== "/" || href.charAt(1) === "/") return;
      if (a.dataset.noSpa != null) return;
      let u;
      try { u = new URL(a.href, location.origin); } catch (err) { return; }
      if (u.origin !== location.origin) return;
      const path = u.pathname.replace(/\/index\.html$/, "/");
      if (!pageFor(path)) return;               // only in-app dashboard routes
      e.preventDefault();
      const qs = u.search || "";
      swapRoute(path + qs, path + qs !== location.pathname + location.search);
    });
    window.addEventListener("popstate", () => {
      const path = location.pathname.replace(/\/index\.html$/, "/");
      if (pageFor(path)) swapRoute(location.pathname + location.search, false);
    });
  }


  // O2: one-time welcome modal for first-login users, offering the tour.
  async function maybeWelcome() {
    if (page !== "overview" || !window.SMSPINUI) return;
    let seen = null;
    try { seen = localStorage.getItem("smspin_welcomed"); } catch (e) {}
    if (seen === "1") return;
    let d = null;
    try { d = await SMSPIN.rpc("dashboard_overview"); } catch (e) { return; }
    const firstRun = d && !d.total_orders && Number(d.balance) <= 0;
    try { localStorage.setItem("smspin_welcomed", "1"); } catch (e) {}
    const res = await SMSPINUI.modal({
      title: firstRun ? "Welcome to SMSPin" : "Welcome back",
      tone: "success",
      html:
        '<p class="mdl-msg">' + (firstRun
          ? "You're three steps from your first code: fund your wallet, buy a number, and read the SMS here."
          : "Your dashboard is ready. Take a quick tour any time from the Help button.") + "</p>" +
        '<ol class="dev-steps" style="margin:10px 0 0"><li><b>Fund your wallet</b> — one top-up covers many numbers.</li>' +
        '<li><b>Buy a number</b> — pick a service and country.</li>' +
        '<li><b>Read the code</b> — it lands in your inbox in seconds.</li></ol>',
      actions: firstRun
        ? [{ id: "tour", label: "Take the tour", variant: "secondary" },
           { id: "buy", label: "Buy my first number", variant: "primary" }]
        : [{ id: "ok", label: "Get started", variant: "primary" }],
    });
    if (res === "tour" && window.TOUR) window.TOUR.dashboard(true);
    else if (res === "buy") location.href = "/dashboard/buy/";
  }

  // O1: start the first-run dashboard tour once, on the overview page.
  function maybeStartTour() {
    if (page !== "overview" || !window.TOUR) return;
    if (window.TOUR.seen("dashboard")) return;
    setTimeout(() => window.TOUR.dashboard(), 900);
  }

  // E1: live order updates over Server-Sent Events. Codes appear the moment
  // they arrive without a manual refresh; falls back silently if unsupported.
  function wireLiveEvents() {
    if (!window.EventSource || !SMSPIN.getSession || !SMSPIN.getSession()) return;
    let es;
    try { es = new EventSource("/api/events"); } catch (e) { return; }
    es.addEventListener("sms", (ev) => {
      let d = {}; try { d = JSON.parse(ev.data); } catch (e) { return; }
      document.dispatchEvent(new CustomEvent("smspin:sms", { detail: d }));
      if (window.SMSPINUI && SMSPINUI.alert) {
        SMSPINUI.alert("New SMS code", (d.sender || "A service") + " sent " + (d.code || "a message") + ".");
      }
    });
    es.onerror = () => { try { es.close(); } catch (e) {} };
  }
})();
