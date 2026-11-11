-- Phase 4 remainder (M1-M7 app distribution, O1/O13 tours, B1/B3 payments) and
-- Phase 5 "Make it grow" (O2-O20 enablement, E1-E12 customer UX, G5 experiments,
-- I1-I6 growth, H1-H7 API platform, L2/L3 legal & accounting, F6-F9 admin).
--
-- Conventions match earlier phases: SECURITY DEFINER functions; owner-scoped
-- functions resolve the caller with auth.uid(); ops/admin functions are
-- service_role-only (the backend verifies is_admin before calling them).
-- Everything is written idempotently (if not exists / create or replace).

-- ================================================================ B3 multi-currency wallet
create table if not exists wallet_balances (
  user_id    uuid not null,
  currency   text not null,
  balance    numeric(16,2) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, currency)
);

-- Mirror the primary wallet row into wallet_balances so the ledger stays single-source.
create or replace function public.sync_wallet_balance()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  insert into wallet_balances(user_id, currency, balance, updated_at)
    values (new.user_id, coalesce(new.currency,'NGN'), new.balance, now())
  on conflict (user_id, currency)
    do update set balance = excluded.balance, updated_at = now();
  return new;
end $$;

drop trigger if exists wallets_sync_balances on wallets;
create trigger wallets_sync_balances after insert or update of balance, currency on wallets
  for each row execute function public.sync_wallet_balance();

-- Backfill existing wallets.
insert into wallet_balances(user_id, currency, balance, updated_at)
  select user_id, coalesce(currency,'NGN'), balance, now() from wallets
  on conflict (user_id, currency) do update set balance = excluded.balance, updated_at = now();

create or replace function public.my_wallet_balances()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return jsonb_build_object(
    'balances', coalesce((select jsonb_agg(jsonb_build_object(
        'currency', currency, 'balance', balance, 'updated_at', updated_at) order by balance desc)
      from wallet_balances where user_id = uid), '[]'::jsonb),
    'settlement_currency', coalesce((select currency from wallets where user_id=uid), 'NGN'),
    'rates', (select jsonb_object_agg(code, rate) from fx_rates where code in ('NGN','USD','GBP','EUR')));
end $$;

-- Convert between the user's own currency balances at the stored FX rate.
create or replace function public.convert_balance(p_from text, p_to text, p_amount numeric)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  uid uuid := auth.uid();
  v_from text := upper(trim(p_from));
  v_to text := upper(trim(p_to));
  v_rate_from numeric;
  v_rate_to numeric;
  v_ngn numeric;
  v_out numeric;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive' using errcode='22023'; end if;
  if v_from = v_to then raise exception 'currencies must differ' using errcode='22023'; end if;
  select rate into v_rate_from from fx_rates where code = v_from;
  select rate into v_rate_to from fx_rates where code = v_to;
  v_rate_from := coalesce(v_rate_from, 1); v_rate_to := coalesce(v_rate_to, 1);
  if (select coalesce(balance,0) from wallet_balances where user_id=uid and currency=v_from) < p_amount then
    raise exception 'insufficient % balance', v_from using errcode='22023';
  end if;
  v_ngn := p_amount * v_rate_from;
  v_out := round(v_ngn / v_rate_to, 2);
  update wallet_balances set balance = balance - p_amount, updated_at=now()
    where user_id=uid and currency=v_from;
  insert into wallet_balances(user_id, currency, balance, updated_at) values (uid, v_to, v_out, now())
    on conflict (user_id, currency) do update set balance = wallet_balances.balance + v_out, updated_at=now();
  insert into transactions(user_id, type, amount, method, ref)
    values (uid, 'convert', -p_amount, 'fx', 'fx:'||v_from||'>'||v_to||':'||round(v_out,2));
  return jsonb_build_object('from', v_from, 'to', v_to, 'in', p_amount, 'out', v_out, 'rate', round(v_ngn/p_amount, 6));
end $$;

-- ================================================================ B1 payment rails
create or replace function public.payment_rails()
returns jsonb language sql stable as $$
  select jsonb_build_array(
    jsonb_build_object('id','korapay','name','KoraPay','kinds',jsonb_build_array('card','bank_transfer','ussd'),
      'currencies',jsonb_build_array('NGN'),'fee_pct',1.5,'enabled',true),
    jsonb_build_object('id','paystack','name','Paystack','kinds',jsonb_build_array('card','bank_transfer'),
      'currencies',jsonb_build_array('NGN','GHS','ZAR','KES'),'fee_pct',1.5,'enabled',false),
    jsonb_build_object('id','flutterwave','name','Flutterwave','kinds',jsonb_build_array('card','bank_transfer','mobile_money'),
      'currencies',jsonb_build_array('NGN','GHS','KES','ZAR','USD'),'fee_pct',1.4,'enabled',false),
    jsonb_build_object('id','monnify','name','Monnify','kinds',jsonb_build_array('card','bank_transfer','ussd'),
      'currencies',jsonb_build_array('NGN'),'fee_pct',1.5,'enabled',false),
    jsonb_build_object('id','stripe','name','Stripe','kinds',jsonb_build_array('card','apple_pay','google_pay'),
      'currencies',jsonb_build_array('USD','GBP','EUR'),'fee_pct',2.9,'enabled',false),
    jsonb_build_object('id','paypal','name','PayPal','kinds',jsonb_build_array('paypal'),
      'currencies',jsonb_build_array('USD','GBP','EUR'),'fee_pct',3.4,'enabled',false),
    jsonb_build_object('id','usdt','name','USDT (crypto)','kinds',jsonb_build_array('crypto'),
      'currencies',jsonb_build_array('USDT'),'fee_pct',0.8,'enabled',false)
  );
$$;

