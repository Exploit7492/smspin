-- Per-tenant white-label custom domains: lifecycle state.
--
-- `businesses.domain` holds the host an owner wants to serve their storefront
-- from. These columns track whether that host is actually live on the product
-- host and, while it is not, the DNS record the owner must publish.
--
-- Provisioning is done by the `api` Edge Function (route POST /api/business/domain),
-- which holds the Vercel token in its environment — the database never does.
-- This migration only records the state the owner and the build read.

alter table businesses add column if not exists domain_status text default 'none';
alter table businesses add column if not exists domain_verification jsonb;
alter table businesses add column if not exists domain_error text;
alter table businesses add column if not exists domain_checked_at timestamptz;

-- Only one live/pending host per store; the resolver already keys on domain.
create index if not exists businesses_domain_idx on businesses (lower(domain))
  where domain is not null;

-- The owner's branding save is the source of truth for the requested host. When
-- the host changes, the previous verification is invalid, so reset the lifecycle
-- to 'pending' and let the edge route provision it on the product host.
create or replace function public.business_set_branding(
  p_logo_url text default null, p_tagline text default null,
  p_support_email text default null, p_primary text default null,
  p_secondary text default null, p_domain text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare uid uuid := auth.uid(); v_biz businesses%rowtype; v_domain text; v_changed boolean;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid and parent_id is null;
  if not found then raise exception 'create your store first' using errcode='P0002'; end if;

  v_domain := nullif(trim(lower(p_domain)), '');
  if v_domain is not null then
    if v_domain !~ '^([a-z0-9-]+\.)+[a-z]{2,}$' then
      raise exception 'invalid domain' using errcode='22023';
    end if;
    if exists (select 1 from businesses where lower(domain) = v_domain and id <> v_biz.id) then
      raise exception 'domain already in use' using errcode='23505';
    end if;
  end if;

  v_changed := p_domain is not null and coalesce(v_domain, '') <> coalesce(v_biz.domain, '');

  update businesses set
    logo_url        = coalesce(nullif(trim(p_logo_url), ''), logo_url),
    tagline         = coalesce(nullif(trim(p_tagline), ''), tagline),
    support_email   = coalesce(nullif(trim(p_support_email), ''), support_email),
    primary_color   = coalesce(nullif(trim(p_primary), ''), primary_color),
    secondary_color = coalesce(nullif(trim(p_secondary), ''), secondary_color),
    domain          = case when p_domain is null then domain else v_domain end,
    domain_status   = case
                        when p_domain is null then domain_status
                        when v_domain is null then 'none'
                        when v_changed then 'pending'
                        else domain_status end,
    domain_verification = case when v_changed then null else domain_verification end,
    domain_error    = case when v_changed then null else domain_error end,
    updated_at      = now()
   where id = v_biz.id
  returning * into v_biz;

  return jsonb_build_object('id', v_biz.id, 'slug', v_biz.slug, 'domain', v_biz.domain,
    'domain_status', v_biz.domain_status, 'domain_verification', v_biz.domain_verification,
    'logo_url', v_biz.logo_url, 'tagline', v_biz.tagline, 'support_email', v_biz.support_email,
    'primary_color', v_biz.primary_color, 'secondary_color', v_biz.secondary_color);
end $function$;

-- Owner-readable domain state, used by the dashboard to render DNS instructions.
create or replace function public.my_domain_state()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare uid uuid := auth.uid(); v_biz businesses%rowtype;
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  select * into v_biz from businesses where user_id = uid and parent_id is null;
  if not found then return null; end if;
  return jsonb_build_object(
    'slug', v_biz.slug, 'domain', v_biz.domain,
    'status', coalesce(v_biz.domain_status, 'none'),
    'verification', v_biz.domain_verification,
    'error', v_biz.domain_error,
    'checked_at', v_biz.domain_checked_at);
end $function$;

grant execute on function public.my_domain_state() to authenticated;

-- Called by the `api` Edge Function after it has provisioned (or re-checked) the
-- host on the product host. Service-role only: the owner cannot set their own
-- domain live, and the browser never talks to this.
create or replace function public.business_set_domain_state(
  p_slug text, p_status text, p_verification jsonb default null, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_biz businesses%rowtype;
begin
  update businesses set
    domain_status = p_status,
    domain_verification = p_verification,
    domain_error = p_error,
    domain_checked_at = now(),
    updated_at = now()
   where slug = p_slug
  returning * into v_biz;
  if not found then return null; end if;
  return jsonb_build_object('slug', v_biz.slug, 'domain', v_biz.domain,
    'status', v_biz.domain_status, 'verification', v_biz.domain_verification,
    'error', v_biz.domain_error);
end $function$;

revoke all on function public.business_set_domain_state(text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.business_set_domain_state(text, text, jsonb, text) to service_role;
