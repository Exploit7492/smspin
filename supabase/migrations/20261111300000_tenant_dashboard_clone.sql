-- Tenant dashboards are verbatim clones of the main app: the SAME HTML/CSS/JS
-- files under /dashboard and /admin are served for every store. Only the data
-- layer differs, because tenant rows are keyed by tenant_account_id (a store
-- account) instead of auth.uid() (a Supabase user).
--
-- These functions take the tenant's opaque session token and return the exact
-- same JSON shapes as their auth.uid()-based counterparts, so the shared
-- frontend renders unchanged. Adding a widget to the main dashboard therefore
-- lands on every tenant automatically, as long as the underlying RPC name has
-- a tenant_* twin here.

-- Resolve the caller's store business once; every function below starts here.
create or replace function public.tenant_ctx(p_token text)
returns table(account_id uuid, business_id bigint, slug text, name text, theme text)
language sql stable security definer set search_path to 'public' as $$
  select a.id, a.business_id, coalesce(a.tenant_slug, b.slug), coalesce(b.name, 'SMSPin'), coalesce(b.theme, 'crimson')
    from tenant_accounts a
    left join businesses b on b.id = a.business_id
   where a.id = tenant_resolve(p_token);
$$;

-- ===== Overview =====
create or replace function public.tenant_dashboard_overview(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  return jsonb_build_object(
    'balance', coalesce((select balance from tenant_wallets where account_id=uid),0),
    'currency', coalesce((select currency from tenant_wallets where account_id=uid),'NGN'),
    'active_numbers', (select count(*) from orders where tenant_account_id=uid and status in ('waiting','received')),
    'total_orders', (select count(*) from orders where tenant_account_id=uid),
    'sms_received', (select count(*) from sms_messages m join orders o on o.id=m.order_id where o.tenant_account_id=uid),
    'unread_sms', (select count(*) from sms_messages m join orders o on o.id=m.order_id where o.tenant_account_id=uid and m.received_at > now() - interval '1 day'),
    'recent_orders', coalesce((
      select jsonb_agg(x) from (
        select o.id, s.name as service, s.icon as service_icon, o.phone_number, o.status, o.price, o.created_at
        from orders o left join services s on s.code=o.service_code
        where o.tenant_account_id=uid order by o.created_at desc limit 5
      ) x), '[]'::jsonb),
    'recent_messages', coalesce((
      select jsonb_agg(y) from (
        select m.id, m.sender, m.body, m.code, m.received_at,
               s.name as service, s.icon as service_icon, o.phone_number
        from sms_messages m join orders o on o.id=m.order_id
        left join services s on s.code=o.service_code
        where o.tenant_account_id=uid order by m.received_at desc limit 9
      ) y), '[]'::jsonb),
    'quick_actions', coalesce((
      select jsonb_agg(jsonb_build_object('code', p.code, 'name', p.name, 'icon', p.icon, 'orders', p.mine) order by p.ord)
      from (
        select s.code, s.name, s.icon,
               coalesce((select count(*) from orders o where o.tenant_account_id=uid and o.service_code=s.code),0) as mine,
               pin.ord
        from (values ('wa',1),('ig',2),('tw',3),('fb',4),('tg',5),('lf',6)) as pin(code,ord)
        join services s on s.code=pin.code
        where exists (select 1 from number_catalog n where n.service_code=s.code and n.active)
      ) p), '[]'::jsonb)
  );
end $$;

-- ===== Wallet summary =====
create or replace function public.tenant_wallet_summary(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  return jsonb_build_object(
    'balance', coalesce((select balance from tenant_wallets where account_id=uid),0),
    'currency', coalesce((select currency from tenant_wallets where account_id=uid),'NGN'),
    'spent_month', coalesce((select -sum(amount) from transactions where tenant_account_id=uid and amount<0 and created_at > date_trunc('month', now())),0),
    'auto_topup', false, 'auto_topup_amount', 0, 'auto_topup_threshold', 0,
    'spent_30d', coalesce((select -sum(amount) from transactions where tenant_account_id=uid and amount<0 and created_at > now() - interval '30 days'),0),
    'funded_30d', coalesce((select sum(amount) from transactions where tenant_account_id=uid and amount>0 and created_at > now() - interval '30 days'),0),
    'activity', coalesce((select jsonb_agg(x) from (
       select t.id,t.type,t.amount,t.method,t.created_at, s.name as service_name, s.icon as service_icon
       from transactions t left join services s on s.code=t.method
       where t.tenant_account_id=uid order by t.created_at desc limit 8) x),'[]'::jsonb),
    'by_category', coalesce((select jsonb_agg(x) from (
       select t.method as service, coalesce(s.name,t.method) as name, s.icon as icon, sum(-t.amount) as total
       from transactions t left join services s on s.code=t.method
       where t.tenant_account_id=uid and t.amount<0 and t.type='purchase' and t.created_at > now() - interval '30 days'
       group by t.method, s.name, s.icon order by total desc limit 8) x),'[]'::jsonb),
    'by_country', coalesce((select jsonb_agg(x) from (
       select c.name as country, c.flag, sum(-t.amount) as total
       from transactions t join orders o on t.ref='order:'||o.id join countries c on c.code=o.country_code
       where t.tenant_account_id=uid and t.amount<0 and t.created_at > now() - interval '30 days'
       group by c.name, c.flag order by total desc limit 8) x),'[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('d',d.dy::date,'in',coalesce(i.amt,0),'out',coalesce(o.amt,0)) order by d.dy) from
       generate_series(current_date-13, current_date, interval '1 day') d(dy)
       left join (select date_trunc('day',created_at) dy, sum(amount) amt from transactions where tenant_account_id=uid and amount>0 group by 1) i on i.dy=d.dy
       left join (select date_trunc('day',created_at) dy, sum(-amount) amt from transactions where tenant_account_id=uid and amount<0 group by 1) o on o.dy=d.dy),'[]'::jsonb)
  );
end $$;

-- ===== Orders (full shape, incl. rental flag + sms count) =====
create or replace function public.tenant_my_orders(p_token text, p_limit integer default 300)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(x) from (
    select o.id, c.name as country, c.flag, s.name as service, s.icon as service_icon,
           o.phone_number, o.price, o.status, o.created_at, o.expires_at, o.upstream_status,
           (o.upstream_status = 'rental') as is_rental,
           (select count(*) from sms_messages m where m.order_id=o.id) as sms_count
    from orders o left join countries c on c.code=o.country_code left join services s on s.code=o.service_code
    where o.tenant_account_id=uid order by o.created_at desc limit greatest(1,least(coalesce(p_limit,300),1000))
  ) x),'[]'::jsonb);
