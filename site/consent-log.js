/* G3: mirror the visitor's cookie-consent choice to the backend as proof of
 * consent. The banner (Next.js chunk) writes the smspin_consent cookie
 * client-side; we poll briefly to catch the moment it appears, then log once. */
(function () {
  var KEY = "smspin_consent";
  var SENT = "smspin_consent_logged";
  var deadline = Date.now() + 60000;

  function readCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
    return m ? m[1] : null;
  }

  function parse() {
    var raw = readCookie(KEY);
    if (!raw) return null;
    var val = raw;
    if (val.indexOf("%") !== -1) {
      try { val = decodeURIComponent(val); } catch (e) {}
    }
    try {
      var c = JSON.parse(val);
      return c && c.v === 1 ? c : null;
    } catch (e) {
      return null;
    }
  }

  function send(c) {
    var stamp = String(c.ts || "");
    if (readCookie(SENT) === stamp) return true;
    var anon = null;
    try { anon = localStorage.getItem("smspin_anon"); } catch (e) {}
    fetch("/api/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        consent: { analytics: !!c.analytics, ads: !!c.ads, functional: true },
        anon_id: anon || "",
        policy: "v1",
      }),
      keepalive: true,
    }).then(function () {
      document.cookie = SENT + "=" + encodeURIComponent(stamp) + "; path=/; max-age=31536000; SameSite=Lax";
    }).catch(function () {});
    return true;
  }

  function tick() {
    var c = parse();
    if (c && send(c)) return;
    if (Date.now() < deadline) setTimeout(tick, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tick);
  } else {
    tick();
  }
})();
