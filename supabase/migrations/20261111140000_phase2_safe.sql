-- Phase 2 "Make it safe": fraud/blocklists (D8), email verification (D1),
-- acceptable-use acceptance (L4), observability (J4/J5), scheduled jobs + DR (J2/J10).
-- All functions are SECURITY DEFINER and service_role-only; the browser never
-- calls them directly (verified by the backend before the request proceeds).

-- ================================================================ D8 blocklists
create table if not exists blocklist (
  id         bigserial primary key,
  kind       text not null,          -- email | email_domain | ip | user | phone_prefix
  value      text not null,
  reason     text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, value)
);

create or replace function public.blocklist_add(p_kind text, p_value text, p_reason text default null)
returns bigint
language sql
security definer
set search_path to 'public'
as $$
  insert into blocklist (kind, value, reason)
  values (lower(p_kind), lower(p_value), p_reason)
  on conflict (kind, value) do update set active = true, reason = excluded.reason
  returning id;
$$;

create or replace function public.blocklist_remove(p_kind text, p_value text)
returns void
language sql
security definer
set search_path to 'public'
as $$ update blocklist set active = false where kind = lower(p_kind) and value = lower(p_value); $$;

create or replace function public.blocklist_list(p_kind text default null)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc), '[]'::jsonb) from (
    select id, kind, value, reason, active, created_at from blocklist
    where active and (p_kind is null or kind = lower(p_kind)) limit 500
  ) t;
$$;

