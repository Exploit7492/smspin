# AGENTS.md — SMSPin mirror + backend

## What this is
A full local mirror of https://smspin.io served by a custom Python backend, plus a
Supabase-backed app (auth, dashboard, wallet, API gateway, white-label "Business").

## Layout
- `backend/server.py` — single-file HTTP server. Serves `site/` statically and exposes
  `/api/*`. Runs with `KORA_MODE=test PORT=12000`.
- `site/` — static mirror. Pages are normalized to `dir/index.html` form.
  - `site/dashboard/*/` — logged-in screens (auth guard via `dashboard/api.js`).
  - `site/dashboard/api.js` — Supabase auth + RPC client. Session in `localStorage.smspin_session`.
  - `site/store/index.html` — white-label tenant storefront (served for `/store/<slug>`).
- `site/dashboard/business/` — the Business wizard page.

## Running
```
cd /workspace/project/backend
KORA_MODE=test PORT=12000 nohup python3 server.py > /tmp/backend.log 2>&1 &
```
Public URL: https://work-1-wfaewerfovqrkyxa.prod-runtime.all-hands.dev/ (port 12000).

## Backend secrets (env)
`Smspin_supabase_Postgresql` (direct PG), `Smspin_Supabase_url`, `Smspin_supabase_annonkey`
(anon REST), `Smspin_apikey` (upstream smspin API). KoraPay keys are separate.

## Supabase model
- Tables: `profiles`, `wallets`, `number_catalog`, `prices`, `orders`, `transactions`,
  `api_keys`, `businesses`, `services`, `countries`.
- All webapp data access goes through RPC (not direct table reads) so RLS stays locked.
- Auth: email confirmation disabled; signup trigger creates profile + wallet.

## Pricing
- `prices` holds the raw upstream catalog (`price_ngn`), fetched by `/tmp/fetch_catalog.py`.
- `number_catalog` is the live, marked-up table the app reads (upsert from `prices`).
- Business markup is per-tenant (`businesses.markup_percent`, default 30).

## Theming (light / dark glass)
- `site/theme.css` + `site/theme.js`, injected into every page's `<head>` by a one-off
  script (inline no-flash snippet → `theme.css` → `theme.js`).
- Precedence: saved `localStorage.smspin_theme` → device `prefers-color-scheme` → light.
  The toggle (`.theme-toggle`) mounts into `[data-theme-toggle]` if present, else
  `.st-top-inner`, else fixed top-right. `window.SMSPIN_THEME.set("dark"|"light")`.
- Light = crystal glass; dark = polished dark with ruby glass (`--accent:#ff3b5c`).
- theme.css remaps the site's own tokens (`--white/--surface/--border/--text-*`) so
  existing components inherit the theme. It also overrides the `.home` scoped palette
  (marketing + public `buy/` pages) in both modes.
- Buttons use a glass palette (`.btn` + `.btn-primary` tinted ruby glass, `.btn-ghost`/`.btn-secondary` frosted crystal).
- Dashboard stat cards (`.cards > .card`) are **squares** (`aspect-ratio:1/1`, capped at
  `max-width:172px`) in a compact auto-fit grid (`minmax(150px,1fr)`, `justify-content:start`),
  so they stay small and evenly spaced on wide screens. SMS cards (`.sms-grid > .sms-card`)
  are small squares in a 3x3 grid. Both keep 3 columns down to 520px.
- Each card's title (`.card .k`) is an absolutely-positioned, glassy pill centred on the
  card's TOP border (the border passes behind it), bold and uppercase.
- Card values (`.card .v`) are **fit to the box** by `fitStatValues()` in `dash.js`: it
  measures the value at 100px and scales it down to the widest that fits the card's inner
  width (clamped 13–46px), so short numbers read big while long currency strings never
  clip. Re-run on resize. A CSS `font-size:min(40px,15cqw)` acts as the pre-JS fallback
  (the card is a `container-type:inline-size` container).
- To re-inject after adding pages: add the same 3 tags before `</head>`.

## Tenant storefront (white-label)
- `site/store/index.html` is a full landing page (hero, catalog with search + service
  chips, how-it-works, features, pricing, coverage, FAQ, CTA, footer). It is served for
  any `/store/<slug>` and reads the slug from the path.
- Data comes from RPCs `business_public(p_slug)` (brand, theme, marked-up catalog) and
  `business_stats(p_slug)` (service/country/order counts). Theme + name drive the
  page's `--brand` colours and copy.
- Auth pages (`/login`, `/register`) read `?store=<slug>`, brand themselves with the
  store's name + colours, and `dashboard/api.js` remembers the slug in
  `localStorage.smspin_store`.
