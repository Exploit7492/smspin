#!/usr/bin/env node
// Production build for the SMSPin static site on Vercel.
//
// The site is a pre-rendered Next.js export (thousands of static pages) served
// as-is. This step injects the runtime configuration and the multi-tenant
// bootstrap that a static host cannot add per request, so no dummy or sandbox
// values ever ship:
//   * site/dashboard/config.js  -> the Supabase URL + public anon key the
//                                  browser talks to (all surfaces load it).
//   * tenant slug bootstrap + re-skin/consent scripts on public pages, so the
//     shared dashboard/admin code and tenant-brand.js know which store they
//     render (the Python backend stamped this per request; a static host cannot).
//   * the $2 minimum sell price, so the mirrored pages never quote the old
//     sub-$1 sample figures (ported from the backend's _apply_min_price_floor).
//   * site/robots.txt + sitemap.xml -> real SEO files (the old Python backend
//                                  generated these per request).
// It fails the build if required configuration is missing or if any sandbox
// URL survived into the tree.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SITE = "site";
const SUPA_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const ANON = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const SITE_URL = (process.env.SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) ||
  "https://smspin.vercel.app").replace(/\/$/, "");

function fail(msg) { console.error("build: " + msg); process.exit(1); }

if (!SUPA_URL) fail("SUPABASE_URL is not set — refusing to build with a dummy backend.");
if (!ANON) fail("SUPABASE_ANON_KEY is not set — refusing to build without an auth key.");

// 1. Runtime config for the browser.
writeFileSync(join(SITE, "dashboard", "config.js"),
  `window.SMSPIN_CONFIG = ${JSON.stringify({ url: SUPA_URL, anonKey: ANON, siteUrl: SITE_URL })};\n`);

// 2. Walk the tree once, collecting pages for the sitemap and checking for
//    sandbox URLs that must never reach production.
const pages = [];
const offenders = [];
const injected = [];
const BAD = [/:12000\b/, /work-1-[a-z0-9]+\.prod-runtime\.all-hands\.dev/, /work-2-[a-z0-9]+\.prod-runtime\.all-hands\.dev/, /onrender\.com/];
const SKIP = [/(^|\/)\.git\//, /node_modules/, /\.map$/];

// Tenant bootstrap. The Python backend used to stamp the store slug into every
// page it served (window.SMSPIN_TENANT_SLUG/BASE) so the shared dashboard/admin
// code and tenant-brand.js knew which store they were rendering. A static host
// cannot do that per request, so the bootstrap below derives the slug from the
// URL path (/store/<slug>/...) in the browser, before any app script runs, and
// from the host for a white-label custom domain (map baked in at build time).
//
// Faithful to the backend's split: the slug bootstrap goes on every page (it is
// a no-op off /store/<slug>/), while the re-skin script and consent log go only
// on the public marketing pages — the dashboard/admin re-brand themselves from
// site_config and must not have their links rewritten underneath them.
function tenantBoot(domains) {
  const map = Object.keys(domains).length ? JSON.stringify(domains) : "null";
  return `<script>(function(){try{var D=${map};var host=location.hostname.toLowerCase();var s=D&&D[host]?D[host]:null;var custom=!!s;if(!s){var m=location.pathname.match(/^\\/store\\/([^\\/?#.]+)(?:\\/|$)/);if(!m)return;s=decodeURIComponent(m[1]);if(s==="login"||s==="register"||s==="account"||s==="index")return;}if(!window.SMSPIN_TENANT_SLUG){window.SMSPIN_TENANT_SLUG=s;window.SMSPIN_TENANT_BASE=custom?"":"/store/"+s;}}catch(e){}})();</script>`;
}

// Active white-label domains, resolved to their store slug, so a visitor on a
// tenant's own domain is recognised without a server. Read at build time via the
// public RPC; a failure is non-fatal (falls back to /store/<slug> routing).
async function fetchTenantDomains() {
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/tenant_domains`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) return {};
    const j = await r.json();
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}

// Every active store's brand, keyed by slug. Baked into the page so the tenant
// re-skin (site/tenant-brand.js) resolves the name, palette and logo
// synchronously — with no RPC round-trip, the platform brand is never painted
// first. A failure is non-fatal (tenant-brand.js falls back to the RPC).
async function fetchTenantBrands() {
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/tenant_brands`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) return {};
    const j = await r.json();
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}
const BRANDS = await fetchTenantBrands();
const BOOT = tenantBoot(await fetchTenantDomains());
// Version the injected assets by commit so a new deploy never serves a stale
// cached copy (vercel.json caches .js for a week).
const BUILD = (process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now())).slice(0, 8);
const BRANDS_SRC = `<script>window.SMSPIN_TENANT_BRANDS=${JSON.stringify(BRANDS)};</script>`;
const BRAND_SRC = `<script src="/tenant-brand.js?v=${BUILD}" defer></script>`;
const CONSENT_SRC = `<script src="/consent-log.js?v=${BUILD}" defer></script>`;

