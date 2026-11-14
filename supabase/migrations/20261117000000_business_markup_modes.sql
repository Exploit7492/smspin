-- Markup by percentage OR fixed price, and host-base strikethrough pricing.
--
-- A store used to price only by markup_percent applied to the platform base.
-- Two things were missing:
--   1. A host may prefer a flat margin (e.g. "+₦500 per number") instead of a
--      percentage, so businesses gain markup_mode ('percent'|'fixed') and
--      markup_fixed_ngn.
--   2. A store created *from a tenant account* is a child of that tenant, and
--      the tenant becomes its host. The child's selling price is the host's
--      selling price plus the child's own markup, and the figure the child
--      strikes out is the host's price (its "base"), not the raw platform cost.
--
-- biz_sell_price_ngn walks the parent chain root-first, applying each level's
-- markup, so a price is always (platform base -> root markup -> ... -> this
-- business). biz_host_base_ngn returns the immediate parent's sell price (the
-- strikethrough), or the platform base for a root business.

alter table public.businesses
  add column if not exists markup_mode text not null default 'percent',
  add column if not exists markup_fixed_ngn numeric(12,2) not null default 0;

-- Guard the mode to the two supported values.
do $$ begin
  alter table public.businesses
    add constraint businesses_markup_mode_chk check (markup_mode in ('percent','fixed'));
exception when duplicate_object then null; end $$;

-- Apply one business's own markup to an incoming base amount.
create or replace function public.biz_apply_markup(p_business_id bigint, p_base_ngn numeric)
returns numeric language plpgsql stable security definer set search_path to 'public' as $$
declare v_mode text; v_pct numeric; v_fixed numeric;
begin
  select coalesce(markup_mode,'percent'), coalesce(markup_percent,0), coalesce(markup_fixed_ngn,0)
    into v_mode, v_pct, v_fixed
    from businesses where id = p_business_id;
  if v_mode = 'fixed' then
    return public.sell_price_ngn(p_base_ngn, 0) + greatest(0, v_fixed);
  end if;
  return public.sell_price_ngn(p_base_ngn, v_pct);
end $$;

-- Full sell price for a business: platform base marked up along its whole
-- parent chain (root first, then each descendant).
create or replace function public.biz_sell_price_ngn(p_business_id bigint, p_base_ngn numeric)
returns numeric language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_chain bigint[] := '{}'; v_cur bigint := p_business_id; v_guard int := 0;
  v_price numeric := public.sell_price_ngn(p_base_ngn, 0); v_id bigint;
begin
  while v_cur is not null and v_guard < 32 loop
    v_chain := array_prepend(v_cur, v_chain);
    select parent_id into v_cur from businesses where id = v_cur;
    v_guard := v_guard + 1;
  end loop;
  foreach v_id in array v_chain loop
    v_price := public.biz_apply_markup(v_id, v_price);
  end loop;
  return v_price;
end $$;

-- The host's base amount (the strikethrough): the immediate parent's sell
-- price, or the platform base when the business is itself the host (root).
create or replace function public.biz_host_base_ngn(p_business_id bigint, p_base_ngn numeric)
returns numeric language plpgsql stable security definer set search_path to 'public' as $$
declare v_parent bigint;
begin
  select parent_id into v_parent from businesses where id = p_business_id;
  if v_parent is null then return public.sell_price_ngn(p_base_ngn, 0); end if;
  return public.biz_sell_price_ngn(v_parent, p_base_ngn);
end $$;

create or replace function public.biz_sell_price_usd(p_business_id bigint, p_base_ngn numeric)
returns int language plpgsql stable security definer set search_path to 'public' as $$
declare v_rate numeric := coalesce((select rate from fx_rates where code='NGN'), 1600);
begin
  return greatest(2, round(public.biz_sell_price_ngn(p_business_id, p_base_ngn) / v_rate))::int;
end $$;

