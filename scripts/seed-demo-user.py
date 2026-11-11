"""Seed a fully-populated demo login for local cross-checking.

Sets a known password on demo@smspin.local, grants admin, and tops up the
notifications feed + onboarding checklist so every dashboard surface has data.
"""
import os
import psycopg2

DSN = os.environ["Smspin_supabase_Postgresql"]
EMAIL = "demo@smspin.local"
PASSWORD = "SmspinDemo123!"
ADMIN_EMAIL = "demo@smspin.local"

conn = psycopg2.connect(DSN, connect_timeout=15)
conn.autocommit = True
cur = conn.cursor()

cur.execute("select id from auth.users where lower(email)=lower(%s)", (EMAIL,))
row = cur.fetchone()
if not row:
    raise SystemExit("demo user not found")
uid = row[0]
print("user id:", uid)

# bcrypt via pgcrypto (GoTrue stores bcrypt $2a$ hashes)
cur.execute(
    "update auth.users set encrypted_password = crypt(%s, gen_salt('bf')), "
    "email_confirmed_at = coalesce(email_confirmed_at, now()), "
    "updated_at = now() where id = %s",
    (PASSWORD, uid),
)
print("password set; rows:", cur.rowcount)

# Grant admin so the ops console unlocks.
cur.execute("insert into admins(email, role) values (%s,'owner') "
            "on conflict (email) do update set role='owner'", (ADMIN_EMAIL,))
print("admin granted")

# Notifications feed (bell menu).
cur.execute("select count(*) from notifications where user_id=%s", (uid,))
if cur.fetchone()[0] == 0:
    notes = [
        ("order", "Order delivered", "Your WhatsApp verification code arrived.", "/dashboard/sms/"),
        ("wallet", "Wallet funded", "NGN 50,000.00 added to your balance.", "/dashboard/wallet/"),
        ("refund", "Auto-refund issued", "No code received — NGN 250.00 refunded.", "/dashboard/transactions/"),
        ("security", "New sign-in", "A new device signed in to your account.", "/dashboard/settings/"),
        ("growth", "Referral reward", "You earned NGN 500.00 from a referral.", "/dashboard/referrals/"),
    ]
    for kind, title, body, href in notes:
        cur.execute("insert into notifications(user_id,kind,title,body,href) "
                    "values (%s,%s,%s,%s,%s)", (uid, kind, title, body, href))
    print("notifications seeded:", len(notes))

# Onboarding checklist — leave a couple items open so progress is visible.
cur.execute("select count(*) from onboarding_state where user_id=%s", (uid,))
if cur.fetchone()[0] == 0:
    for key, done in [("verify_email", True), ("fund_wallet", True),
                      ("first_order", True), ("create_api_key", True),
                      ("join_affiliate", False), ("enable_2fa", False)]:
        cur.execute("insert into onboarding_state(user_id,item_key,done) "
                    "values (%s,%s,%s)", (uid, key, done))
    print("onboarding seeded")

# Make sure the wallet is funded enough to exercise every flow.
cur.execute("update wallets set balance = greatest(balance, 150000) where user_id=%s", (uid,))
print("wallet balance:", cur.fetchone())

cur.close()
conn.close()
print("DONE")
print("login:", EMAIL, "/", PASSWORD)
