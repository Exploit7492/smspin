-- Multi-tenant transactional email (Novu).
--
-- Every account — the platform and each white-label store — sends its
-- transactional email through ONE shared infrastructure (Novu), but with the
-- sender's own branding: display name, from address, support address, reply-to,
-- logo and colours. Branding is data on `businesses`, so adding a store needs no
-- code change.
--
-- Tenancy model:
--   * a tenant is a `businesses` row; the platform is `tenant_slug IS NULL`;
--   * `businesses.email_*` override the platform defaults (settings.*);
--   * `email_queue.tenant_slug` records which brand an email belongs to, so the
--     dispatcher (Supabase Edge Function `email`) can render it correctly;
--   * `email_events` is an append-only delivery log for ops/debugging.

-- ---------------------------------------------------------------- branding
alter table businesses add column if not exists email_from_name  text;
alter table businesses add column if not exists email_from_email text;
alter table businesses add column if not exists email_reply_to   text;
alter table businesses add column if not exists email_logo_url   text;
alter table businesses add column if not exists email_footer     text;

-- ---------------------------------------------------------------- queue tenancy
alter table email_queue add column if not exists tenant_slug text;
alter table email_queue add column if not exists template_slug text;
alter table email_queue add column if not exists provider text;
alter table email_queue add column if not exists provider_ref text;
alter table email_queue add column if not exists tenant_id text;   -- Novu tenant identifier
create index if not exists email_queue_tenant_idx on email_queue (tenant_slug, status, created_at);

