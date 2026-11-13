-- Include the store tagline in the resolved email sender identity, so the
-- branded email header can show it next to the logo/wordmark. Purely additive:
-- the renderers already accept a tagline and fall back to an empty header cell.
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
    'tagline',       coalesce((select tagline from biz),
                              (select value #>> '{}' from settings where key='tagline'),
                              'Virtual numbers'),
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
