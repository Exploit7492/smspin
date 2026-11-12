-- Rentals: long-lived numbers (24h/72h/168h) bought the same way as one-shot
-- OTP numbers. The provider returns the price; the server passes it in, and
-- this function debits the wallet + records the order + the ledger entry in one
-- atomic step. Mirrors reserve_number's tenant/user handling.
create or replace function public.reserve_rental(
  p_user uuid, p_country text, p_service text, p_duration integer,
  p_price_ngn numeric, p_tenant_account uuid DEFAULT NULL::uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_bal numeric(14,2); v_order bigint; v_biz businesses%rowtype;
  v_price numeric(12,2) := round(coalesce(p_price_ngn, 0));
begin
  if p_user is null and p_tenant_account is null then
    raise exception 'no buyer' using errcode='28000';
  end if;
  if v_price <= 0 then
    raise exception 'invalid rental price' using errcode='P0001';
  end if;

  if p_tenant_account is not null then
    select b.* into v_biz from tenant_accounts a join businesses b on b.id = a.business_id
     where a.id = p_tenant_account;
  elsif p_user is not null then
    select * into v_biz from businesses where user_id = p_user and status = 'active' limit 1;
  end if;

  if p_tenant_account is not null then
    select balance into v_bal from tenant_wallets where account_id = p_tenant_account for update;
    if v_bal is null or v_bal < v_price then raise exception 'insufficient balance' using errcode='P0001'; end if;
    update tenant_wallets set balance = balance - v_price, updated_at = now() where account_id = p_tenant_account;
  else
    select balance into v_bal from wallets where user_id = p_user for update;
    if v_bal is null or v_bal < v_price then raise exception 'insufficient balance' using errcode='P0001'; end if;
    update wallets set balance = balance - v_price, updated_at = now() where user_id = p_user;
  end if;

  insert into orders(user_id, country_code, service_code, phone_number, price, status,
                     expires_at, business_id, tenant_account_id, upstream_status)
    values (p_user, lower(p_country), p_service, '', v_price, 'waiting',
            now() + make_interval(hours => greatest(1, coalesce(p_duration, 24))),
            v_biz.id, p_tenant_account, 'rental')
    returning id into v_order;

  insert into transactions(user_id, type, amount, method, ref, tenant_account_id)
    values (p_user, 'purchase', -v_price, 'rental:' || p_service, 'order:' || v_order, p_tenant_account);

  return jsonb_build_object('order_id', v_order, 'price_ngn', v_price,
    'business_id', v_biz.id, 'tenant_account_id', p_tenant_account,
    'duration', greatest(1, coalesce(p_duration, 24)), 'status', 'reserved');
end $$;

grant execute on function public.reserve_rental(uuid,text,text,integer,numeric,uuid) to authenticated;
