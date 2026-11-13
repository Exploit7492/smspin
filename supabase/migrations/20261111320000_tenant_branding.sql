-- Tenant dashboard branding: the store dashboard reuses the platform HTML, so
-- it needs the tenant's own colours and logo alongside the name. Extend
-- tenant_site_config (read by dashboard/dash.js loadSite -> applyBrand) with the
-- branding fields, defaulting to the platform palette when unset.
create or replace function public.tenant_site_config(p_slug text)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'brand_name', coalesce((select name from businesses where slug=p_slug), 'SMSPin'),
    'brand_short', coalesce((select name from businesses where slug=p_slug), 'SMSPin'),
    'support_email', coalesce((select support_email from businesses where slug=p_slug), ''),
    'currency', 'NGN',
    'commission', coalesce((select markup_percent from businesses where slug=p_slug), 0),
    'store_markup_percent', coalesce((select markup_percent from businesses where slug=p_slug), 0),
    'theme', coalesce((select theme from businesses where slug=p_slug), 'crimson'),
    'primary_color', (select primary_color from businesses where slug=p_slug),
    'secondary_color', (select secondary_color from businesses where slug=p_slug),
    'logo_url', (select logo_url from businesses where slug=p_slug)
  );
$function$;
