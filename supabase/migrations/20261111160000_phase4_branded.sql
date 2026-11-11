-- Phase 4 "Make it branded & guided": per-tenant branding (C2), tenant payouts
-- (C4), tenant API keys + scopes + webhooks (C6), COGS/margin reporting (A8).
-- All functions are SECURITY DEFINER. Owner-scoped functions resolve the caller
-- with auth.uid(); ops functions are service_role-only (backend checks admin).

-- ================================================================ C2 branding
alter table businesses add column if not exists logo_url text;
alter table businesses add column if not exists domain text;
alter table businesses add column if not exists tagline text;
alter table businesses add column if not exists support_email text;
alter table businesses add column if not exists primary_color text;
alter table businesses add column if not exists secondary_color text;
create unique index if not exists businesses_domain_key on businesses (lower(domain)) where domain is not null;

-- ================================================================ C4 payouts
alter table businesses add column if not exists earnings_paid numeric(14,2) not null default 0;
create table if not exists tenant_payouts (
  id          bigint generated always as identity primary key,
  business_id bigint not null references businesses(id) on delete cascade,
  amount      numeric(14,2) not null,
  method      text not null default 'wallet',
  status      text not null default 'paid',
  reference   text,
  created_at  timestamptz not null default now()
);
create index if not exists tenant_payouts_business_idx on tenant_payouts (business_id, created_at desc);

-- ================================================================ C6 tenant API keys
create table if not exists tenant_api_keys (
  id            bigint generated always as identity primary key,
  business_id   bigint not null references businesses(id) on delete cascade,
  name          text not null default 'default',
  key_prefix    text not null,
  key_hash      text not null,
  scopes        text[] not null default array['read'],
  webhook_url   text,
  webhook_secret text,
  last_used_at  timestamptz,
  revoked       boolean not null default false,
  created_at    timestamptz not null default now()
);
create unique index if not exists tenant_api_keys_hash_key on tenant_api_keys (key_hash);

-- Queue of tenant webhook deliveries (drained by the scheduler).
create table if not exists tenant_webhook_events (
  id          bigint generated always as identity primary key,
  business_id bigint not null references businesses(id) on delete cascade,
  event       text not null,
  payload     jsonb not null,
  status      text not null default 'pending',
  attempts    int not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists tenant_webhook_events_pending_idx on tenant_webhook_events (status, created_at);

-- ================================================================ C2 branding RPCs
-- Owner sets branding (logo, colours, tagline, support email, domain).
create or replace function public.business_set_branding(
  p_logo_url text default null,
  p_tagline text default null,
  p_support_email text default null,
  p_primary text default null,
  p_secondary text default null,
  p_domain text default null
) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v_biz businesses%rowtype; v_domain text;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid;
  if not found then raise exception 'create your store first' using errcode='P0002'; end if;

  v_domain := nullif(trim(lower(p_domain)), '');
  if v_domain is not null then
    if v_domain !~ '^([a-z0-9-]+\.)+[a-z]{2,}$' then
      raise exception 'invalid domain' using errcode='22023';
    end if;
    if exists (select 1 from businesses where lower(domain) = v_domain and id <> v_biz.id) then
      raise exception 'domain already in use' using errcode='23505';
    end if;
  end if;

  update businesses set
    logo_url        = coalesce(nullif(trim(p_logo_url), ''), logo_url),
    tagline         = coalesce(nullif(trim(p_tagline), ''), tagline),
    support_email   = coalesce(nullif(trim(p_support_email), ''), support_email),
    primary_color   = coalesce(nullif(trim(p_primary), ''), primary_color),
    secondary_color = coalesce(nullif(trim(p_secondary), ''), secondary_color),
    domain          = case when p_domain is null then domain else v_domain end,
    updated_at      = now()
   where id = v_biz.id
  returning * into v_biz;

  return jsonb_build_object('id', v_biz.id, 'slug', v_biz.slug, 'domain', v_biz.domain,
    'logo_url', v_biz.logo_url, 'tagline', v_biz.tagline, 'support_email', v_biz.support_email,
    'primary_color', v_biz.primary_color, 'secondary_color', v_biz.secondary_color);
end $$;

-- Public: resolve a custom domain to its active store slug (for host-based routing).
create or replace function public.resolve_domain(p_host text)
returns text
language sql stable security definer set search_path to 'public' as $$
  select b.slug from businesses b
   where lower(b.domain) = lower(regexp_replace(coalesce(p_host,''), ':\d+$', '')) and b.status = 'active'
   limit 1;
$$;

-- Public: full branding payload for the storefront (falls back to defaults).
create or replace function public.business_branding(p_slug text)
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select jsonb_build_object(
      'name', b.name, 'slug', b.slug, 'theme', b.theme,
      'logo_url', b.logo_url, 'tagline', b.tagline,
      'support_email', coalesce(b.support_email, (select value #>> '{}' from settings where key='support_email')),
      'primary_color', b.primary_color, 'secondary_color', b.secondary_color,
      'domain', b.domain, 'status', b.status,
      'markup_percent', b.markup_percent)
    from businesses b where b.slug = p_slug
  ), 'null'::jsonb);
$$;

-- ================================================================ C4 payout RPCs
-- Owner's payout summary: earned, already paid out, available to withdraw.
create or replace function public.my_payouts()
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select jsonb_build_object(
      'earned_ngn', coalesce((select sum(amount) from business_earnings e where e.business_id = b.id), 0),
      'paid_ngn', b.earnings_paid,
      'available_ngn', greatest(0, coalesce((select sum(amount) from business_earnings e where e.business_id = b.id), 0) - b.earnings_paid),
      'payouts', coalesce((select jsonb_agg(jsonb_build_object(
          'id', p.id, 'amount', p.amount, 'method', p.method, 'status', p.status,
          'reference', p.reference, 'created_at', p.created_at) order by p.created_at desc)
        from tenant_payouts p where p.business_id = b.id), '[]'::jsonb))
    from businesses b where b.user_id = auth.uid()
  ), 'null'::jsonb);
