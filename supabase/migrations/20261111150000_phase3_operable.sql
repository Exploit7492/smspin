-- Phase 3 "Make it operable": admin console (F1-F5), support threads (K1),
-- refund comms (K5), ops refunds (B7), public status page (J6).
-- All functions are SECURITY DEFINER and service_role-only; the backend verifies
-- the caller is an admin (admins table) before invoking any admin_* function.

-- ================================================================ F2 user management
alter table profiles add column if not exists suspended boolean not null default false;
alter table profiles add column if not exists suspended_reason text;
alter table profiles add column if not exists suspended_at timestamptz;

create or replace function public.admin_users_list(p_q text default null, p_limit int default 50)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select p.id, p.email, p.full_name, p.country, p.created_at,
           p.suspended, p.suspended_reason,
           coalesce(w.balance, 0) as balance, coalesce(w.currency, 'NGN') as currency,
           (select count(*) from orders o where o.user_id = p.id) as orders,
           (select count(*) from orders o where o.user_id = p.id and o.status in ('waiting','received')) as active_orders
      from profiles p left join wallets w on w.user_id = p.id
     where p_q is null or p_q = '' or p.email ilike '%'||p_q||'%' or p.full_name ilike '%'||p_q||'%'
     order by p.created_at desc limit greatest(1, least(p_limit, 500))
  ) x;
$$;

create or replace function public.admin_user_detail(p_user uuid)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(t) from (
       select id, email, full_name, phone, country, referral_code, created_at,
              suspended, suspended_reason, suspended_at from profiles where id = p_user) t),
    'wallet',  (select to_jsonb(t) from (select balance, currency from wallets where user_id = p_user) t),
    'orders',  (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
       select id, country_code, service_code, phone_number, price, status, created_at
         from orders where user_id = p_user order by created_at desc limit 50) x),
    'transactions', (select coalesce(jsonb_agg(y order by y.created_at desc), '[]'::jsonb) from (
       select id, type, amount, method, ref, created_at from transactions
        where user_id = p_user order by created_at desc limit 50) y),
    'risk', (select coalesce(jsonb_agg(r order by r.created_at desc), '[]'::jsonb) from (
       select id, kind, score, allow, reasons, created_at from risk_events
        where user_id = p_user order by created_at desc limit 20) r)
  );
$$;