- Purchases made while that slug is remembered go through `buy_number_store(slug,country,service)`:
  it charges the store price (base + `markup_percent`), tags `orders.business_id`, and
  credits the owner's wallet with the markup (logged in `business_earnings`).
- `dashboard/buy` shows the store's marked-up prices when a store is remembered.
- The Business page has a "Store performance" panel (`my_business_stats`): store orders,
  markup earned, markup %, and recent storefront orders.

## API keys
- ONE active key per user. `create_api_key` raises `P0003` if one exists.
- `regenerate_api_key` revokes the active key and mints a fresh one atomically.
- The API Keys page shows the current key + revoke + regenerate, plus history.

## Base URL
- Never hardcode `smspin.io` in the app. Use `location.origin` (referrals, API base URL,
  curl examples). The gateway is served at `<origin>/api/v1/*`.

## Dashboard shell (glass side panel)
- There is NO top header on dashboard pages. Navigation, wallet balance, account,
  theme toggle and Sign out all live in the fixed glass `.dash-side` panel.
- The panel is docked on the RIGHT (`right:0`, left border + leftward shadow) and holds
  the SMSPin logo + icon at its top. `.dash-shell` clears it with right padding (300px);
  under 900px the panel slides in from the right via the top-right `.dash-toggle`.
- Every dashboard page carries the same `<aside class="dash-side" id="dashSide">` block,
  plus `.dash-toggle` (hamburger) and `.dash-scrim` for mobile. `dash.js` wires the
  toggle, fills `#sideBalance`, and hydrates the account name/email.
- Side panel sections: Menu / Billing (Wallet, Transaction history) / Grow / Account,
  then an Active-numbers list (`#sideNums`, `fillSideNumbers()`) and a Recent-orders
  list (`#sideOrders`, `fillSideOrders()`), then the account footer. The overview page
  no longer has its own "Active numbers" or "Recent orders" panels.
- The panel is translucent glass (`--glass-bg-soft` + `backdrop-filter: blur(26px)
  saturate(180%)`) so the ambient page gradient shows through; it must stay see-through.
- `.dash-shell` uses right padding (300px) to clear the fixed panel; under 900px the
  panel slides in from the right and `.dash-shell` keeps >=64px top padding so the fixed
  `.dash-toggle` (top-right) never covers the page heading.
- The overview greeting (`#ovWelcome`) reads "Welcome back, <name>" from the signed-in
  user's email local-part (first segment, split on `. _ - +`, capitalised).

## Conventions / gotchas
- Dashboard pages must include `<meta name="viewport">` and rely on `dashboard/dashboard.css`
  breakpoints (900px, 520px). New pages need their own small-screen rules.
- When adding a dashboard page, copy the full `.dash-side` block from an existing page
  (add/rename entries as needed) and mark the current link `class="active"`.
- API gateway: user API keys map to the owning user's wallet; tenant keys add markup.
- `create_api_key` is capped at 5 active keys per user — revoke before creating more.
- Test user: `demo@smspin.local`.

## Local demo logins (seeded, for cross-checking)
- User dashboard: `demo@smspin.local` / `SmspinDemo123!` (also an admin — the ops
  console at `/admin/` unlocks). Seeded by `scripts/seed-demo-user.py`.
