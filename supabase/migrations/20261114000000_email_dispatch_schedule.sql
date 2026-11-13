-- Schedule the serverless transactional-email dispatcher.
--
-- All transactional mail goes through ONE infrastructure: the Supabase Edge
-- Function `email` (supabase/functions/email), which fans out to Novu with the
-- branding of the store each message belongs to. pg_cron drives it once a
-- minute; pg_net makes the outbound HTTP call. The worker URL + key live in
-- Vault (never in this repo), so no credential is committed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Fire the dispatcher once. Runs as the database superuser, reads its endpoint
-- and key from Vault, and returns the pg_net request id (or NULL if unset).
create or replace function public.smspin_dispatch_emails()
returns bigint
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets
   where name = 'smspin_email_worker_url';
  select decrypted_secret into v_key from vault.decrypted_secrets
   where name = 'smspin_email_worker_key';
  if v_url is null or v_key is null then
    return null;  -- not provisioned yet; nothing to do
  end if;
  return net.http_post(
    url := v_url,
    body := '{"limit": 50}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    timeout_milliseconds := 20000
  );
end;
$$;

-- Only the scheduler (superuser) needs this; keep it off the public API surface.
revoke all on function public.smspin_dispatch_emails() from public, anon, authenticated;

-- Re-create the schedule idempotently.
do $$
begin
  perform cron.unschedule('smspin-email-dispatch');
exception when others then
  null;  -- not scheduled yet
end;
$$;

select cron.schedule(
  'smspin-email-dispatch',
  '* * * * *',
  $$select public.smspin_dispatch_emails();$$
);
