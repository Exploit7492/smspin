-- Raise the site-wide minimum sell price from $1 to $2.
--
-- Every buyer-facing price is a whole number of US dollars rounded to the
-- nearest dollar; the floor previously sat at $1, so the cheapest pairs (raw
-- provider cost ~$0.01) sold for $1. This migration raises the floor to $2 so
-- nothing on the site is ever cheaper than $2. number_catalog.price stays the
-- raw platform price; the floor is applied to the final buyer price here, so
-- every reader of sell_price_ngn / sell_price_usd (browse_catalog,
-- business_public, reserve_number, buy_number_store) picks it up at once.
create or replace function public.sell_price_ngn(p_amount_ngn numeric, p_markup_pct numeric default 0)
returns numeric language sql stable set search_path to 'public' as $$
  with r as (select coalesce((select rate from fx_rates where code='NGN'), 1600) as rate)
  select round(
           greatest(2, round(p_amount_ngn * (1 + coalesce(p_markup_pct, 0) / 100.0) / r.rate))
           * r.rate)
  from r
$$;

create or replace function public.sell_price_usd(p_amount_ngn numeric, p_markup_pct numeric default 0)
returns int language sql stable set search_path to 'public' as $$
  with r as (select coalesce((select rate from fx_rates where code='NGN'), 1600) as rate)
  select greatest(2, round(p_amount_ngn * (1 + coalesce(p_markup_pct, 0) / 100.0) / r.rate))::int
  from r
$$;
