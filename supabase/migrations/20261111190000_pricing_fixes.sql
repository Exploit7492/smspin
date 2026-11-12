-- Pricing corrections.
--
-- 1. Platform markup is a straight 2x: a pair the provider sells at $1 is
--    displayed at $2. The previous 200% markup tripled it.
-- 2. Funding fee is a flat 2.5% on every rail, every currency, every country
--    (the PPP tiering is gone; see backend/pricing.py).
-- 3. Existing catalog prices are recomputed from their stored cost so the
--    markup change takes effect immediately (no wait for the next sync).

update settings set value = to_jsonb(100) where key = 'markup_percent';

-- Recompute every sell price from the stored provider cost at the new markup.
update number_catalog n
   set price = round(n.cost_usd * (1 + 100 / 100.0)
                     * coalesce((select rate from fx_rates where code = 'NGN'), 1), 2),
       updated_at = now()
 where n.cost_usd is not null and n.cost_usd > 0;

-- The default markup baked into catalog_upsert must match the setting.
create or replace function public.catalog_upsert(p_items jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_n int := 0; it jsonb; v_rate numeric;
begin
  select coalesce(rate,1) into v_rate from fx_rates where code='NGN';
  for it in select * from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    insert into number_catalog(country_code, service_code, price, cost_usd, stock, active, updated_at)
    values (
      lower(it->>'country'), it->>'service',
      coalesce((it->>'price_ngn')::numeric, round((it->>'cost_usd')::numeric * (1 + coalesce((select value::text::numeric from settings where key='markup_percent'),100)/100.0) * v_rate, 2)),
      (it->>'cost_usd')::numeric,
      coalesce((it->>'stock')::int, 0), coalesce((it->>'stock')::int,0) > 0, now())
    on conflict (country_code, service_code) do update
      set price = excluded.price, cost_usd = excluded.cost_usd,
          stock = excluded.stock, active = excluded.active, updated_at = now();
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('upserted', v_n);
end $$;

-- Flat 2.5% on every payment rail.
create or replace function public.payment_rails()
returns jsonb language sql stable as $$
  select jsonb_build_array(
    jsonb_build_object('id','korapay','name','KoraPay','kinds',jsonb_build_array('card','bank_transfer','ussd'),
      'currencies',jsonb_build_array('NGN'),'fee_pct',2.5,'enabled',true),
    jsonb_build_object('id','paystack','name','Paystack','kinds',jsonb_build_array('card','bank_transfer'),
      'currencies',jsonb_build_array('NGN','GHS','ZAR','KES'),'fee_pct',2.5,'enabled',false),
    jsonb_build_object('id','flutterwave','name','Flutterwave','kinds',jsonb_build_array('card','bank_transfer','mobile_money'),
      'currencies',jsonb_build_array('NGN','GHS','KES','ZAR','USD'),'fee_pct',2.5,'enabled',false),
    jsonb_build_object('id','monnify','name','Monnify','kinds',jsonb_build_array('card','bank_transfer','ussd'),
      'currencies',jsonb_build_array('NGN'),'fee_pct',2.5,'enabled',false),
    jsonb_build_object('id','stripe','name','Stripe','kinds',jsonb_build_array('card','apple_pay','google_pay'),
      'currencies',jsonb_build_array('USD','GBP','EUR'),'fee_pct',2.5,'enabled',false),
    jsonb_build_object('id','paypal','name','PayPal','kinds',jsonb_build_array('paypal'),
      'currencies',jsonb_build_array('USD','GBP','EUR'),'fee_pct',2.5,'enabled',false),
    jsonb_build_object('id','usdt','name','USDT (crypto)','kinds',jsonb_build_array('crypto'),
      'currencies',jsonb_build_array('USDT'),'fee_pct',2.5,'enabled',false)
  );
$$;