-- ---------------------------------------------------------------------------
-- Readers: storefront + tenant catalog now expose price_ngn, base_ngn (host
-- base, for the strikethrough) and price_usd from the chain functions.
-- ---------------------------------------------------------------------------
create or replace function public.business_public(p_slug text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select jsonb_build_object(
      'name', b.name, 'slug', b.slug, 'theme', b.theme,
      'markup_percent', b.markup_percent, 'markup_mode', b.markup_mode,
      'markup_fixed_ngn', b.markup_fixed_ngn, 'status', b.status,
      'catalog', (select coalesce(jsonb_agg(jsonb_build_object(
          'country', c.code, 'country_name', c.name, 'flag', c.flag,
          'service', s.code, 'service_name', s.name, 'icon', s.icon,
          'price_ngn', public.biz_sell_price_ngn(b.id, n.price),
          'base_ngn', public.biz_host_base_ngn(b.id, n.price),
          'price_usd', public.biz_sell_price_usd(b.id, n.price),
          'stock', n.stock)), '[]'::jsonb)
        from number_catalog n
        join countries c on c.code = n.country_code
        join services  s on s.code = n.service_code
        where n.active and n.stock > 0))
    from businesses b where b.slug = p_slug and b.status = 'active'
  ), 'null'::jsonb);
$$;

create or replace function public.tenant_browse_catalog(p_slug text, p_country text default null, p_service text default null)
returns jsonb language sql security definer set search_path to 'public' as $$
  with biz as (select id from businesses where slug=p_slug and status='active' limit 1)
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select n.id, c.code as country, c.name as country_name, c.flag,
           s.code as service, s.name as service_name, s.icon as service_icon,
           public.biz_sell_price_ngn((select id from biz), n.price) as price,
           public.biz_host_base_ngn((select id from biz), n.price) as base,
           public.biz_sell_price_usd((select id from biz), n.price) as price_usd,
           n.stock
    from number_catalog n join countries c on c.code=n.country_code join services s on s.code=n.service_code
    where n.active and n.stock>0
      and (p_country is null or n.country_code=p_country)
      and (p_service is null or n.service_code=p_service)
    order by n.price asc
  ) x;
$$;

-- Dashboard catalog for the signed-in buyer: their own store's chain pricing,
-- plus the host base for the strikethrough.
create or replace function public.browse_catalog(p_country text default null, p_service text default null)
returns jsonb language sql security definer set search_path to 'public' as $$
  with buyer as (
    select b.id from businesses b where b.status='active' and b.user_id=auth.uid() limit 1
  )
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select n.id, c.code as country, c.name as country_name, c.flag,
           s.code as service, s.name as service_name, s.icon as service_icon,
           public.biz_sell_price_ngn((select id from buyer), n.price) as price,
           public.biz_host_base_ngn((select id from buyer), n.price) as base,
           public.biz_sell_price_usd((select id from buyer), n.price) as price_usd,
           n.stock
    from number_catalog n
    join countries c on c.code = n.country_code
    join services  s on s.code = n.service_code
    where n.active
      and (p_country is null or n.country_code = p_country)
      and (p_service is null or n.service_code = p_service)
    order by n.price asc
  ) x;
$$;

-- ---------------------------------------------------------------------------
-- Writers: charge exactly the chain price so the displayed figure is debited.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_number(
  p_user uuid, p_country text, p_service text,
  p_tenant_account uuid default null, p_operator integer default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_base numeric(12,2); v_markup numeric(12,2); v_price numeric(12,2);
  v_bal numeric(14,2); v_order bigint; v_biz businesses%rowtype;
  v_cost numeric(12,4); v_host numeric(12,2);
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

  if v_biz.id is null then
    v_price := public.sell_price_ngn(v_base, 0);
    v_host  := v_price;
  else
    v_price := public.biz_sell_price_ngn(v_biz.id, v_base);
    v_host  := public.biz_host_base_ngn(v_biz.id, v_base);
  end if;
  v_markup := v_price - v_host;

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
    'base_ngn', v_host, 'markup_ngn', v_markup,
    'price_usd', greatest(2, round(v_price / coalesce((select rate from fx_rates where code='NGN'),1600)))::int,
    'cost_usd', v_cost, 'business_id', v_biz.id, 'tenant_account_id', p_tenant_account, 'status', 'reserved');
end $$;

