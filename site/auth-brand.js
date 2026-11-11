// Auth page branding. Loads the tenant's brand from site_config (no hardcoded
// values) and lets a ?store=<slug> deep link override name + colours.
(function () {
  var THEMES = {
    crimson: ["#E11D2E", "#F26B7A"], ocean: ["#0EA5E9", "#38BDF8"],
    emerald: ["#10B981", "#34D399"], violet: ["#7C3AED", "#A78BFA"],
    amber: ["#F59E0B", "#FCD34D"], rose: ["#E11D48", "#FB7185"],
    slate: ["#475569", "#94A3B8"], midnight: ["#1E293B", "#334155"],
  };

  function applyTheme(theme) {
    var t = THEMES[theme] || THEMES.crimson;
    var root = document.documentElement.style;
    root.setProperty("--brand", t[0]);
    root.setProperty("--brand-2", t[1]);
    root.setProperty("--accent", t[0]);
    root.setProperty("--accent-dark", t[1]);
    root.setProperty("--indigo", t[0]);
    var card = document.querySelector(".auth-card");
    if (card) card.style.borderColor = t[0] + "55";
  }

  function applyName(name) {
    if (!name) return;
    var logo = document.querySelector(".auth-card .logo");
    if (logo) {
      var spans = logo.querySelectorAll("span");
      var label = spans[spans.length - 1];
      if (label) label.textContent = name;
    }
    var title = document.title.replace(/SMSPin/g, name);
    document.title = title;
    [".auth-card h1", ".auth-card .sub", ".auth-card .auth-foot"].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) el.innerHTML = el.innerHTML.replace(/SMSPin/g, name);
    });
  }

  function boot() {
    if (!window.SMSPIN) return;
    SMSPIN.rpc("site_config").then(function (cfg) {
      if (cfg && cfg.brand_name) applyName(cfg.brand_name);
    }).catch(function () {});

    var slug = new URLSearchParams(location.search).get("store");
    if (!slug) return;
    SMSPIN.rpc("business_public", { p_slug: slug }).then(function (b) {
      if (!b || !b.name) return;
      applyName(b.name);
      if (b.theme) applyTheme(b.theme);
    }).catch(function () {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
