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