-- ================================================================ M1-M7 branded app builds
create table if not exists app_builds (
  id             bigint generated always as identity primary key,
  business_id    bigint not null references businesses(id) on delete cascade,
  version        text not null default '1.0.0',
  status         text not null default 'queued',   -- queued | building | ready | failed
  artifact_url   text,
  download_token text,
  size_bytes     bigint,
  error          text,
  created_at     timestamptz not null default now(),
  built_at       timestamptz,
  expires_at     timestamptz
);
create index if not exists app_builds_business_idx on app_builds (business_id, created_at desc);
create unique index if not exists app_builds_token_key on app_builds (download_token) where download_token is not null;

create or replace function public.my_app_builds()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'version', a.version, 'status', a.status, 'size_bytes', a.size_bytes,
      'created_at', a.created_at, 'built_at', a.built_at, 'expires_at', a.expires_at,
      'download_url', case when a.status='ready' and a.download_token is not null
        then '/api/app/download/'||a.download_token else null end)
      order by a.created_at desc)
    from app_builds a join businesses b on b.id = a.business_id
    where b.user_id = auth.uid()), '[]'::jsonb);
$$;

-- Queue a branded build. Returns the build row; the backend worker fulfils it.
create or replace function public.request_app_build(p_version text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  uid uuid := auth.uid();
  v_biz businesses%rowtype;
  v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid;
  if not found then raise exception 'create your store first' using errcode='P0002'; end if;
  if v_biz.status <> 'active' then raise exception 'activate your store first' using errcode='P0002'; end if;
  insert into app_builds(business_id, version, status)
    values (v_biz.id, coalesce(nullif(trim(p_version),''), '1.0.0'), 'queued')
    returning id into v_id;
  update businesses set app_status = 'building', updated_at = now() where id = v_biz.id;
  return jsonb_build_object('id', v_id, 'status', 'queued', 'version', coalesce(p_version,'1.0.0'));
end $$;

-- ================================================================ O1/O13/O18 tours
create table if not exists tour_progress (
  user_id    uuid not null,
  tour_key   text not null,
  step       int not null default 0,
  completed  boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, tour_key)
);

create table if not exists tour_events (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  tour_key   text not null,
  step       int,
  event      text not null,       -- start | step | complete | skip | dismiss
  variant    text,
  created_at timestamptz not null default now()
);
create index if not exists tour_events_key_idx on tour_events (tour_key, event, created_at desc);

create or replace function public.tour_state(p_key text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v tour_progress%rowtype;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v from tour_progress where user_id=uid and tour_key=p_key;
  return jsonb_build_object('tour_key', p_key, 'step', coalesce(v.step,0),
    'completed', coalesce(v.completed,false), 'seen', v.user_id is not null);
end $$;

create or replace function public.tour_record(p_key text, p_step int default null,
                                              p_event text default 'step', p_complete boolean default null,
                                              p_variant text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v_step int; v_done boolean;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  insert into tour_progress(user_id, tour_key, step, completed, updated_at)
    values (uid, p_key, coalesce(p_step,0), coalesce(p_complete,false), now())
  on conflict (user_id, tour_key) do update
    set step = greatest(tour_progress.step, coalesce(p_step, tour_progress.step)),
        completed = coalesce(p_complete, tour_progress.completed),
        updated_at = now()
  returning step, completed into v_step, v_done;
  insert into tour_events(user_id, tour_key, step, event, variant)
    values (uid, p_key, p_step, p_event, p_variant);
  return jsonb_build_object('step', v_step, 'completed', v_done);
end $$;

-- O18 activation funnel: start -> steps -> complete per tour, plus drop-off.
create or replace function public.tour_funnel(p_days int default 30)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select tour_key,
      count(*) filter (where event='start')   as starts,
      count(*) filter (where event='step')    as steps,
      count(*) filter (where event='complete') as completes,
      count(*) filter (where event='skip')    as skips,
      round(100.0 * count(*) filter (where event='complete')
            / greatest(1, count(*) filter (where event='start')), 1) as completion_pct
      from tour_events
     where created_at > now() - make_interval(days => greatest(1, p_days))
     group by tour_key order by starts desc
  ) x;
$$;

-- ================================================================ O2/O10/O11/O14-O16 onboarding state
create table if not exists onboarding_state (
  user_id    uuid not null,
  item_key   text not null,
  done       boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_key)
);

create or replace function public.my_onboarding()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
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
  select count(*) into v_biz from businesses where user_id = uid;
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
end $$;

create or replace function public.onboarding_mark(p_key text, p_done boolean default true)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  insert into onboarding_state(user_id, item_key, done, updated_at) values (uid, p_key, p_done, now())
  on conflict (user_id, item_key) do update set done = p_done, updated_at = now();
  return jsonb_build_object('key', p_key, 'done', p_done);
end $$;

-- O10 tenant store launch checklist (owner-scoped, derived + manual).
create or replace function public.my_launch_checklist()
returns jsonb language sql stable security definer set search_path to 'public' as $$
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
    from businesses b where b.user_id = auth.uid()), 'null'::jsonb);
$$;

-- ================================================================ O17/K3 knowledge base
create table if not exists kb_articles (
  id         bigint generated always as identity primary key,
  slug       text not null unique,
  title      text not null,
  category   text not null default 'general',
  body       text not null,
  tags       text[] not null default '{}',
  published  boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.kb_search(p_q text default null, p_category text default null)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('slug',a.slug,'title',a.title,'category',a.category,
      'excerpt', left(a.body, 180)) order by a.title), '[]'::jsonb)
    from kb_articles a
   where a.published
     and (p_category is null or a.category = p_category)
     and (p_q is null or p_q='' or a.title ilike '%'||p_q||'%' or a.body ilike '%'||p_q||'%'
          or p_q = any(a.tags));
$$;