$$;

-- Request a payout: settle available earnings into the owner's SMSPin wallet.
-- (A real bank/stablecoin payout would hand off to the payments provider; the
-- wallet credit keeps the ledger honest and lets the owner withdraw from there.)
create or replace function public.request_payout(p_amount numeric default null)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  uid uuid := auth.uid();
  v_biz businesses%rowtype;
  v_earned numeric(14,2);
  v_available numeric(14,2);
  v_amount numeric(14,2);
  v_payout bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid for update;
  if not found then raise exception 'no store' using errcode='P0002'; end if;

  select coalesce(sum(amount), 0) into v_earned from business_earnings where business_id = v_biz.id;
  v_available := greatest(0, v_earned - v_biz.earnings_paid);
  v_amount := coalesce(p_amount, v_available);
  if v_amount <= 0 then raise exception 'nothing to pay out' using errcode='22023'; end if;
  if v_amount > v_available then raise exception 'amount exceeds available earnings' using errcode='22023'; end if;

  insert into tenant_payouts(business_id, amount, method, status, reference)
    values (v_biz.id, v_amount, 'wallet', 'paid', 'payout:' || v_biz.id || ':' || extract(epoch from now())::bigint)
    returning id into v_payout;
  update businesses set earnings_paid = earnings_paid + v_amount, updated_at = now() where id = v_biz.id;

  insert into wallets(user_id, balance, currency) values (uid, 0, 'NGN')
    on conflict (user_id) do nothing;
  update wallets set balance = balance + v_amount, updated_at = now() where user_id = uid;
  insert into transactions(user_id, type, amount, method, ref)
    values (uid, 'payout', v_amount, 'business_payout', 'payout:' || v_payout);

  return jsonb_build_object('payout_id', v_payout, 'amount', v_amount,
    'available_ngn', v_available - v_amount);
end $$;