// Runs at the end of <head> — the <title>/<meta> are parsed by then but the
// body has not, so the tenant's name and palette are in place before the first
// paint. The logo mark is hidden until site/tenant-brand.js has swapped it for
// the tenant's own (that script clears the data-tenant-brand flag). A timeout
// reveals it anyway if the re-skin never runs.
const BRAND_BOOT = `<script>(function(){try{
var s=window.SMSPIN_TENANT_SLUG;if(!s)return;
var b=(window.SMSPIN_TENANT_BRANDS||{})[s];if(!b||!b.name)return;
var r=document.documentElement;r.setAttribute("data-tenant-brand","");
if(b.primary)r.style.setProperty("--brand",b.primary);
if(b.secondary)r.style.setProperty("--brand-2",b.secondary);
if(document.title&&document.title.indexOf("SMSPin")!==-1)document.title=document.title.split("SMSPin").join(b.name);
var m=document.querySelectorAll('meta[content*="SMSPin"]');for(var i=0;i<m.length;i++){m[i].setAttribute("content",m[i].getAttribute("content").split("SMSPin").join(b.name));}
var st=document.createElement("style");st.id="tenant-boot-hide";st.textContent="html[data-tenant-brand] .logo{visibility:hidden}";document.head.appendChild(st);
setTimeout(function(){if(r.hasAttribute("data-tenant-brand"))r.removeAttribute("data-tenant-brand");},3000);
}catch(e){}})();</script>`;

// The mirrored marketing pages carry the old platform domain in their canonical
// link, OpenGraph tags and JSON-LD (@id/url/logo). Repoint every one of them at
// the deployed product URL so search engines and link previews resolve to the
// live host instead of a domain this build no longer serves.
//
// This must NOT touch the React Server Component flight payload (the
// `self.__next_f.push(...)` <script> blocks). React compares that serialized
// payload against the SSR markup during hydration; rewriting a URL inside it
// desyncs the two and React throws #423, blanking the page. Only the static
// application/ld+json blocks and the non-script markup are rewritten.
const OLD_DOMAIN = /https?:\/\/(?:www\.)?smspin\.io/g;
function retargetDomain(html) {
  if (SITE_URL.includes("smspin.io")) return html;
  const parts = html.split(/(<script\b[^>]*>[\s\S]*?<\/script>)/i);
  return parts
    .map((part, i) => {
      if (i % 2 === 0) return part.replace(OLD_DOMAIN, SITE_URL);
      return /application\/ld\+json/i.test(part) ? part.replace(OLD_DOMAIN, SITE_URL) : part;
    })
    .join("");
}