end $$;

-- ===== Transactions =====
create or replace function public.tenant_my_transactions(p_token text, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(x) from (
    select t.id, t.type, t.amount, t.method, t.ref, t.created_at,
           case when t.ref like 'order:%' then (
             select case o.status when 'received' then 'success' when 'refunded' then 'pending' else 'waiting' end
             from orders o where o.id = nullif(regexp_replace(t.ref,'^order:',''),'')::bigint)
           else 'success' end as status
    from transactions t where t.tenant_account_id=uid order by t.created_at desc limit greatest(1,least(coalesce(p_limit,100),500))
  ) x),'[]'::jsonb);
end $$;

-- ===== Payments (top-up invoices) =====
create or replace function public.tenant_my_payments(p_token text, p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(x) from (
    select p.id, p.reference, p.provider, p.amount, p.currency, p.status, p.channel, p.fee_ngn, p.created_at, p.updated_at
    from payments p where p.tenant_account_id=uid order by p.created_at desc limit greatest(1,least(coalesce(p_limit,50),500))
  ) x),'[]'::jsonb);
end $$;

-- ===== Refund notices =====
create or replace function public.tenant_my_refund_notices(p_token text, p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select id, order_id, amount, currency, reason, status, created_at, sent_at
    from refund_notices where tenant_account_id=uid order by created_at desc limit greatest(1,least(coalesce(p_limit,50),500))) x),'[]'::jsonb);
