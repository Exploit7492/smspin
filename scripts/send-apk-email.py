#!/usr/bin/env python3
"""Email a tenant their branded APK download link (SMTP over SSL).

Env: MAIL_USERNAME, MAIL_PASSWORD, TO, LINK, TENANT
"""
import os
import smtplib
import ssl
from email.message import EmailMessage

user = os.environ["MAIL_USERNAME"]
pwd = os.environ["MAIL_PASSWORD"]
to = os.environ["TO"]
link = os.environ.get("LINK", "")
tenant = os.environ.get("TENANT", "your store")

msg = EmailMessage()
msg["Subject"] = f"Your {tenant} app is ready"
msg["From"] = user
msg["To"] = to
msg.set_content(
    f"Your branded Android app for {tenant} is ready.\n\n"
    f"Download: {link}\n\n"
    "Install it on Android, then sign in with your store account.\n\n"
    "— SMSPin"
)

with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context()) as s:
    s.login(user, pwd)
    s.send_message(msg)
print("Emailed download link to", to)