// Minimum sell price. The mirrored marketing pages baked in sub-$1 sample
// prices under the old $1 floor; every buyer-facing price is now a whole number
// of dollars floored at MIN_PRICE. Ported verbatim from the backend's
// _apply_min_price_floor so the static build and the Python server agree.
const MIN_PRICE = 2;
const PRICE_DEC = /\$(?:<!-- -->)?(\d+)\.(\d{2})(?!\d)/g;
const PRICE_RSC = /(\$\$[\\",]{0,6})(\d+\.\d{1,2})/g;
const PRICE_RSC_STR = /(\$["\\]{1,2}[\\, ]{0,6}[\\"]{0,2})(\d+\.\d{1,2})/g;
const PRICE_BARE = /(?<![$\w."'])\$1(?!\d)(?!,\d)(?![.]\d)/g;
const PRICE_JSON = /("(?:price|lowPrice|highPrice)":\s*"?)(\d+)\.(\d{1,2})/g;
const PRICE_FIELD = /((?:minPrice|maxPrice|lowPrice|highPrice|price)["\\:]{0,16})(\d+(?:\.\d{1,2})?)/g;

function floorNum(raw) {
  return parseFloat(raw) < MIN_PRICE ? `${MIN_PRICE}.00` : raw;
}
function applyMinPriceFloor(html) {
  html = html.replace(PRICE_DEC, (m, a, b) => (parseFloat(`${a}.${b}`) < MIN_PRICE ? `$${MIN_PRICE}.00` : m));
  html = html.replace(PRICE_RSC, (m, p, n) => p + floorNum(n));
  html = html.replace(PRICE_RSC_STR, (m, p, n) => p + floorNum(n));
  html = html.replace(PRICE_BARE, `$${MIN_PRICE}`);
  html = html.replace(PRICE_JSON, (m, p, a, b) => p + floorNum(`${a}.${b}`));
  html = html.replace(PRICE_FIELD, (m, p, n) => p + floorNum(n));
  // A range whose both ends floored to the minimum reads better as one figure.
  const f = `\\$${MIN_PRICE}(?:\\.00)?`;
  html = html.replace(new RegExp(`${f}\\s*[-\\u2013\\u2014]\\s*${f}`, "g"), `$${MIN_PRICE}.00`);
  return html;
}

// Dedicated storefront auth screens resolve the slug (and brand) themselves via
// /store/auth.js, so they get neither the bootstrap nor the re-skin script.
const SKIP_TENANT = new Set(["store/login.html", "store/register.html", "store/account.html", "store/index.html"]);

function injectTenantBootstrap(html, rel) {
  const isPrivate = rel.startsWith("dashboard/") || rel.startsWith("admin/");
  const isStoreAuth = SKIP_TENANT.has(rel);
  let out = retargetDomain(html);
  // The backend floored prices only on public marketing pages (dashboard/admin
  // get their figures from RPCs at runtime).
  if (!isPrivate && !isStoreAuth) {
    out = applyMinPriceFloor(out);
    const extra = (out.includes("/tenant-brand.js") ? "" : BRAND_SRC) +
                  (out.includes("/consent-log.js") ? "" : CONSENT_SRC);
    if (extra) {
      const i = out.search(/<\/head>/i);
      out = i !== -1 ? out.slice(0, i) + extra + out.slice(i)
                     : out.replace(/<\/body>/i, extra + "</body>");
    }
  }
  if (!isStoreAuth && !out.includes("SMSPIN_TENANT_BASE")) {
    const h = out.match(/<head[^>]*>/i);
    if (h) out = out.slice(0, h.index + h[0].length) + BOOT + out.slice(h.index + h[0].length);
  }
  // Public marketing pages (incl. the tenant storefront clone) get the baked
  // brand map and the pre-paint brand boot at the end of <head>.
  if (!isPrivate && !isStoreAuth) {
    const i = out.search(/<\/head>/i);
    if (i !== -1 && !out.includes("SMSPIN_TENANT_BRANDS")) {
      out = out.slice(0, i) + BRANDS_SRC + BRAND_BOOT + out.slice(i);
    }
  }
  return out === html ? null : out;
}
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.some((re) => re.test(p))) continue;
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    const rel = relative(SITE, p).replace(/\\/g, "/");
    if (name === "index.html") {
      const url = "/" + relative(SITE, dir).replace(/\\/g, "/");
      pages.push(url === "/." ? "/" : url.replace(/\/\.$/, "/"));
    }
    // Only scan text assets for leaked sandbox URLs.
    if (/\.(html|js|json|css)$/.test(name) && st.size < 4_000_000) {
      const text = readFileSync(p, "utf8");
      if (BAD.some((re) => re.test(text))) offenders.push(rel);
      if (name.endsWith(".html")) {
        const next = injectTenantBootstrap(text, rel);
        if (next !== null) { writeFileSync(p, next); injected.push(rel); }
      }
    }
  }
}
walk(SITE);

if (offenders.length) fail("sandbox URLs found in: " + offenders.slice(0, 20).join(", "));

// 3. SEO files.
writeFileSync(join(SITE, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /dashboard/\nDisallow: /admin/\nDisallow: /store/\nSitemap: ${SITE_URL}/sitemap.xml\n`);

const urls = pages.map((u) => `  <url><loc>${SITE_URL}${u}</loc></url>`).join("\n");
writeFileSync(join(SITE, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);

console.log(`build: wrote config.js, robots.txt, sitemap.xml (${pages.length} pages, ${injected.length} tenant-injected, ${offenders.length} sandbox refs).`);
