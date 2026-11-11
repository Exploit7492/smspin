-- PPP-tiered funding fees.
-- The fee is computed in real time by the backend (backend/pricing.py: live FX +
-- World Bank PPP) and stamped onto the payment before checkout. Crediting then
-- nets the fee so the wallet only receives the real value of the top-up.

alter table payments add column if not exists fee_ngn numeric not null default 0;

-- Stamp the funding fee (and FX/PPP context) onto a pending payment.
create or replace function public.set_payment_fee(
  p_reference text, p_fee_ngn numeric, p_meta jsonb default null
) returns void language sql security definer set search_path to 'public' as $$
  update payments
     set fee_ngn = greatest(coalesce(p_fee_ngn, 0), 0),
         meta = case when p_meta is null then meta else coalesce(meta, '{}'::jsonb) || p_meta end,
         updated_at = now()
   where reference = p_reference;
$$;

-- User wallets: credit (gross - fee), log the fee as its own transaction.
create or replace function public.credit_wallet_from_payment(
  p_reference text, p_amount numeric, p_channel text default null, p_provider_ref text default null
) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_pay payments%rowtype; v_new numeric; v_fee numeric; v_net numeric;
begin
  select * into v_pay from payments where reference = p_reference for update;
  if not found then raise exception 'payment not found: %', p_reference using errcode='P0002'; end if;
  if v_pay.status = 'success' then
    return jsonb_build_object('already_credited', true, 'status','success');
  end if;

  v_fee := least(coalesce(v_pay.fee_ngn, 0), p_amount);
  v_net := greatest(p_amount - v_fee, 0);

  update wallets set balance = balance + v_net, updated_at = now()
    where user_id = v_pay.user_id returning balance into v_new;
  if not found then
    insert into wallets(user_id, balance, currency) values (v_pay.user_id, v_net, v_pay.currency)
      returning balance into v_new;
  end if;

  insert into transactions(user_id, type, amount, method, ref)
    values (v_pay.user_id, 'topup', v_net, coalesce(p_channel,'card'), p_reference);
  if v_fee > 0 then
    insert into transactions(user_id, type, amount, method, ref)
      values (v_pay.user_id, 'fee', -v_fee, coalesce(p_channel,'card'), p_reference || ':fee');
  end if;

  update payments set status='success', channel=coalesce(p_channel, channel),
         provider_ref=coalesce(p_provider_ref, provider_ref), updated_at=now()
    where id = v_pay.id;

  return jsonb_build_object('credited', true, 'balance', v_new, 'amount', v_net, 'fee', v_fee);
end $$;

-- Tenant wallets: same netting, tenant-account ledger.
create or replace function public.tenant_credit_wallet_from_payment(
  p_reference text, p_amount numeric, p_channel text default null, p_provider_ref text default null
) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_pay payments%rowtype; v_new numeric; v_fee numeric; v_net numeric;
begin
  select * into v_pay from payments where reference = p_reference for update;
  if not found then raise exception 'payment not found: %', p_reference using errcode='P0002'; end if;
  if v_pay.status = 'success' then return jsonb_build_object('already_credited', true); end if;
  if v_pay.tenant_account_id is null then raise exception 'not a tenant payment' using errcode='22023'; end if;

  v_fee := least(coalesce(v_pay.fee_ngn, 0), p_amount);
  v_net := greatest(p_amount - v_fee, 0);

  update tenant_wallets set balance = balance + v_net, updated_at=now()
    where account_id = v_pay.tenant_account_id returning balance into v_new;
  if not found then
    insert into tenant_wallets(account_id, balance) values (v_pay.tenant_account_id, v_net)
      returning balance into v_new;
  end if;

  insert into transactions(user_id,type,amount,method,ref,tenant_account_id)
    values (null,'topup',v_net,coalesce(p_channel,'card'),p_reference,v_pay.tenant_account_id);
  if v_fee > 0 then
    insert into transactions(user_id,type,amount,method,ref,tenant_account_id)
      values (null,'fee',-v_fee,coalesce(p_channel,'card'),p_reference||':fee',v_pay.tenant_account_id);
  end if;

  update payments set status='success', channel=coalesce(p_channel,channel),
         provider_ref=coalesce(p_provider_ref,provider_ref), updated_at=now() where id=v_pay.id;
  return jsonb_build_object('credited', true, 'balance', v_new, 'amount', v_net, 'fee', v_fee);
end $$;
