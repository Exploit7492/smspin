-- Per-customer API keys for white-label stores.
--
-- A store's customers sign in with the store session token, not a Supabase JWT,
-- so the shared dashboard's auth.uid()-based create/regenerate/revoke RPCs raise
-- "not authenticated" on a tenant dashboard and the "Generate key" button never
-- worked there. These token-based twins mint keys scoped to the calling account.
--
-- This also closes a leak: tenant_my_api_keys returned the store OWNER's
-- business keys to any customer of the store.

alter table tenant_api_keys
  add column if not exists account_id uuid references tenant_accounts(id) on delete cascade;
create index if not exists tenant_api_keys_account_idx on tenant_api_keys(account_id);

-- Mint a key for the signed-in store account. The secret is returned once.
create or replace function public.tenant_key_create(
  p_token text, p_name text default 'default',
  p_scopes text[] default array['read'], p_webhook_url text default null)
returns jsonb language plpgsql security definer set search_path to 'public','extensions' as $$
declare
  v_acc uuid := tenant_resolve(p_token);
  v_biz bigint; v_secret text; v_prefix text; v_id bigint;
begin
  if v_acc is null then raise exception 'invalid session' using errcode='28000'; end if;
  select business_id into v_biz from tenant_accounts where id = v_acc;
  v_secret := 'tk_live_' || encode(extensions.gen_random_bytes(24),'hex');
  v_prefix := left(v_secret,14) || '...' || right(v_secret,4);
  insert into tenant_api_keys(account_id, business_id, name, key_prefix, key_hash, scopes, webhook_url, webhook_secret)
    values (v_acc, v_biz, coalesce(nullif(trim(p_name),''),'default'), v_prefix,
            encode(extensions.digest(v_secret,'sha256'),'hex'),
            coalesce(p_scopes, array['read']),
            nullif(trim(p_webhook_url),''),
            case when nullif(trim(p_webhook_url),'') is not null
                 then encode(extensions.gen_random_bytes(24),'hex') else null end)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'key', v_secret, 'secret', v_secret,
    'prefix', v_prefix, 'scopes', coalesce(p_scopes, array['read']));
end $$;

-- Revoke the account's active keys and mint a fresh one, atomically.
create or replace function public.tenant_key_regenerate(p_token text, p_name text default 'default')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_acc uuid := tenant_resolve(p_token);
begin
  if v_acc is null then raise exception 'invalid session' using errcode='28000'; end if;
  update tenant_api_keys set revoked = true where account_id = v_acc and not revoked;
  return public.tenant_key_create(p_token, p_name);
end $$;

create or replace function public.tenant_key_revoke(p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_acc uuid := tenant_resolve(p_token); n int;
begin
  if v_acc is null then raise exception 'invalid session' using errcode='28000'; end if;
  update tenant_api_keys set revoked = true where id = p_id and account_id = v_acc;
  get diagnostics n = row_count;
  return jsonb_build_object('id', p_id, 'revoked', n > 0);
end $$;

-- List only the calling account's keys (never the store owner's).
create or replace function public.tenant_my_api_keys(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_acc uuid := tenant_resolve(p_token);
begin
  if v_acc is null then raise exception 'invalid session' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(x) from (
    select k.id, k.name, k.key_prefix, k.last_used_at, k.revoked, k.created_at
    from tenant_api_keys k where k.account_id = v_acc order by k.created_at desc) x),'[]'::jsonb);
end $$;

-- Carry the owning account through resolution so the gateway can scope the read
-- surface to a single customer instead of the whole store.
create or replace function public.tenant_resolve_api_key(p_hash text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('business_id', k.business_id, 'account_id', k.account_id,
                            'scopes', k.scopes, 'webhook_url', k.webhook_url, 'key_id', k.id)
    from tenant_api_keys k
   where k.key_hash = p_hash and not k.revoked
   limit 1;
$$;

grant execute on function public.tenant_key_create(text,text,text[],text) to anon, authenticated;
grant execute on function public.tenant_key_regenerate(text,text) to anon, authenticated;
grant execute on function public.tenant_key_revoke(text,bigint) to anon, authenticated;
grant execute on function public.tenant_my_api_keys(text) to anon, authenticated;
