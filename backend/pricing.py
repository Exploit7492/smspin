"""Real-time funding-fee engine.

The platform charges a flat 2.5% funding fee on every top-up, in every
currency and every country — there is no PPP or geo tiering.

The only live input is FX: a caller's top-up is converted to the NGN figure
KoraPay settles in using live rates.

    * forex_python.converter.CurrencyRates  -> live exchange rates

Results are memoised in-process with a TTL so the hot path never refetches.
"""
from __future__ import annotations

import json
import time
import threading

_TTL = 6 * 60 * 60  # 6 hours
_lock = threading.Lock()
_ppp_cache: dict = {"t": 0.0, "factors": {}}
_usd_ngn_cache: dict = {"t": 0.0, "rate": None}


def _fresh(cache: dict) -> bool:
    return bool(cache.get("factors") or cache.get("rate")) \
        and (time.time() - cache["t"] < _TTL)


# ---------- live FX ----------
def _currency_rates():
    try:
        from forex_python.converter import CurrencyRates
        return CurrencyRates()
    except Exception:
        return None


def usd_ngn() -> float:
    """Current USD->NGN rate (NGN per 1 USD)."""
    with _lock:
        if _fresh(_usd_ngn_cache):
            return _usd_ngn_cache["rate"]
    rate = None
    cr = _currency_rates()
    if cr is not None:
        try:
            rate = float(cr.get_rate("USD", "NGN"))
        except Exception:
            rate = None
    if not rate or rate <= 0:
        rate = _fallback_ngn()
    with _lock:
        _usd_ngn_cache.update(t=time.time(), rate=rate)
    return rate


def _fallback_ngn() -> float:
    """Last resort only, if the live feed is momentarily down."""
    try:
        import urllib.request
        r = urllib.request.urlopen("https://open.er-api.com/v6/latest/USD", timeout=8)
        v = float(json.loads(r.read() or b"{}").get("rates", {}).get("NGN") or 0)
        if v > 0:
            return v
    except Exception:
        pass
    return 1600.0


def local_per_usd(currency: str) -> float:
    """Units of `currency` per 1 USD, from live rates."""
    cur = (currency or "NGN").upper()
    if cur == "NGN":
        return usd_ngn()
    cr = _currency_rates()
    if cr is not None:
        try:
            return float(cr.get_rate("USD", cur))
        except Exception:
            pass
    return usd_ngn()


def to_ngn(amount: float, currency: str) -> float:
    """Convert `amount` in `currency` into NGN at live FX."""
    return round(float(amount) * usd_ngn() / local_per_usd(currency), 2)


# ---------- live PPP ----------
def ppp_factor(country: str) -> float:
    """PPP conversion factor for `country` (LCU per international $).

    Falls back to the country's FX rate (i.e. plain USD parity) when the World
    Bank has no recent value, so pricing degrades gracefully.
    """
    cc = (country or "").upper()
    if not cc:
        return 1.0
    with _lock:
        if _fresh(_ppp_cache):
            return _ppp_cache["factors"].get(cc) or _ppp_fallback(cc)
    factors = _load_ppp()
    with _lock:
        _ppp_cache.update(t=time.time(), factors=factors)
    return factors.get(cc) or _ppp_fallback(cc)


def _ppp_fallback(cc: str) -> float:
    """No PPP published -> approximate with the market FX rate."""
    return 1.0 if cc == "US" else usd_ngn()


def _load_ppp() -> dict:
    """World Bank PPP conversion factors for every country (cached 6h)."""
    try:
        import wbdata
    except Exception:
        return {}
    out: dict = {}
    try:
        data = wbdata.get_data("PA.NUS.PPP", date=("2018", "2025"))
    except Exception:
        return out
    for row in data or []:
        try:
            cc = row["country"]["id"]
            v = row.get("value")
            yr = str(row.get("date") or "0")
            if v is None:
                continue
            prev = out.get(cc)
            if prev is None or yr > prev[0]:
                out[cc] = (yr, float(v))
        except Exception:
            continue
    return {k: v[1] for k, v in out.items()}


# ---------- fee schedule (flat) ----------
FEE_PERCENT = 2.5  # flat platform funding fee, every currency, every country


def fee_ngn(amount_ngn: float, country: str = "NG") -> float:
    """Flat 2.5% funding fee, regardless of country or currency."""
    return round(float(amount_ngn or 0) * FEE_PERCENT / 100.0, 4)


# ---------- public quote ----------
def quote(amount: float, country: str = "", currency: str = "") -> dict:
    """Funding quote for `amount` expressed in `currency` (the caller's money).

    The fee is a flat 2.5% everywhere. Returns the fee and net credit in the
    caller's currency AND the NGN figures KoraPay settles in, plus the live FX
    context used.
    """
    amount = float(amount or 0)
    cur = (currency or "NGN").upper()
    cc = (country or "NG").upper()
    fee_local = round(amount * FEE_PERCENT / 100.0, 4)
    net_local = round(amount - fee_local, 4)
    amount_ngn = to_ngn(amount, cur)
    fee_ngn_v = to_ngn(fee_local, cur)
    net_ngn = round(amount_ngn - fee_ngn_v, 2)
    return {
        "country": cc,
        "currency": cur,
        "amount": round(amount, 2),
        "fee": fee_local,
        "net": net_local,
        "fee_percent": FEE_PERCENT,
        "amount_ngn": amount_ngn,
        "fee_ngn": fee_ngn_v,
        "net_ngn": net_ngn,
        "usd_ngn": round(usd_ngn(), 4),
    }


if __name__ == "__main__":
    for c, cur, amt in (("NG", "NGN", 1000), ("US", "USD", 1), ("GB", "GBP", 1),
                        ("IN", "INR", 100), ("KE", "KES", 200), ("NG", "NGN", 5000)):
        print(c, cur, amt, quote(amt, c, cur))
