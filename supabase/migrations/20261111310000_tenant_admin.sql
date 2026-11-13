-- Tenant owner admin console. The owner sees the SAME admin UI (site/admin)
-- as the platform, but every figure is scoped to their store. These functions
-- mirror the admin_* shapes so the shared admin.js renders unchanged; the only
-- difference is the tenant session token in place of the platform admin gate.

create or replace function public.tenant_admin_overview(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  return jsonb_build_object(
    'users_total',   (select count(*) from tenant_accounts where business_id=v_biz),
    'users_new_24h', (select count(*) from tenant_accounts where business_id=v_biz and created_at > now() - interval '24 hours'),
    'users_suspended', 0,
    'orders_total',  (select count(*) from orders where business_id=v_biz),
    'orders_24h',    (select count(*) from orders where business_id=v_biz and created_at > now() - interval '24 hours'),
    'orders_active', (select count(*) from orders where business_id=v_biz and status in ('waiting','received')),
    'revenue_ngn',   coalesce((select sum(amount) from transactions t join tenant_accounts a on a.id=t.tenant_account_id
                                where a.business_id=v_biz and t.type in ('topup','payment')),0),
    'refunds_ngn',   coalesce((select sum(amount) from transactions t join tenant_accounts a on a.id=t.tenant_account_id
                                where a.business_id=v_biz and t.type='refund'),0),
    'wallets_ngn',   coalesce((select sum(w.balance) from tenant_wallets w join tenant_accounts a on a.id=w.account_id
                                where a.business_id=v_biz),0),
    'tickets_open',  0,
    'risk_24h',      0,
    'dlq_open',      coalesce((select count(*) from tenant_webhook_events where business_id=v_biz and status not in ('delivered','ok')),0),
    'markup_percent', coalesce((select markup_percent from businesses where id=v_biz),0),
    'earned_ngn',    coalesce((select sum(amount) from business_earnings where business_id=v_biz),0),
    'available_ngn', coalesce((select sum(amount) from business_earnings where business_id=v_biz),0)
                      - coalesce((select sum(amount) from tenant_payouts where business_id=v_biz and status in ('pending','paid')),0)
  );
end $$;

create or replace function public.tenant_admin_orders(p_token text, p_status text default null, p_q text default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.id, o.tenant_account_id as user_id, a.email as user_email, o.country_code, o.service_code,
           o.phone_number, o.price, o.status, o.upstream_order_id, o.upstream_status, o.created_at, o.expires_at,
           (select count(*) from sms_messages m where m.order_id=o.id) as sms_count,
           (select m.code from sms_messages m where m.order_id=o.id and m.code is not null order by m.received_at desc limit 1) as otp
      from orders o left join tenant_accounts a on a.id=o.tenant_account_id
     where o.business_id=v_biz
       and (p_status is null or p_status='' or o.status=p_status)
       and (p_q is null or p_q='' or o.phone_number ilike '%'||p_q||'%' or o.upstream_order_id ilike '%'||p_q||'%' or a.email ilike '%'||p_q||'%')
     order by o.created_at desc limit greatest(1,least(p_limit,500))) x),'[]'::jsonb);
end $$;

create or replace function public.tenant_admin_catalog(p_token text, p_q text default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; v_pct numeric; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  select coalesce(markup_percent,0) into v_pct from businesses where id=v_biz;
  return coalesce((select jsonb_agg(x order by x.country_code, x.service_code) from (
    select nc.id, nc.country_code, c.name as country_name, nc.service_code, s.name as service_name,
           nc.operator_id, public.sell_price_ngn(nc.price, v_pct) as price, nc.cost_usd, nc.stock, nc.active, nc.updated_at
      from number_catalog nc left join countries c on c.code=nc.country_code left join services s on s.code=nc.service_code
     where p_q is null or p_q='' or nc.country_code ilike '%'||p_q||'%' or nc.service_code ilike '%'||p_q||'%'
     order by nc.country_code, nc.service_code limit greatest(1,least(p_limit,1000))) x),'[]'::jsonb);
end $$;

create or replace function public.tenant_admin_payments(p_token text, p_status text default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select pay.id, pay.tenant_account_id as user_id, a.email as user_email, pay.reference, pay.provider,
           pay.amount, pay.currency, pay.status, pay.channel, pay.fee_ngn, pay.provider_ref, pay.created_at, pay.updated_at
      from payments pay left join tenant_accounts a on a.id=pay.tenant_account_id
     where a.business_id=v_biz
       and (p_status is null or p_status='' or pay.status=p_status)
     order by pay.created_at desc limit greatest(1,least(p_limit,500))) x),'[]'::jsonb);
end $$;

create or replace function public.tenant_admin_customers(p_token text, p_q text default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select a.id, a.email, a.full_name, a.created_at, a.last_login_at,
           coalesce(w.balance,0) as balance,
           (select count(*) from orders o where o.tenant_account_id=a.id) as orders,
           (select count(*) from orders o where o.tenant_account_id=a.id and o.status in ('waiting','received')) as active_orders,
           false as suspended
      from tenant_accounts a left join tenant_wallets w on w.account_id=a.id
     where a.business_id=v_biz
       and (p_q is null or p_q='' or a.email ilike '%'||p_q||'%' or a.full_name ilike '%'||p_q||'%')
     order by a.created_at desc limit greatest(1,least(p_limit,500))) x),'[]'::jsonb);
end $$;

create or replace function public.tenant_admin_margin(p_token text, p_days integer default 30)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := tenant_resolve(p_token); v_biz bigint; begin
  if uid is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id=uid;
  return jsonb_build_object(
    'days', p_days,
    'orders', (select count(*) from orders where business_id=v_biz and created_at > now() - make_interval(days => greatest(1,least(p_days,365)))),
    'revenue_ngn', coalesce((select sum(price) from orders where business_id=v_biz and status in ('waiting','received')),0),
    'refunds_ngn', coalesce((select sum(price) from orders where business_id=v_biz and status='refunded'),0),
    'cogs_ngn', coalesce((select round(sum(cost_usd) * coalesce((select rate from fx_rates where code='NGN'),1),2) from orders where business_id=v_biz and status in ('waiting','received')),0),
    'gross_margin_ngn', coalesce((select round(sum(amount),2) from business_earnings where business_id=v_biz),0),
    'margin_percent', coalesce((select markup_percent from businesses where id=v_biz),0)
  );
end $$;

grant execute on function public.tenant_admin_overview(text) to anon, authenticated;
grant execute on function public.tenant_admin_orders(text, text, text, integer) to anon, authenticated;
grant execute on function public.tenant_admin_catalog(text, text, integer) to anon, authenticated;
grant execute on function public.tenant_admin_payments(text, text, integer) to anon, authenticated;
grant execute on function public.tenant_admin_customers(text, text, integer) to anon, authenticated;
grant execute on function public.tenant_admin_margin(text, integer) to anon, authenticated;
