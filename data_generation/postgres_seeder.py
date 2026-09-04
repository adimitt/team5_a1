#!/usr/bin/env python3
"""Seeds the BiteStream PostgreSQL database: 300k orders and 150k trigger-written ledger rows."""

from __future__ import annotations

import argparse
import math
import os
import pathlib
import random
import sys
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import psycopg
from faker import Faker

# Seeded so two runs produce identical data.
SEED = 42
random.seed(SEED)
Faker.seed(SEED)
fake = Faker("en_IN")

# Volumes. Clears the brief's 100k+ rows for both orders and the ledger.
N_RESTAURANTS = 1_000
N_USERS = 50_000
N_ORDERS = 300_000
N_ACTIVE_ORDERS = 6_000          # users holding one live PREPARING/DELIVERING order
N_CHECKOUT_CALLS = 300           # real sp_execute_checkout invocations
HISTORY_DAYS = 540               # orders spread over ~18 months

# Each pass is ONE set-based UPDATE that the row trigger turns into N_USERS audit rows.
LEDGER_PASSES = [
    ("welcome top-up", 500.00),
    ("first order settlement", -137.50),
    ("cashback", 89.25),
]

# Restaurants cluster around these; mongo_seeder.py reads the coordinates back out of Postgres.
CITIES = [
    ("Hyderabad", 17.3850, 78.4867),
    ("Bengaluru", 12.9716, 77.5946),
    ("Mumbai",    19.0760, 72.8777),
    ("Delhi",     28.6139, 77.2090),
    ("Chennai",   13.0827, 80.2707),
    ("Pune",      18.5204, 73.8567),
    ("Kolkata",   22.5726, 88.3639),
    ("Jaipur",    26.9124, 75.7873),
]

CUISINES = ["Biryani House", "Tandoor", "Cafe", "Dosa Corner", "Chinese Wok", "Pizzeria",
            "Bakery", "Tiffin Centre", "Rolls", "Thali House", "Momo Point", "Kebab Co"]

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX_FILE = REPO_ROOT / "sql" / "02_indexes.sql"


def dsn() -> str:
    return (
        f"host={os.getenv('PGHOST', '127.0.0.1')} "
        f"port={os.getenv('PGPORT', '5432')} "
        f"dbname={os.getenv('PGDATABASE', 'bitestream')} "
        f"user={os.getenv('PGUSER', 'bs')} "
        f"password={os.getenv('PGPASSWORD', 'bs')}"
    )


def log(msg: str) -> None:
    print(f"[postgres_seeder] {msg}", flush=True)


# ======================================================================================
def reset(conn: psycopg.Connection) -> None:
    """Empty every table and drop the analytics indexes ready for a fast bulk load."""
    with conn.cursor() as cur:
        # wallet_audit_logs has a BEFORE TRUNCATE guard (03_triggers_and_audit.sql).
        log("disabling audit immutability guards for the reset")
        cur.execute("ALTER TABLE wallet_audit_logs DISABLE TRIGGER USER")

        # checkout_attempts is created by sql/04_stored_procedures.sql, which may not have
        cur.execute("SELECT to_regclass('public.checkout_attempts') IS NOT NULL")
        has_attempts = cur.fetchone()[0]
        targets = "orders, wallet_audit_logs, users, restaurants"
        if has_attempts:
            targets = "orders, wallet_audit_logs, checkout_attempts, users, restaurants"

        log("truncating all tables (RESTART IDENTITY makes ids a predictable 1..N)")
        cur.execute(f"TRUNCATE {targets} RESTART IDENTITY CASCADE")

        cur.execute("ALTER TABLE wallet_audit_logs ENABLE TRIGGER USER")
        log("audit immutability guards re-enabled")

        # Drop the analytics indexes.
        log("dropping analytics indexes for the duration of the load")
        for ix in (
            "idx_active_user_order",
            "idx_orders_delivered_rest_date",
            "idx_orders_delivered_date_rest",
            "idx_orders_user_created",
            "idx_audit_user_ts",
            "idx_restaurants_active",
        ):
            cur.execute(f"DROP INDEX IF EXISTS {ix}")
    conn.commit()