end $$;

-- ===== Wallet balances =====
create or replace function public.tenant_wallet_balances(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  return jsonb_build_object(
    'balances', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'balance', balance, 'updated_at', updated_at) order by balance desc)
      from (select coalesce(w.currency,'NGN') as currency, w.balance, w.updated_at from tenant_wallets w where w.account_id=uid) q), '[]'::jsonb),
    'settlement_currency', coalesce((select currency from tenant_wallets where account_id=uid), 'NGN'),
    'rates', (select jsonb_object_agg(code, rate) from fx_rates where code in ('NGN','USD','GBP','EUR')));
end $$;

-- ===== Notifications (tenant-scoped) =====
create or replace function public.tenant_my_notifications(p_token text, p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  return jsonb_build_object(
    'unread', 0,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'title',n.title,
        'body',n.body,'href',n.href,'read',true,'created_at',n.created_at) order by n.created_at desc)
      from (select * from notifications where user_id is null order by created_at desc limit greatest(1,least(p_limit,100))) n), '[]'::jsonb));
end $$;

-- ===== Profile (tenant account) =====
create or replace function public.tenant_profile(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); a tenant_accounts%rowtype; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select * into a from tenant_accounts where id=uid;
  return jsonb_build_object('id', a.id, 'email', a.email, 'full_name', coalesce(a.full_name,''),
    'phone', null, 'country', null, 'suspended', false, 'created_at', a.created_at,
    'referred_by', null, 'referral_code', null);
end $$;

-- ===== API keys (business-scoped) =====
create or replace function public.tenant_my_api_keys(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  return coalesce((select jsonb_agg(x) from (
    select k.id, k.name, k.key_prefix, k.last_used_at, k.revoked, k.created_at
    from tenant_api_keys k where k.business_id=v_biz order by k.created_at desc) x),'[]'::jsonb);
end $$;

-- ===== Catalog for a store (markup applied) =====
create or replace function public.tenant_browse_catalog(p_slug text, p_country text default null, p_service text default null)
returns jsonb language sql security definer set search_path to 'public' as $$
  with biz as (select coalesce(markup_percent,0) as pct from businesses where slug=p_slug and status='active' limit 1)
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select n.id, c.code as country, c.name as country_name, c.flag,
           s.code as service, s.name as service_name, s.icon as service_icon,
           public.sell_price_ngn(n.price, coalesce((select pct from biz),0)) as price,
           public.sell_price_usd(n.price, coalesce((select pct from biz),0)) as price_usd,
           n.stock
    from number_catalog n join countries c on c.code=n.country_code join services s on s.code=n.service_code
    where n.active and n.stock>0
      and (p_country is null or n.country_code=p_country)
      and (p_service is null or n.service_code=p_service)
    order by n.price asc
  ) x;
$$;

-- ===== Store branding for the shared shell (brand_name etc.) =====
create or replace function public.tenant_site_config(p_slug text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'brand_name', coalesce((select name from businesses where slug=p_slug), 'SMSPin'),
    'brand_short', coalesce((select name from businesses where slug=p_slug), 'SMSPin'),
    'support_email', coalesce((select support_email from businesses where slug=p_slug), ''),
    'currency', 'NGN',
    'commission', coalesce((select markup_percent from businesses where slug=p_slug), 0),
    'store_markup_percent', coalesce((select markup_percent from businesses where slug=p_slug), 0)
  );
$$;