create or replace function public.buy_number_store(p_slug text, p_country text, p_service text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  uid uuid := auth.uid(); v_biz businesses%rowtype;
  v_base numeric(12,2); v_price numeric(12,2); v_markup numeric(12,2); v_host numeric(12,2);
  v_bal numeric(14,2); v_order_id bigint; v_phone text; v_dial text;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where slug = p_slug and status = 'active';
  if not found then raise exception 'store not found' using errcode='P0002'; end if;

  select price into v_base from number_catalog
   where country_code=p_country and service_code=p_service and active and stock>0
   order by price asc limit 1 for update;
  if v_base is null then raise exception 'no stock for %/%', p_country, p_service using errcode='P0002'; end if;

  v_price := public.biz_sell_price_ngn(v_biz.id, v_base);
  v_host  := public.biz_host_base_ngn(v_biz.id, v_base);
  v_markup := v_price - v_host;

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

  if v_markup > 0 then
    insert into business_earnings(business_id, order_id, amount) values (v_biz.id, v_order_id, v_markup);
    update wallets set balance = balance + v_markup, updated_at=now() where user_id = v_biz.user_id;
    insert into transactions(user_id,type,amount,method,ref)
      values (v_biz.user_id,'business_earning',v_markup,'business','order:'||v_order_id);
  end if;

  return jsonb_build_object('order_id',v_order_id,'phone_number',v_phone,
    'price_ngn',v_price,'base_ngn',v_host,'markup_ngn',v_markup,
    'price_usd', greatest(2, round(v_price / coalesce((select rate from fx_rates where code='NGN'),1600)))::int,
    'store',v_biz.name,'status','waiting');
end $$;

create or replace function public.tenant_buy_number(p_token text, p_country text, p_service text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_uid uuid := tenant_resolve(p_token);
  v_acc tenant_accounts%rowtype; v_biz businesses%rowtype;
  v_base numeric(12,2); v_price numeric(12,2); v_markup numeric(12,2); v_host numeric(12,2);
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

  if v_biz.id is null then
    v_price := public.sell_price_ngn(v_base, 0); v_host := v_price;
  else
    v_price := public.biz_sell_price_ngn(v_biz.id, v_base);
    v_host  := public.biz_host_base_ngn(v_biz.id, v_base);
  end if;
  v_markup := v_price - v_host;

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
    'base_ngn',v_host,'markup_ngn',v_markup,
    'price_usd', greatest(2, round(v_price / coalesce((select rate from fx_rates where code='NGN'),1600)))::int,
    'status','waiting');
end $$;

-- ---------------------------------------------------------------------------
-- Writers: let owners set markup by percent or by a fixed naira amount.
-- ---------------------------------------------------------------------------
create or replace function public.create_business(
  p_name text, p_theme text default 'crimson', p_markup numeric default 0,
  p_markup_mode text default 'percent', p_markup_fixed numeric default 0)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v_slug text; v_id bigint; v_mode text := coalesce(nullif(p_markup_mode,''),'percent');
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'store name required' using errcode='22023'; end if;
  if v_mode not in ('percent','fixed') then raise exception 'invalid markup mode' using errcode='22023'; end if;
  v_slug := trim(both '-' from lower(regexp_replace(p_name, '[^a-zA-Z0-9]+', '-', 'g')));
  if v_slug = '' then v_slug := 'store'; end if;
  while exists (select 1 from businesses where slug = v_slug and user_id <> uid) loop
    v_slug := v_slug || '-' || substr(md5(random()::text), 1, 4);
  end loop;
  insert into businesses(user_id, name, slug, theme, markup_percent, markup_mode, markup_fixed_ngn, status)
    values (uid, trim(p_name), v_slug, coalesce(p_theme,'crimson'),
            greatest(0, coalesce(p_markup,0)), v_mode, greatest(0, coalesce(p_markup_fixed,0)), 'draft')
  on conflict (user_id) where parent_id is null do update
    set name = excluded.name, theme = excluded.theme,
        markup_percent = excluded.markup_percent, markup_mode = excluded.markup_mode,
        markup_fixed_ngn = excluded.markup_fixed_ngn, slug = excluded.slug, updated_at = now()
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'slug', v_slug, 'name', trim(p_name),
    'theme', coalesce(p_theme,'crimson'), 'markup_percent', greatest(0, coalesce(p_markup,0)),
    'markup_mode', v_mode, 'markup_fixed_ngn', greatest(0, coalesce(p_markup_fixed,0)), 'status', 'draft');
end $$;

