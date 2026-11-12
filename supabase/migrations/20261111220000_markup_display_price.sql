-- Display prices must equal the amount reserve_number actually debits.
--
-- The catalog stores the platform base price; each business adds its own
-- markup_percent at purchase time (reserve_number: ceil(base * (1 + pct/100))).
-- browse_catalog fed the base price straight to the dashboard, so the Buy
-- button showed one figure and the wallet was charged a higher one. Apply the
-- signed-in buyer's business markup here, matching reserve_number exactly.

create or replace function public.browse_catalog(
  p_country text default null,
  p_service text default null
)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  with buyer as (
    select coalesce(b.markup_percent, 0) as pct
    from businesses b
    where b.status = 'active' and b.user_id = auth.uid()
    limit 1
  )
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select n.id, c.code as country, c.name as country_name, c.flag,
           s.code as service, s.name as service_name, s.icon as service_icon,
           ceil(n.price + round(n.price * coalesce((select pct from buyer), 0) / 100.0, 2)) as price,
           n.stock
    from number_catalog n
    join countries c on c.code = n.country_code
    join services  s on s.code = n.service_code
    where n.active
      and (p_country is null or n.country_code = p_country)
      and (p_service is null or n.service_code = p_service)
    order by n.price asc
  ) x;
$$;

-- The white-label storefront advertised round(...) while reserve_number debits
-- ceil(...), so a tenant store could show ₦2,107 and charge ₦2,108. Use the
-- same ceiling so the storefront price equals the charge.
create or replace function public.business_public(p_slug text)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $$
  select coalesce((
    select jsonb_build_object(
      'name', b.name, 'slug', b.slug, 'theme', b.theme,
      'markup_percent', b.markup_percent, 'status', b.status,
      'catalog', (select coalesce(jsonb_agg(jsonb_build_object(
          'country', c.code, 'country_name', c.name, 'flag', c.flag,
          'service', s.code, 'service_name', s.name, 'icon', s.icon,
          'price_ngn', ceil(n.price + round(n.price * b.markup_percent/100.0, 2)),
          'stock', n.stock)), '[]'::jsonb)
        from number_catalog n
        join countries c on c.code = n.country_code
        join services  s on s.code = n.service_code
        where n.active and n.stock > 0))
    from businesses b where b.slug = p_slug and b.status = 'active'
  ), 'null'::jsonb);
$$;
