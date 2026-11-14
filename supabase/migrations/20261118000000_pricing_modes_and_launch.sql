-- Pricing modes, launch resolution, and a real-price preview.
--
-- 1. create_business was defined twice: a 3-arg form (name, theme, markup) and
--    the 5-arg form that also carries the pricing mode. PostgREST cannot choose
--    between them for a call that names only the first three arguments, so
--    every "Launch store" failed with "Could not choose the best candidate
--    function". The 3-arg overload is dropped; the 5-arg form has defaults, so
--    older callers keep working.
--
-- 2. Fixed markup must add the whole amount and never undercharge, so it is
--    applied to the raw base and then rounded UP to a whole dollar. Percentage
--    markup is a true percentage increase, rounded to the nearest whole dollar
--    (the buyer-facing rule from sell_price_ngn).
--
-- 3. business_markup_preview returns REAL in-stock catalog rows priced with the
--    chosen mode, so the wizard shows the same figures a buyer will pay instead
--    of a hard-coded sample.

-- ---------------------------------------------------------------- 1. overload
drop function if exists public.create_business(text, text, numeric);

-- ------------------------------------------- 2. markup applied from raw base
-- Apply one markup (mode + amount) to an incoming base amount.
create or replace function public.biz_markup_amount(
  p_base_ngn numeric, p_mode text, p_pct numeric, p_fixed numeric)
returns numeric language plpgsql stable set search_path to 'public' as $$
declare v_rate numeric := coalesce((select rate from fx_rates where code='NGN'), 1600);
begin
  if coalesce(p_mode, 'percent') = 'fixed' then
    -- Add the whole fixed amount, then round UP to a whole dollar so the store
    -- never sells below its host price plus the margin it asked for.
    return greatest(2 * v_rate, ceil((coalesce(p_base_ngn, 0) + greatest(0, coalesce(p_fixed, 0))) / v_rate) * v_rate);
  end if;
  return public.sell_price_ngn(coalesce(p_base_ngn, 0), greatest(0, coalesce(p_pct, 0)));
end $$;

create or replace function public.biz_apply_markup(p_business_id bigint, p_base_ngn numeric)
returns numeric language plpgsql stable security definer set search_path to 'public' as $$
declare v_mode text; v_pct numeric; v_fixed numeric;
begin
  select coalesce(markup_mode,'percent'), coalesce(markup_percent,0), coalesce(markup_fixed_ngn,0)
    into v_mode, v_pct, v_fixed
    from businesses where id = p_business_id;
  if not found then return public.sell_price_ngn(coalesce(p_base_ngn,0), 0); end if;
  return public.biz_markup_amount(p_base_ngn, v_mode, v_pct, v_fixed);
end $$;

-- ------------------------------------------------- 3. real-price preview RPC
-- A few real, in-stock numbers priced for a store that does not exist yet
-- (root store: host base = platform sell price) or for the signed-in store's
-- own chain. Accepts the *unsaved* mode/amount so the wizard previews live.
create or replace function public.business_markup_preview(
  p_mode text default 'percent', p_percent numeric default 0, p_fixed numeric default 0)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_biz bigint;
  v_mode text := case when p_mode = 'fixed' then 'fixed' else 'percent' end;
  v_rate numeric := coalesce((select rate from fx_rates where code='NGN'), 1600);
begin
  select b.id into v_biz from businesses b
   where b.status = 'active' and b.user_id = auth.uid() and b.parent_id is null
   limit 1;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'country', x.country_code, 'country_name', x.country_name, 'flag', x.flag,
      'service', x.service_code, 'service_name', x.service_name, 'icon', x.icon,
      'base_ngn', x.base, 'price_ngn', x.ours,
      'price_usd', greatest(2, round(x.ours / v_rate))::int))
    from (
      select * from (
        select c.code as country_code, c.name as country_name, c.flag,
               s.code as service_code, s.name as service_name, s.icon,
               public.biz_host_base_ngn(v_biz, n.price) as base,
               public.biz_markup_amount(public.biz_host_base_ngn(v_biz, n.price), v_mode, p_percent, p_fixed) as ours,
               row_number() over (order by n.price asc, n.id) as rn,
               count(*) over () as cnt
        from number_catalog n
        join countries c on c.code = n.country_code
        join services  s on s.code = n.service_code
        where n.active and n.stock > 0
      ) r
      -- Cheapest, median and dearest in-stock numbers, so the preview shows how
      -- the markup moves a low and a high base, not three identical rows.
      where r.rn in (1, greatest(1, r.cnt / 2), r.cnt)
      order by r.base asc
    ) x
  ), '[]'::jsonb);
end $$;

-- ------------------------------------------- 4. canonical storefront URL
-- Tenants are served at the root path (smspin.io/<slug>); /store/<slug> still
-- resolves for old links. The launch response returns the canonical form.
create or replace function public.purchase_business()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v_b businesses%rowtype; v_price numeric(14,2); v_bal numeric(14,2);
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_b from businesses where user_id = uid and parent_id is null for update;
  if not found then raise exception 'create your store first' using errcode='P0002'; end if;
  if v_b.status = 'active' then return jsonb_build_object('already_active', true, 'slug', v_b.slug, 'store_url', '/' || v_b.slug); end if;
  v_price := round(20 * coalesce((select rate from fx_rates where code='NGN'), 1), 2);
  select balance into v_bal from wallets where user_id = uid for update;
  if v_bal is null or v_bal < v_price then
    return jsonb_build_object('insufficient', true, 'required_ngn', v_price, 'balance', coalesce(v_bal,0));
  end if;
  update wallets set balance = balance - v_price, updated_at = now() where user_id = uid;
  insert into transactions(user_id, type, amount, method, ref)
    values (uid, 'purchase', -v_price, 'business', 'business:' || v_b.id);
  update businesses set status = 'active', paid_ngn = v_price, paid_usd = 20,
    app_status = 'provisioned', updated_at = now() where id = v_b.id;
  return jsonb_build_object('activated', true, 'slug', v_b.slug,
    'paid_ngn', v_price, 'paid_usd', 20, 'store_url', '/' || v_b.slug);
end $$;

-- ------------------------------------------------- 5. build row for dispatch
-- The edge dispatches the CI workflow from this row and returns it to the
-- dashboard, so it carries the store's branding and the current build status.
create or replace function public.app_build_row(p_id bigint)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', a.id, 'business_id', a.business_id, 'version', a.version, 'status', a.status,
    'size_bytes', a.size_bytes, 'created_at', a.created_at, 'built_at', a.built_at,
    'download_url', case when a.status='ready' and a.download_token is not null
      then '/api/app/download/'||a.download_token else null end,
    'slug', b.slug, 'name', b.name, 'primary_color', b.primary_color,
    'secondary_color', b.secondary_color, 'tagline', b.tagline,
    'support_email', b.support_email, 'logo_url', b.logo_url, 'domain', b.domain)
  from app_builds a join businesses b on b.id = a.business_id
  where a.id = p_id;
$$;