create table if not exists risk_events (
  id         bigserial primary key,
  user_id    uuid,
  kind       text not null,          -- fraud_check | velocity | blocklist_hit
  score      integer not null default 0,
  allow      boolean not null default true,
  reasons    jsonb not null default '[]'::jsonb,
  ip         text,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists risk_events_user_idx on risk_events (user_id, created_at desc);

-- ------------------------------------------------------------------ D8 fraud_check
-- Velocity + blocklist scoring run *before* a purchase. Returns an allow/deny
-- decision with a score and the reasons, and records a risk_event either way.
create or replace function public.fraud_check(p_user uuid, p_ip text, p_email text,
                                              p_meta jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_score int := 0;
  v_reasons jsonb := '[]'::jsonb;
  v_allow boolean := true;
  v_max_hour int := coalesce((select (value#>>'{}')::int from settings where key='fraud_max_orders_hour'), 20);
  v_max_day  int := coalesce((select (value#>>'{}')::int from settings where key='fraud_max_orders_day'), 200);
  v_max_fail int := coalesce((select (value#>>'{}')::int from settings where key='fraud_max_failed_pay_hour'), 10);
  v_orders_hour int;
  v_orders_day  int;
  v_fail_hour   int;
  v_domain text;
begin
  -- Explicit blocklists always deny.
  if exists (select 1 from blocklist where active and kind='user' and value = p_user::text) then
    v_allow := false; v_score := v_score + 100; v_reasons := v_reasons || to_jsonb('user_blocked'::text);
  end if;
  if p_ip is not null and exists (select 1 from blocklist where active and kind='ip' and value = lower(p_ip)) then
    v_allow := false; v_score := v_score + 100; v_reasons := v_reasons || to_jsonb('ip_blocked'::text);
  end if;
  if p_email is not null then
    if exists (select 1 from blocklist where active and kind='email' and value = lower(p_email)) then
      v_allow := false; v_score := v_score + 100; v_reasons := v_reasons || to_jsonb('email_blocked'::text);
    end if;
    v_domain := lower(split_part(p_email, '@', 2));
    if v_domain <> '' and exists (select 1 from blocklist where active and kind='email_domain' and value = v_domain) then
      v_allow := false; v_score := v_score + 80; v_reasons := v_reasons || to_jsonb('disposable_email'::text);
    end if;
  end if;

  -- Velocity: recent order + failed-payment counts.
  select count(*) into v_orders_hour from orders
   where user_id = p_user and created_at > now() - interval '1 hour';
  select count(*) into v_orders_day from orders
   where user_id = p_user and created_at > now() - interval '1 day';
  select count(*) into v_fail_hour from payments
   where user_id = p_user and status in ('failed','abandoned') and created_at > now() - interval '1 hour';

  if v_orders_hour >= v_max_hour then
    v_allow := false; v_score := v_score + 60;
    v_reasons := v_reasons || to_jsonb('velocity_orders_hour'::text);
  elsif v_orders_hour >= (v_max_hour * 0.7) then
    v_score := v_score + 25; v_reasons := v_reasons || to_jsonb('near_hour_limit'::text);
  end if;
  if v_orders_day >= v_max_day then
    v_allow := false; v_score := v_score + 60;
    v_reasons := v_reasons || to_jsonb('velocity_orders_day'::text);
  end if;
  if v_fail_hour >= v_max_fail then
    v_score := v_score + 40; v_reasons := v_reasons || to_jsonb('failed_payments'::text);
  end if;

  insert into risk_events (user_id, kind, score, allow, reasons, ip, meta)
  values (p_user, 'fraud_check', v_score, v_allow, v_reasons, p_ip, coalesce(p_meta, '{}'::jsonb));

  return jsonb_build_object('allow', v_allow, 'score', v_score, 'reasons', v_reasons,
                            'orders_hour', v_orders_hour, 'orders_day', v_orders_day,
                            'failed_payments_hour', v_fail_hour);
end $$;

create or replace function public.risk_events_list(p_limit integer default 100, p_user uuid default null)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc), '[]'::jsonb) from (
    select id, user_id, kind, score, allow, reasons, ip, created_at from risk_events
    where p_user is null or user_id = p_user
    order by id desc limit greatest(1, least(coalesce(p_limit,100), 1000))
  ) t;
$$;

-- Seed the common disposable domains so the list is useful out of the box.
insert into blocklist (kind, value, reason) values
  ('email_domain','mailinator.com','disposable'),
  ('email_domain','guerrillamail.com','disposable'),
  ('email_domain','10minutemail.com','disposable'),
  ('email_domain','tempmail.com','disposable'),
  ('email_domain','throwawaymail.com','disposable'),
  ('email_domain','yopmail.com','disposable'),
  ('email_domain','sharklasers.com','disposable'),
  ('email_domain','trashmail.com','disposable'),
  ('email_domain','getnada.com','disposable'),
  ('email_domain','dispostable.com','disposable')
on conflict (kind, value) do nothing;

-- ================================================================ D1 email verify
-- Verification is OFF by default (setting `email_verification_required` = false).
-- Flip it to true to enforce confirmed email before purchase.
create or replace function public.email_verification_required()
returns boolean
language sql
security definer
set search_path to 'public'
as $$
  select coalesce((select (value#>>'{}')::boolean from settings
                   where key = 'email_verification_required'), false);
$$;

create or replace function public.email_verified(p_user uuid)
returns boolean
language sql
security definer
set search_path to 'public'
as $$
  select coalesce((select email_confirmed_at is not null from auth.users where id = p_user), false);
$$;

-- ================================================================ L4 acceptable use
create table if not exists policy_acceptances (
  id          bigserial primary key,
  user_id     uuid,
  tenant_account_id uuid,
  policy      text not null,          -- aup | terms | privacy
  version     text not null,
  ip          text,
  accepted_at timestamptz not null default now()
);
-- A plain unique(...) does not dedupe NULL tenant_account_id rows (NULLs are
-- distinct in Postgres), so key the index on coalesced columns instead.
alter table policy_acceptances drop constraint if exists policy_acceptances_user_id_tenant_account_id_policy_version_key;
-- Collapse any rows created before the coalesced key existed.
delete from policy_acceptances a using policy_acceptances b
 where a.id > b.id
   and coalesce(a.user_id,'00000000-0000-0000-0000-000000000000'::uuid) =
       coalesce(b.user_id,'00000000-0000-0000-0000-000000000000'::uuid)
   and coalesce(a.tenant_account_id,'00000000-0000-0000-0000-000000000000'::uuid) =
       coalesce(b.tenant_account_id,'00000000-0000-0000-0000-000000000000'::uuid)
   and a.policy = b.policy and a.version = b.version;
create unique index if not exists policy_acceptances_key_idx
  on policy_acceptances (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
                         coalesce(tenant_account_id, '00000000-0000-0000-0000-000000000000'::uuid),
                         policy, version);

create or replace function public.policy_current(p_policy text)
returns text
language sql
security definer
set search_path to 'public'
as $$ select coalesce((select value#>>'{}' from settings where key = 'policy_'||p_policy||'_version'), '1.0'); $$;

create or replace function public.policy_accept(p_user uuid, p_tenant uuid, p_policy text, p_ip text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_ver text := public.policy_current(p_policy);
begin
  if not exists (select 1 from policy_acceptances
                 where policy = p_policy and version = v_ver
                   and coalesce(user_id,'00000000-0000-0000-0000-000000000000'::uuid) =
                       coalesce(p_user,'00000000-0000-0000-0000-000000000000'::uuid)
                   and coalesce(tenant_account_id,'00000000-0000-0000-0000-000000000000'::uuid) =
                       coalesce(p_tenant,'00000000-0000-0000-0000-000000000000'::uuid)) then
    insert into policy_acceptances (user_id, tenant_account_id, policy, version, ip)
    values (p_user, p_tenant, p_policy, v_ver, p_ip);
  end if;
  return jsonb_build_object('policy', p_policy, 'version', v_ver, 'accepted', true);
end $$;

create or replace function public.policy_status(p_user uuid, p_tenant uuid)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'aup_version', public.policy_current('aup'),
    'aup_required', coalesce((select (value#>>'{}')::boolean from settings
                              where key = 'aup_enforcement_required'), false),
    'aup_accepted', exists (select 1 from policy_acceptances
       where policy='aup' and version = public.policy_current('aup')
         and (user_id = p_user or (p_tenant is not null and tenant_account_id = p_tenant)))
  );
$$;

-- ================================================================ J4/J5 observability
create table if not exists metrics_snapshot (
  id          bigserial primary key,
  captured_at timestamptz not null default now(),
  window_min  integer not null default 5,
  metrics     jsonb not null default '{}'::jsonb
);
create index if not exists metrics_snapshot_time_idx on metrics_snapshot (captured_at desc);

-- A single call returns everything the dashboard/alerts need.
create or replace function public.ops_metrics(p_window_min integer default 5)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  with w as (select now() - (p_window_min || ' minutes')::interval as since)
  select jsonb_build_object(
    'captured_at', now(),
    'window_min', p_window_min,
    'orders_total',    (select count(*) from orders, w where created_at >= w.since),
    'orders_received', (select count(*) from orders, w where created_at >= w.since and status='received'),
    'orders_refunded', (select count(*) from orders, w where created_at >= w.since and status='refunded'),
    'orders_waiting',  (select count(*) from orders where status='waiting'),
    'payments_ok',     (select count(*) from payments, w where created_at >= w.since and status in ('paid','success','successful')),
    'payments_failed', (select count(*) from payments, w where created_at >= w.since and status in ('failed','abandoned')),
    'revenue_ngn',     (select coalesce(sum(amount - coalesce(fee_ngn,0)),0) from payments, w
                          where created_at >= w.since and status in ('paid','success','successful')),
    'risk_denied',     (select count(*) from risk_events, w where created_at >= w.since and not allow),
    'dlq_open',        (select count(*) from webhook_dlq where not resolved),
    'jobs_pending',    (select count(*) from jobs where status='pending'),
    'jobs_dead',       (select count(*) from jobs where status='dead'),
    'users_total',     (select count(*) from profiles)
  );
$$;

create or replace function public.metrics_record(p_window_min integer default 5)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_id bigint;
begin
  insert into metrics_snapshot (window_min, metrics) values (p_window_min, public.ops_metrics(p_window_min))
  returning id into v_id;
  -- Keep a bounded history (7 days at 5-min cadence).
  delete from metrics_snapshot where captured_at < now() - interval '7 days';
  return v_id;
end $$;

create or replace function public.metrics_series(p_limit integer default 288)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.captured_at), '[]'::jsonb) from (
    select captured_at, window_min, metrics from metrics_snapshot
    order by captured_at desc limit greatest(1, least(coalesce(p_limit,288), 5000))
  ) t;
$$;

-- ------------------------------------------------------------------ J5 alerts
create table if not exists alert_rules (
  key        text primary key,
  metric     text not null,          -- path into ops_metrics, e.g. 'payments_failed'
  op         text not null default '>',   -- > >= < <= ==
  threshold  numeric not null,
  severity   text not null default 'warning',
  enabled    boolean not null default true,
  cooldown_s integer not null default 900,
  note       text
);

create table if not exists alert_events (
  id          bigserial primary key,
  rule_key    text not null,
  severity    text not null,
  metric      text not null,
  value       numeric,
  threshold   numeric,
  message     text,
  delivered   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists alert_events_time_idx on alert_events (created_at desc);

create or replace function public.alert_evaluate()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  m jsonb := public.ops_metrics(15);
  v numeric;
  v_fired jsonb := '[]'::jsonb;
  v_last timestamptz;
begin
  for r in select * from alert_rules where enabled loop
    v := coalesce((m ->> r.metric)::numeric, 0);
    if (r.op = '>'  and v >  r.threshold)
    or (r.op = '>=' and v >= r.threshold)
    or (r.op = '<'  and v <  r.threshold)
    or (r.op = '<=' and v <= r.threshold)
    or (r.op = '==' and v =  r.threshold) then
      select max(created_at) into v_last from alert_events where rule_key = r.key;
      if v_last is null or v_last < now() - (r.cooldown_s || ' seconds')::interval then
        insert into alert_events (rule_key, severity, metric, value, threshold, message)
        values (r.key, r.severity, r.metric, v, r.threshold,
                format('%s %s %s (now %s)', r.metric, r.op, r.threshold, v));
        v_fired := v_fired || jsonb_build_object('rule', r.key, 'severity', r.severity,
                                                 'value', v, 'threshold', r.threshold);
      end if;
    end if;
  end loop;
  return v_fired;
end $$;

create or replace function public.alert_mark_delivered(p_id bigint)
returns void language sql security definer set search_path to 'public'
as $$ update alert_events set delivered = true where id = p_id; $$;

create or replace function public.alert_events_list(p_limit integer default 50)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc), '[]'::jsonb) from (
    select id, rule_key, severity, metric, value, threshold, message, delivered, created_at
    from alert_events order by id desc limit greatest(1, least(coalesce(p_limit,50), 500))
  ) t;
$$;

create or replace function public.alert_rules_list()
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.key), '[]'::jsonb) from (
    select key, metric, op, threshold, severity, enabled, cooldown_s, note from alert_rules
  ) t;
$$;

-- ================================================================ admin allow-list
create table if not exists admins (
  email      text primary key,
  role       text not null default 'admin',
  created_at timestamptz not null default now()
);

create or replace function public.is_admin(p_email text)
returns boolean
language sql
security definer
set search_path to 'public'
as $$
  select coalesce((select true from admins where lower(email) = lower(p_email)), false);
$$;

insert into alert_rules (key, metric, op, threshold, severity, note) values
  ('payment_failures','payments_failed','>',5,'critical','Failed/abandoned payments in 15 min'),
  ('dlq_backlog','dlq_open','>',10,'warning','Unresolved upstream webhook events'),
  ('dead_jobs','jobs_dead','>',0,'critical','Jobs exhausted retries'),
  ('order_backlog','orders_waiting','>',100,'warning','Orders waiting on OTP'),
  ('refund_spike','orders_refunded','>',25,'warning','Refunds in window')
on conflict (key) do nothing;

-- Default settings for the phase-2 features.
insert into settings (key, value) values
  ('policy_aup_version', '"1.0"'),
  ('policy_terms_version', '"1.0"'),
  ('policy_privacy_version', '"1.0"'),
  ('fraud_max_orders_hour', '20'),
  ('fraud_max_orders_day', '200'),
  ('fraud_max_failed_pay_hour', '10'),
  ('email_verification_required', 'false'),
  ('aup_enforcement_required', 'false'),
  ('alerts_webhook_url', '""'),
  ('support_email', '"support@smspin.io"')
on conflict (key) do nothing;

-- ================================================================ J2 scheduler state
create table if not exists scheduler_state (
  key        text primary key,
  last_run   timestamptz,
  last_ok    boolean,
  detail     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.scheduler_mark(p_key text, p_ok boolean, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into scheduler_state (key, last_run, last_ok, detail, updated_at)
  values (p_key, now(), p_ok, coalesce(p_detail,'{}'::jsonb), now())
  on conflict (key) do update set last_run=now(), last_ok=p_ok, detail=excluded.detail, updated_at=now();
$$;

create or replace function public.scheduler_status()
returns jsonb
language sql
security definer
set search_path to 'public'
as $$ select coalesce(jsonb_agg(to_jsonb(t) order by t.key), '[]'::jsonb) from scheduler_state t; $$;

-- ================================================================ J10 backup verify
-- We cannot trigger a Supabase PITR backup from SQL, but we CAN verify the data
-- plane is intact and record a checksum so a restore can be validated.
create table if not exists backup_checks (
  id          bigserial primary key,
  checked_at  timestamptz not null default now(),
  ok          boolean not null default true,
  detail      jsonb not null default '{}'::jsonb
);

create or replace function public.backup_verify()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_detail jsonb;
begin
  select jsonb_build_object(
    'profiles', (select count(*) from profiles),
    'orders',   (select count(*) from orders),
    'payments', (select count(*) from payments),
    'transactions', (select count(*) from transactions),
    'wallets_sum', (select coalesce(sum(balance),0) from wallets),
    'latest_order', (select max(created_at) from orders)
  ) into v_detail;
  insert into backup_checks (ok, detail) values (true, v_detail);
  delete from backup_checks where checked_at < now() - interval '30 days';
  return v_detail;
end $$;

-- ------------------------------------------------------------------ locks
do $$
declare f text;
begin
  foreach f in array array[
    'blocklist_add','blocklist_remove','blocklist_list','fraud_check','risk_events_list',
    'email_verified','email_verification_required','policy_current','policy_accept','policy_status',
    'ops_metrics','metrics_record','metrics_series','alert_evaluate','alert_mark_delivered',
    'alert_events_list','alert_rules_list','is_admin','scheduler_mark','scheduler_status','backup_verify'
  ] loop
    execute format('revoke all on function public.%I from public, anon, authenticated', f);
    execute format('grant execute on function public.%I to service_role', f);
  end loop;
end $$;
