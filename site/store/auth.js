// Shared logic for every tenant's dedicated auth screens.
// Resolves the store slug from the URL path (/store/<slug>/login) or ?store=,
// loads the tenant's brand + theme, and exposes small helpers.
(function () {
  var THEMES = {
    crimson: ["#E11D2E", "#F26B7A"], ocean: ["#0EA5E9", "#38BDF8"],
    emerald: ["#10B981", "#34D399"], violet: ["#7C3AED", "#A78BFA"],
    amber: ["#F59E0B", "#FCD34D"], rose: ["#E11D48", "#FB7185"],
    slate: ["#475569", "#94A3B8"], midnight: ["#1E293B", "#334155"],
  };

  function slug() {
    var parts = location.pathname.split("/").filter(Boolean); // ["store","<slug>","login"] or ["<slug>","login"]
    var reserved = { login: 1, register: 1, account: 1 };
    var fromPath = "";
    if (parts[0] === "store") {
      var cand = (parts[1] || "").replace(/\.html$/, "");
      if (cand && !reserved[cand]) fromPath = cand;
    } else if (parts.length >= 2 && reserved[parts[parts.length - 1]]) {
      // Product form: /<slug>/login, /<slug>/register, /<slug>/account.
      fromPath = parts[0];
    }
    if (fromPath) return fromPath;
    var q = new URLSearchParams(location.search);
    return q.get("store") || q.get("slug") || "";
  }

  function applyTheme(theme) {
    var t = THEMES[theme] || THEMES.crimson;
    var r = document.documentElement.style;
    r.setProperty("--brand", t[0]); r.setProperty("--brand-2", t[1]);
  }
  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "S";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function applyName(name) {
    if (!name) return;
    document.title = document.title.replace(/SMSPin/g, name);
    var b = document.querySelectorAll("[data-tenant-name]");
    for (var i = 0; i < b.length; i++) b[i].textContent = name;
    var g = document.querySelectorAll("[data-tenant-initials]");
    for (var j = 0; j < g.length; j++) g[j].textContent = initials(name);
  }
  function show(el, text, cls) { if (!el) return; el.textContent = text; el.className = "ta-msg show " + cls; }

  var S = slug();

  function boot(cb) {
    if (!window.SMSPIN) { if (cb) cb(null); return; }
    if (S) SMSPIN.rpc("business_public", { p_slug: S }).then(function (b) {
      if (b && b.name) { applyName(b.name); if (b.theme) applyTheme(b.theme); }
      if (cb) cb(b);
      SMSPIN.rpc("business_branding", { p_slug: S }).then(function (br) {
        if (br && br.primary_color) {
          var r = document.documentElement.style;
          r.setProperty("--brand", br.primary_color);
          if (br.secondary_color) r.setProperty("--brand-2", br.secondary_color);
        }
      }).catch(function () {});
    }).catch(function () { if (cb) cb(null); });
    else {
      SMSPIN.rpc("site_config").then(function (c) { if (c && c.brand_name) applyName(c.brand_name); if (cb) cb(null); })
        .catch(function () { if (cb) cb(null); });
    }
  }

  window.TENANT_AUTH = { slug: slug, S: S, boot: boot, show: show, applyName: applyName, applyTheme: applyTheme };
})();
