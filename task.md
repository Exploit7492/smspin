# SMSPin — Full Build Plan (task.md)

Living backlog for the SMSPin platform: the public marketing site, the customer
dashboard, the multi-tenant white-label stores, the SMSPin API integration, the
per-tenant Kotlin Android app, and all operational/compliance work needed for a
pro-standard launch.

**Legend:** ✅ built · 🟡 partial · ❌ not started
**Priority:** P0 = launch blocker · P1 = pro-standard ops · P2 = scale & polish

---

## 0. Current state (baseline)

| Layer | Reality |
|---|---|
| Marketing site | ~10,100 static pages (Next.js mirror): sms-verification, free-numbers, temp-number, rent, buy, blog, receive-sms, rent-virtual-number, + legal/company pages |
| Dashboard | 13 pages: overview, buy, numbers, orders, inbox, wallet/analytics, transactions, api-keys, business, referrals, profile, settings, support |
| Auth | Email/password only (Supabase GoTrue): login, register, forgot/reset |
| White-label | `store/*` (login, register, account) + `businesses` table + `app_status` |
| Backend | `backend/server.py`: static, `/api/geo`, `/api/fx`, `/api/funding/quote`, `/api/payments/initialize`, `/api/korapay/webhook`, `/api/v1/*`, openapi, business manifest |
| Pricing | ✅ Live FX (`forex-python`) + PPP (`wbdata`) fee engine |
| Payments | KoraPay only, `KORA_MODE=test`, HMAC-verified webhook |
| DB | 21 tables, 51 RPCs; RLS via SECURITY DEFINER RPCs |
| SMS | ❌ No live provider wired yet — `sms_messages` seeded; dashboard polls 1s |
| Catalog | 🟡 DB has 8,885 services / 7,398 priced pairs; upstream API exposes 8,880 services × 225 countries |

---

## 1. Upstream provider — SMSPin API (confirmed)

