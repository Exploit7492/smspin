-- Whole-number pricing.
--
-- Buyers only ever see whole numbers. A provider price of 1.56 (or a marked-up
-- 1.56) is displayed and charged as 2. We round UP (ceil) so the displayed
-- price never undercuts the true cost.
--
-- 1. catalog_upsert stores ceil() of the sell price.
-- 2. Existing catalog rows are recomputed with ceil().
-- 3. reserve_number / tenant_buy_number charge ceil(base + markup).

-- 1. Ceil on upsert (both an explicit price and the computed markup fallback).
create or replace function public.catalog_upsert(p_items jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_n int := 0; it jsonb; v_rate numeric;
begin
  select coalesce(rate,1) into v_rate from fx_rates where code='NGN';
  for it in select * from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    insert into number_catalog(country_code, service_code, price, cost_usd, stock, active, updated_at)
    values (
      lower(it->>'country'), it->>'service',
      ceil(coalesce(
        (it->>'price_ngn')::numeric,
        (it->>'cost_usd')::numeric * (1 + coalesce((select value::text::numeric from settings where key='markup_percent'),100)/100.0) * v_rate)),
      (it->>'cost_usd')::numeric,
      coalesce((it->>'stock')::int, 0), coalesce((it->>'stock')::int,0) > 0, now())
    on conflict (country_code, service_code) do update
      set price = excluded.price, cost_usd = excluded.cost_usd,
          stock = excluded.stock, active = excluded.active, updated_at = now();
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('upserted', v_n);
end $$;

-- 2. Recompute every stored sell price as a whole number.
update number_catalog n
   set price = ceil(n.cost_usd * (1 + 100 / 100.0)
                    * coalesce((select rate from fx_rates where code = 'NGN'), 1)),
       updated_at = now()
 where n.cost_usd is not null and n.cost_usd > 0;

-- 3. Charge whole numbers at reserve time (base is whole; markup may be a
--    fraction of it, so ceil the total).
create or replace function public.reserve_number(p_user uuid, p_country text, p_service text, p_tenant_account uuid DEFAULT NULL::uuid, p_operator integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_price  := ceil(v_base + v_markup);

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
    'markup_ngn', v_price - v_base, 'cost_usd', v_cost, 'business_id', v_biz.id,
    'tenant_account_id', p_tenant_account, 'status', 'reserved');
end $function$;

-- tenant_buy_number charges the same whole number.
create or replace function public.tenant_buy_number(p_token text, p_country text, p_service text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := tenant_resolve(p_token);
  v_acc tenant_accounts%rowtype;
  v_biz businesses%rowtype;
  v_base numeric(12,2); v_price numeric(12,2); v_markup numeric(12,2);
  v_bal numeric(14,2); v_order bigint; v_phone text; v_dial text;
begin
  if v_uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select * into v_acc from tenant_accounts where id = v_uid;
  if v_acc.business_id is not null then
    select * into v_biz from businesses where id = v_acc.business_id;
  end if;

  select price into v_base from number_catalog
   where country_code=p_country and service_code=p_service and active and stock>0
   order by price asc limit 1 for update;
  if v_base is null then raise exception 'no stock for %/%', p_country, p_service using errcode='P0002'; end if;

  v_markup := round(v_base * coalesce(v_biz.markup_percent,0)/100.0, 2);
  v_price  := ceil(v_base + v_markup);

  select balance into v_bal from tenant_wallets where account_id = v_uid for update;
  if v_bal is null or v_bal < v_price then raise exception 'insufficient balance' using errcode='P0001'; end if;

  select dial_code into v_dial from countries where code=p_country;
  update tenant_wallets set balance = balance - v_price, updated_at=now() where account_id = v_uid;
  update number_catalog set stock = stock - 1
    where country_code=p_country and service_code=p_service and active and stock>0;

  v_phone := coalesce(v_dial,'+') || ' ' ||
             lpad((floor(random()*900000000)+100000000)::text, 9, '0');

  insert into orders(user_id,country_code,service_code,phone_number,price,status,expires_at,business_id,tenant_account_id)
    values (null, p_country, p_service, v_phone, v_price, 'waiting', now() + interval '20 minutes', v_biz.id, v_uid)
    returning id into v_order;

  insert into transactions(user_id,type,amount,method,ref,tenant_account_id)
    values (null,'purchase',-v_price,p_service,'order:'||v_order,v_uid);

  if v_markup > 0 and v_biz.id is not null then
    insert into business_earnings(business_id, order_id, amount) values (v_biz.id, v_order, v_markup);
    update wallets set balance = balance + v_markup, updated_at=now() where user_id = v_biz.user_id;
    insert into transactions(user_id,type,amount,method,ref)
      values (v_biz.user_id,'business_earning',v_markup,'business','order:'||v_order);
  end if;

  return jsonb_build_object('order_id',v_order,'phone_number',v_phone,'price_ngn',v_price,
    'base_ngn',v_base,'markup_ngn',v_price - v_base,'status','waiting');
end $function$;
