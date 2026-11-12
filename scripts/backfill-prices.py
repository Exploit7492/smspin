#!/usr/bin/env python3
"""Re-sync sellable catalog pairs at the corrected (cheapest-operator) price.

The first catalog import priced every pair off the provider's headline price,
which is a high operator tier, so displayed prices were several times the real
provider cost. This walks the sellable pairs and re-runs sync_pair(), which now
prices from the cheapest in-stock operator.

Pairs are fetched concurrently (the provider client is stateless per request).
Progress is written to number_catalog.updated_at, so a re-run only touches
pairs that are still stale.

Usage: python3 scripts/backfill-prices.py [workers] [max_seconds]
"""
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import psycopg2  # noqa: E402
import server  # noqa: E402


def pairs_to_fix():
    conn = psycopg2.connect(os.environ["Smspin_supabase_Postgresql"])
    cur = conn.cursor()
    cur.execute("""select country_code, service_code from number_catalog
                    where active and stock > 0
                    order by updated_at asc""")
    pairs = cur.fetchall()
    cur.close()
    conn.close()
    return pairs


def main(workers=8, budget=None):
    pairs = pairs_to_fix()
    total = len(pairs)
    print(f"{total} pairs to re-sync", flush=True)
    started = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(server.sync_pair, cc, sv, True): (cc, sv) for cc, sv in pairs}
        for fut in as_completed(futs):
            done += 1
            if done % 250 == 0:
                rate = done / max(time.time() - started, 1)
                left = (total - done) / rate if rate else 0
                print(f"{done}/{total}  {rate:.1f}/s  ~{left/60:.0f}m left", flush=True)
            if budget and time.time() - started > budget:
                break
    print(f"done: {done}/{total} in {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    w = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    b = int(sys.argv[2]) if len(sys.argv) > 2 else None
    main(w, b)
