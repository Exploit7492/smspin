"""Transactional email via SMTP (stdlib only) — legacy fallback.

Novu (see ``novu.py``) is the platform's email infrastructure; this module is
only used when Novu is not configured (e.g. a bare local checkout). Configured
through the environment; when credentials are absent every send is a no-op that
returns ``False`` so callers can fall back to in-app notices:

    MAIL_USERNAME, MAIL_PASSWORD   SMTP login (Gmail app password in prod)
    MAIL_HOST, MAIL_PORT           defaults to smtp.gmail.com:465 (SSL)
    MAIL_FROM                      defaults to MAIL_USERNAME
"""
import os
import ssl
import smtplib
import threading
from email.message import EmailMessage

_LOCK = threading.Lock()


def configured():
    return bool(os.environ.get("MAIL_USERNAME") and os.environ.get("MAIL_PASSWORD"))


def send(to, subject, body, html=None):
    """Send a plain-text (optionally multipart) email. Returns True on success."""
    if not configured() or not to:
        return False
    host = os.environ.get("MAIL_HOST", "smtp.gmail.com")
    port = int(os.environ.get("MAIL_PORT", "465"))
    user = os.environ["MAIL_USERNAME"]
    pwd = os.environ["MAIL_PASSWORD"]

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.environ.get("MAIL_FROM", user)
    msg["To"] = to
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")

    try:
        with _LOCK:
            with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=20) as s:
                s.login(user, pwd)
                s.send_message(msg)
        return True
    except Exception:
        return False
