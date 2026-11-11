-- Phase 1 closure: finish the upstream integration surface.
--   N2  gradual catalog sync progress (sync_cursor)
--   N3  operator persistence (operators ext fields + upsert_operators)
--   N8  provider state (balance/reconciliation snapshot)
--   N9  dead-letter queue for failed upstream events
--   B4  reconciliation report
--   J3  durable job queue (claim/retry/dead-letter)
--   D10 audit log (used from Phase 2, table created here)
-- All functions are SECURITY DEFINER and revoked from anon/authenticated;
-- only the backend (service_role / postgres) may call them.

-- ------------------------------------------------------------------ N3
alter table operators
  add column if not exists label      text,
  add column if not exists price_usd  numeric,
  add column if not exists stock      integer,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists operators_country_name_key
  on operators (country_code, name);

create or replace function public.upsert_operators(p_items jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  it jsonb; n int := 0;
begin
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into operators (country_code, name, ext_id, label, price_usd, stock, updated_at)
    values (
      lower(it->>'country'),
      coalesce(nullif(it->>'operator', ''), nullif(it->>'label', ''), 'unknown'),
      nullif(it->>'id', '')::bigint,
      coalesce(it->>'label', it->>'operator'),
      nullif(it->>'price', '')::numeric,
      nullif(it->>'count', '')::integer,
      now())
    on conflict (country_code, name) do update
      set ext_id = coalesce(excluded.ext_id, operators.ext_id),
          label = coalesce(excluded.label, operators.label),
          price_usd = coalesce(excluded.price_usd, operators.price_usd),
          stock = coalesce(excluded.stock, operators.stock),
          updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------------ N2
-- Gradual catalog sync progress. We cannot pull the full 8,880 x 225 grid in
-- one shot, so a crawler walks a priority frontier and records where it got to.
create table if not exists sync_cursor (
  country_code text not null,
  service_code text not null,
  done         boolean not null default false,
  synced_at    timestamptz,
  primary key (country_code, service_code)
);

-- Seed the frontier: every country x the mainstream services people actually buy.
create or replace function public.sync_seed()
returns integer
language sql
security definer
set search_path to 'public'
as $$
  with mainsvc as (
    select unnest(array['wa','tg','ig','go','fb','tw','gb','ds','ap','nf','oi','ss','ub']) as s
  )
  insert into sync_cursor (country_code, service_code)
  select c.code, m.s from countries c cross join mainsvc m
  on conflict do nothing;
  select count(*) from sync_cursor;
$$;

create or replace function public.sync_next(p_limit integer default 40)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object('country', country_code, 'service', service_code)), '[]'::jsonb)
  from (
    select country_code, service_code from sync_cursor
    where not done
    order by synced_at nulls first, country_code, service_code
    limit greatest(1, least(coalesce(p_limit, 40), 200))
    for update skip locked
  ) t;
$$;

create or replace function public.sync_mark(p_country text, p_service text, p_done boolean default true)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into sync_cursor (country_code, service_code, done, synced_at)
  values (lower(p_country), p_service, coalesce(p_done, true), now())
  on conflict (country_code, service_code)
    do update set done = coalesce(p_done, true), synced_at = now();
$$;

create or replace function public.sync_progress()
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'total', count(*),
    'done', count(*) filter (where done),
    'pending', count(*) filter (where not done))
  from sync_cursor;
$$;