create or replace function public.kb_article(p_slug text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce((select to_jsonb(a) from kb_articles a where a.slug=p_slug and a.published), 'null'::jsonb);
$$;

-- ================================================================ E6 notifications center
create table if not exists notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  kind       text not null default 'info',
  title      text not null,
  body       text,
  href       text,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);

create or replace function public.my_notifications(p_limit int default 30)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return jsonb_build_object(
    'unread', (select count(*) from notifications where user_id=uid and not read),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'title',n.title,
        'body',n.body,'href',n.href,'read',n.read,'created_at',n.created_at) order by n.created_at desc)
      from (select * from notifications where user_id=uid order by created_at desc limit greatest(1,least(p_limit,100))) n), '[]'::jsonb));
end $$;

create or replace function public.notification_read(p_id bigint default null, p_all boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v_n int;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  if p_all then
    update notifications set read=true where user_id=uid and not read;
  else
    update notifications set read=true where user_id=uid and id=p_id;
  end if;
  get diagnostics v_n = row_count;
  return jsonb_build_object('updated', v_n);
end $$;

-- O16 what's-new / changelog
create table if not exists changelog (
  id         bigint generated always as identity primary key,
  version    text not null,
  title      text not null,
  body       text,
  released_at timestamptz not null default now()
);

create or replace function public.changelog_list(p_limit int default 10)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('version',c.version,'title',c.title,'body',c.body,
      'released_at',c.released_at) order by c.released_at desc), '[]'::jsonb)
    from (select * from changelog order by released_at desc limit greatest(1,least(p_limit,50))) c;
$$;

-- ================================================================ G5 experiments
create table if not exists experiments (
  key        text primary key,
  description text,
  variants   jsonb not null default '["a","b"]'::jsonb,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists experiment_assignments (
  user_id    uuid not null,
  key        text not null,
  variant    text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

create or replace function public.experiment_variant(p_key text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  uid uuid := auth.uid();
  v_exp experiments%rowtype;
  v_var text;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_exp from experiments where key=p_key;
  if not found or not v_exp.active then return jsonb_build_object('key',p_key,'variant',null,'active',false); end if;
  select variant into v_var from experiment_assignments where user_id=uid and key=p_key;
  if v_var is null then
    select value into v_var from jsonb_array_elements_text(v_exp.variants) value
     order by hashtext(uid::text || p_key) limit 1;
    insert into experiment_assignments(user_id, key, variant) values (uid, p_key, v_var)
      on conflict (user_id, key) do nothing;
  end if;
  return jsonb_build_object('key', p_key, 'variant', v_var, 'active', true);
end $$;

create or replace function public.experiment_stats()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select a.key, a.variant, count(*) as assigned
      from experiment_assignments a group by a.key, a.variant order by a.key, a.variant) x;
$$;

-- ================================================================ I4 coupons + loyalty
create table if not exists coupons (
  id            bigint generated always as identity primary key,
  code          text not null unique,
  kind          text not null default 'percent',   -- percent | flat | bonus
  value         numeric(12,2) not null,
  min_amount    numeric(12,2) not null default 0,
  max_redemptions int not null default 100,
  redemptions   int not null default 0,
  expires_at    timestamptz,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create table if not exists coupon_redemptions (
  id         bigint generated always as identity primary key,
  coupon_id  bigint not null references coupons(id) on delete cascade,
  user_id    uuid not null,
  amount     numeric(12,2) not null,
  created_at timestamptz not null default now(),
  unique (coupon_id, user_id)
);

create or replace function public.redeem_coupon(p_code text, p_amount numeric default 0)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  uid uuid := auth.uid();
  v coupons%rowtype;
  v_bonus numeric(12,2);
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v from coupons where upper(code)=upper(trim(p_code)) and active;
  if not found then raise exception 'invalid coupon' using errcode='22023'; end if;
  if v.expires_at is not null and v.expires_at < now() then raise exception 'coupon expired' using errcode='22023'; end if;
  if v.redemptions >= v.max_redemptions then raise exception 'coupon fully redeemed' using errcode='22023'; end if;
  if exists (select 1 from coupon_redemptions where coupon_id=v.id and user_id=uid) then
    raise exception 'coupon already used' using errcode='23505';
  end if;
  v_bonus := case v.kind when 'percent' then round(coalesce(p_amount,0) * v.value / 100.0, 2)
                         when 'flat' then least(v.value, coalesce(p_amount,0))
                         else v.value end;
  insert into coupon_redemptions(coupon_id, user_id, amount) values (v.id, uid, v_bonus);
  update coupons set redemptions = redemptions + 1 where id = v.id;
  if v_bonus > 0 then
    insert into wallets(user_id, balance, currency) values (uid, 0, 'NGN')
      on conflict (user_id) do nothing;
    update wallets set balance = balance + v_bonus, updated_at=now() where user_id=uid;
    insert into transactions(user_id, type, amount, method, ref)
      values (uid, 'bonus', v_bonus, 'coupon', 'coupon:'||v.code);
  end if;
  return jsonb_build_object('code', v.code, 'kind', v.kind, 'credit', v_bonus);
end $$;

-- ================================================================ I2 affiliate payouts
create table if not exists affiliate_payouts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  amount     numeric(14,2) not null,
  method     text not null default 'wallet',
  status     text not null default 'paid',
  reference  text,
  created_at timestamptz not null default now()
);

create or replace function public.my_affiliate_payouts()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v_earned numeric; v_paid numeric;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select coalesce(sum(earned),0) into v_earned from referrals where referrer_id=uid;
  select coalesce(sum(amount),0) into v_paid from affiliate_payouts where user_id=uid;
  return jsonb_build_object(
    'earned', v_earned, 'paid', v_paid, 'available', greatest(0, v_earned - v_paid),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount,'method',p.method,
        'status',p.status,'reference',p.reference,'created_at',p.created_at) order by p.created_at desc)
      from affiliate_payouts p where p.user_id=uid), '[]'::jsonb));