-- ===== Owner earnings + withdrawals (tenant admin console) =====
create or replace function public.tenant_earnings(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  return jsonb_build_object(
    'business_id', v_biz,
    'markup_percent', coalesce((select markup_percent from businesses where id=v_biz),0),
    'earned_total', coalesce((select sum(amount) from business_earnings where business_id=v_biz),0),
    'earned_30d', coalesce((select sum(amount) from business_earnings where business_id=v_biz and created_at > now() - interval '30 days'),0),
    'paid_total', coalesce((select sum(amount) from tenant_payouts where business_id=v_biz and status='paid'),0),
    'pending_total', coalesce((select sum(amount) from tenant_payouts where business_id=v_biz and status='pending'),0),
    'available', coalesce((select sum(amount) from business_earnings where business_id=v_biz),0)
                  - coalesce((select sum(amount) from tenant_payouts where business_id=v_biz and status in ('pending','paid')),0),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('d',d.dy::date,'earned',coalesce(e.amt,0)) order by d.dy) from
       generate_series(current_date-13, current_date, interval '1 day') d(dy)
       left join (select date_trunc('day',created_at) dy, sum(amount) amt from business_earnings where business_id=v_biz group by 1) e on e.dy=d.dy),'[]'::jsonb),
    'payouts', coalesce((select jsonb_agg(x) from (
       select id, amount, method, status, reference, created_at from tenant_payouts
       where business_id=v_biz order by created_at desc limit 25) x),'[]'::jsonb)
  );
end $$;

create or replace function public.tenant_payout_request(p_token text, p_amount numeric, p_method text default 'bank_transfer')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; v_avail numeric; v_ref text; v_id bigint; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  if v_biz is null then raise exception 'no store attached' using errcode='P0001'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invalid amount' using errcode='P0001'; end if;
  v_avail := coalesce((select sum(amount) from business_earnings where business_id=v_biz),0)
             - coalesce((select sum(amount) from tenant_payouts where business_id=v_biz and status in ('pending','paid')),0);
  if p_amount > v_avail then raise exception 'amount exceeds available balance' using errcode='P0001'; end if;
  v_ref := 'pay_' || replace(gen_random_uuid()::text,'-','');
  insert into tenant_payouts(business_id, amount, method, status, reference)
    values (v_biz, p_amount, coalesce(p_method,'bank_transfer'), 'pending', v_ref)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'reference', v_ref, 'amount', p_amount, 'status', 'pending');
end $$;

create or replace function public.tenant_set_markup(p_token text, p_percent numeric)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  if v_biz is null then raise exception 'no store attached' using errcode='P0001'; end if;
  if p_percent is null or p_percent < 0 or p_percent > 1000 then raise exception 'invalid markup' using errcode='P0001'; end if;
  update businesses set markup_percent = p_percent, updated_at = now() where id = v_biz;
  return jsonb_build_object('markup_percent', p_percent);
end $$;

grant execute on function public.tenant_ctx(text) to anon, authenticated;
grant execute on function public.tenant_dashboard_overview(text) to anon, authenticated;
grant execute on function public.tenant_wallet_summary(text) to anon, authenticated;
grant execute on function public.tenant_my_orders(text, integer) to anon, authenticated;
grant execute on function public.tenant_my_transactions(text, integer) to anon, authenticated;
grant execute on function public.tenant_my_payments(text, integer) to anon, authenticated;
grant execute on function public.tenant_my_refund_notices(text, integer) to anon, authenticated;
grant execute on function public.tenant_wallet_balances(text) to anon, authenticated;
grant execute on function public.tenant_my_notifications(text, integer) to anon, authenticated;
grant execute on function public.tenant_profile(text) to anon, authenticated;
grant execute on function public.tenant_my_api_keys(text) to anon, authenticated;
grant execute on function public.tenant_browse_catalog(text, text, text) to anon, authenticated;
grant execute on function public.tenant_site_config(text) to anon, authenticated;
grant execute on function public.tenant_earnings(text) to anon, authenticated;
grant execute on function public.tenant_payout_request(text, numeric, text) to anon, authenticated;
grant execute on function public.tenant_set_markup(text, numeric) to anon, authenticated;