-- ------------------------------------------------------------------ N8
-- Small key/value store for provider-side facts (balance, last reconcile...).
create table if not exists provider_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.provider_state_set(p_key text, p_value jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into provider_state (key, value, updated_at)
  values (p_key, coalesce(p_value, '{}'::jsonb), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;

create or replace function public.provider_state_get(p_key text)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce((select value from provider_state where key = p_key), '{}'::jsonb);
$$;

-- ------------------------------------------------------------------ N9
create table if not exists webhook_dlq (
  id          bigserial primary key,
  source      text not null default 'upstream',
  event       text,
  payload     jsonb not null default '{}'::jsonb,
  error       text,
  attempts    integer not null default 0,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create or replace function public.dlq_enqueue(p_source text, p_event text, p_payload jsonb, p_error text)
returns bigint
language sql
security definer
set search_path to 'public'
as $$
  insert into webhook_dlq (source, event, payload, error)
  values (coalesce(p_source,'upstream'), p_event, coalesce(p_payload,'{}'::jsonb), p_error)
  returning id;
$$;

create or replace function public.dlq_list(p_limit integer default 50)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
    select id, source, event, error, attempts, created_at
    from webhook_dlq where not resolved order by id desc
    limit greatest(1, least(coalesce(p_limit,50), 500))
  ) t;
$$;

create or replace function public.dlq_resolve(p_id bigint)
returns void
language sql
security definer
set search_path to 'public'
as $$ update webhook_dlq set resolved = true, updated_at = now() where id = p_id; $$;

-- ------------------------------------------------------------------ J3
-- Durable job queue: enqueue -> claim (with lock) -> finish (retry or dead-letter).
create table if not exists jobs (
  id          bigserial primary key,
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending',   -- pending|running|done|dead
  attempts    integer not null default 0,
  max_attempts integer not null default 5,
  run_after   timestamptz not null default now(),
  locked_at   timestamptz,
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists jobs_claim_idx on jobs (status, run_after) where status in ('pending','running');

create or replace function public.job_enqueue(p_kind text, p_payload jsonb default '{}'::jsonb, p_run_after timestamptz default now())
returns bigint
language sql
security definer
set search_path to 'public'
as $$
  insert into jobs (kind, payload, run_after) values (p_kind, coalesce(p_payload,'{}'::jsonb), coalesce(p_run_after, now()))
  returning id;
$$;

create or replace function public.job_claim(p_limit integer default 10)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  with c as (
    select id from jobs
    where status = 'pending' and run_after <= now()
    order by run_after, id
    limit greatest(1, least(coalesce(p_limit,10), 100))
    for update skip locked
  ),
  u as (
    update jobs j set status = 'running', attempts = attempts + 1,
                      locked_at = now(), updated_at = now()
    from c where j.id = c.id
    returning j.id, j.kind, j.payload, j.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'kind', kind, 'payload', payload, 'attempts', attempts)), '[]'::jsonb)
  from u;
$$;

create or replace function public.job_finish(p_id bigint, p_ok boolean, p_error text default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_status text; v_attempts int; v_max int;
begin
  select status, attempts, max_attempts into v_status, v_attempts, v_max from jobs where id = p_id for update;
  if not found then return 'missing'; end if;
  if p_ok then
    update jobs set status='done', last_error=null, updated_at=now() where id = p_id;
    return 'done';
  end if;
  if v_attempts >= v_max then
    update jobs set status='dead', last_error=p_error, updated_at=now() where id = p_id;
    return 'dead';
  end if;
  update jobs set status='pending', last_error=p_error, updated_at=now(),
                  run_after = now() + (interval '5 seconds' * power(2, v_attempts))
   where id = p_id;
  return 'retry';
end $$;

-- Recover jobs orphaned by a crash (running but not touched for 5 minutes).
create or replace function public.job_reap(p_timeout interval default interval '5 minutes')
returns integer
language sql
security definer
set search_path to 'public'
as $$
  with r as (
    update jobs set status='pending', updated_at=now()
    where status='running' and locked_at < now() - p_timeout
    returning 1
  ) select count(*)::int from r;
$$;

-- ------------------------------------------------------------------ B4
create or replace function public.reconcile_report(p_days integer default 7)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  with win as (select now() - (p_days || ' days')::interval as since),
  o as (
    select * from orders, win where created_at >= win.since
  )
  select jsonb_build_object(
    'since', (select since from win),
    'orders_total',     (select count(*) from o),
    'orders_received',  (select count(*) from o where status='received'),
    'orders_refunded',  (select count(*) from o where status='refunded'),
    'orders_waiting',   (select count(*) from o where status='waiting'),
    'revenue_ngn',      (select coalesce(sum(price),0) from o where status='received'),
    'refunded_ngn',     (select coalesce(sum(price),0) from o where status='refunded'),
    'cogs_usd',         (select coalesce(sum(cost_usd),0) from o where status='received'),
    'stuck_orders',     (select coalesce(jsonb_agg(jsonb_build_object(
                            'id', id, 'status', status, 'upstream_order_id', upstream_order_id,
                            'age_min', round(extract(epoch from (now()-created_at))/60)::int))
                          filter (where status='waiting' and created_at < now() - interval '10 minutes'), '[]'::jsonb)
                        from o)
  );
$$;

-- ------------------------------------------------------------------ D10
create table if not exists audit_log (
  id          bigserial primary key,
  actor       text,            -- 'user:<uuid>' | 'tenant:<uuid>' | 'admin:<id>' | 'system'
  action      text not null,
  subject     text,            -- the entity acted on
  detail      jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_created_idx on audit_log (created_at desc);

create or replace function public.audit_write(p_actor text, p_action text, p_subject text default null,
                                              p_detail jsonb default '{}'::jsonb, p_ip text default null)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into audit_log (actor, action, subject, detail, ip)
  values (p_actor, p_action, p_subject, coalesce(p_detail,'{}'::jsonb), p_ip);
$$;

create or replace function public.audit_list(p_limit integer default 100, p_actor text default null)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
    select id, actor, action, subject, detail, ip, created_at
    from audit_log
    where p_actor is null or actor = p_actor
    order by id desc limit greatest(1, least(coalesce(p_limit,100), 1000))
  ) t;
$$;

-- ------------------------------------------------------------------ locks
-- Backend-only: the browser must never call these directly.
do $$
declare f text;
begin
  foreach f in array array[
    'upsert_operators','sync_seed','sync_next','sync_mark','sync_progress',
    'provider_state_set','provider_state_get','dlq_enqueue','dlq_list','dlq_resolve',
    'job_enqueue','job_claim','job_finish','job_reap','reconcile_report',
    'audit_write','audit_list'
  ] loop
    execute format('revoke all on function public.%I from public, anon, authenticated', f);
    execute format('grant execute on function public.%I to service_role', f);
  end loop;
end $$;

select public.sync_seed();
