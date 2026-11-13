-- Root-scoped business lookups (Task 4).
--
-- Once a user may own a root store plus nested child stores, every "the user's
-- store" lookup must be scoped to the ROOT row (parent_id is null) so a child
-- store is never mistaken for the account's own storefront. These bodies mirror
-- the definitions live in the project database.

CREATE OR REPLACE FUNCTION public.my_business()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select to_jsonb(b) - 'user_id' from businesses b where b.user_id = auth.uid() and b.parent_id is null), 'null'::jsonb);
$function$;

CREATE OR REPLACE FUNCTION public.my_business_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid := auth.uid(); v_biz businesses%rowtype;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid and parent_id is null;
  if not found then return 'null'::jsonb; end if;
  return jsonb_build_object(
    'slug', v_biz.slug, 'name', v_biz.name, 'theme', v_biz.theme,
    'markup_percent', v_biz.markup_percent, 'status', v_biz.status,
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
end $function$;

CREATE OR REPLACE FUNCTION public.business_set_branding(p_logo_url text DEFAULT NULL::text, p_tagline text DEFAULT NULL::text, p_support_email text DEFAULT NULL::text, p_primary text DEFAULT NULL::text, p_secondary text DEFAULT NULL::text, p_domain text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid := auth.uid(); v_biz businesses%rowtype; v_domain text;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid and parent_id is null;
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
end $function$;

CREATE OR REPLACE FUNCTION public.request_payout(p_amount numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  v_biz businesses%rowtype;
  v_earned numeric(14,2);
  v_available numeric(14,2);
  v_amount numeric(14,2);
  v_payout bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid and parent_id is null for update;
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
end $function$;

CREATE OR REPLACE FUNCTION public.purchase_business()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid := auth.uid(); v_b businesses%rowtype; v_price numeric(14,2); v_bal numeric(14,2);
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_b from businesses where user_id = uid and parent_id is null for update;
  if not found then raise exception 'create your store first' using errcode='P0002'; end if;
  if v_b.status = 'active' then return jsonb_build_object('already_active', true, 'slug', v_b.slug); end if;
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
    'paid_ngn', v_price, 'paid_usd', 20, 'store_url', '/store/' || v_b.slug);
end $function$;

CREATE OR REPLACE FUNCTION public.request_app_build(p_version text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  v_biz businesses%rowtype;
  v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid and parent_id is null;
  if not found then raise exception 'create your store first' using errcode='P0002'; end if;
  if v_biz.status <> 'active' then raise exception 'activate your store first' using errcode='P0002'; end if;
  insert into app_builds(business_id, version, status)
    values (v_biz.id, coalesce(nullif(trim(p_version),''), '1.0.0'), 'queued')
    returning id into v_id;
  update businesses set app_status = 'building', updated_at = now() where id = v_biz.id;
  return jsonb_build_object('id', v_id, 'status', 'queued', 'version', coalesce(p_version,'1.0.0'));
end $function$;

CREATE OR REPLACE FUNCTION public.my_onboarding()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  v_items jsonb;
  v_orders int;
  v_key int;
  v_funded numeric;
  v_biz int;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select count(*) into v_orders from orders where user_id = uid;
  select count(*) into v_key from api_keys where user_id=uid and not revoked;
  select count(*) into v_biz from businesses where user_id = uid and parent_id is null;
  select coalesce(sum(amount),0) into v_funded from transactions where user_id=uid and type='fund' and amount>0;

  v_items := jsonb_build_array(
    jsonb_build_object('key','verify_email','label','Verify your email','href','/dashboard/profile/',
      'done', coalesce((select done from onboarding_state where user_id=uid and item_key='verify_email'), false)),
    jsonb_build_object('key','fund_wallet','label','Fund your wallet','href','/dashboard/wallet/','done', v_funded > 0),
    jsonb_build_object('key','first_number','label','Buy your first number','href','/dashboard/buy/','done', v_orders > 0),
    jsonb_build_object('key','receive_sms','label','Receive an SMS code','href','/dashboard/sms/',
      'done', exists (select 1 from sms_messages m join orders o on o.id=m.order_id where o.user_id=uid)),
    jsonb_build_object('key','api_key','label','Create an API key','href','/dashboard/api-keys/','done', v_key > 0),
    jsonb_build_object('key','store','label','Launch your own store','href','/dashboard/business/','done', v_biz > 0)
  );
  return jsonb_build_object(
    'items', v_items,
    'done', (select count(*) from jsonb_array_elements(v_items) e where (e->>'done')::boolean),
    'total', jsonb_array_length(v_items),
    'dismissed', coalesce((select done from onboarding_state where user_id=uid and item_key='__dismissed'), false));
end $function$;

CREATE OR REPLACE FUNCTION public.my_launch_checklist()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select jsonb_build_object(
      'items', jsonb_build_array(
        jsonb_build_object('key','branding','label','Set your branding','href','/dashboard/business/','done', b.primary_color is not null or b.logo_url is not null),
        jsonb_build_object('key','pricing','label','Set your markup','href','/dashboard/business/','done', coalesce(b.markup_percent,0) > 0),
        jsonb_build_object('key','payments','label','Connect payments','href','/dashboard/business/','done', b.status='active'),
        jsonb_build_object('key','legal','label','Publish legal pages','href','/dashboard/business/','done', b.support_email is not null),
        jsonb_build_object('key','first_order','label','Run a first test order','href','/store/'||b.slug||'/','done', exists(select 1 from orders o where o.business_id=b.id))
      ),
      'slug', b.slug, 'status', b.status)
    from businesses b where b.user_id = auth.uid() and b.parent_id is null), 'null'::jsonb);
$function$;

CREATE OR REPLACE FUNCTION public.my_payouts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select jsonb_build_object(
      'earned_ngn', coalesce((select sum(amount) from business_earnings e where e.business_id = b.id), 0),
      'paid_ngn', b.earnings_paid,
      'available_ngn', greatest(0, coalesce((select sum(amount) from business_earnings e where e.business_id = b.id), 0) - b.earnings_paid),
      'payouts', coalesce((select jsonb_agg(jsonb_build_object(
          'id', p.id, 'amount', p.amount, 'method', p.method, 'status', p.status,
          'reference', p.reference, 'created_at', p.created_at) order by p.created_at desc)
        from tenant_payouts p where p.business_id = b.id), '[]'::jsonb))
    from businesses b where b.user_id = auth.uid() and b.parent_id is null
  ), 'null'::jsonb);
