// Tenant branding for white-label stores.
//
// A store is a verbatim clone of the platform site: the SAME HTML/CSS/JS is
// served for /store/<slug>/*, and this script re-skins it in the browser from
// the tenant's own brand row. The build bakes every active store's brand into
// window.SMSPIN_TENANT_BRANDS (see scripts/vercel-build.mjs) and resolves the
// slug + palette synchronously in <head>, so the first paint is already the
// tenant's — there is no round-trip that would flash the platform brand first.
// The RPC path below is only a fallback for a slug the bake did not know about.
//
// The marketing page is a hydrated Next.js app: React reconciles the server DOM
// after load and re-asserts its own brand tokens and hrefs. So the re-skin runs
// on a short interval for the first few seconds (and on every history push),
// and clicks on platform routes are intercepted so the visitor can never be
// bounced out of the storefront.
//
// Nothing here touches the React Server Component flight payload (the
// self.__next_f.push() <script> text). Rewriting that text desyncs hydration and
// React blanks the page (error #423). Only visible text, head metadata and the
// static application/ld+json blocks are rewritten.
(function () {
  var THEMES = {
    crimson: ["#E11D2E", "#F26B7A"], ocean: ["#0EA5E9", "#38BDF8"],
    emerald: ["#10B981", "#34D399"], violet: ["#7C3AED", "#A78BFA"],
    amber: ["#F59E0B", "#FCD34D"], rose: ["#E11D48", "#FB7185"],
    slate: ["#475569", "#94A3B8"], midnight: ["#1E293B", "#334155"],
  };
  var DEFAULT_NAME = "SMSPin";
  var PLATFORM_RED = "#e11d2e";
  // Any absolute reference to the platform host, in either the old domain or
  // the current product host, that must never appear on a tenant's page.
  var HOST_RE = /https?:\/\/(?:www\.)?smspin\.(?:io|vercel\.app)/g;

  function slug() {
    if (window.SMSPIN_TENANT_SLUG) return window.SMSPIN_TENANT_SLUG;
    var m = location.pathname.match(/^\/store\/([^\/]+)/);
    if (m) return decodeURIComponent(m[1]);
    // Root form: /<slug>/... — only when the build baked that slug as a store,
    // so a real route (/about, /price) is never read as a tenant.
    var p = location.pathname.split("/").filter(Boolean);
    var known = window.SMSPIN_TENANT_BRANDS || {};
    if (p.length && p[0] && p[0].indexOf(".") === -1 && known[p[0]]) return decodeURIComponent(p[0]);
    return "";
  }
  function base() {
    if (window.SMSPIN_TENANT_BASE) return window.SMSPIN_TENANT_BASE.replace(/\/$/, "");
    var s = slug();
    return s ? "/" + s : "";
  }
  function rpc(fn, args) {
    return fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fn: fn, args: args || {} }),
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function hexToRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || "").trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) { var c = hexToRgb(hex); return c ? "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")" : null; }
  function mix(hex, pct, baseRgb) {
    var c = hexToRgb(hex); if (!c) return null;
    var b = baseRgb || [255, 255, 255];
    return "rgb(" + c.map(function (v, i) { return Math.round(v + (b[i] - v) * pct); }).join(",") + ")";
  }

  // The mirrored Next.js CSS hardcodes the platform's red in ~50 places (both
  // hex and rgba). Re-skin the stylesheet text itself so a store adopts its own
  // palette everywhere, not just where the theme exposes a variable.
  var PLATFORM_RED_HEX = ["#f43f4e", "#e11d2e", "#dc2626", "#ff3b5c"];
  var PLATFORM_RED_RGB = [[244, 63, 78], [225, 29, 46], [255, 59, 92]];
  var PLATFORM_SEC_HEX = ["#ff7089", "#f26b7a"];
  var PLATFORM_SEC_RGB = [255, 112, 137];
  function reskinCss(css, primary, secondary) {
    var pri = hexToRgb(primary), sec = hexToRgb(secondary);
    if (!pri || !sec) return css;
    function swap(list, to) {
      list.forEach(function (h) { css = css.split(h).join(to).split(h.toUpperCase()).join(to); });
    }
    swap(PLATFORM_RED_HEX, primary);
    swap(PLATFORM_SEC_HEX, secondary);
    var deep = mix(primary, .35, [0, 0, 0]);
    css = css.split("#b81d33").join(deep).split("#B81D33").join(deep);
    function rgbRe(tri) { return new RegExp("rgba?\\(\\s*" + tri[0] + "\\s*,\\s*" + tri[1] + "\\s*,\\s*" + tri[2] + "\\s*,", "g"); }
    PLATFORM_RED_RGB.forEach(function (t) { css = css.replace(rgbRe(t), "rgba(" + pri.join(",") + ","); });
    css = css.replace(rgbRe(PLATFORM_SEC_RGB), "rgba(" + sec.join(",") + ",");
    return css;
  }
  function applyCssReskin() {
    if (!PAL) return;
    if (applyCssReskin._key === PAL.primary + PAL.secondary) return;
    applyCssReskin._key = PAL.primary + PAL.secondary;
    var links = Array.prototype.slice.call(document.querySelectorAll('link[rel="stylesheet"]'));
    var pending = links.length;
    var acc = "";
    if (!pending) return;
    links.forEach(function (l) {
      fetch(l.href).then(function (r) { return r.ok ? r.text() : ""; })
        .then(function (t) {
          acc += reskinCss(t, PAL.primary, PAL.secondary);
        }).catch(function () {}).then(function () {
          if (--pending === 0) {
            var st = document.getElementById("tenant-css");
            if (!st) { st = document.createElement("style"); st.id = "tenant-css"; }
            st.textContent = acc;
            document.head.appendChild(st);   // append last so it wins the cascade
          }
        });
    });
  }

  var PAL = null;   // { primary, secondary }
  var NAME = null;
  var LOGO = null;
  var DOMAIN = null;

  function applyPalette() {
    if (!PAL) return;
    var primary = PAL.primary, secondary = PAL.secondary;
    var root = document.documentElement;
    root.style.setProperty("--brand", primary);
    root.style.setProperty("--brand-2", secondary);
    root.style.setProperty("--accent", primary);
    root.style.setProperty("--accent-dark", secondary);
    root.style.setProperty("--indigo", primary);
    // The mirrored marketing CSS hardcodes the platform palette in scoped
    // selectors (theme.css repaints `.home` sky-blue in light mode; the Next
    // chunk sets the ruby `--red`), so a stylesheet override of equal
    // specificity is a coin toss. Inline custom properties on `.home` win the
    // cascade outright, and the background needs `!important` to beat the
    // `!important` already on `.home`.
    var vars = {
      "--red": primary,
      "--red-deep": secondary,
      "--red-darkest": mix(primary, .35, [0, 0, 0]) || primary,
      "--red-soft": rgba(primary, .10) || "transparent",
      "--red-tint": rgba(primary, .14) || "transparent",
      "--red-line": rgba(primary, .20) || "transparent",
    };
    var bg =
      "radial-gradient(900px 600px at 85% -10%," + (rgba(primary, .16) || "transparent") + ",transparent 60%)," +
      "radial-gradient(700px 500px at -10% 40%," + (rgba(secondary, .12) || "transparent") + ",transparent 60%)," +
      "radial-gradient(1000px 700px at 50% 110%," + (rgba(primary, .12) || "transparent") + ",transparent 60%),var(--page-bg)";
    document.querySelectorAll(".home").forEach(function (el) {
      Object.keys(vars).forEach(function (k) { el.style.setProperty(k, vars[k]); });
      el.style.setProperty("background", bg, "important");
      el.style.setProperty("background-attachment", "fixed", "important");
    });
    // The nav wordmark SVG hardcodes the platform red inline; repaint its
    // mark background and any inline fill so the logo adopts the store colour.
    document.querySelectorAll(".logo [aria-hidden='true']").forEach(function (mark) {
      if (!mark.querySelector("img")) mark.style.background = primary;
    });
    document.querySelectorAll("[fill]").forEach(function (el) {
      var f = String(el.getAttribute("fill") || "").toLowerCase();
      if (f === PLATFORM_RED) el.setAttribute("fill", primary);
    });
  }

  function applyLogo() {
    if (!LOGO) return;
    document.querySelectorAll(".logo [aria-hidden='true']").forEach(function (mark) {
      if (mark.querySelector("img")) return;
      // Inline `!important` so the coloured mark is cleared even though the
      // build-time guard sets the background with `!important`.
      mark.style.setProperty("background", "transparent", "important");
      mark.style.setProperty("box-shadow", "none", "important");
      mark.innerHTML = '<img src="' + LOGO + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">';
    });
  }

  function applyWordmark() {
    if (!NAME || NAME === DEFAULT_NAME) return;
    document.querySelectorAll(".logo").forEach(function (logo) {
      var word = logo.querySelector(":scope > span:last-child");
      if (word && word.textContent !== NAME) word.textContent = NAME;
    });
  }

  // Rewrite the platform name and host out of every visible text node. Scripts
  // are skipped: mutating the flight payload would break hydration (error #423).
  var TEXT_HOST_RE = /https?:\/\/(?:www\.)?smspin\.(?:io|vercel\.app)/g;
  function renameText() {
    if (!NAME || NAME === DEFAULT_NAME) return;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (p && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        var v = n.nodeValue;
        if (!v) return NodeFilter.FILTER_REJECT;
        return (v.indexOf(DEFAULT_NAME) !== -1 || TEXT_HOST_RE.test(v)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (t) {
      t.nodeValue = t.nodeValue
        .replace(/SMSPin\.io/g, NAME)
        .replace(new RegExp(DEFAULT_NAME, "g"), NAME)
        .replace(TEXT_HOST_RE, DOMAIN ? "https://" + DOMAIN : "");
    });
    if (document.title.indexOf(DEFAULT_NAME) !== -1) document.title = document.title.split(DEFAULT_NAME).join(NAME);
    document.querySelectorAll('meta[content*="' + DEFAULT_NAME + '"]').forEach(function (m) {
      m.setAttribute("content", m.getAttribute("content").split(DEFAULT_NAME).join(NAME));
    });
    document.querySelectorAll('[aria-label*="' + DEFAULT_NAME + '"]').forEach(function (el) {
      el.setAttribute("aria-label", el.getAttribute("aria-label").split(DEFAULT_NAME).join(NAME));
    });
  }

  // Strip every reference to the platform host so a tenant page never exposes
  // the host it is cloned from. A tenant with its own domain keeps absolute URLs
  // (repointed at that domain); one without gets relative URLs. Head metadata
  // and the static application/ld+json blocks are handled here too; the flight
  // payload is deliberately left alone.
  function hostless(v) {
    if (!v) return v;
    return v.replace(HOST_RE, DOMAIN ? "https://" + DOMAIN : "");
  }
  function scrubHost() {
    if (DOMAIN) {
      document.querySelectorAll('link[rel="canonical"]').forEach(function (l) {
        var h = l.getAttribute("href");
        if (h && HOST_RE.test(h)) { HOST_RE.lastIndex = 0; l.setAttribute("href", "https://" + DOMAIN + h.replace(HOST_RE, "")); }
      });
    }
    document.querySelectorAll("meta[content]").forEach(function (m) {
      var c = m.getAttribute("content");
      if (c && (HOST_RE.test(c) || c.indexOf("smspin.io") !== -1)) {
        HOST_RE.lastIndex = 0;
        m.setAttribute("content", hostless(c).replace(/smspin\.io/g, DOMAIN || ""));
      }
    });
    document.querySelectorAll('link[href]').forEach(function (l) {
      var h = l.getAttribute("href");
      if (h && HOST_RE.test(h)) { HOST_RE.lastIndex = 0; l.setAttribute("href", hostless(h)); }
    });
    // Static JSON-LD (not the flight payload) carries absolute host URLs too.
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      var t = s.textContent;
      if (t && /smspin\.(io|vercel\.app)|SMSPin/.test(t)) {
        s.textContent = hostless(t).replace(/smspin\.io/g, DOMAIN || "").replace(/SMSPin/g, NAME || DEFAULT_NAME);
      }
    });
  }

  var ASSET_RE = /\.(css|js|png|jpe?g|svg|ico|webp|woff2?|ttf|json|txt|xml|map|webmanifest)$/i;
  function rewriteLinks() {
    if (!base()) return;
    document.querySelectorAll("a[href]").forEach(function (a) {
      var h = a.getAttribute("href");
      var mapped = storeHref(h);
      if (mapped && mapped !== h) a.setAttribute("href", mapped);
    });
  }

  // React <Link> hijacks clicks using its own href prop, which still points at
  // the platform route. Intercepting at the document (capture) guarantees the
  // visitor stays inside the storefront no matter what React re-asserts.
  function storeHref(h) {
    var b = base();
    if (!b || !h || h.charAt(0) !== "/" || h.charAt(1) === "/") return null;
    var frag = "";
    if (h.indexOf("#") !== -1) {
      var i = h.indexOf("#");
      frag = h.slice(i); h = h.slice(0, i);
      if (!h) return null;
    }
    if (h.indexOf(b + "/") === 0 || h === b) return h + frag;       // already in-store
    if (h.indexOf("/store/") === 0 || h.indexOf("/_next/") === 0 || h.indexOf("/api/") === 0) return null;
    if (ASSET_RE.test(h)) return null;                              // shared asset
    if (h === "/login" || h === "/login/") return b + "/login/" + frag;
    if (h === "/register" || h === "/register/") return b + "/register/" + frag;
    if (h === "/") return b + "/" + frag;
    return b + (h.charAt(h.length - 1) === "/" ? h : h + "/") + frag;
  }
  function guardLinks() {
    if (!base()) return;
    document.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      var target = storeHref(a.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      location.assign(target);
    }, true);
  }

  function apply() {
    applyPalette(); applyLogo(); applyWordmark(); renameText(); scrubHost(); rewriteLinks(); applyCssReskin();
    // The head bootstrap hides the platform logo until the re-skin has run;
    // reveal it now that the tenant's own mark and wordmark are in place.
    if (NAME && document.documentElement.hasAttribute("data-tenant-brand")) {
      document.documentElement.removeAttribute("data-tenant-brand");
    }
  }

  function boot() {
    var s = slug();
    if (!s) return;
    // Preferred path: brand baked into the page by the build — synchronous, so
    // there is no window in which the platform brand is visible.
    var baked = (window.SMSPIN_TENANT_BRANDS || {})[s];
    if (baked && baked.name) {
      NAME = baked.name;
      DOMAIN = baked.domain || null;
      var theme = THEMES[baked.theme] || THEMES.crimson;
      PAL = { primary: baked.primary || theme[0], secondary: baked.secondary || theme[1] };
      LOGO = baked.logo || null;
      apply();
      return;
    }
    // Fallback: a slug the bake did not know about (store created after build).
    rpc("business_public", { p_slug: s }).then(function (pub) {
      if (!pub || !pub.name) return;
      NAME = pub.name;
      var theme = THEMES[pub.theme] || THEMES.crimson;
      rpc("business_branding", { p_slug: s }).then(function (b) {
        b = b || {};
        DOMAIN = b.domain || null;
        PAL = { primary: b.primary_color || theme[0], secondary: b.secondary_color || theme[1] };
        LOGO = b.logo_url || null;
        apply();
      });
    });
  }

  // Re-apply through hydration: timed passes plus a short interval that stops
  // once the page has settled, so React's re-render cannot win.
  function bootAndSettle() {
    boot();
    [150, 400, 900, 1600, 2600, 4000].forEach(function (t) { setTimeout(apply, t); });
    var n = 0, iv = setInterval(function () { apply(); if (++n > 20) clearInterval(iv); }, 500);
  }

  // React replaces the nav (and its logo/wordmark) when hydration finishes. The
  // interval above can be up to 500ms late, which is long enough to paint a frame
  // of the platform brand, so re-apply the moment the DOM changes. Debounced to
  // one pass per frame so a large re-render does not thrash.
  function watchDom() {
    if (!window.MutationObserver || !document.body) return;
    var queued = false;
    var obs = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; apply(); });
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { bootAndSettle(); guardLinks(); watchDom(); });
  else { bootAndSettle(); guardLinks(); watchDom(); }
  window.addEventListener("load", bootAndSettle);
  ["pushState", "replaceState"].forEach(function (k) {
    var orig = history[k];
    if (!orig) return;
    history[k] = function () { var r = orig.apply(this, arguments); setTimeout(apply, 0); return r; };
  });

  window.SMSPIN_TENANT_BRAND = { apply: apply, slug: slug, storeHref: storeHref };
})();