end $$;

create or replace function public.request_affiliate_payout(p_amount numeric default null, p_method text default 'wallet')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  uid uuid := auth.uid();
  v_earned numeric; v_paid numeric; v_avail numeric; v_amt numeric; v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select coalesce(sum(earned),0) into v_earned from referrals where referrer_id=uid;
  select coalesce(sum(amount),0) into v_paid from affiliate_payouts where user_id=uid;
  v_avail := greatest(0, v_earned - v_paid);
  v_amt := coalesce(p_amount, v_avail);
  if v_amt <= 0 then raise exception 'nothing to pay out' using errcode='22023'; end if;
  if v_amt < 5 then raise exception 'minimum payout is 5' using errcode='22023'; end if;
  if v_amt > v_avail then raise exception 'amount exceeds available' using errcode='22023'; end if;
  insert into affiliate_payouts(user_id, amount, method, status, reference)
    values (uid, v_amt, coalesce(p_method,'wallet'), 'paid', 'aff:'||uid||':'||extract(epoch from now())::bigint)
    returning id into v_id;
  update referrals set claimed = true where referrer_id=uid and not coalesce(claimed,false);
  if coalesce(p_method,'wallet') = 'wallet' then
    insert into wallets(user_id, balance, currency) values (uid, 0, 'NGN') on conflict (user_id) do nothing;
    update wallets set balance = balance + v_amt, updated_at=now() where user_id=uid;
    insert into transactions(user_id, type, amount, method, ref)
      values (uid, 'affiliate_payout', v_amt, 'affiliate', 'aff_payout:'||v_id);
  end if;
  return jsonb_build_object('payout_id', v_id, 'amount', v_amt, 'available', v_avail - v_amt);
end $$;

-- ================================================================ I3 operator program
create table if not exists operator_applications (
  id            bigint generated always as identity primary key,
  user_id       uuid not null,
  msisdn        text not null,
  country       text,
  device        text,
  carrier       text,
  status        text not null default 'pending',   -- pending | approved | rejected | active
  revenue_share numeric(5,2) not null default 60,
  health        text not null default 'unknown',
  created_at    timestamptz not null default now()
);

create or replace function public.my_operator_status()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return coalesce((select jsonb_build_object('id',o.id,'msisdn',o.msisdn,'country',o.country,
      'device',o.device,'carrier',o.carrier,'status',o.status,'revenue_share',o.revenue_share,
      'health',o.health,'created_at',o.created_at)
    from operator_applications o where o.user_id=uid order by o.created_at desc limit 1), 'null'::jsonb);
end $$;

create or replace function public.apply_operator(p_msisdn text, p_country text default null,
                                                 p_device text default null, p_carrier text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  if coalesce(trim(p_msisdn),'') = '' then raise exception 'phone number required' using errcode='22023'; end if;
  if exists (select 1 from operator_applications where user_id=uid and status in ('pending','approved','active')) then
    raise exception 'you already have an application' using errcode='23505';
  end if;
  insert into operator_applications(user_id, msisdn, country, device, carrier)
    values (uid, trim(p_msisdn), p_country, p_device, p_carrier) returning id into v_id;
  return jsonb_build_object('id', v_id, 'status', 'pending');
end $$;

-- ================================================================ I6 lifecycle email queue
create table if not exists email_queue (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  to_email   text not null,
  template   text not null,
  payload    jsonb not null default '{}'::jsonb,
  status     text not null default 'queued',   -- queued | sent | failed
  attempts   int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index if not exists email_queue_pending_idx on email_queue (status, created_at);

-- ================================================================ H1 API key scopes/limits
alter table api_keys add column if not exists scopes text[] not null default array['read','write'];
alter table api_keys add column if not exists rate_limit int not null default 60;
alter table api_keys add column if not exists quota_month int not null default 10000;
alter table api_keys add column if not exists ip_allowlist text[] not null default '{}';
alter table api_keys add column if not exists sandbox boolean not null default false;

create or replace function public.api_key_settings(p_id bigint, p_scopes text[] default null,
    p_rate_limit int default null, p_quota int default null, p_ip_allowlist text[] default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v api_keys%rowtype;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v from api_keys where id=p_id and user_id=uid;
  if not found then raise exception 'key not found' using errcode='P0002'; end if;
  update api_keys set
    scopes = coalesce(p_scopes, scopes),
    rate_limit = coalesce(p_rate_limit, rate_limit),
    quota_month = coalesce(p_quota, quota_month),
    ip_allowlist = coalesce(p_ip_allowlist, ip_allowlist)
   where id = p_id
  returning * into v;
  return jsonb_build_object('id', v.id, 'scopes', v.scopes, 'rate_limit', v.rate_limit,
    'quota_month', v.quota_month, 'ip_allowlist', v.ip_allowlist, 'sandbox', v.sandbox);
end $$;

-- H4 sandbox key: a fake key that never bills and simulates SMS.
create or replace function public.create_sandbox_key(p_name text default 'sandbox')
returns jsonb language plpgsql security definer set search_path to 'public','extensions' as $$
declare
  uid uuid := auth.uid();
  v_secret text; v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  v_secret := 'sk_test_' || encode(extensions.gen_random_bytes(20), 'hex');
  insert into api_keys(user_id, name, key_prefix, key_hash, scopes, sandbox)
    values (uid, coalesce(p_name,'sandbox'), left(v_secret, 12),
            encode(extensions.digest(v_secret,'sha256'),'hex'), array['read','write'], true)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'key', v_secret, 'sandbox', true,
    'warning', 'Sandbox key: simulated numbers and SMS only, never billed.');
end $$;

-- H5 usage metering
create table if not exists api_usage (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  api_key_id bigint,
  path       text not null,
  method     text not null default 'GET',
  status     int,
  created_at timestamptz not null default now()
);
create index if not exists api_usage_user_idx on api_usage (user_id, created_at desc);

create or replace function public.api_usage_summary(p_days int default 30)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return jsonb_build_object(
    'total', (select count(*) from api_usage where user_id=uid and created_at > now() - make_interval(days=>greatest(1,p_days))),
    'by_path', coalesce((select jsonb_agg(jsonb_build_object('path',path,'count',c)) from (
        select path, count(*) c from api_usage where user_id=uid
          and created_at > now() - make_interval(days=>greatest(1,p_days))
         group by path order by c desc limit 20) x), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day',d,'count',c) order by d) from (
        select date_trunc('day',created_at)::date d, count(*) c from api_usage where user_id=uid
          and created_at > now() - make_interval(days=>greatest(1,p_days))
         group by 1) y), '[]'::jsonb),
    'quota', coalesce((select quota_month from api_keys where user_id=uid and not revoked order by created_at limit 1), 10000));
