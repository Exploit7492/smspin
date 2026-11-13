/* In-page KoraPay checkout.
 *
 * Opens KoraPay's own modal SDK (KorapayModal) on top of the current page so a
 * top-up never leaves the dashboard. The backend is asked for an "inline"
 * payment first: it reserves the reference and returns our public key, then the
 * SDK creates and settles the charge against that same reference. If the SDK or
 * its CDN is unavailable we fall back to the hosted redirect so payment still
 * works.
 */
(function (global) {
  "use strict";

  var SDK_URL = "https://korablobstorage.blob.core.windows.net/modal-bucket/korapay-collections.min.js";
  var sdkPromise = null;

  function loadSdk() {
    if (global.Korapay) return Promise.resolve(global.Korapay);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = SDK_URL;
      s.async = true;
      s.onload = function () { global.Korapay ? resolve(global.Korapay) : reject(new Error("KoraPay SDK unavailable")); };
      s.onerror = function () { reject(new Error("Could not load KoraPay checkout")); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  /* opts: { amount, channel, tenantToken, bearer, onSuccess, onClose, onError }
   * Returns a promise resolving to the KoraPay reference once settled. */
  function checkout(opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    if (opts.bearer) headers.Authorization = "Bearer " + opts.bearer;
    if (opts.tenantToken) headers["x-tenant-token"] = opts.tenantToken;
    var body = { amount: Math.round(opts.amount), channel: opts.channel, inline: true };
    if (opts.tenantToken) body.tenant_token = opts.tenantToken;

    return fetch("/api/payments/initialize", { method: "POST", headers: headers, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        var d = res.d || {};
        if (!res.ok) throw new Error(d.error || "Could not start payment");
        if (!d.inline) return redirectFallback(d, opts);   // server did not go inline
        return loadSdk().then(function (Korapay) {
          return new Promise(function (resolve, reject) {
            var settled = false;
            // The bundle ships as a ready object (window.Korapay.initialize); other
            // builds expose a constructor. Support both so a CDN swap can't break us.
            var modal = typeof Korapay === "function" ? new Korapay() : Korapay;
            modal.initialize({
              key: d.public_key,
              amount: d.amount,
              currency: "NGN",
              reference: d.reference,
              narration: d.narration || "SMSPin wallet top-up",
              customer: d.customer || {},
              notification_url: d.notification_url,
              onSuccess: function (data) {
                settled = true;
                if (opts.onSuccess) opts.onSuccess(data || {});
                resolve(d.reference);
              },
              onPending: function () { if (opts.onPending) opts.onPending(); },
              onClose: function () { if (!settled && opts.onClose) opts.onClose(); },
              onError: function (err) {
                if (!settled) reject(err instanceof Error ? err : new Error("Payment failed"));
                if (opts.onError) opts.onError(err);
              }
            }).catch(function (err) {
              if (!settled) reject(err instanceof Error ? err : new Error(String(err)));
            });
          });
        });
      });
  }

  function redirectFallback(d, opts) {
    if (d && d.checkout_url) { location.href = d.checkout_url; return new Promise(function () {}); }
    throw new Error("Could not start payment");
  }

  global.SMSPIN_PAY = { checkout: checkout, loadSdk: loadSdk };
})(window);