-- ================================================================ C6 key RPCs
create or replace function public.tenant_api_key_create(
  p_name text default 'default',
  p_scopes text[] default array['read'],
  p_webhook_url text default null
) returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare
  uid uuid := auth.uid();
  v_biz businesses%rowtype;
  v_secret text; v_prefix text; v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid;
  if not found then raise exception 'create your store first' using errcode='P0002'; end if;
  if v_biz.status <> 'active' then raise exception 'activate your store first' using errcode='P0002'; end if;

  v_secret := 'tk_live_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_prefix := left(v_secret, 14) || '...' || right(v_secret, 4);
  insert into tenant_api_keys(business_id, name, key_prefix, key_hash, scopes, webhook_url, webhook_secret)
    values (v_biz.id, coalesce(nullif(trim(p_name),''), 'default'), v_prefix,
            encode(extensions.digest(v_secret, 'sha256'), 'hex'),
            coalesce(p_scopes, array['read']),
            nullif(trim(p_webhook_url), ''),
            case when nullif(trim(p_webhook_url),'') is not null
                 then encode(extensions.gen_random_bytes(24), 'hex') else null end)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'key', v_secret, 'prefix', v_prefix,
    'scopes', coalesce(p_scopes, array['read']));
end $$;

create or replace function public.tenant_api_keys_list()
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'prefix', k.key_prefix,
        'scopes', k.scopes, 'webhook_url', k.webhook_url, 'revoked', k.revoked,
        'last_used_at', k.last_used_at, 'created_at', k.created_at) order by k.created_at desc)
    from tenant_api_keys k join businesses b on b.id = k.business_id
    where b.user_id = auth.uid()
  ), '[]'::jsonb);
$$;

create or replace function public.tenant_api_key_revoke(p_id bigint)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  update tenant_api_keys k set revoked = true
   where k.id = p_id
     and exists (select 1 from businesses b where b.id = k.business_id and b.user_id = auth.uid());
  get diagnostics n = row_count;
  return jsonb_build_object('revoked', n > 0);
end $$;

-- Resolve a tenant API key secret to {business_id, scopes, webhook_url}. Called by
-- the backend (service_role) with the sha256 hash of the presented secret.
create or replace function public.tenant_resolve_api_key(p_hash text)
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('business_id', k.business_id, 'scopes', k.scopes,
                            'webhook_url', k.webhook_url, 'key_id', k.id)
    from tenant_api_keys k
   where k.key_hash = p_hash and not k.revoked
   limit 1;
$$;

-- Queue a webhook delivery for every active key on a business with a webhook URL.
create or replace function public.tenant_webhook_enqueue(p_business bigint, p_event text, p_payload jsonb)
returns int
language plpgsql security definer set search_path to 'public' as $$
declare n int := 0;
begin
  insert into tenant_webhook_events(business_id, event, payload)
  select k.business_id, p_event, p_payload
    from tenant_api_keys k
   where k.business_id = p_business and not k.revoked and k.webhook_url is not null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Pending deliveries (backend drains them with the key's URL + secret).
create or replace function public.tenant_webhook_pending(p_limit int default 20)
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select e.id, e.business_id, e.event, e.payload, e.attempts,
           k.webhook_url, k.webhook_secret
      from tenant_webhook_events e
      join tenant_api_keys k on k.business_id = e.business_id and not k.revoked
     where e.status = 'pending' and k.webhook_url is not null
     order by e.created_at asc limit greatest(1, least(p_limit, 200))) x;
$$;

create or replace function public.tenant_webhook_mark(p_id bigint, p_ok boolean, p_error text default null)
returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if p_ok then
    update tenant_webhook_events set status='delivered', delivered_at=now(), attempts=attempts+1 where id=p_id;
  else
    update tenant_webhook_events set attempts=attempts+1, last_error=p_error,
      status = case when attempts+1 >= 5 then 'failed' else 'pending' end
     where id=p_id;
  end if;
end $$;