# ======================================================================================
def seed_restaurants(conn: psycopg.Connection, n: int) -> list[tuple[float, float]]:
    """COPY n restaurants clustered around the eight metros. Returns their coordinates."""
    log(f"COPY {n:,} restaurants")
    coords: list[tuple[float, float]] = []
    with conn.cursor() as cur, cur.copy(
        "COPY restaurants (name, city, latitude, longitude, is_active) FROM STDIN"
    ) as cp:
        for i in range(n):
            city, clat, clng = CITIES[i % len(CITIES)]
            # +/- ~0.08 deg is roughly a 9 km city spread.
            lat = clat + random.gauss(0, 0.05)
            lng = clng + random.gauss(0, 0.05) / math.cos(math.radians(clat))
            lat = max(-90.0, min(90.0, lat))     # honour ck_rest_latitude
            lng = max(-180.0, min(180.0, lng))   # honour ck_rest_longitude
            name = f"{fake.last_name()} {random.choice(CUISINES)}"
            cp.write_row((name, city, lat, lng, random.random() > 0.05))
            coords.append((lat, lng))
    conn.commit()
    return coords


def seed_users(conn: psycopg.Connection, n: int) -> None:
    """COPY n users with a starting wallet balance."""
    log(f"COPY {n:,} users")
    with conn.cursor() as cur, cur.copy(
        "COPY users (name, email, wallet_balance) FROM STDIN"
    ) as cp:
        for i in range(n):
            # Deterministic synthetic email; never a real address.
            cp.write_row((fake.name(), f"user{i + 1}@bitestream.invalid",
                          round(random.uniform(200, 5000), 2)))
    conn.commit()


def build_orders(n_orders: int, n_users: int, n_restaurants: int, n_active: int):
    """Generate order rows; at most one active order per user, or the partial unique index aborts the COPY."""
    now = datetime.now(timezone.utc)
    rows: list[list] = []
    by_user: dict[int, list[int]] = {}

    for idx in range(n_orders):
        user_id = random.randint(1, n_users)
        restaurant_id = random.randint(1, n_restaurants)
        amount = round(random.uniform(99, 1899), 2)          # honours ck_orders_amount_positive
        created = now - timedelta(
            days=random.uniform(0, HISTORY_DAYS),
            minutes=random.uniform(0, 1440),
        )
        delivered = created + timedelta(minutes=random.uniform(20, 90))
        rows.append([user_id, restaurant_id, amount, "DELIVERED", created, delivered])
        by_user.setdefault(user_id, []).append(idx)

    # Only users who actually placed an order can hold an active one.
    eligible = [u for u, ix in by_user.items() if ix]
    n_active = min(n_active, len(eligible))
    active_users = random.sample(eligible, n_active)

    for user_id in active_users:
        idx = random.choice(by_user[user_id])
        rows[idx][3] = random.choice(["PREPARING", "DELIVERING"])
        rows[idx][5] = None                                   # no delivered_at yet
        # A live order is a recent one;
        recent = now - timedelta(minutes=random.uniform(1, 110))
        rows[idx][4] = recent

    assert len(active_users) == len(set(active_users)), \
        "partial unique index would be violated: duplicate active user"
    return rows, len(active_users)


def seed_orders(conn: psycopg.Connection, rows: list[list]) -> None:
    log(f"COPY {len(rows):,} orders")
    with conn.cursor() as cur, cur.copy(
        "COPY orders (user_id, restaurant_id, total_amount, status, created_at, delivered_at) "
        "FROM STDIN"
    ) as cp:
        for r in rows:
            cp.write_row(r)
    conn.commit()


