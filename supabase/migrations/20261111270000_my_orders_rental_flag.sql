-- Surface whether an order is a rental so the buy page can split
-- "Temp orders" from "Rent orders" without a second round-trip.
create or replace function public.my_orders(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(x) from (
    select o.id, c.name as country, c.flag, s.name as service, s.icon as service_icon,
           o.phone_number, o.price, o.status, o.created_at, o.expires_at,
           o.upstream_status,
           (o.upstream_status = 'rental') as is_rental,
           (select count(*) from sms_messages m where m.order_id=o.id) as sms_count
    from orders o
    left join countries c on c.code=o.country_code
    left join services s on s.code=o.service_code
    where o.user_id=uid order by o.created_at desc limit p_limit
  ) x),'[]'::jsonb);
end $$;
