-- Whole-dollar pricing.
--
-- The sell price a buyer sees and pays is a whole number of US dollars, rounded
-- to the nearest dollar (floored at $1). The NGN figure is that dollar amount at
-- the live USD->NGN rate, so the geo price always equals the dollar equivalent
-- shown next to it. The previous ceil-on-naira model rounded the naira first,
-- which left ₦2,108 (a $1.56 remainder) labelled "$2" when $2 is ₦2,700.
--
-- number_catalog.price stays the raw platform price (provider cost + platform
-- markup, in naira); the whole-dollar rounding is applied to the final figure a
-- buyer sees, after the business markup. Keeping the base raw is what makes the
-- demo's us/wa come out at $2: $1.56 rounds to $2, whereas pre-rounding the base
-- to $2 would push the marked-up price to $3.

-- Whole-dollar sell price, returned as an NGN amount (a whole multiple of the
-- live rate).
create or replace function public.sell_price_ngn(p_amount_ngn numeric, p_markup_pct numeric default 0)
returns numeric language sql stable set search_path to 'public' as $$
  with r as (select coalesce((select rate from fx_rates where code='NGN'), 1600) as rate)
  select round(
           greatest(1, round(p_amount_ngn * (1 + coalesce(p_markup_pct, 0) / 100.0) / r.rate))
           * r.rate)
  from r
$$;

-- Whole-dollar sell price as a dollar figure (for the "(≈ $n)" label).
create or replace function public.sell_price_usd(p_amount_ngn numeric, p_markup_pct numeric default 0)
returns int language sql stable set search_path to 'public' as $$
  with r as (select coalesce((select rate from fx_rates where code='NGN'), 1600) as rate)
  select greatest(1, round(p_amount_ngn * (1 + coalesce(p_markup_pct, 0) / 100.0) / r.rate))::int
  from r
$$;

-- 1. Recompute every stored price as the raw platform price (provider cost plus
--    the platform markup), in naira.
update number_catalog n
   set price = round(n.cost_usd
                     * (1 + coalesce((select value::text::numeric from settings where key='markup_percent'), 100) / 100.0)
                     * coalesce((select rate from fx_rates where code='NGN'), 1600)),
       updated_at = now()
 where n.cost_usd is not null and n.cost_usd > 0;