# ======================================================================================
def seed_ledger(conn: psycopg.Connection) -> None:
    """Fill the ledger to >100k rows using ONLY the trigger: one set-based UPDATE fires it once per row."""
    with conn.cursor() as cur:
        for label, amount in LEDGER_PASSES:
            t0 = time.perf_counter()
            cur.execute("UPDATE users SET wallet_balance = wallet_balance + %s", (amount,))
            n = cur.rowcount
            conn.commit()
            log(f"ledger pass '{label}': {n:,} trigger-generated rows "
                f"in {time.perf_counter() - t0:.2f}s")


# ======================================================================================
def recreate_indexes(conn: psycopg.Connection) -> None:
    """Replay sql/02_indexes.sql so index definitions live in one place (psql meta-commands stripped)."""
    log("re-creating indexes by replaying sql/02_indexes.sql")
    sql = "\n".join(
        line for line in INDEX_FILE.read_text().splitlines()
        if not line.lstrip().startswith("\\")
    )
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()
    log(f"indexes rebuilt in {time.perf_counter() - t0:.2f}s")


def analyze(conn: psycopg.Connection) -> None:
    """VACUUM (ANALYZE): without stats the planner picks Seq Scan; without VACUUM, Heap Fetches never hits 0."""
    log("VACUUM (ANALYZE) - required before any EXPLAIN is captured")
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("VACUUM (ANALYZE) restaurants")
        cur.execute("VACUUM (ANALYZE) users")
        cur.execute("VACUUM (ANALYZE) orders")
        cur.execute("VACUUM (ANALYZE) wallet_audit_logs")
    conn.autocommit = False


# ======================================================================================
def exercise_checkouts(conn: psycopg.Connection, n_calls: int,
                       n_users: int, n_restaurants: int) -> dict[str, int]:
    """Drive sp_execute_checkout down every branch. Needs autocommit -- it controls its own transaction."""
    outcomes: dict[str, int] = {}
    conn.autocommit = True
    with conn.cursor() as cur:
        for i in range(n_calls):
            user_id = random.randint(1, n_users)
            restaurant_id = random.randint(1, n_restaurants)

            roll = random.random()
            if roll < 0.10:
                amount = 999_999.00                     # -> INSUFFICIENT_FUNDS
            elif roll < 0.15:
                amount = -25.00                         # -> AMOUNT_INVALID
            elif roll < 0.20:
                restaurant_id = 10_000_000              # -> BAD_REFERENCE
                amount = 250.00
            else:
                amount = round(random.uniform(99, 900), 2)

            # Explicit casts matter:
            cur.execute(
                "CALL sp_execute_checkout("
                "  %s::bigint, %s::bigint, %s::numeric(10,2), NULL::bigint, NULL::text)",
                (user_id, restaurant_id, Decimal(str(amount))),
            )
            status = cur.fetchone()[1]
            key = status.split(":")[0]
            outcomes[key] = outcomes.get(key, 0) + 1
    conn.autocommit = False
    return outcomes


def refresh_mv(conn: psycopg.Connection) -> None:
    """Refresh the materialized view if it exists; sql/05 creates it WITH DATA if it does not yet."""
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.mv_restaurant_performance') IS NOT NULL")
        if not cur.fetchone()[0]:
            log("mv_restaurant_performance does not exist yet - "
                "sql/05_materialized_views.sql will create it WITH DATA (skipping refresh)")
            conn.autocommit = False
            return
        log("refreshing mv_restaurant_performance CONCURRENTLY")
        cur.execute("CALL sp_refresh_restaurant_performance()")
    conn.autocommit = False