Base: `https://smspin.io/api/v1` · Auth header: `X-API-Key: sk_live_...`
(also accepts `Authorization: Bearer`). Docs: `/docs/api/reference` (rendered from `/api/openapi`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/account` | Account, balance (USD), plan |
| GET | `/countries` | Every supported country (225) |
| GET | `/services` | Every supported service (8,880); `?country=` filters |
| GET | `/operators?country&service` | Operators + label + USD per-OTP price + stock count |
| GET | `/numbers?country&service` | Live price & availability |
| GET | `/orders` | List orders |
| POST | `/orders` | Create order (`country`, `service`, optional `operator`) |
| GET | `/orders/{id}` | Poll order (`otpCode`, `status`); poll every 3–5 s |
| DELETE | `/orders/{id}` | Cancel + refund (2-min window, no code) |
| GET | `/rent/prices?service[&country]` | Rental durations + prices |
| POST | `/rent` | Rent a number (`service`, `country`, `duration` hours, `maxPrice`) |
| GET | `/rent` | List rentals (`status`, `limit`) |
| GET | `/rent/{id}` | Rental + its SMS (`messages` may be null) |
| DELETE | `/rent/{id}` | Cancel rental (2–20 min window, full refund) |
| GET | `/rent/{id}/extend` | Extension options |
| POST | `/rent/{id}/extend` | Extend rental (`duration`, `maxPrice`) |

Key objects: `Order{id,phoneNumber,country,service,operator,status,otpCode,price,createdAt,expiresAt}`,
`Rental{id,phoneNumber,service,country,status,durationHours,price,smsCount,extended,createdAt,expiresAt}`.

---

## Workstream N — SMSPin API integration  (P0)

| # | Item | Notes | Status |
|---|---|---|---|
| N1 | API client + account/balance | Wrap `/account`, `/countries`, `/services`; retries, timeouts, rate-limit | ❌ |
| N2 | Full catalog sync (8,880 services / 225 countries) | Replace partial 7,398-pair catalog with full inventory | ❌ |
| N3 | Operators + live per-OTP price sync | `/operators` → operator, label, USD price, stock; drives markup | ❌ |
| N4 | Order creation via `POST /orders` | Reserve number server-side; store upstream order id | ❌ |
| N5 | OTP polling → `sms_messages` ingest | Poll `/orders/{id}` 3–5 s → `otpCode`; push to client | ❌ |
| N6 | Cancel + auto-refund via `DELETE /orders/{id}` | 2-min window; wallet refund + `refund` txn; sweep expired | ❌ |
| N7 | Rent flow (prices/create/get/extend/cancel) | `/rent*`; recurring billing for long-term rental | ❌ |
| N8 | Upstream balance top-up + reconciliation | Monitor provider balance; top up; reconcile orders | ❌ |
| N9 | Error/retry/rate-limit + webhook fallback | Backoff, DLQ; webhook alternative to polling | ❌ |

---

## Workstream M — Kotlin white-label Android app  (P1)

| # | Item | Notes | Status |
|---|---|---|---|
| M1 | Kotlin app scaffold | WebView replica of the *same* website screens (dashboard + store), one codebase, config-driven, multi-tenant | ❌ |
| M2 | Per-tenant config injection | Brand, theme, store slug, API base, catalog baked per build | ❌ |
| M3 | Logo upload OR auto-generated initials logo | Use uploaded logo, else generate from wizard initials + theme colors | ❌ |
| M4 | APK build pipeline + signing + versioning | Per-tenant build, sign, version, store artifact | ❌ |
| M5 | Email APK download link | Secure time-limited link emailed to tenant | ❌ |
| M6 | App distribution + updates + push | Distribution page, in-app updates, FCM push | ❌ |
| M7 | Device features | OTP inbox, biometric unlock, deep links | ❌ |

---

## Workstream O — Onboarding, tours & enablement  (P0/P1)

| # | Item | Notes | Status |
|---|---|---|---|
| O1 | Tour/onboarding engine | Driver.js/Shepherd; step defs, state, role+tenant targeting, analytics | ❌ |
| O2 | End-user welcome + getting-started checklist | First-login modal + persistent checklist | ❌ |
| O3 | End-user guided dashboard tour | Coach marks across overview/buy/numbers/inbox/wallet/api-keys | ❌ |
| O4 | First-purchase tutorial + sample OTP demo | Step-by-step buy; sandbox number with demo OTP | ❌ |
| O5 | Contextual tooltips + in-app help widget | Inline "?" + help drawer with search/KB | ❌ |
| O6 | Empty-state onboarding | Every page's empty state teaches the next action | ❌ |
| O7 | Developer onboarding | Quickstart, key walkthrough, playground, SDK snippets, Postman | ❌ |
| O8 | Tenant business-creation wizard | Multi-step: name/slug/country/plan/theme | ❌ |
| O9 | Tenant branding wizard + live preview | Logo upload or auto-initials, colors, domain, live preview | ❌ |
| O10 | Tenant store launch checklist | Branding, pricing, payments, legal, first test order | ❌ |
| O11 | Tenant admin dashboard tour | Tour of their business/stats/payout pages | ❌ |
| O12 | Tenant APK onboarding | Build wizard → progress → download email → first-run screens | ❌ |
| O13 | Tenant end-user branded onboarding | Per-store welcome + tour on store page and in APK | ❌ |
| O14 | Operator onboarding wizard | SIM registration, device pairing, revenue share, payouts | ❌ |
| O15 | Superadmin console onboarding + runbooks | Admin tour + internal runbooks | ❌ |
| O16 | What's-new / changelog tours | In-app announcements + feature tours on release | ❌ |
| O17 | Help center / KB + video tutorials | Searchable KB + short how-to videos | ❌ |
| O18 | Onboarding analytics + activation funnel + A/B | Step completion, drop-off, experiment variants | ❌ |
| O19 | Accessibility + i18n for tours | Keyboard/screen-reader tours, localized copy | ❌ |
| O20 | Progressive disclosure / contextual nudges | Behaviour-triggered tips + tooltip system | ❌ |

---

## Workstream A — Product & inventory  (P1)

| # | Item | Notes | Status |
|---|---|---|---|
| A8 | COGS & margin tracking | Per-order provider cost (USD) vs charge; margin report | ❌ |

*(A1–A5, A7 are delivered by workstream N; A6 voice/verify remains P2.)*

| A6 | Voice / call verification | Optional voice-OTP path | ❌ |

---

## Workstream B — Payments & money  (P0/P1)

| # | Item | Notes | Status |
|---|---|---|---|
| B2 | Payments go-live (KoraPay prod) | Merchant KYC, prod keys, live webhook, settlement | ❌ |
| B4 | Payment idempotency + reconciliation | Idempotency keys, replay protection, settlement reconciliation | ❌ |
| B3 | Multi-currency wallet | Per-currency balances or auto-convert; settlement currency | ❌ |
| B1 | More payment rails | Paystack/Flutterwave/Monnify + Stripe/PayPal + USDT | ❌ |
| B6 | Receipts, invoices + VAT/tax | PDF/email receipts, VAT on fees, statements | ❌ |
| B7 | Admin refunds / partial refunds | Ops-initiated refunds with reason + ledger | ❌ |
| B9 | Auto-topup execution | Low balance → charge saved method | ❌ |
| E5 | Saved payment methods | Vault cards/methods, default, remove | ❌ |
| B8 | Double-entry ledger + accounting export | Append-only ledger, derived balances, revenue/COGS export | ❌ |
| B5 | Chargebacks / disputes | Dispute workflow, evidence, ledger holds | ❌ |

---

## Workstream C — Multi-tenant  (P0/P1)

| # | Item | Notes | Status |
|---|---|---|---|
| C1 | Tenant isolation hardening | Verified RLS/tenant_id on every table; audit SECURITY DEFINER | ❌ |
| C2 | Custom domains + per-tenant branding | Domain, logo, colors, email sender, legal per store | ❌ |
| C3 | Per-tenant pricing overrides | Per service/country markup; per-tenant FX | ❌ |
| C4 | Tenant payouts + statements | Scheduled settlement to tenant wallet/bank + statements | ❌ |
| C6 | Tenant API keys + scopes + webhooks | Per-tenant keys, scopes, event webhooks | ❌ |
| C7 | Tenant onboarding/KYC/approval | Approval flow, plan enforcement, suspension | ❌ |
| C8 | Tenant analytics | Cohorts, LTV, churn, revenue per tenant | ❌ |

---

## Workstream D — Auth, security & compliance  (P0/P1)

| # | Item | Notes | Status |
|---|---|---|---|
| D1 | Email verification | Verify email before purchase | ❌ |
| D2 | Transactional email infra | Welcome, receipt, refund, ticket, security, APK link | ❌ |
| D7 | Rate limiting + anti-abuse + captcha | Per-IP/key/user limits, captcha, velocity, blocklists | ❌ |
| D8 | Fraud scoring + blocklists | Velocity, device fingerprint, disposable email/number block | ❌ |
| D3 | 2FA (TOTP/email) | Optional 2FA for login + payouts | ❌ |
| D6 | Session/device management | Active sessions list, revoke, log out all | ❌ |
| D5 | Password policy / breach check | Min length, breach list, lockout | ❌ |
| D4 | OAuth / social login | Google/Apple/GitHub | ❌ |
| D9 | KYC/AML + sanctions screening | Tiered KYC, PEP/sanctions, thresholds | ❌ |
| D10 | Audit log | Immutable admin/user action log | ❌ |
| D11 | Secrets management | Vault/secret manager, per-env config, rotation | ❌ |
| D12 | Dependency/security scanning | SCA, SAST, DAST in CI | ❌ |

---

## Workstream E — Customer UX  (P1)

| # | Item | Notes | Status |
|---|---|---|---|
| E1 | Real-time SMS (WebSocket/SSE) | Push delivery, copy button, toast on arrival | ❌ |
| E2 | Order detail view | Per-order page: status, messages, refund, extend, cancel | ❌ |
| E3 | Wallet/ledger UI + export | Statements, filters, CSV export, running balance | ❌ |
| E6 | Notifications center | In-app feed + per-event email/push preferences | ❌ |
| E8 | Onboarding flow | Guided first purchase, sample OTP demo | ❌ |
| E9 | Accessibility (WCAG 2.2 AA) | Contrast, keyboard, ARIA, screen-reader audit | ❌ |
| E10 | i18n / RTL | Locale switcher, RTL, localized currency/dates | ❌ |
| E11 | PWA + push | Installable, offline shell, push | ❌ |
| E12 | In-app support chat/KB | Live chat, KB, ticket status, attachments | ❌ |

---

## Workstream F — Admin / operations console  (P0)

| # | Item | Notes | Status |
|---|---|---|---|
| F1 | Admin console | Back-office with role-gated access | ❌ |
| F2 | User management | Search, view, suspend, adjust balance with reason | ❌ |
| F3 | Order/SMS ops | Replay webhook, force-refund, resend, mark received | ❌ |
| F4 | Pricing/inventory admin | Edit markup/prices/stock, enable/disable | ❌ |
| F5 | Payments reconciliation console | Pending/settled, provider reconciliation, refunds | ❌ |
| F6 | Tenant/business admin | Approve/suspend stores, payouts, plans | ❌ |
| F7 | Support console | Queue, assignment, canned replies, SLA | ❌ |
| F8 | Fraud/abuse console | Flags queue, blocklists, manual review | ❌ |
| F9 | Settings + feature flags | Editable config, kill-switches per feature/tenant | ❌ |

---

## Workstream G — Marketing & SEO  (P0/P1)

| # | Item | Notes | Status |
|---|---|---|---|
| G1 | sitemap.xml + robots.txt | Auto-generated sitemaps for 10k pages; canonical host | ❌ |
| G2 | Structured data expansion | Add Product/Offer, Review, HowTo | ❌ |
| G3 | CMP consent + Core Web Vitals | Granular consent, image opt, LCP/CLS budgets | ❌ |
| G5 | Experiments + attribution | A/B framework, funnel attribution | ❌ |
| G6 | Trust: reviews + status page | Reviews, case studies, uptime page | ❌ |
| G7 | Blog CMS | Authoring pipeline, scheduling, tags, search | ❌ |

---

## Workstream H — API platform & developer experience  (P1)

| # | Item | Notes | Status |
|---|---|---|---|
| H1 | API key scopes/limits/quotas | Scopes, per-key rate limits, quotas, IP allowlist | ❌ |
| H2 | Customer webhooks | Order/SMS events, signing, retries | ❌ |
| H3 | Interactive docs + SDKs | OpenAPI → Redoc, Node/Python/PHP SDKs | ❌ |
| H4 | Sandbox environment | Test keys, fake SMS, full sandbox | ❌ |
| H6 | Idempotency/pagination/errors | Idempotency keys, cursor pagination, standard errors | ❌ |
| H5 | Usage metering/billing | Usage dashboard, API-customer invoices | ❌ |

---

## Workstream I — Growth  (P1/P2)

| # | Item | Notes | Status |
|---|---|---|---|
| I1 | Referral program completion | Attribution, tiers, fraud checks | ❌ |
| I2 | Affiliate payouts (USDT/bank) | Payout flow ≥ $5, statements, tax docs | ❌ |
| I3 | Operator program (SIM onboarding) | SIM onboarding, device health, revenue-share payouts | ❌ |
| I4 | Coupons + loyalty | Coupon engine, rewards, credit expiry | ❌ |
| I6 | Lifecycle email | Nurture, win-back, abandoned-fund | ❌ |

---

## Workstream J — Platform engineering & operations  (P0)

| # | Item | Notes | Status |
|---|---|---|---|
| J1 | Versioned migrations + CI apply | Migration pipeline with rollback | ❌ |
| J2 | Scheduled jobs (pg_cron/queue) | Expiry, refunds, catalog sync, payouts | ❌ |
| J3 | Durable worker/queue | Queue with retries + DLQ | ❌ |
| J4 | Observability | Structured logs, metrics, tracing, error tracking | ❌ |
| J5 | Alerting / on-call | Error rate, payment failures, stock alerts | ❌ |
| J6 | Status / uptime page | Public status page, synthetic checks | ❌ |
| J7 | Test suite + coverage | Unit + integration + e2e (Playwright) | ❌ |
| J8 | CI/CD pipelines | Lint, test, build, migrate, deploy | ❌ |
| J9 | Environments + preview deploys | dev/staging/prod isolation | ❌ |
| J10 | Backups / DR | PITR, tested restore, RTO/RPO | ❌ |
| J11 | Scaling / CDN / WAF | Horizontal scale, CDN, WAF, caching | ❌ |
| J12 | IaC | Terraform/Compose reproducible infra | ❌ |
| J13 | Load testing | Load tests + capacity plan | ❌ |

---

## Workstream K — Support & communications  (P0/P1)

| # | Item | Notes | Status |
|---|---|---|---|
| K1 | Support ticket threads | Two-way thread, agent reply, attachments, status | ❌ |
| K2 | SLA + routing | Priority, SLA timers, escalation | ❌ |
| K3 | Knowledge base | Help center with search (feeds O17) | ❌ |
| K4 | Live chat | Widget + agent console | ❌ |
| K5 | Refund communication | Auto email/in-app notice on refund | ❌ |
| K6 | Incident comms | Status page + email on outage | ❌ |

---

## Workstream L — Business & legal  (P0/P1)

| # | Item | Notes | Status |
|---|---|---|---|
| L1 | Legal review/versioning | Jurisdiction review, versioned, acceptance log | ❌ |
| L4 | Acceptable-use policy + enforcement | AUP + enforcement (illegal-use abuse risk) | ❌ |
| L5 | GDPR/NDPR tooling | DPA, DSAR, retention, sub-processors | ❌ |
| L6 | Company/ops/banking/provider contracts | Entities, banking, upstream provider agreement | ❌ |
| L2 | Tax/VAT reporting | VAT on fees, tax reports, invoices | ❌ |
| L3 | Accounting export | Ledger export, revenue/COGS reports | ❌ |

---

## Build sequence (phases)

| Phase | Theme | Contents |
|---|---|---|
| 1 | Make it real | N1–N9 · B2, B4 · J2, J3, D2 |
| 2 | Make it safe | D1, D7, D8, D10, L4 · J4, J5, J7, J8, J10 |
| 3 | Make it operable | F1–F5, K1, K5, B7 · J9, J6 |
| 4 | Make it branded & guided | M1–M7 · O1, O8, O9, O12, O13 · C2, C4, C6 · A8, B1, B3 |
| 5 | Make it grow | O2–O7, O10, O11, O14–O20 · E1–E12 · G5 · I1–I6 · H1–H7 · L2, L3 |

---

## APK form-wizard → branding mapping

| Wizard field | App use | Logo generation | Fallback |
|---|---|---|---|
| Business name | App name, launcher, splash | Initials (e.g. "Nova Numbers" → `NN`) | — |
| Store slug | API base, deep links | filename token | slugified name |
| Logo upload | Launcher icon, splash, header | used directly if present | else generated |
| Theme color | Primary/accent, status bar | logo background gradient | theme default |
| Secondary color | Buttons, chips | logo text color | auto-contrast |
| Domain | Links, email sender | — | `smspin.io/store/<slug>` |
| Country/currency | Prices, locale | — | GEO default |
| Markup % | Pricing shown | — | platform default |
| Tagline | Splash subtitle | — | "Virtual numbers, instantly" |
| Support email | In-app support | — | tenant email |

**Logo rule:** uploaded logo wins; otherwise generate a square mark from the
business-name initials on the chosen theme color with auto-contrast text, exported
at all Android densities (mdpi→xxxhdpi) + adaptive icon + splash.

**App = website replica.** The APK renders the *same* screens as the website
(dashboard, store, buy, inbox …) inside a thin Kotlin/WebView shell, so the UI is
identical to the site and updates ship with the site (no app rebuild for UI
changes). Only branding (name, colors, logo, slug, deep links) is baked per tenant.

---

## Repo layout

| Path | Contents |
|---|---|
| `site/` | The marketing site + dashboard + store (served by the backend) |
| `backend/` | Python backend (static, API, KoraPay, FX/PPP, `/api/v1/*`) |
| `supabase/` | Migrations, RPCs, edge functions |
| `app/` | Kotlin Android shell (website replica), config-driven per tenant |
| `scripts/` | `brand_app.py` (branding + initials logo), `send-apk-email.py` |
| `.github/workflows/` | `build-app.yml` (per-request branded APK), `branding-preview.yml` |
| `task.md` | This plan |


---

## CI — per-request branded app build

`.github/workflows/build-app.yml` (workflow_dispatch) accepts tenant branding
inputs (slug, name, colors, logo, API base, country, currency, markup) and:
1. Generates an initials logo when no logo is uploaded (ImageMagick).
2. Injects `brand.json` into the app source.
3. Builds a signed release APK with Gradle.
4. Uploads the APK as a build artifact (and optionally emails a link).