end $$;

-- H2 customer webhooks
create table if not exists webhook_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  url        text not null,
  secret     text not null,
  events     text[] not null default array['order.created','order.received','order.refunded'],
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists webhook_deliveries (
  id         bigint generated always as identity primary key,
  sub_id     bigint not null references webhook_subscriptions(id) on delete cascade,
  event      text not null,
  payload    jsonb not null,
  status     text not null default 'pending',
  attempts   int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists webhook_deliveries_pending_idx on webhook_deliveries (status, created_at);

create or replace function public.my_webhook_subs()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'url',s.url,'events',s.events,
      'active',s.active,'created_at',s.created_at) order by s.created_at desc)
    from webhook_subscriptions s where s.user_id=uid), '[]'::jsonb);
end $$;

create or replace function public.create_webhook_sub(p_url text, p_events text[] default null)
returns jsonb language plpgsql security definer set search_path to 'public','extensions' as $$
declare uid uuid := auth.uid(); v_secret text; v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  if p_url !~ '^https?://' then raise exception 'invalid url' using errcode='22023'; end if;
  v_secret := 'whsec_' || encode(extensions.gen_random_bytes(24),'hex');
  insert into webhook_subscriptions(user_id, url, secret, events)
    values (uid, p_url, v_secret, coalesce(p_events, array['order.created','order.received','order.refunded']))
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'secret', v_secret, 'url', p_url);
end $$;

create or replace function public.delete_webhook_sub(p_id bigint)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); v_n int;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  delete from webhook_subscriptions where id=p_id and user_id=uid;
  get diagnostics v_n = row_count;
  return jsonb_build_object('deleted', v_n);
end $$;

-- H6 idempotency keys
create table if not exists api_idempotency (
  key        text primary key,
  user_id    uuid not null,
  response   jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.idempotency_lookup(p_key text, p_user uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select response from api_idempotency where key=p_key and user_id=p_user;
$$;

create or replace function public.idempotency_store(p_key text, p_user uuid, p_response jsonb)
returns void language sql security definer set search_path to 'public' as $$
  insert into api_idempotency(key, user_id, response) values (p_key, p_user, p_response)
  on conflict (key) do nothing;
$$;

-- ================================================================ E5 saved payment methods
create table if not exists payment_methods (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  provider   text not null default 'korapay',
  brand      text,
  last4      text,
  exp        text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.my_payment_methods()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'provider',m.provider,'brand',m.brand,
      'last4',m.last4,'exp',m.exp,'is_default',m.is_default,'created_at',m.created_at) order by m.is_default desc, m.created_at desc)
    from payment_methods m where m.user_id=uid), '[]'::jsonb);
end $$;

-- ================================================================ B8/L3 double-entry ledger
create table if not exists ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  account    text not null,           -- wallet | revenue | cogs | refunds | payouts | tax
  direction  text not null,           -- debit | credit
  amount     numeric(16,2) not null,
  currency   text not null default 'NGN',
  ref        text,
  meta       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ledger_created_idx on ledger (created_at desc);
create index if not exists ledger_account_idx on ledger (account, created_at desc);

create or replace function public.ledger_export(p_from date default null, p_to date default null)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'user_id',l.user_id,'account',l.account,
      'direction',l.direction,'amount',l.amount,'currency',l.currency,'ref',l.ref,'created_at',l.created_at)
      order by l.created_at desc), '[]'::jsonb)
    from ledger l
   where (p_from is null or l.created_at >= p_from)
     and (p_to is null or l.created_at < (p_to + interval '1 day'));
$$;

-- ================================================================ L2 tax / VAT
create table if not exists invoices (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  number     text not null unique,
  subtotal   numeric(14,2) not null,
  tax        numeric(14,2) not null default 0,
  total      numeric(14,2) not null,
  currency   text not null default 'NGN',
  status     text not null default 'paid',
  meta       jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.tax_report(p_days int default 30)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'period_days', greatest(1,p_days),
    'fees_ngn', coalesce((select sum(fee_ngn) from payments where status='success'
        and created_at > now() - make_interval(days=>greatest(1,p_days))), 0),
    'vat_rate', coalesce((select (value#>>'{}')::numeric from settings where key='vat_rate'), 0.075),
    'revenue_ngn', coalesce((select sum(amount) from business_earnings where created_at > now() - make_interval(days=>greatest(1,p_days))), 0),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object('number',i.number,'total',i.total,
        'tax',i.tax,'created_at',i.created_at) order by i.created_at desc)
      from (select * from invoices order by created_at desc limit 100) i), '[]'::jsonb));
$$;

-- ================================================================ F9 feature flags
-- tenant_id 0 = global default; a row with a tenant_id overrides it.
create table if not exists feature_flags (
  key         text not null,
  tenant_id   bigint not null default 0,
  enabled     boolean not null default false,
  description text,
  updated_at  timestamptz not null default now(),
  primary key (key, tenant_id)
);
alter table feature_flags alter column tenant_id set default 0;
update feature_flags set tenant_id = 0 where tenant_id is null;

