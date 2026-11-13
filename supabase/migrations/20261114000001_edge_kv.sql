-- Edge runtime support tables for the serverless API.
--
-- The old Python backend kept rate-limit counters and idempotency keys in
-- process memory, which does not survive across stateless edge invocations.
-- These tables give the edge functions the same primitives, shared across all
-- instances: a sliding-window rate limiter and a generic key/value store.

create table if not exists public.edge_kv (
  k          text primary key,
  v          jsonb not null default '{}'::jsonb,
  expires_at timestamptz
);
create index if not exists edge_kv_expires_idx on public.edge_kv (expires_at);

-- Atomic sliding-window rate limit. Returns true when the caller is under the
-- limit, and prunes expired buckets opportunistically.
create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket text := p_key || ':' || floor(extract(epoch from now()) / greatest(p_window, 1))::text;
  v_count integer;
begin
  delete from edge_kv where k like 'rl:%' and expires_at < now();
  insert into edge_kv(k, v, expires_at)
    values ('rl:' || v_bucket, '{"n":1}'::jsonb, now() + make_interval(secs => p_window * 2))
    on conflict (k) do update
      set v = jsonb_set(edge_kv.v, '{n}', to_jsonb(coalesce((edge_kv.v->>'n')::int, 0) + 1))
    returning (v->>'n')::int into v_count;
  return v_count <= p_limit;
end $$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;

-- Generic get/set with TTL, for OAuth state, short-lived codes, etc.
create or replace function public.edge_kv_get(p_key text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select v from edge_kv where k = p_key and (expires_at is null or expires_at > now());
$$;

create or replace function public.edge_kv_set(p_key text, p_value jsonb, p_ttl_seconds integer default 600)
returns void
language sql
security definer
set search_path = public
as $$
  insert into edge_kv(k, v, expires_at)
    values (p_key, coalesce(p_value, '{}'::jsonb),
            case when p_ttl_seconds is null then null
                 else now() + make_interval(secs => p_ttl_seconds) end)
  on conflict (k) do update set v = excluded.v, expires_at = excluded.expires_at;
$$;

create or replace function public.edge_kv_del(p_key text)
returns void language sql security definer set search_path = public
as $$ delete from edge_kv where k = p_key; $$;

revoke all on function public.edge_kv_get(text) from public, anon, authenticated;
revoke all on function public.edge_kv_set(text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.edge_kv_del(text) from public, anon, authenticated;