create or replace function public.admin_user_suspend(p_user uuid, p_suspended boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update profiles set suspended = p_suspended,
         suspended_reason = case when p_suspended then p_reason else null end,
         suspended_at = case when p_suspended then now() else null end
   where id = p_user;
  return jsonb_build_object('user_id', p_user, 'suspended', p_suspended);
end $$;

-- Adjust a wallet balance with a reason. Positive = credit, negative = debit.
-- Never lets a debit drive the balance below zero. Writes a ledger transaction.
create or replace function public.admin_adjust_balance(p_user uuid, p_amount numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_before numeric; v_after numeric;
begin
  if p_amount is null or p_amount = 0 then raise exception 'amount required' using errcode='22023'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason required' using errcode='22023'; end if;
  insert into wallets(user_id, balance, currency) values (p_user, 0, 'NGN')
    on conflict (user_id) do nothing;
  select balance into v_before from wallets where user_id = p_user for update;
  v_after := v_before + p_amount;
  if v_after < 0 then raise exception 'balance cannot go negative' using errcode='22023'; end if;
  update wallets set balance = v_after, updated_at = now() where user_id = p_user;
  insert into transactions(user_id, type, amount, method, ref)
    values (p_user, case when p_amount > 0 then 'admin_credit' else 'admin_debit' end,
            abs(p_amount), p_reason, 'admin');
  return jsonb_build_object('user_id', p_user, 'before', v_before, 'after', v_after, 'delta', p_amount);
end $$;

create or replace function public.is_suspended(p_user uuid)
returns boolean
language sql
security definer
set search_path to 'public'
as $$ select coalesce((select suspended from profiles where id = p_user), false); $$;

-- ================================================================ B7 partial refunds
-- Extends the existing refund_order with an ops-initiated partial amount.
create or replace function public.refund_order_partial(p_order_id bigint, p_amount numeric, p_reason text default 'refund')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare o orders%rowtype; v_refund numeric;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'order % not found', p_order_id using errcode='P0002'; end if;
  v_refund := coalesce(p_amount, o.price);
  if v_refund <= 0 or v_refund > o.price then
    raise exception 'refund amount must be between 0 and %', o.price using errcode='22023';
  end if;

  if o.tenant_account_id is not null then
    update tenant_wallets set balance = balance + v_refund, updated_at = now() where account_id = o.tenant_account_id;
  elsif o.user_id is not null then
    update wallets set balance = balance + v_refund, updated_at = now() where user_id = o.user_id;
  end if;

  update orders set status = case when v_refund >= o.price then 'refunded' else status end,
         upstream_status = coalesce(upstream_status, 'cancelled'), last_synced_at = now()
   where id = p_order_id;

  insert into transactions(user_id, type, amount, method, ref, tenant_account_id)
    values (o.user_id, 'refund', v_refund, p_reason, 'order:'||o.id, o.tenant_account_id);

  return jsonb_build_object('order_id', p_order_id, 'refunded', v_refund,
                            'partial', v_refund < o.price, 'status',
                            case when v_refund >= o.price then 'refunded' else o.status end);
end $$;

-- ================================================================ K5 refund notices
create table if not exists refund_notices (
  id                bigserial primary key,
  order_id          bigint,
  user_id           uuid,
  tenant_account_id uuid,
  email             text,
  amount            numeric(14,2) not null,
  currency          text not null default 'NGN',
  reason            text,
  channel           text not null default 'email',   -- email | in_app
  status            text not null default 'pending', -- pending | sent | failed | read
  error             text,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz
);
create index if not exists refund_notices_user_idx on refund_notices (user_id, created_at desc);
create index if not exists refund_notices_status_idx on refund_notices (status);

create or replace function public.refund_notice_create(p_order_id bigint, p_user uuid, p_tenant uuid,
                                                       p_email text, p_amount numeric, p_reason text)
returns bigint
language sql
security definer
set search_path to 'public'
as $$
  insert into refund_notices(order_id, user_id, tenant_account_id, email, amount, reason, channel)
  values (p_order_id, p_user, p_tenant, p_email, p_amount, p_reason, 'email')
  returning id;
$$;

create or replace function public.refund_notices_pending(p_limit int default 20)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from (
    select id, order_id, user_id, email, amount, currency, reason from refund_notices
     where status = 'pending' order by id limit greatest(1, least(p_limit, 200))
  ) t;
$$;

create or replace function public.refund_notice_mark(p_id bigint, p_status text, p_error text default null)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update refund_notices set status = p_status, error = p_error,
         sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_id;
$$;

create or replace function public.my_refund_notices(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select id, order_id, amount, currency, reason, status, created_at, sent_at
      from refund_notices where user_id = uid order by created_at desc limit p_limit) x), '[]'::jsonb);
end $$;

-- ================================================================ K1 support threads
alter table support_tickets add column if not exists updated_at timestamptz not null default now();
alter table support_tickets add column if not exists priority text not null default 'normal';
alter table support_tickets add column if not exists assigned_to text;
alter table support_tickets add column if not exists last_author_type text not null default 'user';

create table if not exists ticket_messages (
  id             bigserial primary key,
  ticket_id      bigint not null references support_tickets(id) on delete cascade,
  author_type    text not null default 'user',   -- user | agent | system
  author_id      uuid,
  author_name    text,
  body           text not null,
  attachment_url text,
  created_at     timestamptz not null default now()
);
create index if not exists ticket_messages_ticket_idx on ticket_messages (ticket_id, created_at);

