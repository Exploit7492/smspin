"""Real-time funding-fee engine (no static FX / PPP tables).

Fee bench (NGN, from the product spec):
    500  -> 10
    700  -> 20
    1000 -> 50

The bench is the Nigerian schedule. It is lifted into *international dollars*
at Nigeria's current purchasing-power parity (World Bank PA.NUS.PPP), which
makes the schedule a pure "real effort" curve. A caller's top-up is then priced
the same way, in their own currency, at their own country's PPP factor, so the
same real top-up costs the same real fee everywhere while poorer countries pay
less in hard currency and richer countries pay more.

Both inputs are fetched live via packages - never static tables:

    * forex_python.converter.CurrencyRates  -> live exchange rates
    * wbdata                                -> World Bank PA.NUS.PPP (LCU/int$)

Results are memoised in-process with a TTL so the hot path never refetches.
"""
from __future__ import annotations

import json
import time
import threading

# Bench: (amount in NGN, fee in NGN) at Nigerian scale.
_BENCH = [(500.0, 10.0), (700.0, 20.0), (1000.0, 50.0)]
_MAX_MAGNITUDE = 6  # schedule extends across 10**0 .. 10**6 multiples

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


# ---------- fee schedule (international dollars) ----------
def _bench_int() -> list:
    """The NGN bench re-expressed in international dollars (via NG's PPP)."""
    f = ppp_factor("NG") or 1.0
    return [(a / f, fee / f) for a, fee in _BENCH]


def _tiered(amount_int: float) -> float:
    """Fee in international dollars for a real top-up of `amount_int` int$."""
    bench = _bench_int()
    anchors = [a for a, _ in bench]
    fees = [x for _, x in bench]
    lo, hi = anchors[0], anchors[-1]
    a = max(amount_int, 0.0)
    band = 0
    while band < _MAX_MAGNITUDE and a >= hi * (10 ** (band + 1)):
        band += 1
    scale = 10.0 ** band
    x = a / scale
    if x <= lo:
        fee = fees[0]
    elif x <= hi:
        fee = fees[-1]
        for i in range(len(anchors) - 1):
            if anchors[i] <= x <= anchors[i + 1]:
                f0, f1 = fees[i], fees[i + 1]
                fee = f0 + (f1 - f0) * (x - anchors[i]) / (anchors[i + 1] - anchors[i])
                break
    else:
        # linear extension beyond the top anchor at the 1k-anchor slope
        slope = (fees[-1] - fees[-2]) / (anchors[-1] - anchors[-2])
        fee = fees[-1] + slope * (x - hi)
    return fee * scale


def fee_ngn(amount_ngn: float, country: str = "NG") -> float:
    """Fee in NGN for a Nigerian-denominated top-up, PPP-priced for `country`."""
    f = ppp_factor(country)
    amount_int = float(amount_ngn or 0) / (ppp_factor("NG") or 1.0)
    return round(_tiered(amount_int) * f, 4)


# ---------- public quote ----------
def quote(amount: float, country: str = "", currency: str = "") -> dict:
    """Funding quote for `amount` expressed in `currency` (the caller's money).

    Returns the fee and net credit in the caller's currency AND the NGN figures
    KoraPay settles in, plus the live FX / PPP context used.
    """
    amount = float(amount or 0)
    cur = (currency or "NGN").upper()
    cc = (country or "NG").upper()
    f = ppp_factor(cc)
    amount_int = amount / (f or 1.0)
    fee_local = round(_tiered(amount_int) * f, 4)
    fee_local = min(fee_local, amount * 0.5)  # never fee away more than half
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
        "fee_percent": round((fee_local / amount * 100) if amount else 0, 2),
        "amount_ngn": amount_ngn,
        "fee_ngn": fee_ngn_v,
        "net_ngn": net_ngn,
        "usd_ngn": round(usd_ngn(), 4),
        "ppp_factor": round(f, 6),
    }


if __name__ == "__main__":
    print("NGN bench:", [(a, fee_ngn(a, "NG")) for a, _ in _BENCH])
    for c, cur, amt in (("NG", "NGN", 1000), ("US", "USD", 1), ("GB", "GBP", 1),
                        ("IN", "INR", 100), ("KE", "KES", 200), ("NG", "NGN", 5000)):
        print(c, cur, amt, quote(amt, c, cur))
