-- Fix FK violations coming from the sync frontier.
--
-- sync_seed() seeded a cursor row for service code 'ap', which is not a real
-- service (Apple is 'wx'). The crawler then walked those 225 (country,'ap')
-- pairs and every catalog write failed with
--   number_catalog_service_code_fkey
-- because number_catalog.service_code references services(code).
--
-- Fixes:
--   1. Repoint the bogus 'ap' cursor rows at the real Apple code 'wx'.
--   2. sync_seed() only seeds pairs that actually exist in countries/services.
--   3. sync_mark() refuses to record unknown pairs, so the frontier can never
--      be poisoned with an FK-breaking code again.

-- 1. Repair the poisoned frontier (Apple 'ap' -> 'wx').
delete from sync_cursor where service_code = 'ap'
  and exists (select 1 from services where code = 'wx');
insert into sync_cursor (country_code, service_code)
  select c.code, 'wx' from countries c
  where exists (select 1 from services where code = 'wx')
  on conflict do nothing;
delete from sync_cursor where service_code = 'ap';  -- in case 'wx' was absent

-- 2. Seed only real service codes for real countries.
create or replace function public.sync_seed()
returns integer language sql security definer set search_path to 'public' as $$
  with mainsvc as (
    select unnest(array['wa','tg','ig','go','fb','tw','gb','ds','wx','nf','oi','ss','ub']) as s
  )
  insert into sync_cursor (country_code, service_code)
  select c.code, m.s
    from countries c
    cross join mainsvc m
    join services v on v.code = m.s
  on conflict do nothing;
  select count(*) from sync_cursor;
$$;

-- 3. Never record a pair whose country or service does not exist.
create or replace function public.sync_mark(p_country text, p_service text, p_done boolean DEFAULT true)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not exists (select 1 from countries where code = lower(p_country))
     or not exists (select 1 from services where code = p_service) then
    return;
  end if;
  insert into sync_cursor (country_code, service_code, done, synced_at)
  values (lower(p_country), p_service, coalesce(p_done, true), now())
  on conflict (country_code, service_code)
    do update set done = coalesce(p_done, true), synced_at = now();
end $$;
