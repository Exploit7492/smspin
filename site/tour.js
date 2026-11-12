// Lightweight in-app guided-tour engine (O1). No dependencies: renders a
// spotlight + coach-mark card, supports keyboard/screen-reader navigation
// (O19), localized copy (O19) and records completion to the backend for
// activation analytics (O18). Tours are declared as data (O3/O11/O13/O15).
(function () {
  const $ = (s, r = document) => (r || document).querySelector(s);
  const LS = "smspin_tour_seen";

  // Minimal i18n: each step may carry per-locale strings; fall back to English.
  const LOCALE = (document.documentElement.lang || navigator.language || "en").slice(0, 2);
  function T(v) {
    if (v && typeof v === "object") return v[LOCALE] || v.en || Object.values(v)[0];
    return v || "";
  }

  function seen(key) {
    try { return (JSON.parse(localStorage.getItem(LS) || "{}")[key]) === true; } catch (e) { return false; }
  }
  function markSeen(key) {
    try { const m = JSON.parse(localStorage.getItem(LS) || "{}"); m[key] = true; localStorage.setItem(LS, JSON.stringify(m)); } catch (e) {}
  }
  function record(key, step, event, complete) {
    try {
      if (window.SMSPIN && SMSPIN.rpc) {
        SMSPIN.rpc("tour_record", { p_key: key, p_step: step, p_event: event,
          p_complete: !!complete, p_variant: (state && state.variant) || null }).catch(() => {});
      }
    } catch (e) {}
  }

  // O18: ask the backend which A/B variant this user is in for the tour.
  async function variantFor(key) {
    try {
      if (window.SMSPIN && SMSPIN.rpc) {
        const r = await SMSPIN.rpc("experiment_variant", { p_key: key });
        if (r && r.active) return r.variant;
      }
    } catch (e) {}
    return null;
  }

  function ensureStyles() {
    if ($("#tourCss")) return;
    const l = document.createElement("link");
    l.id = "tourCss"; l.rel = "stylesheet"; l.href = "/tour.css";
    document.head.appendChild(l);
  }

  let state = null; // {key, steps, i, overlay, card, target}

  function build() {
    const overlay = document.createElement("div");
    overlay.className = "tour-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Guided tour");
    const card = document.createElement("div");
    card.className = "tour-card";
    card.tabIndex = -1;
    const pointer = document.createElement("div");
    pointer.id = "tourPointer";
    pointer.className = "tour-pointer";
    pointer.setAttribute("aria-hidden", "true");
    pointer.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">' +
      '<path d="M5 3.5 19 11l-5.6 1.4L10.6 18 5 3.5Z" fill="#fff" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    overlay.appendChild(card);
    overlay.appendChild(pointer);
    document.body.appendChild(overlay);
    return { overlay, card, pointer };
  }

  // A target may match several elements (sidebar link, quick action, card). Pick
  // the first one that is actually on screen so the spotlight never lands on an
  // off-screen duplicate — e.g. the sidebar link on mobile, which is translated
  // out of view while the drawer is closed.
  function visibleMatch(sel) {
    let els;
    try { els = document.querySelectorAll(sel); } catch (e) { return null; }
    if (!els || !els.length) return null;
    const vw = window.innerWidth, vh = window.innerHeight;
    let fallback = null;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      if (onScreen) return el;
      if (!fallback) fallback = el;
    }
    return fallback || els[0];
  }

  function clearTarget() {
    if (state && state.target) { state.target.classList.remove("tour-target"); state.target = null; }
  }

  function movePointer(r) {
    const p = $("#tourPointer");
    if (!p) return;
    // Park the pointer just outside the target's top-left corner, pointing in.
    const x = Math.max(6, r.left - 26), y = Math.max(6, r.top - 26);
    p.style.left = x + "px";
    p.style.top = y + "px";
    p.style.opacity = "1";
  }

  function place(card, el) {
    const pad = 12;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    // On narrow screens dock the card to the bottom instead of trying to point
    // at the element; the spotlight + pointer still show where to look.
    if (vw <= 560) {
      card.style.top = "auto";
      card.style.left = "8px";
      card.style.right = "8px";
      card.style.bottom = "calc(8px + env(safe-area-inset-bottom, 0px))";
      card.style.width = "auto";
      card.style.maxWidth = "none";
      card.style.transform = "";
    } else {
      card.style.bottom = "auto";
      card.style.right = "auto";
      card.style.width = "min(340px, 92vw)";
      let top = r.bottom + pad, left = r.left;
      if (top + ch > vh - 8) top = Math.max(8, r.top - ch - pad);      // flip above
      if (left + cw > vw - 8) left = vw - cw - 8;
      if (left < 8) left = 8;
      card.style.top = top + "px";
      card.style.left = left + "px";
      card.style.position = "fixed";
    }
    // Spotlight hole around the target.
    const hole = $("#tourHole");
    if (hole) {
      hole.style.top = (r.top - 6) + "px";
      hole.style.left = (r.left - 6) + "px";
      hole.style.width = (r.width + 12) + "px";
      hole.style.height = (r.height + 12) + "px";
      hole.style.opacity = "1";
    }
    movePointer(r);
  }

  function center(card) {
    card.style.position = "fixed";
    card.style.top = "50%"; card.style.left = "50%";
    card.style.transform = "translate(-50%,-50%)";
    const hole = $("#tourHole");
    if (hole) hole.style.opacity = "0";
    const p = $("#tourPointer");
    if (p) p.style.opacity = "0";
  }

  function render() {
    const s = state.steps[state.i];
    const card = state.card;
    card.style.transform = "";
    const el = s.target ? visibleMatch(s.target) : null;
    clearTarget();
    if (el) {
      el.classList.add("tour-target");
      state.target = el;
      if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }
    const last = state.i === state.steps.length - 1;
    card.innerHTML =
      '<div class="tour-head"><span class="tour-step">' + (state.i + 1) + " / " + state.steps.length + "</span>" +
      '<button class="tour-x" type="button" aria-label="Close tour">&times;</button></div>' +
      '<h3 class="tour-title" id="tourTitle">' + T(s.title) + "</h3>" +
      '<p class="tour-body" id="tourBody">' + T(s.body) + "</p>" +
      '<div class="tour-foot">' +
        '<button class="tour-skip" type="button">Skip</button>' +
        '<span class="spacer"></span>' +
        (state.i > 0 ? '<button class="tour-prev" type="button">Back</button>' : "") +
        '<button class="tour-next" type="button">' + (last ? "Done" : "Next") + "</button>" +
      "</div>" +
      '<span class="sr-only" aria-live="polite">Step ' + (state.i + 1) + " of " + state.steps.length +
        ": " + T(s.title) + "</span>";
    card.setAttribute("aria-labelledby", "tourTitle");
    card.setAttribute("aria-describedby", "tourBody");
    $(".tour-x", card).onclick = () => finish("skip");
    $(".tour-skip", card).onclick = () => finish("skip");
    const prev = $(".tour-prev", card); if (prev) prev.onclick = () => { state.i--; render(); record(state.key, state.i, "step"); };
    $(".tour-next", card).onclick = () => {
      if (last) return finish("complete");
      state.i++; render(); record(state.key, state.i, "step");
    };
    // Position after layout so we can measure the card.
    requestAnimationFrame(() => {
      if (el) place(card, el); else center(card);
    });
    card.focus({ preventScroll: true });
    record(state.key, state.i, "step");
  }

  function finish(event) {
    if (!state) return;
    const key = state.key, last = state.i, total = state.steps.length;
    clearTarget();
    if (state.overlay && state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay);
    if (state.onend) { try { state.onend(event); } catch (e) {} }
    markSeen(key);
    record(key, last, event, event === "complete" || (event === "skip" && last >= total - 1));
    state = null;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onReposition, true);
    window.removeEventListener("resize", onReposition, true);
  }

  // Keep the spotlight and pointer glued to the target while the user scrolls
  // or rotates the device.
  function onReposition() {
    if (!state) return;
    const s = state.steps[state.i];
    const el = state.target || (s.target ? visibleMatch(s.target) : null);
    if (el) place(state.card, el); else center(state.card);
  }

  function onKey(e) {
    if (!state) return;
    if (e.key === "Escape") { e.preventDefault(); finish("skip"); }
    else if (e.key === "ArrowRight") { e.preventDefault(); const n = $(".tour-next", state.card); if (n) n.click(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); const p = $(".tour-prev", state.card); if (p) p.click(); }
  }

  function start(key, steps, opts) {
    opts = opts || {};
    if (!steps || !steps.length) return;
    if (state) return; // a tour is already on screen — never stack two.
    if (!opts.force && seen(key)) return;
    ensureStyles();
    const parts = build();
    // Spotlight layer (a bright ring with a dimmed backdrop).
    const wrap = document.createElement("div");
    wrap.className = "tour-dim";
    const hole = document.createElement("div");
    hole.id = "tourHole"; hole.className = "tour-hole";
    wrap.appendChild(hole);
    parts.overlay.insertBefore(wrap, parts.card);
    state = { key, steps, i: 0, overlay: parts.overlay, card: parts.card, onend: opts.onend };
    // O18: resolve the A/B variant (if any) before recording so funnel rows
    // carry the variant. Fire-and-forget so the tour opens instantly.
    variantFor(key).then(v => { if (state && state.key === key) state.variant = v; });
    record(key, 0, "start");
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition, true);
    render();
  }

  // ---------------------------------------------------------- tour definitions
  // O3 end-user dashboard tour. Each step lists the sidebar link first and an
  // on-page fallback second, so the spotlight lands on something visible on
  // mobile (where the sidebar is a closed drawer).
  const DASHBOARD_TOUR = [
    { target: ".dash-wallet, .cards .card", title: { en: "Your wallet", es: "Tu cartera" }, body: { en: "Your balance lives here. Top up once and it works across every service.", es: "Tu saldo vive aquí. Recarga una vez y sirve para todos los servicios." } },
    { target: '#ovQuickPanel, a[href="/dashboard/buy/"]', title: { en: "Buy a number" }, body: { en: "Pick a country and service, and we reserve a number instantly." } },
    { target: 'a[href="/dashboard/numbers/"]', title: { en: "Manage your numbers" }, body: { en: "Every number you hold — active, expired or released — is listed here." } },
    { target: 'a[href="/dashboard/sms/"], #ovMsgPanel', title: { en: "Receive codes" }, body: { en: "SMS codes land in your inbox within seconds of arriving." } },
    { target: 'a[href="/dashboard/api-keys/"]', title: { en: "Automate it" }, body: { en: "Create an API key to buy numbers and read codes programmatically." } },
    { target: 'a[href="/dashboard/business/"]', title: { en: "Launch your own store" }, body: { en: "White-label SMSPin under your own brand and domain." } },
  ];

  // O11 tenant business dashboard tour.
  const BUSINESS_TOUR = [
    { target: "#bizProgress", title: { en: "Your store dashboard" }, body: { en: "Everything about your white-label store lives here: branding, pricing, payouts and a launch checklist." } },
    { target: "#bizBrandPanel", title: { en: "Branding" }, body: { en: "Set your logo, colours, tagline and custom domain with a live preview." } },
    { target: "#bizChecklistPanel", title: { en: "Launch checklist" }, body: { en: "Work through this checklist to get your store live and making sales." } },
    { target: "#bizPayoutPanel", title: { en: "Payouts" }, body: { en: "Your earnings settle to your wallet. Withdraw any time." } },
    { target: "#bizKeyPanel", title: { en: "Tenant API keys" }, body: { en: "Give your own customers an API and webhooks for their store." } },
  ];

  // O13 tenant end-user branded onboarding (store page).
  const STORE_TOUR = [
    { target: "#catalog, .st-catalog", title: { en: "Pick a number" }, body: { en: "Browse live stock across services and countries. Prices include everything." } },
    { target: "#how, .st-how", title: { en: "Three quick steps" }, body: { en: "Top up, choose a number, and receive your code." } },
    { target: "#faq, .st-faq", title: { en: "Questions?" }, body: { en: "Codes are refunded automatically if they never arrive." } },
  ];

  // O15 superadmin console onboarding.
  const ADMIN_TOUR = [
    { target: '#admTabs [data-tab="overview"]', title: { en: "Start here" }, body: { en: "The overview shows live KPIs: users, orders, float, revenue and open tickets." } },
    { target: '#admTabs [data-tab="tickets"]', title: { en: "Support queue" }, body: { en: "Work tickets here — assign, prioritise and reply from canned responses." } },
    { target: '#admTabs [data-tab="fraud"]', title: { en: "Risk & fraud" }, body: { en: "Review the fraud queue and block abusive accounts before they cost you." } },
    { target: '#admTabs [data-tab="flags"]', title: { en: "Flags & settings" }, body: { en: "Toggle feature flags and tune platform settings without a deploy." } },
    { target: '#admTabs [data-tab="runbooks"]', title: { en: "Runbooks" }, body: { en: "Follow step-by-step runbooks for refunds, incidents and provider outages." } },
  ];

  window.TOUR = {
    start, finish, seen, markSeen,
    dashboard: (force) => start("dashboard", DASHBOARD_TOUR, { force }),
    business: (force) => start("business", BUSINESS_TOUR, { force }),
    store: (force) => start("store", STORE_TOUR, { force }),
    admin: (force) => start("admin", ADMIN_TOUR, { force }),
    defs: { DASHBOARD_TOUR, BUSINESS_TOUR, STORE_TOUR, ADMIN_TOUR },
  };
})();