-- Seed the first message from the ticket body when the thread is empty.
create or replace function public.ticket_ensure_seed(p_ticket_id bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare t support_tickets%rowtype;
begin
  select * into t from support_tickets where id = p_ticket_id;
  if not found then return; end if;
  if not exists (select 1 from ticket_messages where ticket_id = p_ticket_id) then
    insert into ticket_messages(ticket_id, author_type, author_id, body)
      values (p_ticket_id, 'user', t.user_id, t.message);
  end if;
end $$;

create or replace function public.ticket_reply(p_ticket_id bigint, p_body text, p_attachment_url text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare uid uuid := auth.uid(); v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  if not exists (select 1 from support_tickets where id = p_ticket_id and user_id = uid) then
    raise exception 'ticket not found' using errcode='P0002';
  end if;
  perform public.ticket_ensure_seed(p_ticket_id);
  insert into ticket_messages(ticket_id, author_type, author_id, body, attachment_url)
    values (p_ticket_id, 'user', uid, p_body, p_attachment_url) returning id into v_id;
  update support_tickets set updated_at = now(), last_author_type = 'user',
         status = case when status = 'resolved' then 'open' else status end
   where id = p_ticket_id;
  return jsonb_build_object('message_id', v_id);
end $$;

create or replace function public.ticket_thread(p_ticket_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare uid uuid := auth.uid(); t support_tickets%rowtype;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into t from support_tickets where id = p_ticket_id and user_id = uid;
  if not found then raise exception 'ticket not found' using errcode='P0002'; end if;
  perform public.ticket_ensure_seed(p_ticket_id);
  return jsonb_build_object(
    'ticket', jsonb_build_object('id', t.id, 'subject', t.subject, 'status', t.status,
                                 'order_ref', t.order_ref, 'created_at', t.created_at,
                                 'updated_at', t.updated_at),
    'messages', coalesce((select jsonb_agg(x order by x.created_at) from (
       select id, author_type, author_name, body, attachment_url, created_at
         from ticket_messages where ticket_id = p_ticket_id order by created_at) x), '[]'::jsonb)
  );
end $$;

create or replace function public.my_tickets()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(x order by x.updated_at desc) from (
    select t.id, t.subject, t.status, t.order_ref, t.created_at, t.updated_at,
           (select count(*) from ticket_messages m where m.ticket_id = t.id) as messages,
           (select count(*) from ticket_messages m where m.ticket_id = t.id and m.author_type='agent') as agent_replies
      from support_tickets t where t.user_id = uid order by t.updated_at desc limit 50) x), '[]'::jsonb);
end $$;

-- ---- agent side ----
create or replace function public.admin_tickets_list(p_status text default null, p_limit int default 100)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(x order by x.updated_at desc), '[]'::jsonb) from (
    select t.id, t.subject, t.status, t.priority, t.assigned_to, t.order_ref,
           t.created_at, t.updated_at, t.last_author_type,
           p.email as user_email, p.full_name as user_name,
           (select count(*) from ticket_messages m where m.ticket_id = t.id) as messages
      from support_tickets t left join profiles p on p.id = t.user_id
     where p_status is null or p_status = '' or t.status = p_status
     order by t.updated_at desc limit greatest(1, least(p_limit, 500))
  ) x;
$$;

create or replace function public.admin_ticket_thread(p_ticket_id bigint)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'ticket', (select to_jsonb(t) from (
       select t.id, t.subject, t.status, t.priority, t.assigned_to, t.order_ref,
              t.created_at, t.updated_at, t.user_id, p.email as user_email, p.full_name as user_name
         from support_tickets t left join profiles p on p.id = t.user_id where t.id = p_ticket_id) t),
    'messages', (select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) from (
       select id, author_type, author_name, body, attachment_url, created_at
         from ticket_messages where ticket_id = p_ticket_id order by created_at) x)
  );
$$;

