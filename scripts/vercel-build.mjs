#!/usr/bin/env node
// Production build for the SMSPin static site on Vercel.
//
// The site is a pre-rendered Next.js export (thousands of static pages) served
// as-is. This step only injects runtime configuration that must come from the
// deployment environment, so no dummy or sandbox values ever ship:
//   * site/dashboard/config.js  -> the Supabase URL + public anon key the
//                                  browser talks to (all surfaces load it).
//   * site/robots.txt + sitemap.xml -> real SEO files (the old Python backend
//                                  generated these per request).
// It fails the build if required configuration is missing or if any sandbox
// URL survived into the tree.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SITE = "site";
const SUPA_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const ANON = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const SITE_URL = (process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` || "https://smspin.io").replace(/\/$/, "");

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
const BAD = [/:12000\b/, /work-1-[a-z0-9]+\.prod-runtime\.all-hands\.dev/, /work-2-[a-z0-9]+\.prod-runtime\.all-hands\.dev/, /onrender\.com/];
const SKIP = [/(^|\/)\.git\//, /node_modules/, /\.map$/];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.some((re) => re.test(p))) continue;
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (name === "index.html") {
      const url = "/" + relative(SITE, dir).replace(/\\/g, "/");
      pages.push(url === "/." ? "/" : url.replace(/\/\.$/, "/"));
    }
    // Only scan text assets for leaked sandbox URLs.
    if (/\.(html|js|json|css)$/.test(name) && st.size < 4_000_000) {
      const text = readFileSync(p, "utf8");
      if (BAD.some((re) => re.test(text))) offenders.push(relative(SITE, p));
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

console.log(`build: wrote config.js, robots.txt, sitemap.xml (${pages.length} pages, ${offenders.length} sandbox refs).`);
