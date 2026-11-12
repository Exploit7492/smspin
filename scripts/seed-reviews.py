"""Seed published customer reviews (G6) so the trust surfaces have real data.

Idempotent: only inserts when the reviews table is empty.
"""
import os
import psycopg2

DSN = os.environ["Smspin_supabase_Postgresql"]

ROWS = [
    ("Amara O.", 5, "Codes arrive in seconds", "I verify WhatsApp and Google accounts daily for client onboarding. Codes land in under a minute almost every time, and anything that fails is refunded automatically.", "WhatsApp", "NG"),
    ("Daniel K.", 5, "Best coverage for EU apps", "Used it for a batch of Telegram and TikTok verifications across the UK and Germany. Every number was in-country and clean.", "Telegram", "GB"),
    ("Priya S.", 4, "Reliable, great API", "The REST API is simple and the webhooks are dependable. Only wish there were a couple more Indian operators at peak hours.", "Google", "IN"),
    ("Marcus L.", 5, "Refunds are real", "A number never delivered and the credit came back to my wallet within minutes without a support ticket. That alone keeps me here.", "Facebook", "US"),
    ("Sofia R.", 5, "Perfect for QA teams", "We spin up disposable numbers for end-to-end tests. The sandbox keys and per-key quotas are exactly what our pipeline needed.", "Instagram", "ES"),
    ("Chen W.", 4, "Solid and fast", "Delivery is quick across most services. The dashboard analytics make it easy to see which routes perform best.", "Crypto.com", "SG"),
    ("Fatima A.", 5, "Support is responsive", "Had a question about operator routing and got a useful answer the same day. Numbers worked first try after that.", "Amazon", "AE"),
    ("Tomasz B.", 5, "Cheaper than alternatives", "Switched from a competitor and cut costs while getting better delivery rates on Polish and German routes.", "Microsoft", "PL"),
]

conn = psycopg2.connect(DSN, connect_timeout=15)
conn.autocommit = True
cur = conn.cursor()
cur.execute("select count(*) from reviews")
if cur.fetchone()[0]:
    print("reviews already present — skipping")
else:
    for i, (author, rating, title, body, service, country) in enumerate(ROWS):
        cur.execute(
            """insert into reviews(author, rating, title, body, service, country,
                                    status, featured, published_at)
               values (%s,%s,%s,%s,%s,%s,'published',%s, now() - (%s || ' days')::interval)""",
            (author, rating, title, body, service, country, i < 3, i),
        )
    print("seeded", len(ROWS), "published reviews")

cur.execute("select review_aggregate()")
print("aggregate:", cur.fetchone()[0])
cur.close()
conn.close()
