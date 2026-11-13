-- Public: every active store's brand, keyed by slug. The static-host build bakes
-- this so a tenant page can re-skin itself in the browser before first paint,
-- with no server and no RPC round-trip (an RPC would flash the platform brand
-- before the tenant's own name and colours replace it).
create or replace function public.tenant_brands()
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_object_agg(b.slug, jsonb_strip_nulls(jsonb_build_object(
    'name', b.name,
    'theme', b.theme,
    'primary', b.primary_color,
    'secondary', b.secondary_color,
    'logo', b.logo_url,
    'tagline', b.tagline,
    'support_email', b.support_email,
    'domain', b.domain
  ))), '{}'::jsonb)
    from businesses b
   where b.status = 'active';
$$;

grant execute on function public.tenant_brands() to anon, authenticated, service_role;