create or replace function public.admin_ticket_reply(p_ticket_id bigint, p_body text,
                                                    p_agent text, p_attachment_url text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_id bigint;
begin
  perform public.ticket_ensure_seed(p_ticket_id);
  insert into ticket_messages(ticket_id, author_type, author_name, body, attachment_url)
    values (p_ticket_id, 'agent', p_agent, p_body, p_attachment_url) returning id into v_id;
  update support_tickets set updated_at = now(), last_author_type = 'agent',
         status = case when status = 'open' then 'pending' else status end
   where id = p_ticket_id;
  return jsonb_build_object('message_id', v_id);
end $$;

create or replace function public.admin_ticket_update(p_ticket_id bigint, p_status text default null,
                                                     p_priority text default null, p_assignee text default null)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  update support_tickets set
    status = coalesce(p_status, status),
    priority = coalesce(p_priority, priority),
    assigned_to = coalesce(p_assignee, assigned_to),
    updated_at = now()
  where id = p_ticket_id
  returning jsonb_build_object('id', id, 'status', status, 'priority', priority, 'assigned_to', assigned_to);
$$;

-- ================================================================ F3 order / SMS ops
create or replace function public.admin_orders_list(p_status text default null, p_q text default null, p_limit int default 100)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select o.id, o.user_id, p.email as user_email, o.country_code, o.service_code,
           o.phone_number, o.price, o.status, o.upstream_order_id, o.upstream_status,
           o.created_at, o.expires_at,
           (select count(*) from sms_messages m where m.order_id = o.id) as sms_count,
           (select m.code from sms_messages m where m.order_id = o.id and m.code is not null
             order by m.received_at desc limit 1) as otp
      from orders o left join profiles p on p.id = o.user_id
     where (p_status is null or p_status = '' or o.status = p_status)
       and (p_q is null or p_q = '' or o.phone_number ilike '%'||p_q||'%'
            or o.upstream_order_id ilike '%'||p_q||'%' or p.email ilike '%'||p_q||'%')
     order by o.created_at desc limit greatest(1, least(p_limit, 500))
  ) x;
$$;

create or replace function public.admin_order_mark_received(p_order_id bigint)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  update orders set status = 'received', last_synced_at = now() where id = p_order_id
  returning jsonb_build_object('order_id', id, 'status', status);
$$;

create or replace function public.admin_sms_inject(p_order_id bigint, p_sender text, p_body text, p_code text)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select jsonb_build_object('message_id', public.record_sms(p_order_id, p_sender, p_body, p_code, now()));
$$;

-- ================================================================ F4 pricing / inventory
create or replace function public.admin_catalog_list(p_q text default null, p_limit int default 100)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(x order by x.country_code, x.service_code), '[]'::jsonb) from (
    select nc.id, nc.country_code, c.name as country_name, nc.service_code, s.name as service_name,
           nc.operator_id, nc.price, nc.cost_usd, nc.stock, nc.active, nc.updated_at
      from number_catalog nc
      left join countries c on c.code = nc.country_code
      left join services s on s.code = nc.service_code
     where p_q is null or p_q = '' or nc.country_code ilike '%'||p_q||'%'
            or nc.service_code ilike '%'||p_q||'%'
     order by nc.country_code, nc.service_code limit greatest(1, least(p_limit, 1000))
  ) x;
$$;

create or replace function public.admin_catalog_update(p_id bigint, p_price numeric default null,
                                                      p_stock int default null, p_active boolean default null)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  update number_catalog set
    price = coalesce(p_price, price),
    stock = coalesce(p_stock, stock),
    active = coalesce(p_active, active),
    updated_at = now()
  where id = p_id
  returning jsonb_build_object('id', id, 'price', price, 'stock', stock, 'active', active);
$$;

create or replace function public.admin_set_markup(p_percent numeric)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  insert into settings(key, value) values ('markup_percent', to_jsonb(p_percent))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  select jsonb_build_object('markup_percent', p_percent);
$$;

