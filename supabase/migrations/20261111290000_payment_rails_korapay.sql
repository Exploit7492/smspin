-- Align the advertised KoraPay rail with the channels the merchant account
-- actually has enabled for NGN. Probed against the live test key: only "card"
-- and "bank_transfer" are accepted; "ussd"/"mobile_money" are rejected for NGN.
-- The backend enforces the same allowlist (backend/server.py: KORA_CHANNELS).
create or replace function public.payment_rails()
returns jsonb language sql stable as $$
  select jsonb_build_array(
    jsonb_build_object('id','korapay','name','KoraPay','kinds',jsonb_build_array('card','bank_transfer'),
      'currencies',jsonb_build_array('NGN'),'fee_pct',2.5,'enabled',true),
    jsonb_build_object('id','paystack','name','Paystack','kinds',jsonb_build_array('card','bank_transfer'),
      'currencies',jsonb_build_array('NGN','GHS','ZAR','KES'),'fee_pct',2.5,'enabled',false),
    jsonb_build_object('id','flutterwave','name','Flutterwave','kinds',jsonb_build_array('card','bank_transfer','mobile_money'),
      'currencies',jsonb_build_array('NGN','GHS','KES','ZAR','USD'),'fee_pct',2.5,'enabled',false),
    jsonb_build_object('id','monnify','name','Monnify','kinds',jsonb_build_array('card','bank_transfer'),
      'currencies',jsonb_build_array('NGN'),'fee_pct',2.5,'enabled',false),
    jsonb_build_object('id','stripe','name','Stripe','kinds',jsonb_build_array('card','apple_pay','google_pay'),
      'currencies',jsonb_build_array('USD','GBP','EUR'),'fee_pct',2.5,'enabled',false),
    jsonb_build_object('id','paypal','name','PayPal','kinds',jsonb_build_array('paypal'),
      'currencies',jsonb_build_array('USD','GBP','EUR'),'fee_pct',2.5,'enabled',false),
    jsonb_build_object('id','usdt','name','USDT (crypto)','kinds',jsonb_build_array('crypto'),
      'currencies',jsonb_build_array('USDT'),'fee_pct',2.5,'enabled',false)
  );
$$;