create or replace function public.create_child_business(
  p_name text, p_parent_slug text default null, p_theme text default null,
  p_markup numeric default null, p_markup_mode text default null, p_markup_fixed numeric default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  uid uuid := auth.uid(); v_parent businesses%rowtype; v_slug text; v_id bigint;
  v_mode text := coalesce(nullif(p_markup_mode,''), 'percent');
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'store name required' using errcode='22023'; end if;
  if v_mode not in ('percent','fixed') then raise exception 'invalid markup mode' using errcode='22023'; end if;

  select * into v_parent from businesses where user_id = uid and parent_id is null for update;
  if not found then raise exception 'create your store first' using errcode='P0002'; end if;

  v_slug := trim(both '-' from lower(regexp_replace(p_name, '[^a-zA-Z0-9]+', '-', 'g')));
  if v_slug = '' then v_slug := 'store'; end if;
  while exists (select 1 from businesses where slug = v_slug) loop
    v_slug := v_slug || '-' || substr(md5(random()::text), 1, 4);
  end loop;

  insert into businesses(user_id, name, slug, theme, markup_percent, markup_mode, markup_fixed_ngn, status, parent_id, root_id)
    values (uid, trim(p_name), v_slug, coalesce(p_theme, v_parent.theme, 'crimson'),
            greatest(0, coalesce(p_markup, v_parent.markup_percent, 0)), v_mode,
            greatest(0, coalesce(p_markup_fixed, 0)), 'draft', v_parent.id, v_parent.root_id)
    returning id into v_id;

  return jsonb_build_object('id', v_id, 'slug', v_slug, 'name', trim(p_name),
    'parent_id', v_parent.id, 'root_id', v_parent.root_id,
    'markup_mode', v_mode, 'status', 'draft');
end $$;

create or replace function public.tenant_set_markup(p_token text, p_percent numeric, p_mode text default 'percent', p_fixed numeric default 0)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; v_mode text := coalesce(nullif(p_mode,''),'percent');
begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  if v_biz is null then raise exception 'no store attached' using errcode='P0001'; end if;
  if v_mode not in ('percent','fixed') then raise exception 'invalid markup mode' using errcode='P0001'; end if;
  if v_mode = 'percent' and (p_percent is null or p_percent < 0 or p_percent > 1000) then raise exception 'invalid markup' using errcode='P0001'; end if;
  if v_mode = 'fixed' and (p_fixed is null or p_fixed < 0) then raise exception 'invalid markup' using errcode='P0001'; end if;
  update businesses set markup_percent = coalesce(p_percent, markup_percent),
                        markup_mode = v_mode,
                        markup_fixed_ngn = greatest(0, coalesce(p_fixed,0)),
                        updated_at = now()
   where id = v_biz;
  return jsonb_build_object('markup_mode', v_mode, 'markup_percent', coalesce(p_percent,0), 'markup_fixed_ngn', greatest(0, coalesce(p_fixed,0)));
end $$;

-- Surface the markup mode/amount to the owner's performance panel.
create or replace function public.my_business_stats()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v_biz businesses%rowtype;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid and parent_id is null;
  if not found then return 'null'::jsonb; end if;
  return jsonb_build_object(
    'slug', v_biz.slug, 'name', v_biz.name, 'theme', v_biz.theme,
    'markup_percent', v_biz.markup_percent,
    'markup_mode', v_biz.markup_mode, 'markup_fixed_ngn', v_biz.markup_fixed_ngn,
    'status', v_biz.status,
    'orders', (select count(*) from orders o where o.business_id = v_biz.id),
    'earned_ngn', coalesce((select sum(amount) from business_earnings e where e.business_id = v_biz.id), 0),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', t.status, 'n', t.n) order by t.n desc) from (
        select o.status, count(*) as n from orders o where o.business_id = v_biz.id group by o.status) t), '[]'::jsonb),
    'by_service', coalesce((select jsonb_agg(jsonb_build_object('service', t.service, 'icon', t.icon, 'n', t.n) order by t.n desc) from (
        select s.name as service, s.icon, count(*) as n
        from orders o join services s on s.code = o.service_code
        where o.business_id = v_biz.id group by s.name, s.icon) t), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(x) from (
        select o.id, o.phone_number, o.status, o.price, o.created_at,
               c.name as country_name, c.flag, s.name as service_name
        from orders o
        join countries c on c.code=o.country_code
        join services s on s.code=o.service_code
        where o.business_id = v_biz.id order by o.created_at desc limit 8) x), '[]'::jsonb));
end $$;
