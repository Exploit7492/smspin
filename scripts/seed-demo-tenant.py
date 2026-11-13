"""Populate the demo tenant (business #2 "Zenith Verify") for cross-checking.

Sets a known store-login password, funds the tenant wallet, and seeds API keys,
payouts, webhook deliveries and a finished app build so every tenant surface
(the /store/<slug>/ dashboard, billing, payouts, developers) has real data.
"""
import hashlib
import os
import psycopg2

DSN = os.environ["Smspin_supabase_Postgresql"]
SLUG = "zenith-verify"
EMAIL = "demo@smspin.local"
PASSWORD = "SmspinDemo123!"
BIZ = 2

conn = psycopg2.connect(DSN, connect_timeout=15)
conn.autocommit = True
cur = conn.cursor()

cur.execute("select id from tenant_accounts where tenant_slug=%s and lower(email)=lower(%s)",
            (SLUG, EMAIL))
row = cur.fetchone()
if not row:
    raise SystemExit("demo tenant account not found")
acc = row[0]
print("tenant account:", acc, "slug:", SLUG)

# Known password (bcrypt, cost 6 to match the existing hashes).
cur.execute("update tenant_accounts set password_hash = extensions.crypt(%s, extensions.gen_salt('bf',6)), "
            "full_name = coalesce(full_name,'Demo Merchant') where id=%s", (PASSWORD, acc))
print("password set; rows:", cur.rowcount)

# Fund the tenant wallet.
cur.execute("insert into tenant_wallets(account_id, balance, currency) values (%s, 42000, 'NGN') "
            "on conflict (account_id) do update set balance=greatest(tenant_wallets.balance, 42000), "
            "updated_at=now()", (acc,))
print("wallet funded")

# Fill in the business profile so branding renders.
cur.execute("""update businesses set
                 tagline = coalesce(tagline, 'Verify anything, anywhere'),
                 support_email = coalesce(support_email, 'help@zenithverify.io'),
                 primary_color = coalesce(primary_color, '#7C3AED'),
                 secondary_color = coalesce(secondary_color, '#A78BFA'),
                 status = 'active', app_status = 'provisioned'
               where id = %s""", (BIZ,))
print("business profile updated")

# Tenant API keys (dev console).
cur.execute("select count(*) from tenant_api_keys where business_id=%s", (BIZ,))
if cur.fetchone()[0] == 0:
    for name, prefix, scopes in [
        ("Production", "tzk_live_zenit", ["orders:read", "orders:write", "sms:read"]),
        ("Sandbox", "tzk_test_zenit", ["orders:read", "orders:write"]),
    ]:
        h = hashlib.sha256((prefix + "demo").encode()).hexdigest()
        cur.execute("""insert into tenant_api_keys(business_id,name,key_prefix,key_hash,scopes,webhook_url)
                       values (%s,%s,%s,%s,%s,%s)""",
                    (BIZ, name, prefix, h, scopes, "https://zenithverify.io/hooks/smspin"))
    print("tenant api keys seeded")

# Payouts history.
cur.execute("select count(*) from tenant_payouts where business_id=%s", (BIZ,))
if cur.fetchone()[0] == 0:
    for amount, method, status, ref in [
        (15000, "bank", "paid", "PAY-2026-0041"),
        (8000, "usdt", "paid", "PAY-2026-0058"),
        (12000, "bank", "pending", "PAY-2026-0063"),
    ]:
        cur.execute("""insert into tenant_payouts(business_id,amount,method,status,reference)
                       values (%s,%s,%s,%s,%s)""", (BIZ, amount, method, status, ref))
    print("payouts seeded")

# Webhook deliveries.
cur.execute("select count(*) from tenant_webhook_events where business_id=%s", (BIZ,))
if cur.fetchone()[0] == 0:
    for ev, st, att in [("order.delivered", "delivered", 1),
                        ("order.created", "delivered", 1),
                        ("sms.received", "failed", 3)]:
        cur.execute("""insert into tenant_webhook_events(business_id,event,payload,status,attempts,delivered_at)
                       values (%s,%s,%s,%s,%s, case when %s='delivered' then now() else null end)""",
                    (BIZ, ev, '{"order_id": 17}', st, att, st))
    print("webhook events seeded")

# A finished Android build.
cur.execute("select count(*) from app_builds where business_id=%s", (BIZ,))
if cur.fetchone()[0] == 0:
    cur.execute("""insert into app_builds(business_id,version,status,artifact_url,download_token,size_bytes,built_at,expires_at)
                   values (%s,'1.0.0','ready','/api/app/download/zenith-verify','demo-token-zenith',18432000,now(),now()+interval '7 days')""",
                (BIZ,))
    print("app build seeded")

# Storefront order history so the store account page has data to show.
cur.execute("select count(*) from orders where tenant_account_id=%s", (acc,))
if cur.fetchone()[0] == 0:
    cur.execute("select id from auth.users where lower(email)=lower(%s)", (EMAIL,))
    buyer = cur.fetchone()[0]
    store_orders = [
        ("us", "whatsapp", "+1 415 555 0142", 2701, "received"),
        ("gb", "telegram", "+44 7 5124 90011", 2701, "waiting"),
        ("ng", "whatsapp", "+234 802 555 0199", 2701, "received"),
        ("us", "google", "+1 646 555 0177", 4052, "received"),
        ("de", "whatsapp", "+49 151 555 0122", 2701, "refunded"),
        ("fr", "instagram", "+33 6 55 55 01 44", 2701, "completed"),
    ]
    for cc, sv, ph, price, st in store_orders:
        cur.execute("""insert into orders(user_id,country_code,service_code,phone_number,price,status,
                        business_id,tenant_account_id,created_at,expires_at)
                       values (%s,%s,%s,%s,%s,%s,%s,%s, now() - (random()*interval '5 days'),
                               now()+interval '20 minutes')""",
                    (buyer, cc, sv, ph, price, st, BIZ, acc))
    print("storefront orders seeded:", len(store_orders))

cur.close()
conn.close()
print("DONE")
print("store login:", EMAIL, "/", PASSWORD, "(slug:", SLUG + ")")