create or replace function public.flag_get(p_key text, p_tenant bigint default null)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select enabled from feature_flags where key=p_key and tenant_id = coalesce(p_tenant,0)),
    (select enabled from feature_flags where key=p_key and tenant_id = 0),
    false);
$$;

-- ================================================================ K2 SLA columns
alter table support_tickets add column if not exists sla_due_at timestamptz;
alter table support_tickets add column if not exists first_response_at timestamptz;
alter table support_tickets add column if not exists canned_reply text;

-- ================================================================ K6 status subscribers
create table if not exists status_subscribers (
  email      text primary key,
  created_at timestamptz not null default now(),
  confirmed  boolean not null default false
);

-- ================================================================ F6-F9 admin RPCs
create or replace function public.admin_tenants_list(p_q text default null, p_limit int default 100)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select b.id, b.name, b.slug, b.status, b.plan, b.markup_percent, b.domain, b.created_at,
           u.email as owner_email,
           (select count(*) from orders o where o.business_id=b.id) as orders,
           coalesce((select sum(amount) from business_earnings e where e.business_id=b.id),0) as earned_ngn
      from businesses b left join profiles u on u.id=b.user_id
     where p_q is null or p_q='' or b.name ilike '%'||p_q||'%' or b.slug ilike '%'||p_q||'%'
     order by b.created_at desc limit greatest(1,least(p_limit,500))) x;
$$;

create or replace function public.admin_tenant_set_status(p_id bigint, p_status text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  update businesses set status = p_status, updated_at = now() where id = p_id;
  return jsonb_build_object('id', p_id, 'status', p_status);
end $$;

create or replace function public.admin_tenant_payouts(p_id bigint)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount,'method',p.method,
      'status',p.status,'reference',p.reference,'created_at',p.created_at) order by p.created_at desc), '[]'::jsonb)
    from tenant_payouts p where p.business_id = p_id;
$$;

-- F7 support console: queue + assignment + canned replies.
create or replace function public.admin_support_queue(p_status text default 'open', p_limit int default 100)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select t.id, t.user_id, t.subject, t.status, t.priority, t.assigned_to,
           t.created_at, t.updated_at, t.sla_due_at, t.first_response_at,
           (select count(*) from ticket_messages m where m.ticket_id=t.id) as messages
      from support_tickets t
     where p_status is null or t.status = p_status
     order by t.created_at desc limit greatest(1,least(p_limit,500))) x;
$$;

create or replace function public.admin_ticket_assign(p_id bigint, p_agent text, p_priority text default null, p_canned text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  update support_tickets set assigned_to = p_agent,
         priority = coalesce(p_priority, priority),
         canned_reply = coalesce(p_canned, canned_reply),
         sla_due_at = coalesce(sla_due_at, now() + interval '24 hours')
   where id = p_id;
  return jsonb_build_object('id', p_id, 'assigned_to', p_agent);
end $$;

-- F8 fraud console: review queue over risk_events.
create or replace function public.admin_fraud_queue(p_limit int default 100)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select r.id, r.user_id, r.kind, r.score, r.allow, r.reasons, r.created_at,
           p.email
      from risk_events r left join profiles p on p.id=r.user_id
     where not coalesce(r.allow,false)
     order by r.created_at desc limit greatest(1,least(p_limit,500))) x;
$$;

create or replace function public.admin_flag_set(p_key text, p_enabled boolean, p_tenant bigint default null, p_description text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  insert into feature_flags(key, tenant_id, enabled, description, updated_at)
    values (p_key, coalesce(p_tenant, 0), p_enabled, p_description, now())
  on conflict (key, tenant_id) do update set enabled=p_enabled,
    description=coalesce(p_description, feature_flags.description), updated_at=now();
  return jsonb_build_object('key', p_key, 'tenant_id', coalesce(p_tenant,0), 'enabled', p_enabled);
end $$;

create or replace function public.admin_flags_list()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('key',f.key,'tenant_id',f.tenant_id,'enabled',f.enabled,
      'description',f.description,'updated_at',f.updated_at) order by f.key), '[]'::jsonb)
    from feature_flags f;
$$;

create or replace function public.admin_settings_get()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from settings;
$$;

