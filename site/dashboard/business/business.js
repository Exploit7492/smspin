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
      '<div class="theme-card' + (t.id === theme ? " sel" : "") + '" data-theme="' + t.id + '">' +
      '<div class="theme-swatch">' + t.c.map(c => '<i style="background:' + c + '"></i>').join("") + "</div>" +
      "<b>" + esc(t.name) + "</b></div>").join("");
    $$("[data-theme]").forEach(el => el.addEventListener("click", () => {
      theme = el.dataset.theme;
      drawThemes();
    }));
  }

  function updateSlug() {
    $("#slugPreview").textContent = "/store/" + slugify($("#bizName").value);
  }

  async function updateMarkupPreview() {
    const mk = Number($("#bizMarkup").value || 0);
    const rows = [["WhatsApp \u00b7 UK", 150], ["Telegram \u00b7 US", 220], ["Google \u00b7 NG", 190]];
    $("#mkPreview").innerHTML = rows.map(([n, base]) => {
      const ours = base * (1 + mk / 100);
      return '<div class="mk"><small>' + esc(n) + "</small><b>" + money(ours) +
        '</b><small style="text-decoration:line-through">' + money(base) + "</small></div>";
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
    const markup = Number($("#bizMarkup").value || 0);
    try {
      return await SMSPIN.rpc("create_business", { p_name: name, p_theme: theme, p_markup: markup });
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
          money(r.balance) + '</b>.</p><a class="btn btn-primary" href="/dashboard/wallet/">Top up wallet</a></div>';
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
    const slug = (r.store_url || "/store/" + draft.slug).replace("/store/", "");
    const url = location.origin + (r.store_url || "/store/" + draft.slug);
    $("#bizStatusBody").innerHTML =
      '<div class="biz-live">' +
      '<div class="row"><span class="pill">Store live</span><span class="pill">App provisioning</span></div>' +
      '<div class="field"><label>Your store URL</label><input readonly value="' + esc(url) + '"></div>' +
      '<div class="row"><a class="btn btn-primary" href="' + esc(r.store_url || "/store/" + draft.slug) +
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
          showLive({ store_url: "/store/" + b.slug, paid_ngn: b.paid_ngn, paid_usd: b.paid_usd || 20 }, b);
          return;
        }
        $("#bizName").value = b.name || "";
        $("#bizMarkup").value = b.markup_percent != null ? b.markup_percent : 30;
        theme = b.theme || "crimson";
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

  async function loadPerf() {
    let s;
    try { s = await SMSPIN.rpc("my_business_stats"); } catch (e) { return; }
    if (!s || s === null || !s.slug) return;
    const panel = $("#bizPerfPanel"); if (!panel) return;
    panel.hidden = false;
    const open = $("#bizOpenStore"); if (open) open.href = "/store/" + s.slug;
    const open2 = $("#bizOpenStore2"); if (open2) open2.href = "/store/" + s.slug;
    drawDonut(s.by_status || []);
    $("#bizEarned").textContent = money(s.earned_ngn);
    $("#bizMarkupPct").textContent = (Number(s.markup_percent) || 0) + "%";
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

  document.addEventListener("DOMContentLoaded", async () => {
    if (!window.SMSPIN || !SMSPIN.auth.isAuthed()) { location.href = "/login/"; return; }
    try { const g = await fetch("/api/geo"); if (g.ok) geo = await g.json(); } catch (e) {}
    drawThemes();
    $("#bizName").addEventListener("input", updateSlug);
    $("#bizMarkup").addEventListener("input", updateMarkupPreview);
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
    updateMarkupPreview();
  });
})();