-- ================================================================ F5 payments reconciliation
create or replace function public.admin_payments_list(p_status text default null, p_limit int default 100)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select pay.id, pay.user_id, pr.email as user_email, pay.reference, pay.provider,
           pay.amount, pay.currency, pay.status, pay.channel, pay.fee_ngn,
           pay.provider_ref, pay.created_at, pay.updated_at
      from payments pay left join profiles pr on pr.id = pay.user_id
     where p_status is null or p_status = '' or pay.status = p_status
     order by pay.created_at desc limit greatest(1, least(p_limit, 500))
  ) x;
$$;

create or replace function public.admin_payment_reconcile(p_days int default 7)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'window_days', p_days,
    'pending',  (select count(*) from payments where status = 'pending' and created_at > now() - (p_days||' days')::interval),
    'success',  (select count(*) from payments where status = 'success' and created_at > now() - (p_days||' days')::interval),
    'failed',   (select count(*) from payments where status = 'failed'  and created_at > now() - (p_days||' days')::interval),
    'gross_ngn',(select coalesce(sum(amount),0) from payments where status = 'success' and created_at > now() - (p_days||' days')::interval),
    'fees_ngn', (select coalesce(sum(fee_ngn),0) from payments where status = 'success' and created_at > now() - (p_days||' days')::interval),
    'net_ngn',  (select coalesce(sum(amount) - sum(fee_ngn),0) from payments where status = 'success' and created_at > now() - (p_days||' days')::interval)
  );
$$;

create or replace function public.admin_payment_mark(p_reference text, p_status text)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  update payments set status = p_status, updated_at = now() where reference = p_reference
  returning jsonb_build_object('reference', reference, 'status', status);
$$;