-- ================================================================ A8 margin
-- Per-order provider cost (USD) vs charge, plus rollups. Admin/service_role only.
create or replace function public.margin_report(p_days int default 30)
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  with o as (
    select id, status, service_code, price, coalesce(cost_usd, 0) as cost_usd, created_at
      from orders
     where created_at > now() - make_interval(days => greatest(1, least(p_days, 365)))
  ), fx as (select coalesce((select rate from fx_rates where code='NGN'), 1) as ngn)
  select jsonb_build_object(
    'days', p_days,
    'orders', (select count(*) from o),
    'revenue_ngn',  coalesce((select sum(price) from o where status in ('waiting','received')), 0),
    'refunds_ngn',  coalesce((select sum(price) from o where status='refunded'), 0),
    'cogs_ngn',     coalesce((select round(sum(cost_usd) * (select ngn from fx), 2) from o where status in ('waiting','received')), 0),
    'cogs_usd',     coalesce((select sum(cost_usd) from o where status in ('waiting','received')), 0),
    'gross_margin_ngn', coalesce((
        select round(sum(price) - sum(cost_usd) * (select ngn from fx), 2)
          from o where status in ('waiting','received')), 0),
    'margin_percent', coalesce((
        select case when sum(price) > 0
                    then round((sum(price) - sum(cost_usd)*(select ngn from fx)) / sum(price) * 100, 2)
                    else 0 end
          from o where status in ('waiting','received')), 0),
    'by_service', coalesce((
        select jsonb_agg(jsonb_build_object(
          'service', s.name, 'icon', s.icon, 'orders', t.n,
          'revenue_ngn', t.rev, 'cogs_ngn', t.cogs,
          'margin_ngn', round(t.rev - t.cogs, 2),
          'margin_percent', case when t.rev > 0 then round((t.rev - t.cogs)/t.rev*100, 2) else 0 end)
          order by t.rev desc)
        from (
          select o.service_code, count(*) as n, sum(o.price) as rev,
                 sum(o.cost_usd) * (select ngn from fx) as cogs
            from o where o.status in ('waiting','received') group by o.service_code) t
        join services s on s.code = t.service_code), '[]'::jsonb),
    'by_day', coalesce((
        select jsonb_agg(jsonb_build_object(
          'day', t.d, 'orders', t.n, 'revenue_ngn', t.rev,
          'margin_ngn', round(t.rev - t.cogs, 2)) order by t.d desc)
        from (
          select date_trunc('day', o.created_at)::date as d, count(*) as n,
                 sum(o.price) as rev, sum(o.cost_usd) * (select ngn from fx) as cogs
            from o where o.status in ('waiting','received')
           group by 1 order by 1 desc limit 60) t), '[]'::jsonb)
  );
$$;

-- Stats for a business id (used by the tenant API surface, service_role only).
create or replace function public.my_business_stats_by_id(p_business bigint)
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select jsonb_build_object(
      'slug', b.slug, 'name', b.name, 'theme', b.theme, 'status', b.status,
      'markup_percent', b.markup_percent,
      'orders', (select count(*) from orders o where o.business_id = b.id),
      'earned_ngn', coalesce((select sum(amount) from business_earnings e where e.business_id = b.id), 0))
    from businesses b where b.id = p_business
  ), 'null'::jsonb);
$$;

-- ================================================================ locks
do $$
declare f text;
begin
  foreach f in array array['margin_report'] loop
    execute format('revoke all on function public.%I from public, anon, authenticated', f);
    execute format('grant execute on function public.%I to service_role', f);
  end loop;
  foreach f in array array[
    'business_set_branding','my_payouts','request_payout',
    'tenant_api_key_create','tenant_api_keys_list','tenant_api_key_revoke'
  ] loop
    execute format('grant execute on function public.%I to authenticated, service_role', f);
  end loop;
  -- Public storefront helpers.
  foreach f in array array['resolve_domain','business_branding'] loop
    execute format('grant execute on function public.%I to anon, authenticated, service_role', f);
  end loop;
  -- Backend-only helpers.
  foreach f in array array[
    'tenant_resolve_api_key','tenant_webhook_enqueue','tenant_webhook_pending','tenant_webhook_mark',
    'my_business_stats_by_id'
  ] loop
    execute format('revoke all on function public.%I from public, anon, authenticated', f);
    execute format('grant execute on function public.%I to service_role', f);
  end loop;
end $$;
