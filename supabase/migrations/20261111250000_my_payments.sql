-- Top-up history: the caller's own payment attempts (KoraPay checkouts and
-- their outcomes), newest first. Powers the Top Up page's "Payment history"
-- panel and the CSV export on History. Mirrors the my_* family's auth model:
-- SECURITY DEFINER, filtered by auth.uid(), never exposing other users' rows.
create or replace function public.my_payments(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(x) from (
    select p.id, p.reference, p.provider, p.amount, p.currency, p.status,
           p.channel, p.fee_ngn, p.created_at, p.updated_at
      from payments p
     where p.user_id = uid
     order by p.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 500))
  ) x), '[]'::jsonb);
end $$;

grant execute on function public.my_payments(integer) to authenticated;