-- ================================================================ F1 admin overview
create or replace function public.admin_overview()
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'users_total',   (select count(*) from profiles),
    'users_new_24h', (select count(*) from profiles where created_at > now() - interval '24 hours'),
    'users_suspended',(select count(*) from profiles where suspended),
    'orders_total',  (select count(*) from orders),
    'orders_24h',    (select count(*) from orders where created_at > now() - interval '24 hours'),
    'orders_active', (select count(*) from orders where status in ('waiting','received')),
    'revenue_ngn',   (select coalesce(sum(amount),0) from transactions where type in ('topup','payment')),
    'refunds_ngn',   (select coalesce(sum(amount),0) from transactions where type = 'refund'),
    'wallets_ngn',   (select coalesce(sum(balance),0) from wallets),
    'tickets_open',  (select count(*) from support_tickets where status in ('open','pending')),
    'risk_24h',      (select count(*) from risk_events where not allow and created_at > now() - interval '24 hours'),
    'dlq_open',      (select count(*) from webhook_dlq where not resolved),
    'markup_percent',(select (value#>>'{}')::numeric from settings where key = 'markup_percent')
  );
$$;

-- ================================================================ J6 status page
create table if not exists service_checks (
  id         bigserial primary key,
  name       text not null,
  status     text not null default 'ok',   -- ok | degraded | down
  latency_ms int,
  detail     jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index if not exists service_checks_name_idx on service_checks (name, checked_at desc);

create table if not exists incidents (
  id          bigserial primary key,
  title       text not null,
  body        text,
  severity    text not null default 'minor',  -- minor | major | critical
  status      text not null default 'investigating', -- investigating | identified | monitoring | resolved
  affected    jsonb not null default '[]'::jsonb,
  started_at  timestamptz not null default now(),
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

-- Probe the things the product actually depends on and record a row per check.
create or replace function public.synthetic_check()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_detail jsonb; v_up boolean; v_dlq int; v_res jsonb := '[]'::jsonb;
begin
  v_detail := jsonb_build_object('orders_24h', (select count(*) from orders where created_at > now() - interval '24 hours'));
  insert into service_checks(name, status, latency_ms, detail)
    values ('database', 'ok', 0, v_detail);

  v_up := coalesce((select (value#>>'{}')::boolean from provider_state where key = 'enabled'), true);
  insert into service_checks(name, status, latency_ms, detail)
    values ('sms_provider', case when v_up then 'ok' else 'down' end, 0,
            jsonb_build_object('enabled', v_up));
  if not v_up then v_res := v_res || jsonb_build_object('sms_provider','down'); end if;

  v_dlq := (select count(*) from webhook_dlq where not resolved);
  insert into service_checks(name, status, latency_ms, detail)
    values ('webhooks', case when v_dlq > 25 then 'degraded' else 'ok' end, 0,
            jsonb_build_object('open_dlq', v_dlq));

  insert into service_checks(name, status, latency_ms, detail)
    values ('payments', 'ok', 0, jsonb_build_object(
      'success_24h', (select count(*) from payments where status='success' and created_at > now() - interval '24 hours')));

  delete from service_checks where checked_at < now() - interval '30 days';
  return jsonb_build_object('checks', 4, 'issues', v_res);
end $$;

create or replace function public.status_report()
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  with latest as (
    select distinct on (name) name, status, latency_ms, detail, checked_at
      from service_checks order by name, checked_at desc
  )
  select jsonb_build_object(
    'overall', case
      when exists (select 1 from latest where status = 'down') then 'down'
      when exists (select 1 from latest where status = 'degraded') then 'degraded'
      else 'ok' end,
    'checked_at', (select max(checked_at) from latest),
    'components', coalesce((select jsonb_agg(to_jsonb(l) order by l.name) from latest l), '[]'::jsonb),
    'incidents', coalesce((select jsonb_agg(i order by i.started_at desc) from (
       select id, title, body, severity, status, affected, started_at, resolved_at
         from incidents where resolved_at is null or started_at > now() - interval '30 days'
        order by started_at desc limit 20) i), '[]'::jsonb)
  );
$$;

create or replace function public.admin_incident_create(p_title text, p_body text, p_severity text default 'minor',
                                                       p_status text default 'investigating', p_affected jsonb default '[]'::jsonb)
returns bigint
language sql
security definer
set search_path to 'public'
as $$
  insert into incidents(title, body, severity, status, affected)
  values (p_title, p_body, p_severity, p_status, p_affected) returning id;
$$;

create or replace function public.admin_incident_update(p_id bigint, p_status text default null,
                                                       p_body text default null, p_severity text default null)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  update incidents set status = coalesce(p_status, status),
         body = coalesce(p_body, body), severity = coalesce(p_severity, severity),
         resolved_at = case when p_status = 'resolved' then now() else resolved_at end
   where id = p_id
  returning jsonb_build_object('id', id, 'status', status, 'resolved_at', resolved_at);
$$;

-- ================================================================ locks
-- Admin/ops functions are service_role-only (the backend checks is_admin first).
do $$
declare f text;
begin
  foreach f in array array[
    'admin_users_list','admin_user_detail','admin_user_suspend','admin_adjust_balance','is_suspended',
    'refund_order_partial','refund_notice_create','refund_notices_pending','refund_notice_mark',
    'ticket_ensure_seed',
    'admin_tickets_list','admin_ticket_thread','admin_ticket_reply','admin_ticket_update',
    'admin_orders_list','admin_order_mark_received','admin_sms_inject',
    'admin_catalog_list','admin_catalog_update','admin_set_markup',
    'admin_payments_list','admin_payment_reconcile','admin_payment_mark','admin_overview',
    'synthetic_check','status_report','admin_incident_create','admin_incident_update'
  ] loop
    execute format('revoke all on function public.%I from public, anon, authenticated', f);
    execute format('grant execute on function public.%I to service_role', f);
  end loop;
end $$;

-- User-facing support + refund-notice functions: callable by signed-in users
-- (the dashboard talks to Supabase RPC directly), scoped to their own rows.
do $$
declare f text;
begin
  foreach f in array array['ticket_reply','ticket_thread','my_tickets','my_refund_notices'] loop
    execute format('grant execute on function public.%I to authenticated, service_role', f);
  end loop;
end $$;

-- The public status page reads a trimmed view with no privileged detail.
grant execute on function public.status_report to anon, authenticated, service_role;
