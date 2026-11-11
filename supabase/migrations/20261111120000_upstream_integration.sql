-- Upstream (SMSPin provider) integration: real numbers, live OTP, refunds.
--
-- The provider API has no bulk catalog, so availability/price is refreshed
-- per (country, service) pair on demand and stored in number_catalog. Orders
-- reserve funds locally, then the backend calls the provider and confirms
-- (or refunds) the order.

-- ---------- schema ----------
alter table orders
  add column if not exists upstream_order_id text,
  add column if not exists upstream_status   text,
  add column if not exists operator          integer,
  add column if not exists cost_usd          numeric(12,4),
  add column if not exists last_synced_at    timestamptz;

create index if not exists orders_upstream_idx on orders(upstream_order_id);
create index if not exists orders_waiting_idx  on orders(status, expires_at) where status = 'waiting';

alter table number_catalog
  add column if not exists cost_usd   numeric(12,4),
  add column if not exists updated_at timestamptz not null default now();

alter table operators
  add column if not exists ext_id integer;
create unique index if not exists operators_country_ext_idx on operators(country_code, ext_id) where ext_id is not null;

-- ---------- catalog upsert (from live provider reads) ----------
create or replace function public.catalog_upsert(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_n int := 0; it jsonb; v_rate numeric;
begin
  select coalesce(rate,1) into v_rate from fx_rates where code='NGN';
  for it in select * from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    insert into number_catalog(country_code, service_code, price, cost_usd, stock, active, updated_at)
    values (
      lower(it->>'country'), it->>'service',
      coalesce((it->>'price_ngn')::numeric, round((it->>'cost_usd')::numeric * (1 + coalesce((select value::text::numeric from settings where key='markup_percent'),200)/100.0) * v_rate, 2)),
      (it->>'cost_usd')::numeric,
      coalesce((it->>'stock')::int, 0), coalesce((it->>'stock')::int,0) > 0, now())
    on conflict (country_code, service_code) do update
      set price = excluded.price, cost_usd = excluded.cost_usd,
          stock = excluded.stock, active = excluded.active, updated_at = now();
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('upserted', v_n);
end $function$;

-- ---------- reserve (debit wallet, create pending order) ----------
-- p_user: dashboard user id (null for white-label tenant accounts)
-- p_tenant_account: tenant account id (null for dashboard users)
create or replace function public.reserve_number(
  p_user uuid, p_country text, p_service text,
  p_tenant_account uuid default null, p_operator integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_base numeric(12,2); v_markup numeric(12,2); v_price numeric(12,2);
  v_bal numeric(14,2); v_order bigint; v_biz businesses%rowtype;
  v_markup_pct numeric := 0; v_cost numeric(12,4);
begin
  if p_user is null and p_tenant_account is null then
    raise exception 'no buyer' using errcode='28000';
  end if;

  select price, cost_usd into v_base, v_cost from number_catalog
   where country_code = p_country and service_code = p_service and active and stock > 0
   order by price asc limit 1;
  if v_base is null then
    raise exception 'no stock for %/%', p_country, p_service using errcode='P0002';
  end if;

  if p_tenant_account is not null then
    select b.* into v_biz from tenant_accounts a join businesses b on b.id = a.business_id
     where a.id = p_tenant_account;
  elsif p_user is not null then
    select * into v_biz from businesses where user_id = p_user and status = 'active' limit 1;
  end if;
  v_markup_pct := coalesce(v_biz.markup_percent, 0);
  v_markup := round(v_base * v_markup_pct / 100.0, 2);
  v_price  := v_base + v_markup;

  if p_tenant_account is not null then
    select balance into v_bal from tenant_wallets where account_id = p_tenant_account for update;
    if v_bal is null or v_bal < v_price then raise exception 'insufficient balance' using errcode='P0001'; end if;
    update tenant_wallets set balance = balance - v_price, updated_at = now() where account_id = p_tenant_account;
  else
    select balance into v_bal from wallets where user_id = p_user for update;
    if v_bal is null or v_bal < v_price then raise exception 'insufficient balance' using errcode='P0001'; end if;
    update wallets set balance = balance - v_price, updated_at = now() where user_id = p_user;
  end if;

  insert into orders(user_id, country_code, service_code, phone_number, price, cost_usd, operator,
                     status, expires_at, business_id, tenant_account_id)
    values (p_user, p_country, p_service, '', v_price, v_cost, p_operator,
            'waiting', now() + interval '20 minutes', v_biz.id, p_tenant_account)
    returning id into v_order;

  insert into transactions(user_id, type, amount, method, ref, tenant_account_id)
    values (p_user, 'purchase', -v_price, p_service, 'order:'||v_order, p_tenant_account);

  return jsonb_build_object('order_id', v_order, 'price_ngn', v_price, 'base_ngn', v_base,
    'markup_ngn', v_markup, 'cost_usd', v_cost, 'business_id', v_biz.id,
    'tenant_account_id', p_tenant_account, 'status', 'reserved');
end $function$;

-- ---------- confirm upstream order ----------
create or replace function public.set_order_upstream(
  p_order_id bigint, p_phone text, p_upstream_id text,
  p_operator integer default null, p_cost_usd numeric default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update orders set phone_number = coalesce(nullif(p_phone,''), phone_number),
         upstream_order_id = p_upstream_id, upstream_status = 'active',
         operator = coalesce(p_operator, operator),
         cost_usd = coalesce(p_cost_usd, cost_usd), last_synced_at = now()
   where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'status', 'active');
end $function$;

-- ---------- refund (cancel / no SMS / failure) ----------
create or replace function public.refund_order(p_order_id bigint, p_reason text default 'refund')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'order % not found', p_order_id using errcode='P0002'; end if;
  if o.status in ('refunded','cancelled') then
    return jsonb_build_object('order_id', p_order_id, 'status', o.status, 'refunded', 0, 'already', true);
  end if;

  if o.tenant_account_id is not null then
    update tenant_wallets set balance = balance + o.price, updated_at = now() where account_id = o.tenant_account_id;
  elsif o.user_id is not null then
    update wallets set balance = balance + o.price, updated_at = now() where user_id = o.user_id;
  end if;

  update orders set status = 'refunded', upstream_status = coalesce(upstream_status,'cancelled'),
         last_synced_at = now() where id = p_order_id;

  insert into transactions(user_id, type, amount, method, ref, tenant_account_id)
    values (o.user_id, 'refund', o.price, p_reason, 'order:'||o.id, o.tenant_account_id);

  return jsonb_build_object('order_id', p_order_id, 'status', 'refunded', 'refunded', o.price);
end $function$;

-- ---------- OTP ingest ----------
create or replace function public.record_sms(
  p_order_id bigint, p_sender text, p_body text, p_code text, p_received_at timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id bigint;
begin
  if p_code is null or p_code = '' then
    return jsonb_build_object('inserted', false, 'reason', 'no code');
  end if;
  select id into v_id from sms_messages
   where order_id = p_order_id and code = p_code limit 1;
  if v_id is null then
    insert into sms_messages(order_id, sender, body, code, received_at)
      values (p_order_id, p_sender, p_body, p_code, coalesce(p_received_at, now()))
      returning id into v_id;
    update orders set status = 'received', upstream_status = 'completed', last_synced_at = now()
     where id = p_order_id and status <> 'received';
    return jsonb_build_object('inserted', true, 'sms_id', v_id, 'code', p_code);
  end if;
  return jsonb_build_object('inserted', false, 'sms_id', v_id, 'duplicate', true);
end $function$;

-- ---------- polling helpers (service-role only) ----------
create or replace function public.upstream_pending_orders(p_limit integer default 100)
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(x),'[]'::jsonb) from (
    select o.id, o.upstream_order_id, o.country_code, o.service_code, o.operator,
           o.status, o.expires_at, o.user_id, o.tenant_account_id
    from orders o
    where o.status = 'waiting' and o.upstream_order_id is not null
    order by o.created_at asc limit p_limit
  ) x;
$function$;

create or replace function public.expired_orders(p_limit integer default 200)
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(x),'[]'::jsonb) from (
    select o.id, o.upstream_order_id, o.user_id, o.tenant_account_id
    from orders o
    where o.status = 'waiting' and o.expires_at < now()
    order by o.expires_at asc limit p_limit
  ) x;
$function$;

create or replace function public.order_by_upstream(p_upstream_id text)
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
  select coalesce((
    select jsonb_build_object('order_id', o.id, 'status', o.status, 'user_id', o.user_id,
                              'tenant_account_id', o.tenant_account_id, 'country', o.country_code,
                              'service', o.service_code)
    from orders o where o.upstream_order_id = p_upstream_id limit 1), 'null'::jsonb);
$function$;

-- ---------- lock down: only the backend (service role) may call these ----------
revoke all on function public.reserve_number(uuid,text,text,uuid,integer) from public, anon, authenticated;
revoke all on function public.set_order_upstream(bigint,text,text,integer,numeric) from public, anon, authenticated;
revoke all on function public.refund_order(bigint,text) from public, anon, authenticated;
revoke all on function public.record_sms(bigint,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.catalog_upsert(jsonb) from public, anon, authenticated;
revoke all on function public.upstream_pending_orders(integer) from public, anon, authenticated;
revoke all on function public.expired_orders(integer) from public, anon, authenticated;
revoke all on function public.order_by_upstream(text) from public, anon, authenticated;

insert into settings(key, value) values ('upstream_live', 'true'::jsonb)
  on conflict (key) do nothing;
