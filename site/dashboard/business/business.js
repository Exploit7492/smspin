// White-label Business wizard — gamified multi-step onboarding.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = n => "\u20a6 " + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const THEMES = [
    { id: "crimson", name: "Crimson", c: ["#E11D2E", "#F26B7A", "#111827"] },
    { id: "ocean", name: "Ocean", c: ["#0EA5E9", "#38BDF8", "#0F172A"] },
    { id: "emerald", name: "Emerald", c: ["#10B981", "#34D399", "#064E3B"] },
    { id: "violet", name: "Violet", c: ["#7C3AED", "#A78BFA", "#1E1B4B"] },
    { id: "amber", name: "Amber", c: ["#F59E0B", "#FCD34D", "#78350F"] },
    { id: "rose", name: "Rose", c: ["#E11D48", "#FB7185", "#4C0519"] },
    { id: "slate", name: "Slate", c: ["#475569", "#94A3B8", "#0F172A"] },
    { id: "midnight", name: "Midnight", c: ["#1E293B", "#334155", "#020617"] },
  ];

  let step = 1;
  const TOTAL = 4;
  let theme = "crimson";
  let markupMode = "percent";
  let geo = { currency: "NGN" };

  function setStep(n) {
    step = Math.max(1, Math.min(TOTAL, n));
    $$(".wiz-pane").forEach(p => { p.hidden = Number(p.dataset.pane) !== step; });
    $$(".biz-step").forEach(s => {
      const k = Number(s.dataset.step);
      s.classList.toggle("done", k < step);
      s.classList.toggle("active", k === step);
    });
    const pct = Math.round((step - 1) / (TOTAL - 1) * 100);
    $("#bizBarFill").style.width = pct + "%";
    $("#bizXp").textContent = pct + "%";
    $("#wizBack").hidden = step === 1;
    $("#wizNext").textContent = step === TOTAL ? "Launch store \u00b7 $20" : "Continue";
    $("#wizTitle").textContent = ["", "Step 1 \u00b7 Name your store", "Step 2 \u00b7 Pick a theme",
      "Step 3 \u00b7 Set your markup", "Step 4 \u00b7 Review & launch"][step];
    if (step === 4) refreshPlan();
  }

  function toast(msg, cls) {
    let el = $("#toast");
    if (!el) { el = document.createElement("div"); el.id = "toast";
      el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99;padding:12px 18px;border-radius:10px;font-size:14px;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,.18)";
      document.body.appendChild(el); }
    el.style.background = cls === "err" ? "#FDECEE" : "#E7F8F1";
    el.style.color = cls === "err" ? "#E11D2E" : "#10B981";
    el.textContent = msg;
    clearTimeout(el._t); el._t = setTimeout(() => el.remove(), 3800);
  }

  function slugify(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "your-store";
  }

  function drawThemes() {
    $("#themeGrid").innerHTML = THEMES.map(t =>
      '<div class="theme-card' + (t.id === theme ? " sel" : "") + '" role="button" tabindex="0" aria-pressed="' + (t.id === theme) + '" data-theme="' + t.id + '">' +
      '<span class="theme-tick" aria-hidden="true">\u2713</span>' +
      '<div class="theme-swatch">' + t.c.map(c => '<i style="background:' + c + '"></i>').join("") + "</div>" +
      "<b>" + esc(t.name) + "</b></div>").join("");
    // Scope to the grid — a global [data-theme] selector also matches the
    // <html data-theme="dark"> that theme.js sets, which would clobber the pick.
    $$("#themeGrid .theme-card").forEach(el => {
      const pick = () => { theme = el.dataset.theme; drawThemes(); };
      el.addEventListener("click", pick);
      el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    });
  }

  function updateSlug() {
    $("#slugPreview").textContent = "/" + slugify($("#bizName").value);
  }

  function markupValue() {
    return markupMode === "fixed"
      ? Number($("#bizMarkupFixed") ? $("#bizMarkupFixed").value : 0) || 0
      : Number($("#bizMarkup") ? $("#bizMarkup").value : 0) || 0;
  }

  // Percentage = a true percentage increase; fixed = the whole naira amount
  // added on top. Mirrors biz_markup_amount() on the server.
  function applyMarkup(base, mode, pct, fixed) {
    return mode === "fixed" ? Number(base || 0) + Number(fixed || 0)
                            : Number(base || 0) * (1 + Number(pct || 0) / 100);
  }

  const MODE_COPY = {
    percent: { label: "By percentage", icon: "%",
      hint: "A percentage is added on top of the host price — 30% of \u20a62,700 is \u20a6810." },
    fixed: { label: "By fixed price", icon: "\u20a6",
      hint: "A flat amount in naira is added to every number — \u20a6500 on a \u20a62,700 base sells at \u20a63,200." },
  };

  function setMarkupMode(mode) {
    markupMode = mode === "fixed" ? "fixed" : "percent";
    const copy = MODE_COPY[markupMode];
    if ($("#mkModeLabel")) $("#mkModeLabel").textContent = copy.label;
    if ($("#mkModeHint")) $("#mkModeHint").textContent = copy.hint;
    const ico = $("#mkModeBtn .picker-ico"); if (ico) ico.textContent = copy.icon;
    if ($("#mkPercentWrap")) $("#mkPercentWrap").hidden = markupMode !== "percent";
    if ($("#mkFixedWrap")) $("#mkFixedWrap").hidden = markupMode !== "fixed";
    updateMarkupPreview();
  }

  async function pickMarkupMode() {
    if (!(window.SMSPINUI && SMSPINUI.select)) { setMarkupMode(markupMode === "percent" ? "fixed" : "percent"); return; }
    const choice = await SMSPINUI.select({
      title: "How do you want to price?",
      items: [
        { value: "percent", label: "By percentage", sub: "Add a % on top of the host price", icon: "%", meta: markupMode === "percent" ? "Current" : "" },
        { value: "fixed", label: "By fixed price", sub: "Add a flat naira amount to every number", icon: "\u20a6", meta: markupMode === "fixed" ? "Current" : "" },
      ],
      value: markupMode,
    });
    if (choice) setMarkupMode(choice);
  }

  let previewSeq = 0;
  async function updateMarkupPreview() {
    // Real, in-stock numbers priced with the chosen mode, so the wizard shows
    // what a buyer will actually pay instead of a hard-coded sample.
    const pct = Number($("#bizMarkup") ? $("#bizMarkup").value : 0) || 0;
    const fixed = Number($("#bizMarkupFixed") ? $("#bizMarkupFixed").value : 0) || 0;
    const box = $("#mkPreview");
    const seq = ++previewSeq;
    let rows = [];
    try {
      rows = await SMSPIN.rpc("business_markup_preview", {
        p_mode: markupMode, p_percent: markupMode === "percent" ? pct : 0,
        p_fixed: markupMode === "fixed" ? fixed : 0,
      }) || [];
    } catch (e) { rows = []; }
    if (seq !== previewSeq || !box) return;
    if (!rows.length) {
      box.innerHTML = '<div class="mk"><small>Preview</small><b>\u2014</b></div>';
      return;
    }
    box.innerHTML = rows.map(r => {
      const name = (r.country_name || r.country || "") + " \u00b7 " + (r.service_name || r.service || "");
      const base = Number(r.base_ngn) || 0;
      const ours = Number(r.price_ngn) || applyMarkup(base, markupMode, pct, fixed);
      const was = base && base < ours ? '<span class="was">' + money(base) + "</span>" : "";
      return '<div class="mk"><small>' + esc(name) + "</small><b>" + money(ours) + was + "</b></div>";
    }).join("");
  }

  async function refreshPlan() {
    try {
      const p = await SMSPIN.rpc("business_plan");
      $("#planPrice").textContent = "$" + p.usd;
      $("#planPriceLocal").textContent = "\u2248 " + money(p.ngn);
    } catch (e) {}
    try {
      const w = await SMSPIN.rpc("wallet_summary");
      $("#planWallet").textContent = money(w.balance);
      const need = await SMSPIN.rpc("business_plan");
      if (Number(w.balance) < Number(need.ngn)) {
        $("#planWallet").innerHTML = money(w.balance) +
          ' <span class="badge err" style="margin-left:8px">insufficient</span>';
      }
    } catch (e) {}
  }

  async function saveDraft() {
    const name = $("#bizName").value.trim();
    if (!name) { toast("Enter a store name", "err"); setStep(1); return null; }
    const pct = Number($("#bizMarkup") ? $("#bizMarkup").value : 0) || 0;
    const fixed = Number($("#bizMarkupFixed") ? $("#bizMarkupFixed").value : 0) || 0;
    try {
      return await SMSPIN.rpc("create_business", {
        p_name: name, p_theme: theme,
        p_markup: markupMode === "percent" ? pct : 0,
        p_markup_mode: markupMode,
        p_markup_fixed: markupMode === "fixed" ? fixed : 0,
      });
    } catch (e) { toast(e.message, "err"); return null; }
  }

  async function launch() {
    const btn = $("#wizNext");
    btn.disabled = true;
    const draft = await saveDraft();
    if (!draft) { btn.disabled = false; return; }
    try {
      const r = await SMSPIN.rpc("purchase_business");
      if (r.insufficient) {
        toast("Insufficient balance. Top up your wallet to launch.", "err");
        $("#bizStatusPanel").hidden = false;
        $("#bizStatusBody").innerHTML =
          '<div class="biz-live"><p>You need <b>' + money(r.required_ngn) + "</b> but your wallet has <b>" +
          money(r.balance) + '</b>.</p><a class="btn btn-primary" href="/dashboard/topup/">Top up wallet</a></div>';
        $("#bizStatusPanel").scrollIntoView({ behavior: "smooth" });
        return;
      }
      showLive(r, draft);
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  function showLive(r, draft) {
    $("#wizardPanel").hidden = true;
    $("#bizStatusPanel").hidden = false;
    const slug = draft.slug || (r.store_url || "").split("/").filter(Boolean).pop() || "";
    const path = "/" + slug;
    const url = location.origin + path;
    $("#bizStatusBody").innerHTML =
      '<div class="biz-live">' +
      '<div class="row"><span class="pill">Store live</span><span class="pill">App provisioning</span></div>' +
      '<div class="field"><label>Your store URL</label><input readonly value="' + esc(url) + '"></div>' +
      '<div class="row"><a class="btn btn-primary" href="' + esc(path) +
      '" target="_blank" rel="noopener">Open store</a>' +
      '<a class="btn btn-secondary" href="/dashboard/api-keys/">Get API key</a>' +
      '<a class="btn btn-ghost" href="/api/business/manifest?slug=' + encodeURIComponent(slug) +
      '" target="_blank" rel="noopener">App manifest (APK build)</a>' +
      '<button class="btn btn-ghost" type="button" id="copyStore">Copy link</button></div>' +
      '<p class="muted">Paid ' + money(r.paid_ngn) + " ($" + r.paid_usd + '). Your Android app build is queued; we will email the APK link.</p>' +
      "</div>";
    $("#copyStore")?.addEventListener("click", () => navigator.clipboard?.writeText(url).then(() => toast("Link copied", "ok")));
    $("#bizStatusPanel").scrollIntoView({ behavior: "smooth" });
  }

  async function loadExisting() {
    try {
      const b = await SMSPIN.rpc("my_business");
      if (b && b.id) {
        if (b.status === "active") {
          showLive({ paid_ngn: b.paid_ngn, paid_usd: b.paid_usd || 20 }, b);
          return;
        }
        $("#bizName").value = b.name || "";
        $("#bizMarkup").value = b.markup_percent != null ? b.markup_percent : 30;
        if ($("#bizMarkupFixed") && b.markup_fixed_ngn != null) $("#bizMarkupFixed").value = b.markup_fixed_ngn;
        theme = b.theme || "crimson";
        setMarkupMode(b.markup_mode || "percent");
        updateSlug();
      }
    } catch (e) {}
  }

  const DONUT_COLORS = { waiting: "var(--brand)", received: "#22c55e", refunded: "#f59e0b", cancelled: "var(--text-muted)" };
  const DONUT_FALLBACK = ["var(--brand)", "#22c55e", "#f59e0b", "#8b5cf6", "#0ea5e9"];
  function drawDonut(rows) {
    const segs = $("#bizDonutSegs"), legend = $("#bizDonutLegend"), num = $("#bizDonutNum");
    if (!segs) return;
    const total = rows.reduce((a, r) => a + (Number(r.n) || 0), 0);
    if (num) num.textContent = total.toLocaleString();
    if (!total) {
      segs.innerHTML = '<circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--glass-border)" stroke-width="5.5"></circle>';
      if (legend) legend.innerHTML = '<span class="muted">No storefront orders yet.</span>';
      return;
    }
    // r=15.9155 → circumference ≈ 100, so a value maps straight to stroke-dasharray.
    let offset = 25;
    segs.innerHTML = rows.map((r, i) => {
      const n = Number(r.n) || 0, pct = (n / total) * 100;
      const color = DONUT_COLORS[r.status] || DONUT_FALLBACK[i % DONUT_FALLBACK.length];
      const seg = '<circle class="donut-seg" cx="21" cy="21" r="15.9155" fill="none" stroke="' + color +
        '" stroke-width="5.5" stroke-dasharray="' + pct.toFixed(2) + ' ' + (100 - pct).toFixed(2) +
        '" stroke-dashoffset="' + offset.toFixed(2) + '"></circle>';
      offset -= pct;
      return seg;
    }).join("");
    if (legend) legend.innerHTML = rows.map((r, i) => {
      const n = Number(r.n) || 0;
      const color = DONUT_COLORS[r.status] || DONUT_FALLBACK[i % DONUT_FALLBACK.length];
      const pct = total ? Math.round((n / total) * 100) : 0;
      return '<span class="dleg"><i style="background:' + color + '"></i>' +
        esc(r.status) + ' <b>' + n + "</b> · " + pct + "%</span>";
    }).join("");
  }

  // ---------------- C2 branding + live preview ----------------
  let brandState = {};
  function paintPreview() {
    const p = $("#brPrimary").value, s = $("#brSecondary").value;
    const wrap = $("#brandPreview");
    if (wrap) { wrap.style.setProperty("--bp1", p); wrap.style.setProperty("--bp2", s); }
    const logo = $("#brLogo").value.trim();
    const name = ($("#bizName").value.trim()) || "Your store";
    $("#bpName").textContent = name;
    $("#bpTag").textContent = $("#brTagline").value.trim() || "Instant numbers for every app";
    $("#bpMail").textContent = $("#brSupport").value.trim() || "support@smspin.io";
    const el = $("#bpLogo");
    if (logo) el.innerHTML = '<img src="' + esc(logo) + '" alt="">';
    else el.textContent = name[0].toUpperCase();
  }

  async function loadBranding() {
    let b = null;
    try { const mine = await SMSPIN.rpc("my_business"); if (mine && mine.slug) brandState.slug = mine.slug; } catch (e) {}
    if (brandState.slug) { try { b = await SMSPIN.rpc("business_branding", { p_slug: brandState.slug }); } catch (e) {} }
    if (b && b.slug) {
      brandState = b;
      if (b.logo_url) $("#brLogo").value = b.logo_url;
      if (b.tagline) $("#brTagline").value = b.tagline;
      if (b.support_email) $("#brSupport").value = b.support_email;
      if (b.primary_color) $("#brPrimary").value = b.primary_color;
      if (b.secondary_color) $("#brSecondary").value = b.secondary_color;
      if (b.domain) $("#brDomain").value = b.domain;
    }
    paintPreview();
    ["#brLogo", "#brTagline", "#brSupport", "#brPrimary", "#brSecondary"].forEach(sel => {
      const el = $(sel); if (el) el.addEventListener("input", paintPreview);
    });
    const save = $("#brandSave");
    if (save) save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await SMSPIN.rpc("business_set_branding", {
          p_logo_url: $("#brLogo").value.trim() || null,
          p_tagline: $("#brTagline").value.trim() || null,
          p_support_email: $("#brSupport").value.trim() || null,
          p_primary: $("#brPrimary").value,
          p_secondary: $("#brSecondary").value,
          p_domain: $("#brDomain").value.trim() || null,
        });
        $("#brandSaved").textContent = "Saved";
        toast("Branding saved", "ok");
        setTimeout(() => { const e = $("#brandSaved"); if (e) e.textContent = ""; }, 2500);
      } catch (e) { toast(e.message, "err"); }
      finally { save.disabled = false; }
    });
    wireDomain();
  }

  // ---------------- C2 custom domain (live provisioning) ----------------
  function renderDomainState(d) {
    const st = $("#domainStatus"), dns = $("#domainDns"), rm = $("#domainRemove");
    if (!st) return;
    const status = (d && d.status) || "none";
    const dom = d && d.domain;
    if (rm) rm.hidden = !dom;
    if (!dom) {
      st.textContent = "No custom domain connected. Your store is also served at " + ((d && d.managed_host) || "") + ".";
      if (dns) dns.textContent = "";
      return;
    }
    const label = { active: "Live", pending: "Waiting for DNS", error: "Error", none: "Not connected" }[status] || status;
    st.innerHTML = "Domain <b>" + esc(dom) + "</b> — " + esc(label) +
      (d.error ? " (" + esc(d.error) + ")" : "");
    if (dns) {
      const recs = (status === "active") ? [] : (d.dns || []);
      dns.innerHTML = recs.length
        ? "Add this DNS record at your registrar:<br>" + recs.map(r =>
            esc(r.type) + " &nbsp; " + esc(r.name) + " &nbsp; → &nbsp; " + esc(r.value)).join("<br>")
        : "";
    }
  }

  function wireDomain() {
    const connect = $("#domainConnect"), rm = $("#domainRemove");
    const refresh = async () => { try { renderDomainState(await SMSPIN.domain("get")); } catch (e) {} };
    if (connect) connect.addEventListener("click", async () => {
      const name = ($("#brDomain").value || "").trim();
      if (!name) { toast("Enter a domain first", "err"); return; }
      connect.disabled = true;
      try { renderDomainState(await SMSPIN.domain("provision", name)); toast("Domain registered", "ok"); }
      catch (e) { toast(e.message, "err"); }
      finally { connect.disabled = false; }
    });
    if (rm) rm.addEventListener("click", async () => {
      rm.disabled = true;
      try { renderDomainState(await SMSPIN.domain("remove")); toast("Domain removed", "ok"); }
      catch (e) { toast(e.message, "err"); }
      finally { rm.disabled = false; }
    });
    refresh();
  }

  // ---------------- C4 payouts ----------------
  async function loadPayouts() {
    let p = null;
    try { p = await SMSPIN.rpc("my_payouts"); } catch (e) { return; }
    if (!p) return;
    $("#payEarned").textContent = money(p.earned_ngn);
    $("#payPaid").textContent = money(p.paid_ngn);
    $("#payAvail").textContent = money(p.available_ngn);
    const when = iso => { try { return new Date(iso).toLocaleDateString(); } catch (e) { return ""; } };
    const tb = $("#payTbl tbody");
    const rows = p.payouts || [];
    if (tb) tb.innerHTML = rows.length ? rows.map(r =>
      "<tr><td>" + esc(when(r.created_at)) + "</td><td>" + money(r.amount) + "</td><td>" + esc(r.method) +
      '</td><td><span class="badge ok">' + esc(r.status) + "</span></td><td class=\"mono\">" + esc(r.reference || "") + "</td></tr>").join("")
      : '<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">No payouts yet.</td></tr>';
    const btn = $("#payoutRequest");
    if (btn) btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await SMSPIN.rpc("request_payout", {});
        toast("Paid out " + money(r.amount) + " to your wallet", "ok");
        loadPayouts();
      } catch (e) { toast(e.message, "err"); }
      finally { btn.disabled = false; }
    });
  }

  // ---------------- C6 tenant API keys ----------------
  async function loadKeys() {
    let keys = [];
    try { keys = await SMSPIN.rpc("tenant_api_keys_list"); } catch (e) { return; }
    const tb = $("#tkTbl tbody");
    const when = iso => { try { return new Date(iso).toLocaleDateString(); } catch (e) { return ""; } };
    if (tb) tb.innerHTML = (keys && keys.length) ? keys.map(k =>
      "<tr><td>" + esc(k.name) + '</td><td class="mono">' + esc(k.prefix) + "</td><td>" + esc((k.scopes || []).join(", ")) +
      "</td><td>" + (k.webhook_url ? esc(k.webhook_url) : '<span class="muted">—</span>') + "</td><td>" + esc(when(k.created_at)) +
      '</td><td>' + (k.revoked ? '<span class="badge err">revoked</span>'
        : '<button class="btn btn-ghost" data-revoke="' + k.id + '">Revoke</button>') + "</td></tr>").join("")
      : '<tr><td colspan="6" class="muted" style="text-align:center;padding:18px">No keys yet.</td></tr>';
    $$("[data-revoke]").forEach(b => b.addEventListener("click", async () => {
      try { await SMSPIN.rpc("tenant_api_key_revoke", { p_id: Number(b.dataset.revoke) }); toast("Key revoked", "ok"); loadKeys(); }
      catch (e) { toast(e.message, "err"); }
    }));
    const create = $("#tkCreate");
    if (create) create.addEventListener("click", async () => {
      create.disabled = true;
      try {
        const scopes = ($("#tkScopes").value || "read").split(",");
        const r = await SMSPIN.rpc("tenant_api_key_create", {
          p_name: $("#tkName").value.trim() || "default",
          p_scopes: scopes,
          p_webhook_url: $("#tkWebhook").value.trim() || null,
        });
        const rev = $("#tkReveal");
        rev.hidden = false;
        rev.innerHTML = "<b>Copy your key now — it won't be shown again.</b><code>" + esc(r.key) + "</code>";
        $("#tkName").value = ""; $("#tkWebhook").value = "";
        loadKeys();
      } catch (e) { toast(e.message, "err"); }
      finally { create.disabled = false; }
    });
  }

  async function loadPerf() {
    let s;
    try { s = await SMSPIN.rpc("my_business_stats"); } catch (e) { return; }
    if (!s || s === null || !s.slug) return;
    const panel = $("#bizPerfPanel"); if (!panel) return;
    panel.hidden = false;
    $("#bizBrandPanel").hidden = false;
    $("#bizPayoutPanel").hidden = false;
    $("#bizKeyPanel").hidden = false;
    $("#bizChecklistPanel").hidden = false;
    $("#bizAppPanel").hidden = false;
    loadBranding();
    loadPayouts();
    loadKeys();
    loadChecklist();
    loadAppBuilds(s.slug);
    const open = $("#bizOpenStore"); if (open) open.href = "/" + s.slug;
    const open2 = $("#bizOpenStore2"); if (open2) open2.href = "/" + s.slug;
    drawDonut(s.by_status || []);
    $("#bizEarned").textContent = money(s.earned_ngn);
    $("#bizMarkupPct").textContent = s.markup_mode === "fixed"
      ? money(s.markup_fixed_ngn || 0) + " / number"
      : (Number(s.markup_percent) || 0) + "%";
    const when = iso => { try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } };
    const badgeCls = st => st === "received" ? "ok" : st === "refunded" ? "err" : "wait";
    const tb = $("#bizOrdersTbl tbody");
    if (tb) {
      const rows = s.recent || [];
      tb.innerHTML = rows.length ? rows.map(r =>
        "<tr><td>" + esc(r.service_name) + "</td><td><span class=\"mono\">" + esc(r.phone_number) + "</span></td>" +
        "<td><span class=\"badge " + badgeCls(r.status) + "\">" + esc(r.status) + "</span></td>" +
        "<td>" + money(r.price) + "</td><td>" + esc(when(r.created_at)) + "</td></tr>").join("")
        : '<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">No storefront orders yet.</td></tr>';
    }
  }

  // ---------------- O10 store launch checklist ----------------
  async function loadChecklist() {
    let d = null;
    try { d = await SMSPIN.rpc("my_launch_checklist"); } catch (e) { return; }
    const host = $("#bizChecklist"), panel = $("#bizChecklistPanel");
    if (!d || !d.items || !host) return;
    if (panel) panel.hidden = false;
    const done = d.items.filter(i => i.done).length;
    const prog = $("#bizCheckProgress"); if (prog) prog.textContent = done + " / " + d.items.length + " done";
    host.innerHTML = d.items.map(it =>
      '<a class="onb-item' + (it.done ? " done" : "") + '" href="' + esc(it.href) + '">' +
        '<span class="onb-check" aria-hidden="true">' + (it.done ? "✓" : "") + "</span>" +
        '<span class="onb-label">' + esc(it.label) + "</span>" +
        '<span class="onb-go" aria-hidden="true">' + (it.done ? "" : "→") + "</span></a>").join("");
  }

  // ---------------- M5-M7 branded app distribution ----------------
  async function loadAppBuilds(slug) {
    const dl = $("#appDownload");
    if (slug) { const d = $("#appDeepLink"); if (d) d.textContent = "/" + slug; }
    let builds = [];
    try { builds = await SMSPIN.rpc("my_app_builds"); } catch (e) { return; }
    const when = iso => { try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return "—"; } };
    const kb = n => n ? (n / 1048576).toFixed(1) + " MB" : "—";
    const tb = $("#appTbl tbody");
    const rows = builds || [];
    if (tb) tb.innerHTML = rows.length ? rows.map(b =>
      "<tr><td>" + esc(b.version) + '</td><td><span class="badge ' +
        (b.status === "ready" ? "ok" : b.status === "failed" ? "err" : "wait") + '">' + esc(b.status) + "</span></td>" +
      "<td>" + kb(b.size_bytes) + "</td><td>" + esc(when(b.built_at || b.created_at)) + "</td><td>" +
      (b.download_url ? '<a class="btn btn-ghost" href="' + esc(b.download_url) + '" download>Download</a>' : "") +
      "</td></tr>").join("")
      : '<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">No builds yet. Build your first app above.</td></tr>';
    // Surface the newest ready build's download button.
    const ready = rows.find(b => b.status === "ready" && b.download_url);
    if (dl && ready) { dl.hidden = false; dl.href = ready.download_url; }
    const btn = $("#appBuildBtn");
    if (btn) btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Building…";
      try {
        const r = await fetch("/api/app/builds/request", { method: "POST",
          headers: { "Authorization": "Bearer " + (SMSPIN.getSession() || {}).access_token, "Content-Type": "application/json" },
          body: JSON.stringify({ version: "1.0.0" }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "build failed");
        toast("Build queued — it will be ready in a moment", "ok");
        setTimeout(() => loadAppBuilds(slug), 2500);
      } catch (e) { toast(e.message, "err"); }
      finally { btn.disabled = false; btn.textContent = "Build my app"; }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!window.SMSPIN || !SMSPIN.auth.isAuthed()) { location.href = "/login/"; return; }
    try { const g = await fetch("/api/geo"); if (g.ok) geo = await g.json(); } catch (e) {}
    drawThemes();
    $("#bizName").addEventListener("input", updateSlug);
    $("#bizMarkup").addEventListener("input", updateMarkupPreview);
    if ($("#bizMarkupFixed")) $("#bizMarkupFixed").addEventListener("input", updateMarkupPreview);
    if ($("#mkModeBtn")) $("#mkModeBtn").addEventListener("click", pickMarkupMode);
    $("#wizBack").addEventListener("click", () => setStep(step - 1));
    $("#wizNext").addEventListener("click", () => {
      if (step === 1) { if (!$("#bizName").value.trim()) { toast("Enter a store name", "err"); return; } setStep(2); }
      else if (step === 2) setStep(3);
      else if (step === 3) setStep(4);
      else launch();
    });
    await loadExisting();
    loadPerf();
    setStep(1);
    updateSlug();
    updateMarkupPreview();
  });
})();
