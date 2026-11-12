// SMSPin UI kit — themed in-app modals (replaces native alert/confirm/prompt).
(function () {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const SVG = (paths, sw) =>
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="' +
    (sw || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";

  const ICONS = {
    info: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/>'),
    success: SVG('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.6L16 9.6"/>'),
    warn: SVG('<path d="M12 4.5 21 19.5H3Z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>'),
    danger: SVG('<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>'),
    key: SVG('<circle cx="8" cy="15.5" r="3.2"/><path d="M10.6 13.4 20 4M13.2 10.8l2 2"/>'),
    question: SVG('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.5-1.2 1-1.2 2"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>'),
    search: SVG('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>'),
    check: SVG('<path d="m5 12.5 4.5 4.5L19 7"/>'),
  };

  function base({ title, message, value, note, tone, actions, html }) {
    return new Promise(resolve => {
      const prevFocus = document.activeElement;
      const ov = document.createElement("div");
      ov.className = "mdl-overlay";
      const acts = actions && actions.length ? actions : [{ id: "ok", label: "OK", variant: "primary" }];
      const bodyHtml = html || (
        (message ? '<p class="mdl-msg">' + esc(message) + "</p>" : "") +
        (value != null
          ? '<div class="mdl-value"><code class="mono">' + esc(value) + "</code>" +
            '<button class="btn btn-ghost mdl-copy" type="button" data-copy="' + esc(value) + '">Copy</button></div>'
          : "") +
        (note ? '<p class="mdl-note">' + esc(note) + "</p>" : "")
      );
      ov.innerHTML =
        '<div class="mdl" role="dialog" aria-modal="true" aria-label="' + esc(title || "Dialog") + '">' +
          '<div class="mdl-head">' +
            '<span class="mdl-ico ' + esc(tone || "info") + '">' + (ICONS[tone] || ICONS.info) + "</span>" +
            "<h3>" + esc(title || "") + "</h3>" +
            '<button class="mdl-x" type="button" aria-label="Close">\u00d7</button>' +
          "</div>" +
          '<div class="mdl-body">' + bodyHtml + "</div>" +
          '<div class="mdl-foot">' + acts.map(a =>
            '<button class="btn ' + (a.variant === "primary" ? "btn-primary" : a.variant === "danger" ? "btn-danger" : "btn-secondary") + '" ' +
            'type="button" data-act="' + esc(a.id) + '">' + esc(a.label) + "</button>").join("") + "</div>" +
        "</div>";
      document.body.appendChild(ov);
      requestAnimationFrame(() => ov.classList.add("in"));

      const close = id => {
        ov.classList.remove("in");
        setTimeout(() => ov.remove(), 180);
        document.removeEventListener("keydown", onKey);
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(id);
      };
      const onKey = e => {
        if (e.key === "Escape") close(null);
        if (e.key === "Enter" && acts.some(a => a.id === "ok")) close("ok");
      };
      document.addEventListener("keydown", onKey);
      ov.addEventListener("click", e => { if (e.target === ov) close(null); });
      ov.querySelector(".mdl-x").addEventListener("click", () => close(null));
      ov.querySelectorAll("[data-act]").forEach(b =>
        b.addEventListener("click", () => close(b.dataset.act)));
      ov.querySelectorAll("[data-copy]").forEach(b =>
        b.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; }
          catch (e) { b.textContent = "Copy failed"; }
          setTimeout(() => (b.textContent = "Copy"), 1600);
        }));
      const first = ov.querySelector(".mdl-foot .btn-primary") || ov.querySelector("[data-act]");
      if (first) first.focus();
    });
  }

  const alert = opts => base(typeof opts === "string" ? { message: opts } : opts);

  // Non-blocking toast for background events (e.g. an SMS code arriving while
  // the user is elsewhere). Never covers the page — it auto-dismisses and can
  // be swiped/clicked away. Use alert() only for things that need a decision.
  function toast({ title, message, tone, icon, timeout }) {
    let host = document.getElementById("uiToastHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "uiToastHost";
      host.className = "ui-toast-host";
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = "ui-toast" + (tone ? " " + tone : "");
    el.setAttribute("role", "status");
    el.innerHTML =
      '<span class="ui-toast-ico">' + (ICONS[tone] || ICONS.info) + "</span>" +
      '<div class="ui-toast-tx">' +
        (title ? "<b>" + esc(title) + "</b>" : "") +
        (message ? '<span>' + esc(message) + "</span>" : "") +
      "</div>" +
      (icon ? '<span class="ui-toast-x" role="button" aria-label="Dismiss">\u00d7</span>' : "");
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("in"));
    const remove = () => { el.classList.remove("in"); setTimeout(() => el.remove(), 200); };
    el.addEventListener("click", remove);
    setTimeout(remove, timeout || 6000);
    return el;
  }
  const confirm = opts => base(Object.assign({ tone: "question",
    actions: [{ id: "cancel", label: "Cancel", variant: "ghost" }, { id: "ok", label: "Confirm", variant: "primary" }] },
    typeof opts === "string" ? { message: opts } : opts));
  const reveal = opts => base(Object.assign({ tone: "key",
    actions: [{ id: "ok", label: "Done", variant: "primary" }] },
    typeof opts === "string" ? { value: opts } : opts));

  // Searchable select — a reusable picker for any dropdown (country, service, ...).
  // items: [{ value, label, sub?, icon?, iconType?, meta? }]
  function select({ title, items, value, placeholder, searchPlaceholder, tone }) {
    return new Promise(resolve => {
      const prevFocus = document.activeElement;
      let list = (items || []).slice();
      let chosen = value != null ? value : null;

      const iconHtml = it => {
        if (!it.icon) return '<span class="pik-ico pik-ico-txt">' + esc((it.label || "?").charAt(0)) + "</span>";
        if (it.iconType === "img" || /^(https?:|data:|\/)/.test(it.icon))
          return '<span class="pik-ico"><img src="' + esc(it.icon) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'"></span>';
        return '<span class="pik-ico">' + esc(it.icon) + "</span>";
      };

      const ov = document.createElement("div");
      ov.className = "mdl-overlay";
      ov.innerHTML =
        '<div class="mdl mdl-picker" role="dialog" aria-modal="true" aria-label="' + esc(title || "Select") + '">' +
          '<div class="mdl-head">' +
            '<span class="mdl-ico ' + esc(tone || "info") + '">' + ICONS.search + "</span>" +
            "<h3>" + esc(title || "Select") + "</h3>" +
            '<button class="mdl-x" type="button" aria-label="Close">\u00d7</button>' +
          "</div>" +
          '<div class="mdl-body">' +
            '<div class="pik-search"><span class="pik-search-ico">' + ICONS.search + "</span>" +
              '<input type="search" class="pik-input" autocomplete="off" placeholder="' +
              esc(searchPlaceholder || "Search\u2026") + '"></div>' +
            '<div class="pik-list" role="listbox"></div>' +
          "</div>" +
          '<div class="mdl-foot"><button class="btn btn-secondary" type="button" data-act="cancel">Close</button></div>' +
        "</div>";
      document.body.appendChild(ov);
      requestAnimationFrame(() => ov.classList.add("in"));

      const listEl = ov.querySelector(".pik-list");
      const input = ov.querySelector(".pik-input");

      function draw() {
        const q = input.value.trim().toLowerCase();
        const shown = q ? list.filter(it =>
          (it.label || "").toLowerCase().includes(q) ||
          (it.sub || "").toLowerCase().includes(q) ||
          (it.value || "").toLowerCase().includes(q)) : list;
        if (!shown.length) { listEl.innerHTML = '<p class="pik-empty">No matches for \u201c' + esc(input.value) + '\u201d</p>'; return; }
        listEl.innerHTML = shown.map(it =>
          '<button class="pik-row' + (it.value === chosen ? " is-on" : "") + '" type="button" role="option" data-val="' + esc(it.value) + '">' +
            iconHtml(it) +
            '<span class="pik-txt"><b>' + esc(it.label) + "</b>" + (it.sub ? "<span>" + esc(it.sub) + "</span>" : "") + "</span>" +
            (it.meta ? '<span class="pik-meta">' + esc(it.meta) + "</span>" : "") +
            (it.value === chosen ? '<span class="pik-check">' + ICONS.check + "</span>" : "") +
          "</button>").join("");
        listEl.querySelectorAll("[data-val]").forEach(b =>
          b.addEventListener("click", () => { chosen = b.dataset.val; close(chosen); }));
      }

      const close = val => {
        ov.classList.remove("in");
        setTimeout(() => ov.remove(), 180);
        document.removeEventListener("keydown", onKey);
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(val);
      };
      const onKey = e => { if (e.key === "Escape") close(null); };
      document.addEventListener("keydown", onKey);
      input.addEventListener("input", draw);
      ov.addEventListener("click", e => { if (e.target === ov) close(null); });
      ov.querySelector(".mdl-x").addEventListener("click", () => close(null));
      ov.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null));

      draw();
      input.focus();
    });
  }

  window.SMSPINUI = { modal: base, alert, confirm, reveal, select, toast };
})();