$function$;

CREATE OR REPLACE FUNCTION public.tenant_api_key_create(p_name text DEFAULT 'default'::text, p_scopes text[] DEFAULT ARRAY['read'::text], p_webhook_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  uid uuid := auth.uid();
  v_biz businesses%rowtype;
  v_secret text; v_prefix text; v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid and parent_id is null;
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
end $function$;

CREATE OR REPLACE FUNCTION public.create_business(p_name text, p_theme text DEFAULT 'crimson'::text, p_markup numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid := auth.uid(); v_slug text; v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'store name required' using errcode='22023'; end if;
  v_slug := trim(both '-' from lower(regexp_replace(p_name, '[^a-zA-Z0-9]+', '-', 'g')));
  if v_slug = '' then v_slug := 'store'; end if;
  while exists (select 1 from businesses where slug = v_slug and user_id <> uid) loop
    v_slug := v_slug || '-' || substr(md5(random()::text), 1, 4);
  end loop;
  insert into businesses(user_id, name, slug, theme, markup_percent, status)
    values (uid, trim(p_name), v_slug, coalesce(p_theme,'crimson'),
            greatest(0, coalesce(p_markup,0)), 'draft')
  on conflict (user_id) where parent_id is null do update
    set name = excluded.name, theme = excluded.theme,
        markup_percent = excluded.markup_percent, slug = excluded.slug, updated_at = now()
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'slug', v_slug, 'name', trim(p_name),
    'theme', coalesce(p_theme,'crimson'),
    'markup_percent', greatest(0, coalesce(p_markup,0)), 'status', 'draft');
end $function$;

CREATE OR REPLACE FUNCTION public.reserve_number(p_user uuid, p_country text, p_service text, p_tenant_account uuid DEFAULT NULL::uuid, p_operator integer DEFAULT NULL::integer)
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
    select * into v_biz from businesses where user_id = p_user and parent_id is null and status = 'active' limit 1;
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

CREATE OR REPLACE FUNCTION public.reserve_rental(p_user uuid, p_country text, p_service text, p_duration integer, p_price_ngn numeric, p_tenant_account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bal numeric(14,2); v_order bigint; v_biz businesses%rowtype;
  v_price numeric(12,2) := round(coalesce(p_price_ngn, 0));
begin
  if p_user is null and p_tenant_account is null then
    raise exception 'no buyer' using errcode='28000';
  end if;
  if v_price <= 0 then
    raise exception 'invalid rental price' using errcode='P0001';
  end if;

  if p_tenant_account is not null then
    select b.* into v_biz from tenant_accounts a join businesses b on b.id = a.business_id
     where a.id = p_tenant_account;
  elsif p_user is not null then
    select * into v_biz from businesses where user_id = p_user and parent_id is null and status = 'active' limit 1;
  end if;

  if p_tenant_account is not null then
    select balance into v_bal from tenant_wallets where account_id = p_tenant_account for update;
    if v_bal is null or v_bal < v_price then raise exception 'insufficient balance' using errcode='P0001'; end if;
    update tenant_wallets set balance = balance - v_price, updated_at = now() where account_id = p_tenant_account;
  else
    select balance into v_bal from wallets where user_id = p_user for update;
    if v_bal is null or v_bal < v_price then raise exception 'insufficient balance' using errcode='P0001'; end if;
    update wallets set balance = balance - v_price, updated_at = now() where user_id = p_user;
  end if;

  insert into orders(user_id, country_code, service_code, phone_number, price, status,
                     expires_at, business_id, tenant_account_id, upstream_status)
    values (p_user, lower(p_country), p_service, '', v_price, 'waiting',
            now() + make_interval(hours => greatest(1, coalesce(p_duration, 24))),
            v_biz.id, p_tenant_account, 'rental')
    returning id into v_order;

  insert into transactions(user_id, type, amount, method, ref, tenant_account_id)
    values (p_user, 'purchase', -v_price, 'rental:' || p_service, 'order:' || v_order, p_tenant_account);

  return jsonb_build_object('order_id', v_order, 'price_ngn', v_price,
    'business_id', v_biz.id, 'tenant_account_id', p_tenant_account,
    'duration', greatest(1, coalesce(p_duration, 24)), 'status', 'reserved');
end $function$;

CREATE OR REPLACE FUNCTION public.api_catalog(p_user uuid, p_country text DEFAULT NULL::text, p_service text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'country', c.code, 'country_name', c.name, 'flag', c.flag,
    'service', s.code, 'service_name', s.name, 'icon', s.icon,
    'price_ngn', round(n.price * (1 + coalesce(b.markup_percent,0)/100.0), 2),
    'stock', n.stock)), '[]'::jsonb)
  from number_catalog n
  join countries c on c.code = n.country_code
  join services  s on s.code = n.service_code
  left join businesses b on b.user_id = p_user and b.parent_id is null and b.status = 'active'
  where n.active and n.stock > 0
    and (p_country is null or n.country_code = p_country)
    and (p_service is null or n.service_code = p_service);
$function$;

CREATE OR REPLACE FUNCTION public.business_app_status()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select jsonb_build_object('app_status',b.app_status,'plan',b.plan,
      'latest_build',(select jsonb_build_object('id',a.id,'status',a.status,'version',a.version,
        'created_at',a.created_at,'size_bytes',a.size_bytes) from app_builds a where a.business_id=b.id
        order by a.created_at desc limit 1))
    from businesses b where b.user_id=auth.uid() and b.parent_id is null), 'null'::jsonb);
$function$;
