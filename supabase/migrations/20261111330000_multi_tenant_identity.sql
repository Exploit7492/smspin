-- Task 4 — unique-email multi-tenant identity with nested stores.
--
-- Identity is (email, tenant). A single email therefore has one independent
-- account per store and can sign in on every store separately; the platform
-- account is just the tenant_slug IS NULL case. Stores may also be nested: a
-- store owner can spin up child stores (and issue API keys) underneath their
-- own, and a child inherits its parent's root for round-robin continuity.

-- 1. Nesting -----------------------------------------------------------------
alter table public.businesses
  add column if not exists parent_id bigint references public.businesses(id) on delete set null,
  add column if not exists root_id   bigint;

-- Backfill: every existing store is its own root.
update public.businesses set root_id = id where root_id is null;

create index if not exists businesses_parent_id_idx on public.businesses(parent_id);
create index if not exists businesses_root_id_idx on public.businesses(root_id);
create index if not exists businesses_user_root_idx on public.businesses(user_id) where parent_id is null;

-- One ROOT store per user (children are unlimited and are scoped by parent_id),
-- which is what lets every "the user's store" lookup below stay unambiguous.
create unique index if not exists businesses_user_root_key
  on public.businesses(user_id) where parent_id is null;

-- Recompute root_id from the parent chain. Depth is bounded by the guard, so a
-- cycle can never spin forever.
create or replace function public.business_set_root()
returns trigger language plpgsql as $function$
declare v_root bigint; v_guard int := 0; v_cur bigint := new.parent_id;
begin
  if new.parent_id is null then
    new.root_id := new.id;
    return new;
  end if;
  while v_cur is not null and v_guard < 32 loop
    v_root := v_cur;
    select parent_id into v_cur from public.businesses where id = v_cur;
    v_guard := v_guard + 1;
  end loop;
  new.root_id := coalesce(v_root, new.id);
  return new;
end $function$;

drop trigger if exists businesses_set_root on public.businesses;
create trigger businesses_set_root before insert or update of parent_id on public.businesses
  for each row execute function public.business_set_root();

-- 2. Identity: (email, tenant) is unique ------------------------------------
create unique index if not exists tenant_accounts_email_slug_key
  on public.tenant_accounts (lower(email), coalesce(tenant_slug, ''));

-- 3. Create a nested child store under the caller's root store --------------
create or replace function public.create_child_business(
  p_name text, p_parent_slug text default null, p_theme text default null, p_markup numeric default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  uid uuid := auth.uid();
  v_parent businesses%rowtype; v_slug text; v_id bigint;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'store name required' using errcode='22023'; end if;

  select * into v_parent from businesses
   where user_id = uid and parent_id is null for update;
  if not found then raise exception 'create your store first' using errcode='P0002'; end if;

  v_slug := trim(both '-' from lower(regexp_replace(p_name, '[^a-zA-Z0-9]+', '-', 'g')));
  if v_slug = '' then v_slug := 'store'; end if;
  while exists (select 1 from businesses where slug = v_slug) loop
    v_slug := v_slug || '-' || substr(md5(random()::text), 1, 4);
  end loop;

  insert into businesses(user_id, name, slug, theme, markup_percent, status, parent_id, root_id)
    values (uid, trim(p_name), v_slug, coalesce(p_theme, v_parent.theme, 'crimson'),
            greatest(0, coalesce(p_markup, v_parent.markup_percent, 0)), 'draft',
            v_parent.id, v_parent.root_id)
    returning id into v_id;

  return jsonb_build_object('id', v_id, 'slug', v_slug, 'name', trim(p_name),
    'parent_id', v_parent.id, 'root_id', v_parent.root_id, 'status', 'draft');
end $function$;

-- 4. List the caller's root store plus every nested child -------------------
create or replace function public.my_businesses()
returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'slug', b.slug, 'name', b.name, 'theme', b.theme,
           'status', b.status, 'app_status', b.app_status,
           'parent_id', b.parent_id, 'root_id', b.root_id,
           'markup_percent', b.markup_percent) order by b.id), '[]'::jsonb)
    from businesses b
   where b.user_id = auth.uid();
$function$;

-- 5. Round-robin continuity --------------------------------------------------
-- When an email exists on several tenants, hand back the most recently used
-- account for that email so sign-in "continues" where the visitor left off;
-- ties break deterministically by account id, giving a stable rotation.
create or replace function public.tenant_identities_for_email(p_email text)
returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'account_id', a.id, 'tenant_slug', a.tenant_slug, 'business_id', a.business_id,
           'tenant_name', coalesce(b.name, 'SMSPin'), 'theme', coalesce(b.theme, 'crimson'),
           'last_login_at', a.last_login_at) order by a.last_login_at desc nulls last, a.id), '[]'::jsonb)
    from tenant_accounts a
    left join businesses b on b.id = a.business_id
   where lower(a.email) = lower(trim(p_email));
$function$;

-- Sign in with just an email + password: resolve the tenant from the identity
-- that was used most recently (round-robin continuity) rather than requiring
-- the visitor to say which store they mean.
create or replace function public.tenant_login_auto(p_email text, p_password text)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_slug text;
  v_acc tenant_accounts%rowtype;
  v_token text; v_bal numeric;
begin
  select a.tenant_slug into v_slug
    from tenant_accounts a
   where lower(a.email) = lower(trim(p_email))
   order by a.last_login_at desc nulls last, a.id
   limit 1;
  if v_slug is null and not exists (select 1 from tenant_accounts where lower(email)=lower(trim(p_email))) then
    raise exception 'invalid email or password' using errcode='28P01';
  end if;

  select * into v_acc from tenant_accounts
   where lower(email) = lower(trim(p_email))
     and coalesce(tenant_slug,'') = coalesce(v_slug,'');
  if not found or v_acc.password_hash <> extensions.crypt(p_password, v_acc.password_hash) then
    raise exception 'invalid email or password' using errcode='28P01';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into tenant_sessions(token, account_id) values (v_token, v_acc.id);
  update tenant_accounts set last_login_at = now() where id = v_acc.id;

  select balance into v_bal from tenant_wallets where account_id = v_acc.id;
  return jsonb_build_object(
    'token', v_token, 'account_id', v_acc.id, 'email', v_acc.email,
    'full_name', coalesce(v_acc.full_name,''), 'tenant_slug', v_acc.tenant_slug,
    'business_id', v_acc.business_id, 'balance', coalesce(v_bal,0), 'currency','NGN');
end $function$;

grant execute on function public.create_child_business(text,text,text,numeric) to anon, authenticated, service_role;
grant execute on function public.my_businesses() to anon, authenticated, service_role;
grant execute on function public.tenant_identities_for_email(text) to anon, authenticated, service_role;
grant execute on function public.tenant_login_auto(text,text) to anon, authenticated, service_role;