create or replace function public.admin_setting_set(p_key text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  insert into settings(key, value, updated_at) values (p_key, p_value, now())
    on conflict (key) do update set value=p_value, updated_at=now();
  return jsonb_build_object('key', p_key, 'value', p_value);
end $$;

-- ================================================================ seeds
insert into coupons(code, kind, value, min_amount, max_redemptions, active)
  values ('WELCOME10','percent',10,1000,1000,true)
  on conflict (code) do nothing;

insert into experiments(key, description, variants, active)
  values ('dashboard_layout','Overview hero A/B test','["a","b"]'::jsonb,true)
  on conflict (key) do nothing;

insert into changelog(version, title, body) values
  ('1.6','Branded apps & guided tours','Build a branded Android app, follow in-app tours, and track your margin.'),
  ('1.7','Multi-currency wallet & coupons','Hold balances in more currencies, convert instantly, and redeem coupons.'),
  ('1.8','Developer platform','Scoped API keys, customer webhooks, sandbox, and usage metering.')
  on conflict do nothing;

insert into kb_articles(slug, title, category, body, tags) values
  ('getting-started','Getting started with SMSPin','basics',
   'Create an account, fund your wallet, then buy your first virtual number. Codes arrive in your inbox within minutes.', array['start','intro']),
  ('funding-wallet','How do I fund my wallet?','billing',
   'Open the wallet page and choose an amount. Pay by card, bank transfer or USSD. Your balance updates automatically when the payment clears.', array['wallet','funding','payment']),
  ('api-quickstart','API quickstart','developers',
   'Create an API key, then call POST /api/v1/order with a country and service. Poll GET /api/v1/order?id=... or subscribe to webhooks for the code.', array['api','developers']),
  ('custom-domain','Connect a custom domain to your store','stores',
   'In Business settings, set your domain. Point a CNAME at your SMSPin host and your store serves from your own domain.', array['store','domain']),
  ('auto-refunds','What happens if no SMS arrives?','orders',
   'Orders expire after 20 minutes. If no code arrives, the full amount is refunded to your wallet automatically.', array['refund','orders'])
  on conflict (slug) do nothing;

insert into feature_flags(key, tenant_id, enabled, description) values
  ('multi_currency', 0, true, 'Per-currency wallet balances + conversion'),
  ('customer_webhooks', 0, true, 'User-defined webhook subscriptions'),
  ('tours', 0, true, 'In-app guided tours'),
  ('sandbox_api', 0, true, 'Sandbox API keys and simulated SMS')
  on conflict (key, tenant_id) do nothing;

-- ================================================================ grants / locks
do $$
declare f text;
begin
  -- Owner-scoped, signed-in users (dashboard calls these via Supabase RPC).
  foreach f in array array[
    'my_wallet_balances','convert_balance','my_app_builds','request_app_build',
    'tour_state','tour_record','my_onboarding','onboarding_mark','my_launch_checklist',
    'my_notifications','notification_read','experiment_variant','redeem_coupon',
    'my_affiliate_payouts','request_affiliate_payout','my_operator_status','apply_operator',
    'api_key_settings','create_sandbox_key','api_usage_summary','my_webhook_subs',
    'create_webhook_sub','delete_webhook_sub','my_payment_methods'
  ] loop
    execute format('grant execute on function public.%I to authenticated, service_role', f);
  end loop;

  -- Public reads (marketing site / storefront / docs).
  foreach f in array array[
    'payment_rails','kb_search','kb_article','changelog_list','tour_funnel'
  ] loop
    execute format('grant execute on function public.%I to anon, authenticated, service_role', f);
  end loop;

  -- Backend/ops only (service_role; backend checks admin first).
  foreach f in array array[
    'sync_wallet_balance','ledger_export','tax_report','idempotency_lookup','idempotency_store',
    'experiment_stats','flag_get','admin_tenants_list','admin_tenant_set_status','admin_tenant_payouts',
    'admin_support_queue','admin_ticket_assign','admin_fraud_queue','admin_flag_set','admin_flags_list',
    'admin_settings_get','admin_setting_set'
  ] loop
    execute format('revoke all on function public.%I from public, anon, authenticated', f);
    execute format('grant execute on function public.%I to service_role', f);
  end loop;
end $$;

-- ================================================================ backend helpers
-- H2: enqueue a customer webhook delivery for every matching active subscription.
create or replace function public.customer_webhook_enqueue(p_user uuid, p_event text, p_payload jsonb)
returns int language plpgsql security definer set search_path to 'public' as $$
declare v_n int := 0;
begin
  if p_user is null then return 0; end if;
  insert into webhook_deliveries(sub_id, event, payload)
    select s.id, p_event, p_payload from webhook_subscriptions s
     where s.user_id = p_user and s.active and p_event = any(s.events);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.customer_webhook_pending(p_limit int default 20)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select d.id, d.event, d.payload, d.attempts, s.url, s.secret
      from webhook_deliveries d join webhook_subscriptions s on s.id = d.sub_id
     where d.status = 'pending' order by d.created_at limit greatest(1,least(p_limit,100))) x;
$$;

create or replace function public.customer_webhook_mark(p_id bigint, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update webhook_deliveries set
    attempts = attempts + 1,
    status = case when p_ok then 'delivered' else (case when attempts + 1 >= 5 then 'failed' else 'pending' end) end,
    last_error = p_error,
    delivered_at = case when p_ok then now() else delivered_at end
   where id = p_id;
end $$;

-- I6: lifecycle email queue helpers.
create or replace function public.email_enqueue(p_user uuid, p_email text, p_template text, p_payload jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v_id bigint;
begin
  if coalesce(trim(p_email),'') = '' then return null; end if;
  insert into email_queue(user_id, to_email, template, payload) values (p_user, p_email, p_template, coalesce(p_payload,'{}'::jsonb))
    returning id into v_id;
  return v_id;
end $$;

create or replace function public.email_queue_pending(p_limit int default 20)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'to_email',e.to_email,'template',e.template,
      'payload',e.payload,'attempts',e.attempts) order by e.created_at), '[]'::jsonb)
    from (select * from email_queue where status='queued' order by created_at limit greatest(1,least(p_limit,100))) e;
$$;

create or replace function public.email_queue_mark(p_id bigint, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update email_queue set attempts = attempts + 1,
    status = case when p_ok then 'sent' else (case when attempts + 1 >= 3 then 'failed' else 'queued' end) end,
    last_error = p_error, sent_at = case when p_ok then now() else sent_at end
   where id = p_id;
end $$;

-- M4: app build queue helpers.
create or replace function public.app_build_pending(p_limit int default 5)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select a.id, a.business_id, a.version, b.slug, b.name, b.primary_color, b.secondary_color,
           b.tagline, b.support_email, b.domain
      from app_builds a join businesses b on b.id = a.business_id
     where a.status = 'queued' order by a.created_at limit greatest(1,least(p_limit,20))) x;
$$;

