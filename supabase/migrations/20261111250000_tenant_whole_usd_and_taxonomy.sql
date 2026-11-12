-- Whole-dollar pricing for the tenant storefront, plus a server-side catalog
-- taxonomy so the browser never has to hit the Next.js/backend for it.

-- tenant_buy_number charges the whole-dollar price (base + store markup).
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

  v_price  := public.sell_price_ngn(v_base, coalesce(v_biz.markup_percent, 0));
  v_markup := v_price - public.sell_price_ngn(v_base, 0);

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
    'base_ngn',public.sell_price_ngn(v_base,0),'markup_ngn',v_markup,
    'price_usd',public.sell_price_usd(v_base, coalesce(v_biz.markup_percent,0)),
    'status','waiting');
end $function$;

-- The full service + country taxonomy, one row per display name (a stocked
-- canonical code wins over a stockless alias). Server-side so the picker never
-- calls the backend for it.
create or replace function public.catalog_taxonomy()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with stocked as (
    select service_code, count(*) as n
      from number_catalog
     where active and stock > 0
     group by service_code
  ), ranked as (
    select s.code, s.name, s.icon,
           row_number() over (
             partition by lower(coalesce(s.name, s.code))
             order by coalesce(st.n, 0) desc, s.code
           ) as rn
      from services s
      left join stocked st on st.service_code = s.code
  )
  select jsonb_build_object(
    'services', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'icon', icon)
                                order by name), '[]'::jsonb)
        from ranked where rn = 1),
    'countries', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'flag', flag)
                                order by name), '[]'::jsonb)
        from countries)
  );
$function$;
