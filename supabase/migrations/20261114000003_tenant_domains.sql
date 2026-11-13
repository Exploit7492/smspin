-- Public: map of active custom domains to their store slug. The static-host
-- build embeds this so a white-label domain can be resolved in the browser
-- without a server round-trip on every request.
create or replace function public.tenant_domains()
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_object_agg(lower(btrim(b.domain)), b.slug), '{}'::jsonb)
    from businesses b
   where b.domain is not null and btrim(b.domain) <> '' and b.status = 'active';
$$;

grant execute on function public.tenant_domains() to anon, authenticated, service_role;