create or replace function public.app_build_mark(p_id bigint, p_status text, p_url text default null,
    p_token text default null, p_size bigint default null, p_error text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_biz bigint;
begin
  update app_builds set status = p_status,
    artifact_url = coalesce(p_url, artifact_url),
    download_token = coalesce(p_token, download_token),
    size_bytes = coalesce(p_size, size_bytes),
    error = p_error,
    built_at = case when p_status='ready' then now() else built_at end,
    expires_at = case when p_status='ready' then now() + interval '30 days' else expires_at end
   where id = p_id returning business_id into v_biz;
  if v_biz is not null then
    update businesses set app_status = p_status, updated_at = now() where id = v_biz;
  end if;
  return jsonb_build_object('id', p_id, 'status', p_status);
end $$;

create or replace function public.app_build_by_token(p_token text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce((select jsonb_build_object('id',a.id,'status',a.status,'version',a.version,
      'artifact_url',a.artifact_url,'expires_at',a.expires_at,'slug',b.slug,'name',b.name)
    from app_builds a join businesses b on b.id=a.business_id
   where a.download_token = p_token and a.status='ready'
     and (a.expires_at is null or a.expires_at > now())), 'null'::jsonb);
$$;

-- E6: insert an in-app notification.
create or replace function public.notify_user(p_user uuid, p_kind text, p_title text, p_body text default null, p_href text default null)
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v_id bigint;
begin
  if p_user is null then return null; end if;
  insert into notifications(user_id, kind, title, body, href) values (p_user, coalesce(p_kind,'info'), p_title, p_body, p_href)
    returning id into v_id;
  return v_id;
end $$;

-- H5: record API usage.
create or replace function public.record_api_usage(p_user uuid, p_key_id bigint, p_path text, p_method text, p_status int)
returns void language sql security definer set search_path to 'public' as $$
  insert into api_usage(user_id, api_key_id, path, method, status) values (p_user, p_key_id, p_path, p_method, p_status);
$$;

-- H1: resolve an API key to its settings + this month's usage for quota checks.
create or replace function public.api_key_by_hash(p_hash text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce((select jsonb_build_object('id',k.id,'user_id',k.user_id,'name',k.name,
      'scopes',k.scopes,'rate_limit',k.rate_limit,'quota_month',k.quota_month,
      'ip_allowlist',k.ip_allowlist,'sandbox',k.sandbox,'revoked',k.revoked,
      'used_month',(select count(*) from api_usage u where u.api_key_id=k.id
                     and u.created_at > date_trunc('month', now())))
    from api_keys k where k.key_hash = p_hash), 'null'::jsonb);
$$;

-- M6: mark a tenant's app as provisioned once a build is ready.
create or replace function public.business_app_status()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce((select jsonb_build_object('app_status',b.app_status,'plan',b.plan,
      'latest_build',(select jsonb_build_object('id',a.id,'status',a.status,'version',a.version,
        'created_at',a.created_at,'size_bytes',a.size_bytes) from app_builds a where a.business_id=b.id
        order by a.created_at desc limit 1))
    from businesses b where b.user_id=auth.uid()), 'null'::jsonb);
$$;

-- ================================================================ more grants
do $$
declare f text;
begin
  foreach f in array array['business_app_status'] loop
    execute format('grant execute on function public.%I to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'customer_webhook_enqueue','customer_webhook_pending','customer_webhook_mark',
    'email_enqueue','email_queue_pending','email_queue_mark',
    'app_build_pending','app_build_mark','app_build_by_token',
    'notify_user','record_api_usage','api_key_by_hash'
  ] loop
    execute format('revoke all on function public.%I from public, anon, authenticated', f);
    execute format('grant execute on function public.%I to service_role', f);
  end loop;
  execute 'grant execute on function public.app_build_by_token(text) to anon, authenticated, service_role';
end $$;

-- ================================================================ I6 lifecycle triggers
create or replace function public.tg_welcome_email()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.email is not null then
    perform public.email_enqueue(new.id, new.email, 'welcome', jsonb_build_object('name', new.full_name));
  end if;
  return new;
end $$;

drop trigger if exists profiles_welcome_email on profiles;
create trigger profiles_welcome_email after insert on profiles
  for each row execute function public.tg_welcome_email();

create or replace function public.tg_fund_receipt()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_email text;
begin
  if new.type = 'fund' and new.amount > 0 then
    select email into v_email from profiles where id = new.user_id;
    perform public.email_enqueue(new.user_id, v_email, 'receipt',
      jsonb_build_object('amount', new.amount, 'method', new.method, 'ref', new.ref));
  end if;
  return new;
end $$;

drop trigger if exists transactions_fund_receipt on transactions;
create trigger transactions_fund_receipt after insert on transactions
  for each row execute function public.tg_fund_receipt();

-- ================================================================ B8/L3 ledger triggers
create or replace function public.tg_ledger_transaction()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_account text;
begin
  v_account := case
    when new.type = 'fund' then 'wallet'
    when new.type in ('purchase','order') then 'revenue'
    when new.type = 'refund' then 'refunds'
    when new.type in ('payout','affiliate_payout','business_payout') then 'payouts'
    else 'wallet' end;
  insert into ledger(user_id, account, direction, amount, currency, ref)
    values (new.user_id, v_account,
            case when new.amount >= 0 then 'credit' else 'debit' end,
            abs(new.amount), 'NGN', new.ref);
  return new;
end $$;

drop trigger if exists transactions_ledger on transactions;
create trigger transactions_ledger after insert on transactions
  for each row execute function public.tg_ledger_transaction();

-- Backfill a ledger row per existing transaction (once).
insert into ledger(user_id, account, direction, amount, currency, ref, created_at)
  select t.user_id,
    case when t.type='fund' then 'wallet' when t.type in ('purchase','order') then 'revenue'
         when t.type='refund' then 'refunds' else 'wallet' end,
    case when t.amount >= 0 then 'credit' else 'debit' end,
    abs(t.amount), 'NGN', t.ref, t.created_at
  from transactions t
  where not exists (select 1 from ledger l where l.ref = t.ref and l.user_id = t.user_id and l.created_at = t.created_at);
