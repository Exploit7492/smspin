// SMSPin theme controller.
// The theme follows the device preference (light/dark). The inline head snippet
// applies it before paint; this file keeps it in sync when the device changes.
(function () {
  var root = document.documentElement;

  function deviceDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function resolve() { return deviceDark() ? "dark" : "light"; }
  function apply(mode) {
    root.setAttribute("data-theme", mode);
    root.style.colorScheme = mode;
    // Keep the pre-CSS background (set inline in the head) in step with the
    // resolved theme so there is never a light flash before theme.css loads.
    root.style.backgroundColor = mode === "dark" ? "#0a0709" : "#eef1f8";
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", mode === "dark" ? "#080a11" : "#eef1f8");
  }

  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () { apply(resolve()); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  apply(resolve());

  window.SMSPIN_THEME = { get: resolve, set: function () { apply(resolve()); } };
})();