- White-label store: `/store/zenith-verify/login` — `demo@smspin.local` /
  `StoreDemo123!` (tenant slug `zenith-verify`, business #2). Seeded by
  `scripts/seed-demo-tenant.py`.
- Both scripts are idempotent and connect with `Smspin_supabase_Postgresql`.

## Phase 6 — findable & fast (G1, G2, G3, G6)
- **G1 SEO**: `build_robots()` / `build_sitemap()` in `backend/server.py` generate
  `/robots.txt` and `/sitemap.xml` from the mirrored tree over `SITE_URL`
  (`SMSPIN_SITE_URL`, default `https://smspin.io`). Private prefixes are disallowed.
- **G2 structured data**: `build_review_jsonld(path)` builds a `Product` +
  `AggregateRating` + `Review` JSON-LD node from the live `public_reviews()` RPC and
  injects it into review-eligible pages (`_REVIEW_PAGES`). Cached 10 min via
  `_reviews_cache()`; injected HTML cached in `_LD_CACHE`.
- **G3 caching + consent**: `_serve_static_file()` sets `ETag`/`Last-Modified` and
  `Cache-Control` (immutable for `/_next/static/`, `must-revalidate` for HTML) and
  answers `304` on `If-None-Match`. Every public page gets
  `<script src="/consent-log.js" defer>`, which mirrors the `smspin_consent` cookie to
  `POST /api/consent` (stored in `consent_log`).
- **G6 trust**: `/reviews` (static page + live `/api/reviews` feed, `POST` to submit
  pending reviews) and `/status` uptime bars (`/api/status/uptime`) + incident
  subscribe (`POST /api/status/subscribe`). Migration:
  `supabase/migrations/20261111180000_phase6_findable.sql` (`reviews`, `consent_log`,
  `status_subscribers`, `status_uptime`, `public_reviews`, `review_aggregate`,
  `submit_review(uuid,...)`). Tests: `tests/test_phase6_findable.py`.

## Edge Functions (server-side funding + purchases)
- `supabase/functions/funding/index.ts` — wallet funding. Actions: `initialize`
  (creates a payment via `create_payment`, starts KoraPay checkout, stores the checkout
  URL) and `verify` (verifies a reference with KoraPay and credits via
  `credit_wallet_from_payment`). KoraPay secret keys live in Supabase function secrets
  (`KORA_MODE`, `KORA_TEST_SECRET_KEY`, `KORA_SECRET_KEY`) — never in the browser.
- `supabase/functions/purchase/index.ts` — buys a number via `buy_number` or, when a
  `store` slug is passed, `buy_number_store`. The browser only sends `{country, service, store}`.
- Frontend calls them through `SMSPIN.functions(name, payload)` (see `dashboard/api.js`),
  so no Supabase RPC name or provider key is exposed in the network tab.
- Deploy: `npx supabase functions deploy funding purchase --project-ref <ref> --yes`.
  `supabase/config.toml` pins `verify_jwt = true` for both.

## Themed modals (ui.js)
- `site/ui.js` exposes `window.SMSPINUI` = `{ modal, alert, confirm, reveal }`.
  Never use native `alert()`/`confirm()`/`prompt()` in app code — use these so dialogs
  match the glass theme. `reveal()` shows a copyable secret (used for API keys).
- Styling lives in `theme.css` under `.mdl-*`. Every dashboard page includes `/ui.js`.

## Multi-tenant configuration
- Brand and currency are data, not constants. `site_config()` (SECURITY DEFINER, public)
  returns `brand_name`, `brand_short`, `support_email`, `currency`, `commission`,
  `store_markup_percent` from the `settings` table.
- Dashboard `dash.js` loads it (`loadSite()`) and rewrites `SMSPin` in text nodes, the
  side-brand label and the page title. `money()` uses `SITE.currency` with a
  `CURRENCY_SYMBOL` map.
- Auth pages (`/login`, `/register`) use `site/auth-brand.js`: it applies `site_config`
  branding and, when arriving via `?store=<slug>`, the store's name + theme colours.
- Change branding by editing the `settings` rows; no code edits required.

## New dashboard pages
- `/dashboard/settings` — auto top-up (`set_auto_topup`), notifications, danger zone.
  Linked from the side panel under Account (after Profile).
- `/dashboard/wallet` — cash-flow chart (`wallet_summary.daily`), spend-by-service and
  spend-by-country bars, funding flow (quick amounts + method + summary → funding edge
  function), and a bank-style grouped activity ledger.
- `/dashboard/referrals` — hero with tier progress + claim (`claim_referral_earnings`),
  6-month earnings chart, recent-referrals ledger. `referral_summary` returns
  `available`, `tier`, `next_tier`, `to_next`, `monthly`.
- `/dashboard/profile` — identity hero (avatar, member-since, referral code),
  personal details, password strength + update (`SMSPIN.auth.updatePassword`), verification.
- Stat cards on overview/wallet/referrals/profile are clickable and route to the
  relevant page (`CARD_LINKS` in `dash.js`).
- Wallet page: the "Add funds" button sits at the **top** of the page (`.page-head` flex row,
  `#addFundsBtn`); the funding form was moved off the page into a **slide-up sheet**
  (`.sheet-overlay#fundSheet` > `.sheet`, opened by `#addFundsBtn`, closed by backdrop /
  `.sheet-x[data-close]` / Escape; `body.sheet-lock` freezes scroll). The wallet page keeps
  only the **Cash flow** chart — the "Spend by service"/"Spend by country" analytics grids
  were removed.
- Nav icons are inline SVGs (no emoji/`?` glyphs) injected into `.ico` spans.
## Quick actions (speed dial)
- The overview page shows a "Quick actions" panel (`#ovQuickActions`) — a 3x2 grid (6 tiles) of
  service icons only (no names; the name is the `title` tooltip). Clicking a tile routes
  to `/dashboard/buy/?service=<code>`.
- `dashboard_overview()` returns `quick_actions`: a fixed set of 6 social services, pinned
  in order via a `values` list of codes — WhatsApp `wa`, Instagram `ig`, Twitter/X `tw`,
  Facebook `fb`, Telegram `tg`, TikTok `lf`. These are the icon-bearing codes (the plain
  `whatsapp`/`instagram`/… codes only carry emoji), so every tile renders a real logo.
- Icons may be an image URL or an emoji; the renderer handles both.

## Dashboard top-left brand
- `dash.js` `mountTopBrand()` injects a fixed top-left `.dash-topbrand` bar with the
  app logo + tenant name (`SITE.brand_name`) on every dashboard page. Styled in
  `dashboard/dashboard.css`; the shell has extra top padding to clear it.

## Searchable picker modal
- `SMSPINUI.select({ title, items, value, searchPlaceholder, tone })` (in `site/ui.js`)
  opens a themed modal with a live search box and a scrollable result list. `items` are
  `{ value, label, sub?, icon?, iconType?, meta? }`; returns the chosen value or `null`.
- The Buy page uses it for both the Service and Country pickers (trigger buttons are
  `.picker-btn` with `.picker-ico` / `.picker-txt`), replacing the old native `<select>`s.
  `browse_catalog` now also returns `service_icon`.
- The Buy page honours `?service=` and `?country=` query params to preselect.

## White-label storefront auth (multi-tenant)
- Each store runs its OWN account system. Tenant identity lives in `tenant_accounts`,
  `tenant_sessions` (opaque 30-day token), `tenant_wallets`; unique index on (email, tenant).
  The same email can register/login independently on every tenant.
- Auth RPCs: `tenant_register`, `tenant_login`, `tenant_logout`, `tenant_me`, `tenant_wallet`,
  `tenant_buy_number`, `tenant_orders`, `tenant_create_payment`,
  `tenant_credit_wallet_from_payment`, `tenant_resolve`. Password hashing uses pgcrypto in
  the `extensions` schema (`extensions.crypt` / `extensions.gen_salt`).
- Dedicated screens served per store: `/store/<slug>/login/`, `/store/<slug>/register/`,
  `/store/<slug>/account/`. `backend/server.py` maps these to `site/store/{login,register,account}.html`
  but lets real files (`/store/auth.css`, `/store/auth.js`) pass through untouched
  (`os.path.isfile` guard). Shared logic in `site/store/auth.js` (`TENANT_AUTH`) resolves the
  slug from the path, loads brand + theme, and the shared styles are in `site/store/auth.css`.
- `site/dashboard/api.js` exposes `SMSPIN.tenant.*` (register/login/logout/me/wallet/buy/orders/
  createPayment, `isAuthed(slug)`, `token(slug)`); sessions are per-slug in localStorage
  (`smspin_tenant:<slug>`). Tenant payments route through `/api/payments/initialize` with
  `tenant_token` and credit the tenant wallet (never the main user wallet).
- `payments.user_id` / `orders.user_id` / `transactions.user_id` are nullable so tenant rows
  can carry `tenant_account_id` instead.

## Service icons everywhere
- `svcIcon(o, cls)` in `dashboard/dash.js` renders a service icon: image URL -> `<img>`, else
  emoji, else first letter of the service name. Used on the side-panel recent orders +
  active numbers, the orders/numbers flip cards, and (in `store/account.html`) tenant orders.
- `my_orders` and `dashboard_overview().recent_orders` both return `service_icon`;
  `tenant_orders(p_token, p_limit)` returns orders for a tenant account.
- CSS: `.svc-ico` / `.svc-cell` / `.num-svc-badge` (theme.css), `.ta-svc-ico` / `.ta-order`
  (store/auth.css). The side-panel `.side-order` grid is 3 columns: icon | name+number | badge.

## Transactions page
- `my_transactions(p_limit)` returns a derived `status` (success/pending/waiting) from the
  linked order. The page has All/Success/Pending/Waiting tabs (`.tx-tab`) with live counts
  and a Status column; filtering is client-side in `drawTxRows()`.

## Real-time funding fees (FX + PPP, no static tables)
- `backend/pricing.py` is the single source of truth for funding fees. It fetches LIVE data
  via packages, never a stored table: `forex_python.converter.CurrencyRates` for exchange
  rates and `wbdata` for World Bank `PA.NUS.PPP` (LCU per international $). Both are memoised
  in-process with a 6h TTL (`_usd_ngn_cache`, `_ppp_cache`); `server.py` warms them in a
  background thread at startup. Install deps: `pip install forex-python wbdata`.
- Bench schedule (NGN): `500 -> 10`, `700 -> 20`, `1000 -> 50`. `_bench_int()` lifts it into
  international dollars at Nigeria's current PPP factor; `_tiered()` interpolates within the
  bench and extends linearly across `10**0..10**6` magnitude bands; `quote(amount, country,
  currency)` re-prices at the caller's PPP factor. So the same real top-up costs the same real
  fee everywhere: poorer countries pay less hard currency, richer pay more (e.g. NGN1000 ->
  NG 5.0%, US 7.44%, GB 8.26%).
- `GET /api/funding/quote?amount=&country=&currency=` returns `{fee, net, fee_percent,
  amount_ngn, fee_ngn, net_ngn, usd_ngn, ppp_factor}`. `SMSPIN.feeQuote(amount, currency)` in
  `dashboard/api.js` wraps it (country comes from `window.SMSPIN_GEO`).
- Fee is stamped onto the payment at init (`set_payment_fee(ref, fee_ngn, meta)` called from
  `api_payments_initialize`, both user + tenant branches) and NETTED at credit time:
  `credit_wallet_from_payment` / `tenant_credit_wallet_from_payment` credit `amount - fee_ngn`
  and write a `fee` transaction row (`ref = <ref>:fee`). Migration:
  `supabase/migrations/20261111000000_funding_fees.sql` (adds `payments.fee_ngn`).
- The Add-funds sheet (`updateFundSummary` in `dashboard/dash.js`) shows Fee % and Wallet
  credit live; funding routes through `/api/payments/initialize` (not the `funding` edge fn)
  so the backend can stamp the fee. `TX_LABEL`/`TXP_LABEL` include `fee: "Funding fee"`.

## Buy page defaults
- `?service=` resolves through a code->canonical alias map (`codeToService`), so `?service=wa`
  selects WhatsApp even though the picker de-dupes `wa`/`whatsapp`. `?country=` is matched
  case-insensitively against the geo country (`GEO.country` is upper, catalog codes are lower).
- Default country: deep link -> last-used (`localStorage smspin_last:buy`) -> geo country ->
  first. Default service: mainstream priority list (`MAINSTREAM`: whatsapp, telegram, google,
  ...) present in that country, else most widely available. A `.dash-loader` preloader covers
  slow RPCs and clears when the page render resolves.

## SMSPin upstream API (SMS provider)
- Base `https://smspin.io/api/v1`, auth header `X-API-Key: sk_live_...` (secret `Smspin_apikey`;
  also accepts `Authorization: Bearer`). Docs render from `GET /api/openapi`.
- Endpoints: `/account`, `/countries` (225), `/services` (8,880; `?country=`), `/operators`
  (`?country&service` -> operator/label/USD price/count), `/numbers`, `POST/GET /orders`,
  `GET/DELETE /orders/{id}`, `/rent/prices`, `POST/GET /rent`, `GET/DELETE /rent/{id}`,
  `GET/POST /rent/{id}/extend`.
- Cloudflare blocks non-browser UAs — send a browser `User-Agent` from server-side clients.
- Our DB catalog (`number_catalog`, ~7.4k pairs) is a subset; sync from the API (task N2).

## White-label Android app + CI
- `app/` is a thin Kotlin/WebView shell that renders the **same screens as the website**
  (dashboard + store), so the app is a replica of the site and UI ships with the site.
- Branding is per build via `scripts/brand_app.py` (Pillow): writes `brand.json`,
  `app/src/main/assets/brand.json`, `res/values/colors.xml`, and launcher icons at all
  densities. Uploaded logo wins; otherwise an initials mark is generated from the business
  name on the brand colour.
- `.github/workflows/build-app.yml` (workflow_dispatch) builds a signed release APK, uploads
  it as an artifact, publishes a GitHub Release, and optionally emails the link. Trigger:
  `POST /repos/Exploit7492/smspin/actions/workflows/build-app.yml/dispatches`.
- `.github/workflows/branding-preview.yml` validates branding in seconds (no Gradle).
- Both workflows sparse-checkout only `app`, `scripts`, `settings.gradle.kts`,
  `gradle.properties` so CI never fetches the ~1.9 GB site.
- Repo: https://github.com/Exploit7492/smspin (branch `feat/apk-branding-ci`).

## Live ordering (real numbers + OTP)
- The provider API has **no bulk matrix**: price/availability is per `(country, service)`
  pair. So we never enumerate the full grid; instead `sync_pair()` refreshes a pair on
  demand (15-min TTL) and stores it in `number_catalog` via `catalog_upsert`. The homepage
  pairs are warmed on boot (`warm_popular`, list in `settings.popular_pairs`).
- Buy flow (`backend/server.py`): reserve -> provider -> confirm/refund. `reserve_number`
  debits the wallet (dashboard user OR tenant account) and inserts a `waiting` order;
  `buy_real()` then calls `POST /orders` upstream and either `set_order_upstream` (phone +
  upstream id) or `refund_order` (auto-refund on provider error / no number).
- A background poller (`poll_pending_orders`, every 10s) pulls OTPs via `GET /orders/{id}`
  into `sms_messages` (`record_sms`) and auto-refunds orders past `expires_at`
  (`expired_orders` + upstream `DELETE /orders/{id}`).
- HTTP surface: `POST /api/orders/buy`, `POST /api/orders/cancel`, `GET /api/order/status`,
  `GET /api/catalog/live`. Auth is a dashboard bearer token OR `x-tenant-token`.
  Frontend helpers: `SMSPIN.buyOrder / cancelOrder / orderStatus` (`dashboard/api.js`).
- The new RPCs are service-role only (revoked from anon/authenticated); the browser never
  calls them directly. Migration: `supabase/migrations/20261111120000_upstream_integration.sql`.
- `settings.upstream_live` gates live ordering; set to `false` to fall back to the legacy
  `api_buy` RPC. The provider account must be funded (else orders auto-refund with
  `SMSPin API 402: NO_BALANCE`).

## Phase 1 closure + Phase 2 (safe platform)
Migration `supabase/migrations/20261111130000_phase1_closure.sql` adds the operational
backbone. All new RPCs are `security definer` and revoked from anon/authenticated
(service_role only); the browser never calls them.

- **Catalog crawl (N2)** — the provider still has no bulk endpoint, so `sync_cursor` holds a
  priority frontier (`sync_seed()` seeds 225 countries x 13 mainstream services = 2,925
  pairs). `crawl_step()` (dedicated thread, ~every 20s) claims a slice via `sync_next()`,
  syncs each pair, and marks it with `sync_mark()`. Progress via `sync_progress()`.
- **Operators (N3)** — `upsert_operators(jsonb)` persists `operator/label/price_usd/stock`.
  `name` = operator id, `label` = human name. Wired into the crawler.
- **Durable jobs (J2/J3)** — `jobs` table + `job_enqueue/job_claim/job_finish/job_reap`.
  `job_claim` returns a JSON **array** (built with `jsonb_agg`); `job_finish` retries with
  exponential backoff then dead-letters. Worker thread (`_worker`) drains jobs.
- **Provider monitor (N8)** — `provider_balance()` -> `provider_state` key/value store;
  read via `provider_state_get`. Provider balance is currently 0, hence live 402s.
- **Reconciliation (B4)** — `reconcile_report(days)` returns revenue, refunds, COGS and
  stuck orders.
- **DLQ + webhook (N9)** — `webhook_dlq` + `POST /api/upstream/webhook` (optional
  `Smspin_webhook_secret` header check). Unmatched/failed events are dead-lettered.
- **Rate limiting (D7)** — in-memory sliding window in `server.py` (`rate_limit`/`check_rate`,
  buckets: buy 30/min, auth 60/min, webhook 600/min). Multi-instance deploys should back
  this with Redis.
- **Audit log (D10)** — `audit_log` + `audit_write`/`audit_list`. Wired into buy/cancel;
  `GET /api/audit` is self-service (a caller only sees their own `actor` rows).
- **Observability** — `GET /api/upstream/status` returns provider enabled flag, balance,
  catalog sync progress, DLQ head and a 7-day reconcile report.

### Tests + CI
- `tests/` — pytest: `test_backend_http.py` (pages, auth gates, rate limit, status),
  `test_db_rpc.py` (catalog/operators, OTP idempotency, refund idempotency, job queue, DLQ,
  reconcile, audit), `test_smspin_api.py` (client unit). Fixtures auto-skip when Supabase
  env is missing. Run: `python3 -m pytest tests/ -q`.
- `.github/workflows/backend-tests.yml` — compile + offline unit tests always; integration
  tests run when repository secrets are configured, else skipped.
- HTTP errors: domain rejections (insufficient balance / no stock) return **402**, not 500.

## Phase 2 — safe platform (migration `20261111140000_phase2_safe.sql`)
All RPCs are `security definer`, revoked from anon/authenticated, service_role only.

- **D1 email verification** — `email_verified(uuid)` reads `auth.users.email_confirmed_at`;
  `email_verification_required()` reads the setting of the same name. Buy returns
  `403 email_unverified` **only when the toggle is on**. Off by default.
- **D7 rate limiting** — sliding window in `server.py`; buckets buy 30/min, auth 60/min,
  webhook 600/min, default 240/min. 429 carries `Retry-After`.
- **D8 fraud + blocklists** — `blocklist(kind,value)` (kinds: email, email_domain, ip, user,
  phone_prefix; 10 disposable domains seeded), `risk_events`, and `fraud_check(user,ip,email)`
  which scores velocity (orders/hour, orders/day, failed payments/hour) + blocklist hits and
  records a `risk_event`. Buy returns `403 fraud_block` with `reasons`. Fails closed.
  Admin: `POST /api/admin/blocklist` (add/remove/list), `GET/POST /api/admin/risk`.
- **L4 acceptable use** — `policy_acceptances` + `policy_accept/policy_status/policy_current`.
  `GET /api/policies` (and `?policy=aup` for the text), `POST /api/policies/accept`.
  Enforcement is gated by `aup_enforcement_required`; **off by default**. Accepting via the
  buy body (`accept_aup: true`) also satisfies it.
- **J4 observability** — `JsonLogger` emits one JSON object per line (stdout); `Metrics`
  keeps counters + latency percentiles exposed at `GET /api/metrics`; DB `metrics_snapshot` +
  `metrics_record/metrics_series`; `GET /api/health` reports db/upstream/error-rate.
- **J5 alerting** — `alert_rules` (5 seeded) + `alert_events`; `alert_evaluate()` fires on
  cooldown and `dispatch_alerts()` posts to `settings.alerts_webhook_url`. `GET /api/alerts`
  (admin), `POST /api/admin/alerts/run`.
- **J2 scheduler** — `scheduler_step()` thread every 5 min: metrics snapshot, alert evaluate +
  dispatch, enqueue provider_balance/reconcile/catalog_sync jobs. State in `scheduler_state`,
  read via `GET /api/scheduler`.
- **J10 backups/DR** — hourly `backup_verify()` writes row-count/wallet-sum checksums to
  `backup_checks` so a restore can be validated. Supabase PITR itself is console-managed.
- **Admin allow-list** — `admins(email)` + `is_admin(email)`; backend `_is_admin()` checks the
  caller's profile email. Add rows to grant admin.
- Safety switches (settings): `email_verification_required`, `aup_enforcement_required`,
  `fraud_max_orders_hour` (20), `fraud_max_orders_day` (200), `fraud_max_failed_pay_hour` (10),
  `alerts_webhook_url`.
- Tests: `tests/test_phase2_safe.py` (21). Full suite 59 tests: `python3 -m pytest tests/ -q`.

## Phase 3 — "Make it operable" (admin console, support, refunds, status, envs)

Migration: `supabase/migrations/20261111150000_phase3_operable.sql` (applied to live).
New tables: `ticket_messages`, `refund_notices`, `service_checks`, `incidents`; new columns
`profiles.suspended*`, `support_tickets.{updated_at,priority,assigned_to,last_author_type}`.

- **F1 admin console** — `site/admin/` (`index.html`, `admin.js`, `admin.css`). Talks to
  `/api/admin/*` (Bearer session). Backend gates every route with `_require_admin()`
  (`is_admin(caller email)`), so non-admins get `403`. Tabs: Overview, Users, Orders & SMS,
  Support, Payments, Pricing, Status. Grant access by inserting into `admins(email)`.
- **F2 user management** — `admin_users_list/admin_user_detail/admin_user_suspend/
  admin_adjust_balance/is_suspended`. Balance adjust is ledger-backed (`admin_credit`/
  `admin_debit` transactions) and refuses to go negative. Suspended users get
  `403 account_suspended` on buy.
- **F3 order/SMS ops** — `admin_orders_list/admin_order_mark_received/admin_sms_inject`;
  replay runs the existing `upstream_webhook` mapping. `POST /api/admin/orders/{mark-received,
  replay,sms,refund}`.
- **F4 pricing/inventory** — `admin_catalog_list/admin_catalog_update/admin_set_markup`
  (writes `settings.markup_percent`).
- **F5 payments** — `admin_payments_list/admin_payment_reconcile/admin_payment_mark`;
  `GET /api/admin/payments/reconcile?days=7` returns gross/fees/net.
- **B7 refunds** — `refund_order_partial(order, amount, reason)`; `POST /api/admin/orders/refund`
  with `amount` = partial, blank = full. All refund paths (provider error, expiry, webhook,
  user cancel, admin) funnel through backend `_refund()`.
- **K1 support threads** — `ticket_messages` + `ticket_ensure_seed/ticket_reply/ticket_thread/
  my_tickets` (user, `authenticated`) and `admin_tickets_list/admin_ticket_thread/
  admin_ticket_reply/admin_ticket_update` (service_role). Dashboard `support` page renders the
  thread + reply box; admin console has a Support tab.
- **K5 refund comms** — `refund_notices` queued on every refund; `dispatch_refund_notices()`
  (also run by the scheduler) emails via `backend/mailer.py` when `MAIL_USERNAME`/`MAIL_PASSWORD`
  are set, otherwise the notice is still visible in-app (`my_refund_notices`).
- **J6 status page** — `service_checks` + `incidents`; `synthetic_check()` probes db/provider/
  webhooks/payments and is run by the scheduler; `status_report()` powers `GET /api/status`
  (public) and `site/status/`. Footer links to `/status` site-wide.
- **J9 environments** — `SMSPIN_ENV` = dev|staging|prod (default dev). Outside prod the backend
  forces KoraPay into test mode. `GET /api/env` + `/api/health` expose env/git sha/version.
  `.github/workflows/preview-deploy.yml` boots a staging build on every PR, smokes `/status/`,
  `/admin/` and the admin 403 gate, and comments a summary on the PR.
- Env: `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_HOST` (default smtp.gmail.com), `MAIL_PORT` (465),
  `MAIL_FROM`, `SMSPIN_ENV`, `SMSPIN_GIT_SHA`, `SMSPIN_VERSION`.
- Tests: `tests/test_phase3_operable.py` (11). Full suite: `python3 -m pytest tests/ -q`.

## Static mirror: real files, no redirects (2026-11-11)
The marketing/legacy paths are served from `site/` as **real `index.html` files**, not
redirects or aliases:
- `Handler.send_head` (backend/server.py) serves `<dir>/index.html` directly for a bare
  path like `/about` instead of 301-redirecting to `/about/`. Footer links point at the
  bare paths, so the redirect was pure noise.
- Every path linked from the site resolves to a real file. Full sweep of 10,976 internal
  hrefs: 10,958 × 200, 16 × 404 (all also 404 on live smspin.io — faithful), 1 × 401
  (`/api/wallet/export`, auth-gated), 1 × 301 (`/dashboard/referral` → `/dashboard/referrals/`,
  intentional alias).
- `site/` holds ~12,400 mirrored HTML pages (temp-number, blog incl. pagination 2–54,
  free-numbers, rent, sms-verification, receive-sms, categories, policies).
- Next.js JS chunks live under `site/_next/...`. Pages reference them with URL-encoded
  `%5B`/`%5D`, which the server decodes to `[`/`]`, so the on-disk dirs are the **decoded**
  form (`app/blog/[slug]/`, `app/temp-number/[slug]/`, etc.).
- To re-mirror: fetch `https://smspin.io<path>` → `site/<path>/index.html` (files with a dot
  in the last segment → `site/<path>`), then rename any `%5B`/`%5D` dirs to decoded form.

## Gotchas
- **DB connections**: always use `with db() as conn:` (the `@contextmanager` in
  `server.py`). `with psycopg2.connect(...) as conn:` only commits/rolls back and
  never closes, so a long-lived server leaks one Postgres backend per call until
  the pooler answers `max clients reached`.
- **Upstream country codes are not ISO**: the provider returns e.g. `X145` for
  Bahrain and mislabels `BH` as "Zambia". `countries.flag` follows the provider, so
  a few flag/label pairs are wrong upstream — map them if exact flags matter.
- **Pricing**: `smspin_api.live_price` prices from the *cheapest in-stock operator*;
  the provider's headline `price` is the most expensive tier. Markup is 2x (100%)
  by default; funding fee is a flat 2.5%.

## Dev server: secrets must be named in the launching command
Secret injection only fires when the secret name appears in the command text. Start the
server (or pytest) with the names referenced, else `Smspin_apikey` etc. are empty and
`/api/orders/buy` returns 503 (`_SMS_CLIENT is None`) instead of 401:
```
Smspin_Supabase_url="$Smspin_Supabase_url" Smspin_supabase_annonkey="$Smspin_supabase_annonkey" \
Smspin_supabase_Postgresql="$Smspin_supabase_Postgresql" Smspin_supabase_secretskey="$Smspin_supabase_secretskey" \
Smspin_apikey="$Smspin_apikey" Kora_test_secrete_key="$Kora_test_secrete_key" Kora_test_public_key="$Kora_test_public_key" \
nohup bash scripts/dev-server.sh > /tmp/smspin-dev.log 2>&1 &
```
Backend deps: `pip install -r backend/requirements.txt` (psycopg2-binary, forex-python, wbdata).