# ======================================================================================
def summary(conn: psycopg.Connection) -> None:
    q = """
    SELECT 'restaurants'        AS table_name, count(*) FROM restaurants
    UNION ALL SELECT 'users',                  count(*) FROM users
    UNION ALL SELECT 'orders',                 count(*) FROM orders
    UNION ALL SELECT 'orders (DELIVERED)',     count(*) FROM orders WHERE status='DELIVERED'
    UNION ALL SELECT 'orders (active)',        count(*) FROM orders
                                               WHERE status IN ('PREPARING','DELIVERING')
    UNION ALL SELECT 'wallet_audit_logs',      count(*) FROM wallet_audit_logs
    UNION ALL SELECT 'checkout_attempts',      count(*) FROM checkout_attempts
    """
    # The MV is optional at this point (see refresh_mv); query it only if it exists.
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.mv_restaurant_performance') IS NOT NULL")
        if cur.fetchone()[0]:
            q += ("\n    UNION ALL SELECT 'mv_restaurant_performance', "
                  "count(*) FROM mv_restaurant_performance")

    print("\n" + "=" * 58)
    print(f"{'TABLE':<32}{'ROWS':>12}")
    print("-" * 58)
    total = 0
    with conn.cursor() as cur:
        cur.execute(q)
        for name, cnt in cur.fetchall():
            print(f"{name:<32}{cnt:>12,}")
            if name in ("restaurants", "users", "orders",
                        "wallet_audit_logs", "checkout_attempts"):
                total += cnt
    print("-" * 58)
    print(f"{'TOTAL RELATIONAL ROWS':<32}{total:>12,}")
    print("=" * 58)

    # The partial unique index is a business rule; prove it actually holds in the data.
    with conn.cursor() as cur:
        cur.execute("""
            SELECT count(*) FROM (
                SELECT user_id FROM orders
                WHERE status IN ('PREPARING','DELIVERING')
                GROUP BY user_id HAVING count(*) > 1
            ) x
        """)
        violations = cur.fetchone()[0]
        print(f"users with >1 active order (must be 0): {violations}")

        cur.execute("SELECT count(*) FROM wallet_audit_logs")
        n_audit = cur.fetchone()[0]
        print(f"ledger rows, all trigger-generated:     {n_audit:,}")
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description="Seed the BiteStream PostgreSQL database.")
    ap.add_argument("--scale", type=float, default=1.0,
                    help="multiply all row counts (e.g. 0.05 for a quick smoke test)")
    ap.add_argument("--skip-checkouts", action="store_true",
                    help="skip the live sp_execute_checkout calls")
    args = ap.parse_args()

    s = args.scale
    n_rest = max(10, int(N_RESTAURANTS * s))
    n_users = max(50, int(N_USERS * s))
    n_orders = max(100, int(N_ORDERS * s))
    n_active = max(5, int(N_ACTIVE_ORDERS * s))
    n_calls = 0 if args.skip_checkouts else max(10, int(N_CHECKOUT_CALLS * s))

    t0 = time.perf_counter()
    log(f"connecting: {os.getenv('PGDATABASE', 'bitestream')} @ "
        f"{os.getenv('PGHOST', '127.0.0.1')}:{os.getenv('PGPORT', '5432')}")

    with psycopg.connect(dsn()) as conn:
        reset(conn)
        seed_restaurants(conn, n_rest)
        seed_users(conn, n_users)

        log(f"generating {n_orders:,} order rows in memory "
            f"(honouring the partial unique index)")
        rows, n_actual_active = build_orders(n_orders, n_users, n_rest, n_active)
        log(f"  -> {n_actual_active:,} users given exactly one active order")
        seed_orders(conn, rows)
        del rows

        seed_ledger(conn)
        recreate_indexes(conn)
        analyze(conn)

        if n_calls:
            log(f"exercising sp_execute_checkout ({n_calls} live calls)")
            outcomes = exercise_checkouts(conn, n_calls, n_users, n_rest)
            for k in sorted(outcomes):
                log(f"  {k:<22} {outcomes[k]:>5}")
            # The checkouts created new orders and moved balances; refresh stats again.
            analyze(conn)

        refresh_mv(conn)
        summary(conn)

    log(f"done in {time.perf_counter() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
