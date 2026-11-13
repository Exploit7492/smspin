// SMSPin admin console — talks to the backend /api/admin/* (admin-gated).
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const UI = window.SMSPINUI || { alert: async () => {}, confirm: async () => "ok" };
  const S = window.SMSPIN;

  // Tenant owners get the SAME console, scoped to their store. The server
  // stamps the slug into the page; when present we authenticate with the store
  // session token and the backend serves store-scoped figures under the same
  // /api/admin/* paths, so the tab code below is unchanged.
  const TSLUG = (window.SMSPIN_TENANT_SLUG || "").trim();
  const TENANT = !!TSLUG;
  const TBASE = (window.SMSPIN_TENANT_BASE || (TSLUG ? "/store/" + TSLUG : "")).replace(/\/$/, "");

  const TOAST = $("#admToast");
  let toastT;
  function toast(msg) { TOAST.textContent = msg; TOAST.classList.add("in");
    clearTimeout(toastT); toastT = setTimeout(() => TOAST.classList.remove("in"), 2400); }

  function token() { const s = S.getSession(); return s && s.access_token ? s.access_token : ""; }

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (TENANT) headers["x-tenant-token"] = S.tenant.token(TSLUG) || "";
    else headers["Authorization"] = "Bearer " + token();
    const res = await fetch(path, { ...opts, headers });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (res.status === 403) { const e = new Error("admin only"); e.code = 403; throw e; }
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }
  const get = (p) => api(p);
  const post = (p, body) => api(p, { method: "POST", body: JSON.stringify(body || {}) });

  const money = n => "\u20a6" + Number(n || 0).toLocaleString(undefined,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = t => t ? new Date(t).toLocaleString() : "\u2014";
  const statusPill = s => {
    const bad = ["failed", "cancelled", "refunded", "down", "critical", "suspended"];
    const warn = ["pending", "waiting", "investigating", "degraded", "open", "minor", "major"];
    const cls = bad.includes(s) ? "bad" : warn.includes(s) ? "warn" : "ok";
    return '<span class="adm-pill ' + cls + '">' + esc(s || "\u2014") + "</span>";
  };

  const tabs = {};

  // ---------------------------------------------------------------- overview
  tabs.overview = async (root) => {
    const d = await get("/api/admin/overview");
    const cards = [
      ["Users", d.users_total, "+" + d.users_new_24h + " / 24h"],
      ["Orders", d.orders_total, d.orders_24h + " / 24h"],
      ["Active numbers", d.orders_active, ""],
      ["Wallet float", money(d.wallets_ngn), ""],
      ["Revenue", money(d.revenue_ngn), ""],
      ["Refunds", money(d.refunds_ngn), ""],
      ["Open tickets", d.tickets_open, ""],
      ["Risk blocks / 24h", d.risk_24h, ""],
      ["Webhook DLQ", d.dlq_open, ""],
      ["Markup", (d.markup_percent ?? 0) + "%", ""],
    ];
    root.innerHTML = '<div class="adm-cards">' + cards.map(([k, v, sub]) =>
      '<div class="adm-card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
      (sub ? ' <span class="adm-note">' + esc(sub) + "</span>" : "") + "</div></div>").join("") + "</div>" +
      '<div class="adm-panel"><h2>Quick actions</h2><div class="adm-bar">' +
      '<button class="adm-btn primary" id="ovChecks">Run synthetic checks</button>' +
      '<button class="adm-btn" id="ovAlerts">Evaluate alerts</button>' +
      '<button class="adm-btn" id="ovRefunds">Dispatch refund emails</button>' +
      '<button class="adm-btn" id="ovRecon">Reconcile payments (7d)</button></div>' +
      '<div id="ovOut" class="adm-empty">Reconcile and check results appear here.</div></div>';
    $("#ovChecks").onclick = async () => {
      const r = await post("/api/admin/checks/run");
      $("#ovOut").innerHTML = "Checks run: " + esc(JSON.stringify(r)); toast("Checks run");
    };
    $("#ovAlerts").onclick = async () => {
      const r = await post("/api/admin/alerts/run");
      $("#ovOut").innerHTML = "Alerts: " + esc(JSON.stringify(r)); toast("Alerts evaluated");
    };
    $("#ovRefunds").onclick = async () => {
      const r = await post("/api/admin/refunds/dispatch");
      $("#ovOut").innerHTML = "Refund notices sent: " + esc(r.sent); toast("Refunds dispatched");
    };
    $("#ovRecon").onclick = async () => {
      const r = await get("/api/admin/payments/reconcile?days=7");
      $("#ovOut").innerHTML = '<div class="adm-kv">' + Object.entries(r).map(([k, v]) =>
        '<span class="k">' + esc(k) + '</span><span>' + esc(v) + "</span>").join("") + "</div>";
    };
  };

  // ---------------------------------------------------------------- users
  tabs.users = async (root) => {
    root.innerHTML = '<div class="adm-panel"><h2>Users</h2>' +
      '<div class="adm-bar"><input id="uQ" placeholder="Search email or name"><button class="adm-btn primary" id="uGo">Search</button></div>' +
      '<div class="adm-tablewrap" id="uTable"></div></div>';
    const load = async () => {
      const q = encodeURIComponent($("#uQ").value.trim());
      const rows = await get("/api/admin/users?q=" + q + "&limit=100");
      $("#uTable").innerHTML = rows.length ? '<table class="adm"><thead><tr>' +
        ["Email", "Name", "Balance", "Orders", "Active", "Status", ""].map(h => "<th>" + h + "</th>").join("") +
        "</tr></thead><tbody>" + rows.map(u => "<tr>" +
          "<td>" + esc(u.email) + "</td><td>" + esc(u.full_name || "") + "</td>" +
          "<td>" + money(u.balance) + "</td><td>" + u.orders + "</td><td>" + u.active_orders + "</td>" +
          "<td>" + (u.suspended ? '<span class="adm-pill bad">suspended</span>' : '<span class="adm-pill ok">active</span>') + "</td>" +
          '<td><button class="adm-btn" data-user="' + esc(u.id) + '">Manage</button></td></tr>').join("") +
        "</tbody></table>" : '<div class="adm-empty">No users found.</div>';
      root.querySelectorAll("[data-user]").forEach(b => b.onclick = () => userDrawer(b.dataset.user, load));
    };
    $("#uGo").onclick = load;
    $("#uQ").onkeydown = e => { if (e.key === "Enter") load(); };
    await load();
  };

  async function userDrawer(id, reload) {
    const d = await get("/api/admin/users/" + id);
    const p = d.profile || {}, w = d.wallet || {};
    const open = () => $("#admDrawer").classList.add("in");
    $("#admSheet").innerHTML =
      "<h3>" + esc(p.email || "User") + "</h3>" +
      '<p class="adm-note">' + esc(p.full_name || "") + " \u00b7 joined " + when(p.created_at) + "</p>" +
      '<div class="adm-kv"><span class="k">User id</span><span>' + esc(p.id) + "</span>" +
      '<span class="k">Balance</span><span>' + money(w.balance) + " " + esc(w.currency || "") + "</span>" +
      '<span class="k">Status</span><span>' + (p.suspended ? "suspended" : "active") +
        (p.suspended_reason ? " \u2014 " + esc(p.suspended_reason) : "") + "</span></div>" +
      '<div class="adm-bar"><button class="adm-btn" id="udSuspend">' + (p.suspended ? "Unsuspend" : "Suspend") + "</button></div>" +
      '<div class="adm-bar"><input id="udAmt" type="number" placeholder="Amount (+/-)" style="min-width:120px">' +
      '<input id="udReason" placeholder="Reason (required)"><button class="adm-btn primary" id="udAdjust">Adjust balance</button></div>' +
      '<div class="adm-panel"><h2>Recent orders</h2><div class="adm-tablewrap"><table class="adm"><tbody>' +
      ((d.orders || []).slice(0, 8).map(o => "<tr><td>#" + o.id + "</td><td>" + esc(o.phone_number || "") +
        "</td><td>" + money(o.price) + "</td><td>" + statusPill(o.status) + "</td><td>" + when(o.created_at) + "</td></tr>").join("")
        || '<tr><td class="adm-note">No orders</td></tr>') + "</tbody></table></div></div>" +
      '<div class="adm-panel"><h2>Risk events</h2><div class="adm-tablewrap"><table class="adm"><tbody>' +
      ((d.risk || []).slice(0, 6).map(r => "<tr><td>" + esc(r.kind) + "</td><td>score " + r.score +
        "</td><td>" + statusPill(r.allow ? "ok" : "blocked") + "</td><td>" + when(r.created_at) + "</td></tr>").join("")
        || '<tr><td class="adm-note">None</td></tr>') + "</tbody></table></div></div>" +
      '<div class="adm-bar"><button class="adm-btn" id="udClose">Close</button></div>';
    open();
    $("#udClose").onclick = () => $("#admDrawer").classList.remove("in");
    $("#udSuspend").onclick = async () => {
      const reason = p.suspended ? null : (prompt("Reason for suspension") || "policy");
      await post("/api/admin/users/suspend", { user_id: id, suspended: !p.suspended, reason });
      toast(p.suspended ? "User unsuspended" : "User suspended");
      $("#admDrawer").classList.remove("in"); reload();
    };
    $("#udAdjust").onclick = async () => {
      const amount = parseFloat($("#udAmt").value);
      const reason = $("#udReason").value.trim();
      if (!amount || !reason) { toast("Amount and reason required"); return; }
      try {
        const r = await post("/api/admin/users/adjust", { user_id: id, amount, reason });
        toast("Balance " + money(r.before) + " \u2192 " + money(r.after));
        $("#admDrawer").classList.remove("in"); reload();
      } catch (e) { toast(e.message); }
    };
  }

  // ---------------------------------------------------------------- orders
  tabs.orders = async (root) => {
    root.innerHTML = '<div class="adm-panel"><h2>Orders &amp; SMS</h2>' +
      '<div class="adm-bar"><input id="oQ" placeholder="Phone, upstream id or email">' +
      '<select id="oStatus"><option value="">All statuses</option><option>waiting</option><option>received</option>' +
      '<option>refunded</option><option>cancelled</option></select>' +
      '<button class="adm-btn primary" id="oGo">Filter</button></div>' +
      '<div class="adm-tablewrap" id="oTable"></div></div>';
    const load = async () => {
      const q = encodeURIComponent($("#oQ").value.trim());
      const st = encodeURIComponent($("#oStatus").value);
      const rows = await get("/api/admin/orders?q=" + q + "&status=" + st + "&limit=200");
      $("#oTable").innerHTML = rows.length ? '<table class="adm"><thead><tr>' +
        ["#", "User", "Number", "OTP", "SMS", "Price", "Status", "Created", "Actions"].map(h => "<th>" + h + "</th>").join("") +
        "</tr></thead><tbody>" + rows.map(o => "<tr>" +
          "<td>#" + o.id + "</td><td>" + esc(o.user_email || "") + "</td>" +
          "<td>" + esc(o.phone_number || "") + "</td>" +
          '<td><code>' + esc(o.otp || "\u2014") + "</code></td><td>" + o.sms_count + "</td>" +
          "<td>" + money(o.price) + "</td><td>" + statusPill(o.status) + "</td><td>" + when(o.created_at) + "</td>" +
          '<td><button class="adm-btn" data-act="mark" data-id="' + o.id + '">Mark received</button> ' +
          '<button class="adm-btn" data-act="replay" data-id="' + o.id + '">Replay</button> ' +
          '<button class="adm-btn" data-act="refund" data-id="' + o.id + '">Refund</button> ' +
          '<button class="adm-btn" data-act="sms" data-id="' + o.id + '">Inject SMS</button></td></tr>').join("") +
        "</tbody></table>" : '<div class="adm-empty">No orders found.</div>';
      root.querySelectorAll("[data-act]").forEach(b => b.onclick = () => orderAction(b.dataset.act, b.dataset.id, load));
    };
    $("#oGo").onclick = load;
    $("#oQ").onkeydown = e => { if (e.key === "Enter") load(); };
    await load();
  };

  async function orderAction(act, id, reload) {
    try {
      if (act === "mark") await post("/api/admin/orders/mark-received", { order_id: +id });
      if (act === "replay") await post("/api/admin/orders/replay", { order_id: +id });
      if (act === "refund") {
        const v = prompt("Refund amount (blank = full refund)");
        const body = { order_id: +id, reason: "admin_refund" };
        if (v && v.trim()) body.amount = parseFloat(v);
        await post("/api/admin/orders/refund", body);
      }
      if (act === "sms") {
        const code = prompt("OTP code to inject");
        if (!code) return;
        await post("/api/admin/orders/sms", { order_id: +id, code, body: "Verification code: " + code, sender: "admin" });
      }
      toast("Done"); reload();
    } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- tickets
  tabs.tickets = async (root) => {
    root.innerHTML = '<div class="adm-panel"><h2>Support tickets</h2>' +
      '<div class="adm-bar"><select id="tStatus"><option value="">All</option><option>open</option>' +
      '<option>pending</option><option>resolved</option><option>closed</option></select>' +
      '<button class="adm-btn primary" id="tGo">Filter</button></div>' +
      '<div class="adm-tablewrap" id="tTable"></div></div>' +
      '<div id="tThread"></div>';
    const load = async () => {
      const st = encodeURIComponent($("#tStatus").value);
      const rows = await get("/api/admin/tickets?status=" + st + "&limit=100");
      $("#tTable").innerHTML = rows.length ? '<table class="adm"><thead><tr>' +
        ["#", "Subject", "User", "Msgs", "Last", "Status", "Updated", ""].map(h => "<th>" + h + "</th>").join("") +
        "</tr></thead><tbody>" + rows.map(t => "<tr>" +
          "<td>#" + t.id + "</td><td>" + esc(t.subject) + "</td><td>" + esc(t.user_email || "") + "</td>" +
          "<td>" + t.messages + "</td><td>" + esc(t.last_author_type) + "</td><td>" + statusPill(t.status) + "</td>" +
          "<td>" + when(t.updated_at) + "</td>" +
          '<td><button class="adm-btn" data-ticket="' + t.id + '">Open</button></td></tr>').join("") +
        "</tbody></table>" : '<div class="adm-empty">No tickets.</div>';
      root.querySelectorAll("[data-ticket]").forEach(b => b.onclick = () => ticketThread(b.dataset.ticket, load));
    };
    $("#tGo").onclick = load;
    await load();
  };

  async function ticketThread(id, reload) {
    const d = await get("/api/admin/tickets/" + id);
    const t = d.ticket || {};
    const msgs = d.messages || [];
    $("#tThread").innerHTML = '<div class="adm-panel"><h2>#' + t.id + " \u00b7 " + esc(t.subject) +
      ' <span class="adm-note">' + esc(t.user_email || "") + "</span></h2>" +
      '<div class="adm-bar">Status <select id="thStatus">' +
      ["open", "pending", "resolved", "closed"].map(s => '<option' + (t.status === s ? " selected" : "") + ">" + s + "</option>").join("") +
      '</select> Priority <select id="thPrio">' + ["low", "normal", "high", "urgent"].map(s =>
        '<option' + (t.priority === s ? " selected" : "") + ">" + s + "</option>").join("") + "</select>" +
      '<button class="adm-btn" id="thSave">Save</button></div>' +
      '<div class="adm-thread" id="thMsgs">' + (msgs.map(m =>
        '<div class="adm-msg ' + (m.author_type === "agent" ? "agent" : "") + '"><div class="mh">' +
        esc(m.author_type === "agent" ? (m.author_name || "agent") : "customer") + " \u00b7 " + when(m.created_at) +
        '</div><div class="mb">' + esc(m.body) + "</div></div>").join("") ||
        '<div class="adm-empty">No messages yet.</div>') + "</div>" +
      '<div class="adm-form"><textarea id="thReply" rows="2" placeholder="Reply to the customer..."></textarea>' +
      '<button class="adm-btn primary" id="thSend">Send</button></div></div>';
    $("#thSave").onclick = async () => {
      await post("/api/admin/tickets/update", { ticket_id: +id, status: $("#thStatus").value, priority: $("#thPrio").value });
      toast("Ticket updated"); reload();
    };
    $("#thSend").onclick = async () => {
      const body = $("#thReply").value.trim();
      if (!body) return;
      await post("/api/admin/tickets/reply", { ticket_id: +id, body });
      toast("Reply sent"); ticketThread(id, reload);
    };
  }

  // ---------------------------------------------------------------- payments
  tabs.payments = async (root) => {
    const recon = await get("/api/admin/payments/reconcile?days=7");
    root.innerHTML = '<div class="adm-cards">' + Object.entries(recon).map(([k, v]) =>
      '<div class="adm-card"><div class="k">' + esc(k.replace(/_/g, " ")) + '</div><div class="v">' +
      (k.includes("ngn") ? money(v) : esc(v)) + "</div></div>").join("") + "</div>" +
      '<div class="adm-panel"><h2>Payments</h2><div class="adm-bar">' +
      '<select id="pStatus"><option value="">All</option><option>pending</option><option>success</option><option>failed</option></select>' +
      '<button class="adm-btn primary" id="pGo">Filter</button></div><div class="adm-tablewrap" id="pTable"></div></div>';
    const load = async () => {
      const st = encodeURIComponent($("#pStatus").value);
      const rows = await get("/api/admin/payments?status=" + st + "&limit=200");
      $("#pTable").innerHTML = rows.length ? '<table class="adm"><thead><tr>' +
        ["Reference", "User", "Amount", "Fee", "Channel", "Status", "Created", ""].map(h => "<th>" + h + "</th>").join("") +
        "</tr></thead><tbody>" + rows.map(p => "<tr>" +
          "<td><code>" + esc(p.reference) + "</code></td><td>" + esc(p.user_email || "") + "</td>" +
          "<td>" + money(p.amount) + "</td><td>" + money(p.fee_ngn) + "</td><td>" + esc(p.channel || "") + "</td>" +
          "<td>" + statusPill(p.status) + "</td><td>" + when(p.created_at) + "</td>" +
          '<td><button class="adm-btn" data-ref="' + esc(p.reference) + '" data-st="success">Mark success</button> ' +
          '<button class="adm-btn danger" data-ref="' + esc(p.reference) + '" data-st="failed">Mark failed</button></td></tr>').join("") +
        "</tbody></table>" : '<div class="adm-empty">No payments.</div>';
      root.querySelectorAll("[data-ref]").forEach(b => b.onclick = async () => {
        await post("/api/admin/payments/mark", { reference: b.dataset.ref, status: b.dataset.st });
        toast("Payment marked " + b.dataset.st); load();
      });
    };
    $("#pGo").onclick = load;
    await load();
  };

  // ---------------------------------------------------------------- catalog
  tabs.catalog = async (root) => {
    root.innerHTML = '<div class="adm-panel"><h2>Pricing &amp; inventory</h2>' +
      '<div class="adm-bar"><input id="cQ" placeholder="Country or service code">' +
      '<button class="adm-btn primary" id="cGo">Search</button>' +
      '<span style="flex:1"></span>Markup % <input id="cMarkup" type="number" style="min-width:90px">' +
      '<button class="adm-btn" id="cMarkupSave">Set markup</button></div>' +
      '<div class="adm-tablewrap" id="cTable"></div></div>';
    const load = async () => {
      const q = encodeURIComponent($("#cQ").value.trim());
      const rows = await get("/api/admin/catalog?q=" + q + "&limit=300");
      $("#cTable").innerHTML = rows.length ? '<table class="adm"><thead><tr>' +
        ["Country", "Service", "Operator", "Price", "Cost USD", "Stock", "Active", ""].map(h => "<th>" + h + "</th>").join("") +
        "</tr></thead><tbody>" + rows.map(c => "<tr>" +
          "<td>" + esc(c.country_code) + " " + esc(c.country_name || "") + "</td>" +
          "<td>" + esc(c.service_code) + " " + esc(c.service_name || "") + "</td><td>" + (c.operator_id ?? "\u2014") + "</td>" +
          "<td>" + money(c.price) + "</td><td>" + esc(c.cost_usd ?? "") + "</td><td>" + (c.stock ?? 0) + "</td>" +
          "<td>" + (c.active ? '<span class="adm-pill ok">on</span>' : '<span class="adm-pill bad">off</span>') + "</td>" +
          '<td><button class="adm-btn" data-cid="' + c.id + '" data-price="' + (c.price ?? "") +
          '" data-stock="' + (c.stock ?? 0) + '" data-active="' + (c.active ? 1 : 0) + '">Edit</button></td></tr>').join("") +
        "</tbody></table>" : '<div class="adm-empty">No catalog rows.</div>';
      root.querySelectorAll("[data-cid]").forEach(b => b.onclick = async () => {
        const price = prompt("Price (NGN)", b.dataset.price);
        if (price === null) return;
        const stock = prompt("Stock", b.dataset.stock);
        const active = confirm("Active? OK = on, Cancel = off");
        await post("/api/admin/catalog/update", { id: +b.dataset.cid, price: parseFloat(price),
          stock: stock === null ? null : parseInt(stock, 10), active });
        toast("Catalog updated"); load();
      });
    };
    $("#cGo").onclick = load;
    $("#cMarkupSave").onclick = async () => {
      const p = parseFloat($("#cMarkup").value);
      if (isNaN(p)) { toast("Enter a markup %"); return; }
      await post("/api/admin/pricing/markup", { percent: p });
      toast("Markup set to " + p + "%");
    };
    await load();
  };

  // ---------------------------------------------------------------- status
  tabs.status = async (root) => {
    const s = await get("/api/status");
    const inc = s.incidents || [];
    root.innerHTML = '<div class="adm-panel"><h2>System status <span class="adm-pill ' +
      (s.overall === "ok" ? "ok" : s.overall === "degraded" ? "warn" : "bad") + '">' + esc(s.overall) + "</span></h2>" +
      '<div class="adm-tablewrap"><table class="adm"><thead><tr><th>Component</th><th>Status</th><th>Checked</th><th>Detail</th></tr></thead><tbody>' +
      (s.components || []).map(c => "<tr><td>" + esc(c.name) + "</td><td>" + statusPill(c.status) +
        "</td><td>" + when(c.checked_at) + "</td><td>" + esc(JSON.stringify(c.detail)) + "</td></tr>").join("") +
      "</tbody></table></div></div>" +
      '<div class="adm-panel"><h2>Incidents</h2>' +
      '<div class="adm-tablewrap"><table class="adm"><tbody>' +
      (inc.map(i => "<tr><td>#" + i.id + "</td><td>" + esc(i.title) + "</td><td>" + statusPill(i.severity) +
        "</td><td>" + statusPill(i.status) + "</td><td>" + when(i.started_at) + "</td></tr>").join("") ||
        '<tr><td class="adm-note">No incidents in the last 30 days.</td></tr>') + "</tbody></table></div>" +
      '<div class="adm-bar"><button class="adm-btn" id="stNew">New incident</button></div></div>';
    $("#stNew").onclick = async () => {
      const title = prompt("Incident title");
      if (!title) return;
      await post("/api/admin/incidents", { title, body: prompt("Details") || "", severity: "minor" });
      toast("Incident created"); tabs.status(root);
    };
  };

  // ---------------------------------------------------------------- margin (A8)
  tabs.margin = async (root) => {
    const days = 30;
    const d = await get("/api/admin/margin?days=" + days);
    const svc = d.by_service || [];
    const day = d.by_day || [];
    const maxRev = Math.max.apply(null, [1].concat(day.map(r => Number(r.revenue_ngn) || 0)));
    root.innerHTML = '<div class="adm-cards">' +
      [["Revenue", money(d.revenue_ngn)], ["COGS", money(d.cogs_ngn)],
       ["Gross margin", money(d.gross_margin_ngn)], ["Margin %", (d.margin_percent ?? 0) + "%"]]
        .map(([k, v]) => '<div class="adm-card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div></div>").join("") +
      "</div>" +
      '<div class="adm-panel"><h2>Margin by service <span class="adm-note">last ' + days + " days</span></h2>" +
      '<div class="adm-tablewrap"><table class="adm"><thead><tr>' +
      ["Service", "Orders", "Revenue", "COGS", "Margin", "Margin %"].map(h => "<th>" + h + "</th>").join("") +
      "</tr></thead><tbody>" +
      (svc.length ? svc.map(r => {
        const pct = Number(r.revenue_ngn) > 0 ? Math.round(Number(r.margin_ngn) / Number(r.revenue_ngn) * 1000) / 10 : 0;
        return "<tr><td>" + esc(r.service || r.service_code) + "</td><td>" + (r.orders ?? 0) +
          "</td><td>" + money(r.revenue_ngn) + "</td><td>" + money(r.cogs_ngn) + "</td><td>" + money(r.margin_ngn) +
          "</td><td>" + pct + "%</td></tr>";
      }).join("") : '<tr><td colspan="6" class="adm-note">No orders in range.</td></tr>') +
      "</tbody></table></div></div>" +
      '<div class="adm-panel"><h2>Daily revenue</h2><div class="adm-tablewrap"><table class="adm"><thead><tr>' +
      ["Day", "Orders", "Revenue", "Margin", ""].map(h => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" +
      (day.length ? day.map(r => {
        const w = Math.round((Number(r.revenue_ngn) || 0) / maxRev * 100);
        return "<tr><td>" + esc(r.day) + "</td><td>" + (r.orders ?? 0) + "</td><td>" + money(r.revenue_ngn) +
          "</td><td>" + money(r.margin_ngn) + '</td><td><span class="adm-bar-mini" style="width:' + w + 'px"></span></td></tr>';
      }).join("") : '<tr><td colspan="5" class="adm-note">No data.</td></tr>') +
      "</tbody></table></div></div>";
  };

  // ---------------------------------------------------------------- tenants (F6)
  tabs.tenants = async (root) => {
    root.innerHTML = '<div class="adm-panel"><h2>White-label tenants</h2>' +
      '<div class="adm-bar"><input id="tnQ" placeholder="Store name or slug">' +
      '<button class="adm-btn primary" id="tnGo">Search</button></div>' +
      '<div class="adm-tablewrap" id="tnTable"></div></div>';
    const load = async () => {
      const q = encodeURIComponent($("#tnQ").value.trim());
      const rows = await get("/api/admin/tenants?q=" + q + "&limit=200");
      $("#tnTable").innerHTML = rows.length ? '<table class="adm"><thead><tr>' +
        ["Store", "Slug", "Owner", "Orders", "Earned", "Markup", "Domain", "Status", ""].map(h => "<th>" + h + "</th>").join("") +
        "</tr></thead><tbody>" + rows.map(t => "<tr>" +
          "<td>" + esc(t.name) + "</td><td><code>" + esc(t.slug) + "</code></td><td>" + esc(t.owner_email || "") + "</td>" +
          "<td>" + t.orders + "</td><td>" + money(t.earned_ngn) + "</td><td>" + (t.markup_percent || 0) + "%</td>" +
          "<td>" + esc(t.domain || "\u2014") + "</td><td>" + statusPill(t.status) + "</td>" +
          '<td><button class="adm-btn" data-tstatus="' + t.id + '" data-cur="' + esc(t.status) + '">Toggle</button> ' +
          '<button class="adm-btn" data-tpay="' + t.id + '">Payouts</button></td></tr>').join("") +
        "</tbody></table>" : '<div class="adm-empty">No tenants.</div>';
      root.querySelectorAll("[data-tstatus]").forEach(b => b.onclick = async () => {
        const next = b.dataset.cur === "active" ? "suspended" : "active";
        await post("/api/admin/tenants/status", { id: +b.dataset.tstatus, status: next });
        toast("Tenant " + next); load();
      });
      root.querySelectorAll("[data-tpay]").forEach(b => b.onclick = async () => {
        const rows2 = await post("/api/admin/tenants/payouts", { id: +b.dataset.tpay });
        toast("Payouts: " + (rows2 || []).length);
      });
    };
    $("#tnGo").onclick = load;
    await load();
  };

  // ---------------------------------------------------------------- fraud (F8)
  tabs.fraud = async (root) => {
    const rows = await get("/api/admin/fraud?limit=200");
    root.innerHTML = '<div class="adm-panel"><h2>Fraud review queue</h2>' +
      '<div class="adm-tablewrap">' + (rows.length ? '<table class="adm"><thead><tr>' +
        ["When", "User", "Kind", "Score", "Reasons"].map(h => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map(r => "<tr><td>" + when(r.created_at) + "</td><td>" + esc(r.email || r.user_id || "") + "</td>" +
          "<td>" + esc(r.kind) + "</td><td>" + r.score + "</td><td>" + esc((r.reasons || []).join(", ")) + "</td></tr>").join("") +
        "</tbody></table>" : '<div class="adm-empty">No blocked events.</div>') + "</div></div>";
  };

  // ---------------------------------------------------------------- flags + settings (F9)
  // O15 internal runbooks: step-by-step playbooks for common ops.
  const RUNBOOKS = [
    { key: "refund", title: "Issue a manual refund", steps: [
      "Open the Orders tab and search the order id or phone number.",
      "Confirm the SMS never arrived (no code, status waiting/expired).",
      "Open the order drawer and choose Refund — the wallet is credited instantly.",
      "Reply on the linked ticket so the customer knows the credit landed." ] },
    { key: "provider_outage", title: "Provider outage / degraded stock", steps: [
      "Check the Status tab for provider health and the last incident.",
      "Set the feature flag `provider_paused` to true to stop new purchases.",
      "Update the public status page with an investigating incident.",
      "Notify affected users from the Growth tab broadcast.",
      "When stock returns, clear the flag and resolve the incident." ] },
    { key: "fraud", title: "Fraud spike response", steps: [
      "Open the Fraud tab and sort by risk score.",
      "Block confirmed abusers from the user drawer (blocklist).",
      "Enable the `risk_strict` flag to raise the velocity threshold.",
      "File the incident with the accounts and loss figure." ] },
    { key: "payouts", title: "Approve tenant payouts", steps: [
      "Open Tenants and review pending payout requests.",
      "Verify the earnings ledger totals match the request.",
      "Approve — the tenant wallet is credited and the payout marked paid." ] },
    { key: "email_queue", title: "Stalled email queue", steps: [
      "Check the DLQ count on the Overview tab.",
      "Re-run delivery from Settings → retry queue.",
      "If failures persist, inspect the template payload and provider key." ] },
  ];

  tabs.runbooks = async (root) => {
    root.innerHTML = '<div class="adm-card"><div class="k">Internal runbooks</div>' +
      '<p class="adm-note">Step-by-step playbooks for the most common operations.</p></div>' +
      '<div class="adm-runbooks">' + RUNBOOKS.map(r =>
        '<details class="adm-runbook"><summary>' + esc(r.title) + "</summary><ol>" +
        r.steps.map(s => "<li>" + esc(s) + "</li>").join("") + "</ol></details>").join("") + "</div>";
  };

  // O15 admin onboarding runbooks.
  tabs.onboarding = async (root) => {
    root.innerHTML = '<div class="adm-card"><div class="k">Admin onboarding</div>' +
      '<p class="adm-note">New to the console? Keep the runbooks handy for the day-to-day playbook.</p></div>' +
      '<div class="adm-runbooks">' + RUNBOOKS.map(r =>
        '<details class="adm-runbook"><summary>' + esc(r.title) + "</summary><ol>" +
        r.steps.map(s => "<li>" + esc(s) + "</li>").join("") + "</ol></details>").join("") + "</div>";
  };

  tabs.flags = async (root) => {
    const [flags, settings] = await Promise.all([get("/api/admin/flags"), get("/api/admin/settings")]);
    root.innerHTML = '<div class="adm-panel"><h2>Feature flags</h2>' +
      '<div class="adm-tablewrap"><table class="adm"><thead><tr>' +
      ["Key", "Scope", "Description", "Enabled", ""].map(h => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" +
      (flags.length ? flags.map(f => "<tr><td><code>" + esc(f.key) + "</code></td>" +
        "<td>" + (f.tenant_id ? "tenant " + f.tenant_id : "global") + "</td><td>" + esc(f.description || "") + "</td>" +
        "<td>" + (f.enabled ? '<span class="adm-pill ok">on</span>' : '<span class="adm-pill bad">off</span>') + "</td>" +
        '<td><button class="adm-btn" data-flag="' + esc(f.key) + '" data-on="' + (f.enabled ? 1 : 0) +
        '" data-tenant="' + (f.tenant_id || 0) + '">Toggle</button></td></tr>').join("")
        : '<tr><td class="adm-note">No flags.</td></tr>') + "</tbody></table></div></div>" +
      '<div class="adm-panel"><h2>Platform settings</h2><div class="adm-tablewrap"><table class="adm"><thead><tr>' +
      "<th>Key</th><th>Value</th><th></th></tr></thead><tbody>" +
      Object.entries(settings || {}).map(([k, v]) => "<tr><td><code>" + esc(k) + "</code></td>" +
        '<td><input data-setkey="' + esc(k) + '" value="' + esc(JSON.stringify(v)) + '" style="min-width:220px"></td>' +
        '<td><button class="adm-btn" data-setsave="' + esc(k) + '">Save</button></td></tr>').join("") +
      "</tbody></table></div></div>";
    root.querySelectorAll("[data-flag]").forEach(b => b.onclick = async () => {
      await post("/api/admin/flags/set", { key: b.dataset.flag, enabled: b.dataset.on !== "1",
        tenant_id: +b.dataset.tenant || null });
      toast("Flag updated"); tabs.flags(root);
    });
    root.querySelectorAll("[data-setsave]").forEach(b => b.onclick = async () => {
      const k = b.dataset.setsave;
      const input = root.querySelector('[data-setkey="' + k + '"]');
      let val; try { val = JSON.parse(input.value); } catch (e) { val = input.value; }
      await post("/api/admin/settings/set", { key: k, value: val });
      toast("Setting saved");
    });
  };

  // ---------------------------------------------------------------- growth (G5/I/G/L)
  tabs.growth = async (root) => {
    const [exp, tours, tax, ledger] = await Promise.all([
      get("/api/admin/experiments"), get("/api/admin/tours"),
      get("/api/admin/tax?days=30"), get("/api/admin/ledger"),
    ]);
    root.innerHTML = '<div class="adm-panel"><h2>Experiments (G5)</h2><div class="adm-tablewrap"><table class="adm"><thead><tr>' +
      ["Key", "Variant", "Assigned"].map(h => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" +
      ((exp.stats || []).length ? exp.stats.map(s => "<tr><td><code>" + esc(s.key) + "</code></td><td>" +
        esc(s.variant) + "</td><td>" + s.assigned + "</td></tr>").join("")
        : '<tr><td class="adm-note">No assignments yet.</td></tr>') + "</tbody></table></div></div>" +
      '<div class="adm-panel"><h2>Onboarding funnel (O18)</h2><div class="adm-tablewrap"><table class="adm"><thead><tr>' +
      ["Tour", "Starts", "Steps", "Completes", "Skips", "Completion %"].map(h => "<th>" + h + "</th>").join("") +
      "</tr></thead><tbody>" + ((tours.funnel || []).length ? tours.funnel.map(t => "<tr><td><code>" + esc(t.tour_key) +
        "</code></td><td>" + t.starts + "</td><td>" + t.steps + "</td><td>" + t.completes + "</td><td>" + t.skips +
        "</td><td>" + t.completion_pct + "%</td></tr>").join("")
        : '<tr><td class="adm-note">No tour data.</td></tr>') + "</tbody></table></div></div>" +
      '<div class="adm-panel"><h2>Tax &amp; accounting (L2/L3)</h2>' +
      '<div class="adm-cards"><div class="adm-card"><div class="k">Fees (30d)</div><div class="v">' + money(tax.fees_ngn) +
      '</div></div><div class="adm-card"><div class="k">VAT rate</div><div class="v">' + ((tax.vat_rate || 0) * 100) + "%</div></div>" +
      '<div class="adm-card"><div class="k">Revenue (30d)</div><div class="v">' + money(tax.revenue_ngn) + "</div></div>" +
      '<div class="adm-card"><div class="k">Ledger entries</div><div class="v">' + (ledger || []).length + "</div></div></div>" +
      '<div class="adm-bar"><button class="adm-btn" id="grLedger">Export ledger JSON</button></div></div>';
    $("#grLedger").onclick = () => {
      const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "smspin-ledger.json"; a.click();
    };
  };

  // ---------------------------------------------------------------- boot
  async function boot() {
    const authed = TENANT ? (S && S.tenant && S.tenant.isAuthed(TSLUG)) : (S && S.auth.isAuthed());
    if (!authed) { location.href = TENANT ? TBASE + "/login/" : "/login/"; return; }
    try {
      await get("/api/admin/overview");   // 403 gate
    } catch (e) {
      $("#admGate").hidden = false;
      $("#admGateMsg").textContent = e.code === 403
        ? "Your account is not an administrator." : "Could not reach the admin API: " + e.message;
      return;
    }
    $("#admApp").hidden = false;
    const u = TENANT ? S.tenant.user(TSLUG) : S.auth.user();
    $("#admWho").textContent = (u && u.email) || "";
    if (TENANT) {
      // Same console, store branding and a link back to the store dashboard.
      let storeName = (u && u.tenant_slug) || TSLUG;
      try { const cfg = await S.rpc("site_config"); if (cfg && cfg.brand_name) storeName = cfg.brand_name; } catch (e) {}
      const brand = $("#admBrand"); if (brand) brand.textContent = storeName;
      const badge = $("#admBadge"); if (badge) badge.textContent = "Owner";
      const dash = $("#admDashLink"); if (dash) dash.href = TBASE + "/dashboard/";
      document.title = "Store console \u2014 " + storeName;
    }
    // The owner console is the same UI, minus the platform-only tabs (fraud
    // queue, runbooks, growth experiments, status page). "Tenants" becomes the
    // owner's own payout ledger.
    if (TENANT) {
      ["fraud", "runbooks", "growth", "status"].forEach(t => {
        const b = document.querySelector('#admTabs button[data-tab="' + t + '"]');
        if (b) b.remove();
      });
      const tn = document.querySelector('#admTabs button[data-tab="tenants"]');
      if (tn) tn.textContent = "Payouts";
    }
    const go = async (name) => {
      document.querySelectorAll("#admTabs button").forEach(b =>
        b.classList.toggle("active", b.dataset.tab === name));
      $("#admBody").innerHTML = '<div class="adm-empty">Loading\u2026</div>';
      try { await tabs[name]($("#admBody")); }
      catch (e) { $("#admBody").innerHTML = '<div class="adm-empty">Error: ' + esc(e.message) + "</div>"; }
    };
    document.querySelectorAll("#admTabs button").forEach(b => b.onclick = () => go(b.dataset.tab));
    $("#admDrawer").onclick = e => { if (e.target.id === "admDrawer") $("#admDrawer").classList.remove("in"); };
    await go("overview");
  }
  boot();
})();
