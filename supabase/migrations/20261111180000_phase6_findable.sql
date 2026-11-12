-- Phase 6 (G6 + G3): trust surfaces.
--   reviews            — moderated customer reviews that feed Review/AggregateRating JSON-LD
--   consent_log        — server-side record of cookie/consent choices (audit + proof of consent)
--   service_checks     — keep as-is (synthetic checks); add helpers for the uptime page

-- ---------------------------------------------------------------- reviews
create table if not exists reviews (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete set null,
  author      text not null,
  rating      int  not null check (rating between 1 and 5),
  title       text,
  body        text not null,
  service     text,
  country     text,
  status      text not null default 'pending' check (status in ('pending','published','rejected')),
  featured    boolean not null default false,
  created_at  timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists reviews_status_idx on reviews(status, created_at desc);
create index if not exists reviews_featured_idx on reviews(featured, published_at desc);

-- ---------------------------------------------------------------- consent log
create table if not exists consent_log (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete set null,
  anon_id     text,
  analytics   boolean not null default false,
  ads         boolean not null default false,
  functional  boolean not null default true,
  policy_ver  text,
  user_agent  text,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists consent_log_created_idx on consent_log(created_at desc);
create index if not exists consent_log_user_idx on consent_log(user_id, created_at desc);

-- ---------------------------------------------------------------- public reads
-- Published reviews for the marketing site, plus the aggregate rating.
create or replace function review_aggregate()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when count(*) = 0 then null else jsonb_build_object(
    'ratingValue', round(avg(rating)::numeric, 2),
    'reviewCount', count(*),
    'bestRating', 5, 'worstRating', 1
  ) end
  from reviews where status = 'published';
$$;

create or replace function public_reviews(p_limit int default 20)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'author', r.author, 'rating', r.rating, 'title', r.title,
        'body', r.body, 'service', r.service, 'country', r.country,
        'created_at', coalesce(r.published_at, r.created_at)
      ) order by r.featured desc, coalesce(r.published_at, r.created_at) desc)
      from (select * from reviews where status='published'
             order by featured desc, coalesce(published_at, created_at) desc
             limit greatest(1, least(p_limit, 100))) r), '[]'::jsonb),
    'rating', review_aggregate()
  );
$$;

-- ---------------------------------------------------------------- review submit
-- Any signed-in user may submit; rows land as 'pending' for moderation.
-- p_user is the resolved dashboard user id (the backend authenticates the
-- caller; auth.uid() is not available on the service-role connection).
drop function if exists submit_review(integer, text, text, text, text);
create or replace function submit_review(
  p_user uuid, p_rating int, p_title text, p_body text,
  p_service text default null, p_country text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author text;
  v_id bigint;
begin
  if p_user is null then raise exception 'not authenticated' using errcode='28000'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'rating must be 1..5' using errcode='22023';
  end if;
  if length(coalesce(trim(p_body), '')) < 10 then
    raise exception 'review body too short' using errcode='22023';
  end if;

  select coalesce(nullif(full_name,''), split_part(email,'@',1)) into v_author
    from profiles where id = p_user;

  insert into reviews(user_id, author, rating, title, body, service, country, status)
    values (p_user, coalesce(v_author,'Customer'), p_rating, nullif(trim(p_title),''),
            trim(p_body), nullif(trim(p_service),''), nullif(trim(p_country),''), 'pending')
    returning id into v_id;

  return jsonb_build_object('id', v_id, 'status', 'pending');
end $$;

-- ---------------------------------------------------------------- status uptime
-- Hourly rollup of the synthetic checks so the status page can show history.
create or replace function status_uptime(p_hours int default 72)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select now() - make_interval(hours => greatest(1, least(p_hours, 720))) as since
  ),
  buckets as (
    select date_trunc('hour', checked_at) as bucket,
           count(*) as total,
           count(*) filter (where status = 'ok') as ok
      from service_checks, cfg
     where checked_at >= cfg.since
     group by 1
  )
  select jsonb_build_object(
    'hours', coalesce((select jsonb_agg(jsonb_build_object(
        't', b.bucket,
        'uptime', case when b.total = 0 then 100
                       else round((b.ok::numeric / b.total) * 100, 2) end
      ) order by b.bucket) from buckets b), '[]'::jsonb),
    'overall_uptime', coalesce((
        select round((count(*) filter (where status='ok')::numeric
                      / greatest(count(*),1)) * 100, 3)
          from service_checks, cfg
         where checked_at >= cfg.since), 100)
  );
$$;

-- ---------------------------------------------------------------- status subscribe
create or replace function status_subscribe(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_email text := lower(trim(p_email));
begin
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email' using errcode='22023';
  end if;
  insert into status_subscribers(email, confirmed) values (v_email, false)
    on conflict (email) do nothing;
  return jsonb_build_object('ok', true, 'email', v_email);
end $$;

grant execute on function public_reviews(int)      to anon, authenticated;
grant execute on function review_aggregate()       to anon, authenticated;
grant execute on function status_uptime(int)       to anon, authenticated;
grant execute on function status_subscribe(text)   to anon, authenticated;
grant execute on function submit_review(int,text,text,text,text) to authenticated;