-- 2. catalog_upsert stores the raw platform price.
create or replace function public.catalog_upsert(p_items jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_n int := 0; it jsonb; v_markup numeric; v_rate numeric;
begin
  select coalesce((select value::text::numeric from settings where key='markup_percent'), 100) into v_markup;
  select coalesce((select rate from fx_rates where code='NGN'), 1600) into v_rate;
  for it in select * from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    insert into number_catalog(country_code, service_code, price, cost_usd, stock, active, updated_at)
    values (
      lower(it->>'country'), it->>'service',
      coalesce(
        (it->>'price_ngn')::numeric,
        round((it->>'cost_usd')::numeric * (1 + v_markup / 100.0) * v_rate)),
      (it->>'cost_usd')::numeric,
      coalesce((it->>'stock')::int, 0), coalesce((it->>'stock')::int, 0) > 0, now())
    on conflict (country_code, service_code) do update
      set price = excluded.price, cost_usd = excluded.cost_usd,
          stock = excluded.stock, active = excluded.active, updated_at = now();
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('upserted', v_n);
end $$;

-- 3. reserve_number charges the whole-dollar price (base + buyer markup).
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
  v_price  := public.sell_price_ngn(v_base, v_markup_pct);
  v_markup := v_price - public.sell_price_ngn(v_base, 0);

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

  return jsonb_build_object('order_id', v_order, 'price_ngn', v_price,
    'base_ngn', public.sell_price_ngn(v_base, 0), 'markup_ngn', v_markup,
    'price_usd', public.sell_price_usd(v_base, v_markup_pct), 'cost_usd', v_cost,
    'business_id', v_biz.id, 'tenant_account_id', p_tenant_account, 'status', 'reserved');
end $function$;

-- 4. buy_number_store charges the whole-dollar price (base + store markup).
create or replace function public.buy_number_store(p_slug text, p_country text, p_service text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  v_biz businesses%rowtype;
  v_base numeric(12,2);
  v_price numeric(12,2);
  v_markup numeric(12,2);
  v_bal numeric(14,2);
  v_order_id bigint;
  v_phone text;
  v_dial text;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where slug = p_slug and status = 'active';
  if not found then raise exception 'store not found' using errcode='P0002'; end if;

  select price into v_base from number_catalog
   where country_code=p_country and service_code=p_service and active and stock>0
   order by price asc limit 1 for update;
  if v_base is null then raise exception 'no stock for %/%', p_country, p_service using errcode='P0002'; end if;

  v_price  := public.sell_price_ngn(v_base, coalesce(v_biz.markup_percent, 0));
  v_markup := v_price - public.sell_price_ngn(v_base, 0);

  select balance into v_bal from wallets where user_id=uid for update;
  if v_bal is null or v_bal < v_price then raise exception 'insufficient balance' using errcode='P0001'; end if;

  select dial_code into v_dial from countries where code=p_country;

  update wallets set balance = balance - v_price, updated_at=now() where user_id=uid;
  update number_catalog set stock = stock - 1
    where country_code=p_country and service_code=p_service and active and stock>0;

  v_phone := coalesce(v_dial,'+') || ' ' ||
             lpad((floor(random()*900000000)+100000000)::text, 9, '0');

  insert into orders(user_id,country_code,service_code,phone_number,price,status,expires_at,business_id)
    values (uid,p_country,p_service,v_phone,v_price,'waiting', now() + interval '20 minutes', v_biz.id)
    returning id into v_order_id;

  insert into transactions(user_id,type,amount,method,ref)
    values (uid,'purchase',-v_price,p_service,'order:'||v_order_id);

  -- Store owner keeps the markup (credited to their wallet).
  if v_markup > 0 then
    insert into business_earnings(business_id, order_id, amount) values (v_biz.id, v_order_id, v_markup);
    update wallets set balance = balance + v_markup, updated_at=now() where user_id = v_biz.user_id;
    insert into transactions(user_id,type,amount,method,ref)
      values (v_biz.user_id,'business_earning',v_markup,'business','order:'||v_order_id);
  end if;

  return jsonb_build_object('order_id',v_order_id,'phone_number',v_phone,
    'price_ngn',v_price,'base_ngn',public.sell_price_ngn(v_base,0),'markup_ngn',v_markup,
    'price_usd',public.sell_price_usd(v_base, coalesce(v_biz.markup_percent,0)),
    'store',v_biz.name,'status','waiting');
end $function$;

-- 5. browse_catalog returns the whole-dollar price and its dollar figure.
create or replace function public.browse_catalog(p_country text DEFAULT NULL::text, p_service text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with buyer as (
    select coalesce(b.markup_percent, 0) as pct
    from businesses b
    where b.status = 'active' and b.user_id = auth.uid()
    limit 1
  )
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select n.id, c.code as country, c.name as country_name, c.flag,
           s.code as service, s.name as service_name, s.icon as service_icon,
           public.sell_price_ngn(n.price, coalesce((select pct from buyer), 0)) as price,
           public.sell_price_usd(n.price, coalesce((select pct from buyer), 0)) as price_usd,
           n.stock
    from number_catalog n
    join countries c on c.code = n.country_code
    join services  s on s.code = n.service_code
    where n.active
      and (p_country is null or n.country_code = p_country)
      and (p_service is null or n.service_code = p_service)
    order by n.price asc
  ) x;
$function$;

-- 6. business_public returns the whole-dollar price and its dollar figure.
create or replace function public.business_public(p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select jsonb_build_object(
      'name', b.name, 'slug', b.slug, 'theme', b.theme,
      'markup_percent', b.markup_percent, 'status', b.status,
      'catalog', (select coalesce(jsonb_agg(jsonb_build_object(
          'country', c.code, 'country_name', c.name, 'flag', c.flag,
          'service', s.code, 'service_name', s.name, 'icon', s.icon,
          'price_ngn', public.sell_price_ngn(n.price, b.markup_percent),
          'price_usd', public.sell_price_usd(n.price, b.markup_percent),
          'stock', n.stock)), '[]'::jsonb)
        from number_catalog n
        join countries c on c.code = n.country_code
        join services  s on s.code = n.service_code
        where n.active and n.stock > 0))
    from businesses b where b.slug = p_slug and b.status = 'active'
  ), 'null'::jsonb);
$function$;