-- ---------------------------------------------------------------- delivery log
create table if not exists email_events (
  id          bigint generated always as identity primary key,
  queue_id    bigint,
  tenant_slug text,
  to_email    text,
  template    text,
  provider    text not null default 'novu',
  provider_ref text,
  status      text not null,   -- sent | failed | read
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists email_events_tenant_idx on email_events (tenant_slug, created_at desc);
create index if not exists email_events_queue_idx on email_events (queue_id);

-- ---------------------------------------------------------------- sender identity
-- Resolve the full sender identity for a tenant slug (NULL/'' = platform).
create or replace function public.email_sender(p_slug text default null)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  with biz as (
    select b.* from businesses b
     where coalesce(nullif(trim(p_slug), ''), '') <> '' and b.slug = p_slug
     limit 1
  ), d as (
    select
      coalesce((select value #>> '{}' from settings where key='brand_name'), 'SMSPin')    as brand_name,
      coalesce((select value #>> '{}' from settings where key='support_email'), 'support@smspin.io') as support_email,
      coalesce((select value #>> '{}' from settings where key='email_from_name'), null)   as from_name,
      coalesce((select value #>> '{}' from settings where key='email_from_email'), null)  as from_email,
      coalesce((select value #>> '{}' from settings where key='email_reply_to'), null)    as reply_to
  )
  select jsonb_build_object(
    'tenant_slug',   coalesce((select slug from biz), null),
    'tenant_id',     coalesce((select slug from biz), 'smspin-platform'),
    'brand_name',    coalesce((select name from biz), (select brand_name from d)),
    'from_name',     coalesce((select email_from_name from biz), (select from_name from d),
                              coalesce((select name from biz), (select brand_name from d))),
    'from_email',    coalesce((select email_from_email from biz), (select from_email from d)),
    'reply_to',      coalesce((select email_reply_to from biz), (select support_email from biz),
                              (select reply_to from d), (select support_email from d)),
    'support_email', coalesce((select support_email from biz), (select support_email from d)),
    'logo_url',      coalesce((select email_logo_url from biz), (select logo_url from biz)),
    'primary_color', coalesce((select primary_color from biz), '#E11D2E'),
    'secondary_color', coalesce((select secondary_color from biz), '#F26B7A'),
    'footer',        coalesce((select email_footer from biz),
                              'You are receiving this because you have an account with ' ||
                              coalesce((select name from biz), (select brand_name from d)) || '.'),
    'theme',         coalesce((select theme from biz), 'crimson')
  );
$function$;

-- ---------------------------------------------------------------- queueing
-- Enqueue with tenant awareness. Drop the legacy 4-arg overload so existing
-- callers resolve to the tenant-aware form (the 5th arg defaults to null).
drop function if exists public.email_enqueue(uuid, text, text, jsonb);
drop function if exists public.email_queue_mark(bigint, boolean, text);
create or replace function public.email_enqueue(
    p_user uuid, p_email text, p_template text,
    p_payload jsonb default '{}'::jsonb, p_tenant_slug text default null)
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v_id bigint; v_slug text;
begin
  if coalesce(trim(p_email),'') = '' then return null; end if;
  v_slug := nullif(trim(coalesce(p_tenant_slug, '')), '');
  insert into email_queue(user_id, to_email, template, payload, tenant_slug)
    values (p_user, p_email, p_template, coalesce(p_payload,'{}'::jsonb), v_slug)
    returning id into v_id;
  return v_id;
end $$;

create or replace function public.email_queue_pending(p_limit int default 20)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'to_email', e.to_email, 'template', e.template,
      'payload', e.payload, 'attempts', e.attempts, 'tenant_slug', e.tenant_slug,
      'user_id', e.user_id) order by e.created_at), '[]'::jsonb)
    from (select * from email_queue where status='queued' order by created_at
           limit greatest(1,least(p_limit,100))) e;
$$;

create or replace function public.email_queue_mark(
    p_id bigint, p_ok boolean, p_error text default null,
    p_provider text default null, p_ref text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_slug text; v_to text; v_tpl text;
begin
  update email_queue set attempts = attempts + 1,
    status = case when p_ok then 'sent' else (case when attempts + 1 >= 3 then 'failed' else 'queued' end) end,
    last_error = p_error,
    provider = coalesce(p_provider, provider),
    provider_ref = coalesce(p_ref, provider_ref),
    sent_at = case when p_ok then now() else sent_at end
   where id = p_id
   returning tenant_slug, to_email, template into v_slug, v_to, v_tpl;
  insert into email_events(queue_id, tenant_slug, to_email, template, provider, provider_ref,
                           status, error)
  values (p_id, v_slug, v_to, v_tpl, coalesce(p_provider,'novu'), p_ref,
          case when p_ok then 'sent' else 'failed' end, p_error);
end $$;

-- Ops: recent delivery log, optionally scoped to a tenant.
create or replace function public.email_events_list(p_limit int default 50, p_tenant_slug text default null)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) from (
    select id, queue_id, tenant_slug, to_email, template, provider, provider_ref, status, error, created_at
      from email_events
     where (p_tenant_slug is null or tenant_slug = p_tenant_slug)
     order by created_at desc limit greatest(1, least(p_limit, 500))
  ) t;
$$;

-- Re-queue failed emails (ops retry).
create or replace function public.email_requeue_failed(p_tenant_slug text default null)
returns int language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  update email_queue set status='queued', attempts=0, last_error=null
   where status='failed' and (p_tenant_slug is null or tenant_slug = p_tenant_slug);
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- tenant events
-- Tenant accounts get their own welcome email; tenant wallet funding gets its
-- own receipt. Both carry the store slug so the mail is branded for that store.
create or replace function public.tg_tenant_welcome_email()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.email is not null then
    perform public.email_enqueue(null, new.email, 'welcome',
      jsonb_build_object('name', new.full_name), new.tenant_slug);
  end if;
  return new;
end $$;

drop trigger if exists tenant_accounts_welcome_email on tenant_accounts;
create trigger tenant_accounts_welcome_email after insert on tenant_accounts
  for each row execute function public.tg_tenant_welcome_email();

create or replace function public.tg_tenant_fund_receipt()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_email text; v_slug text;
begin
  if new.type = 'topup' and new.amount > 0 and new.tenant_account_id is not null then
    select email, tenant_slug into v_email, v_slug from tenant_accounts where id = new.tenant_account_id;
    perform public.email_enqueue(null, v_email, 'receipt',
      jsonb_build_object('amount', new.amount, 'method', new.method, 'ref', new.ref), v_slug);
  end if;
  return new;
end $$;

drop trigger if exists transactions_tenant_fund_receipt on transactions;
create trigger transactions_tenant_fund_receipt after insert on transactions
  for each row execute function public.tg_tenant_fund_receipt();

-- Refund notices carry the tenant slug so the dispatcher brands them.
alter table refund_notices add column if not exists tenant_slug text;

create or replace function public.refund_notice_create(p_order_id bigint, p_user uuid, p_tenant uuid, p_email text, p_amount numeric, p_reason text)
returns bigint language sql security definer set search_path to 'public' as $$
  insert into refund_notices(order_id, user_id, tenant_account_id, email, amount, reason, channel, tenant_slug)
  values (p_order_id, p_user, p_tenant, p_email, p_amount, p_reason, 'email',
          (select tenant_slug from tenant_accounts where id = p_tenant))
  returning id;
$$;

create or replace function public.refund_notices_pending(p_limit integer default 20)
returns jsonb language sql security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from (
    select id, order_id, user_id, email, amount, currency, reason, tenant_slug from refund_notices
     where status = 'pending' order by id limit greatest(1, least(p_limit, 200))
  ) t;
$$;

-- ---------------------------------------------------------------- grants
do $$
begin
  -- Public read of a tenant's sender identity (safe: no secrets).
  execute 'grant execute on function public.email_sender(text) to anon, authenticated, service_role';
  revoke all on function public.email_enqueue(uuid,text,text,jsonb,text) from public, anon, authenticated;
  revoke all on function public.email_queue_pending(int) from public, anon, authenticated;
  revoke all on function public.email_queue_mark(bigint,boolean,text,text,text) from public, anon, authenticated;
  revoke all on function public.email_events_list(int,text) from public, anon, authenticated;
  revoke all on function public.email_requeue_failed(text) from public, anon, authenticated;
  grant execute on function public.email_enqueue(uuid,text,text,jsonb,text) to service_role;
  grant execute on function public.email_queue_pending(int) to service_role;
  grant execute on function public.email_queue_mark(bigint,boolean,text,text,text) to service_role;
  grant execute on function public.email_events_list(int,text) to service_role;
  grant execute on function public.email_requeue_failed(text) to service_role;
end $$;
