# BiteStream — Food Delivery & Real-Time Logistics

CS6.302 Software System Development · Assignment 1 · **Project 1**
PostgreSQL + MongoDB, implemented entirely at the database level.

## 1. Submission

| | |
|---|---|
| **Team** | 5 |
| **Project** | 1 — BiteStream (`project_no = (5 % 5) + 1 = 1`) |
| **Members** | Aditya Mittal (2026201055) · Sourav Sahu (2026202001) · Dasari Abhaya Manasa (2026202014) · Gagandeep Singh (2026202008) |
| **Repository** | https://github.com/adimitt/team5_a1 |
| **Final commit** | `fd5acf472df0153a989473e56d6243738857c01a` |

> A file cannot contain its own commit hash, since writing the hash in changes the hash.
> The commit above holds all 17 deliverables; the only commit after it is the one that
> inserted this line. Both resolve to the complete project.

## 2. Environment

PostgreSQL 17.11 · MongoDB 8.3.7 · Python 3.13

```bash
psql -d postgres -c "CREATE ROLE bs LOGIN PASSWORD 'bs' CREATEDB;"
psql -d postgres -c "CREATE DATABASE bitestream OWNER bs;"
python3 -m pip install -r data_generation/requirements.txt
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=bitestream PGUSER=bs PGPASSWORD=bs
export MONGO_URI=mongodb://127.0.0.1:27017
```

## 3. Setup — run in this order

```bash
psql -f sql/01_schema_ddl.sql              # tables, PK/FK, CHECK constraints
psql -f sql/03_triggers_and_audit.sql      # audit trigger — BEFORE any data exists
psql -f sql/04_stored_procedures.sql       # Workflow 1
python3 data_generation/postgres_seeder.py # COPY + trigger-driven ledger + VACUUM ANALYZE
psql -f sql/02_indexes.sql                 # indexes — AFTER the bulk load
psql -f sql/05_materialized_views.sql      # MV + refresh function and procedure

mongosh bitestream mongo/01_collections_and_indexes.js
python3 data_generation/mongo_seeder.py

psql -f sql/06_window_analytics.sql                # Workflow 2
mongosh bitestream mongo/02_workflow3_geonear.js   # Workflow 3
mongosh bitestream mongo/03_workflow4_facet.js     # Workflow 4
psql -c "CALL sp_execute_checkout(1, 1, 250.00, NULL, NULL);"   # Workflow 1
```

**The order is not optional.**
`03` before any data, so every ledger row is trigger-written.
`02` after the seeder — loading into six indexes is far slower, and the partial unique index aborts the COPY midway.
`VACUUM (ANALYZE)` runs last inside the seeder; without it the planner picks Seq Scan.

## 4. Assumptions

1. **BIGINT IDENTITY keys, not UUID.** The brief allows either. Random UUIDv4 destroys B-tree insert locality and widens every FK from 8 to 16 bytes.
2. **`NUMERIC(10,2)` for money, `DOUBLE PRECISION` for coordinates.** Exact decimal for a ledger; geographic precision for lat/lon.
3. **The brief says the order INSERT "triggers the audit log". It does not** — `trg_wallet_audit` is an `AFTER UPDATE` trigger on `users`, so the wallet debit fires it. Implemented as written in the spec's intent.
4. **One active order per user is a hard rule**, enforced by a partial unique index, not by application code.
5. **`total_amount` is pre-computed.** No line-item table; the assignment does not require one.
6. **No cross-database foreign key exists.** Mongo documents carry PostgreSQL ids as opaque copies; `mongo_seeder.py` reads them out of PostgreSQL at load time, which is the only thing keeping them consistent.
7. **Telemetry is intentionally lossy.** The 2-hour TTL on `DriverPings` means the collection drains continuously. Re-run `mongo_seeder.py` before any demo.
8. **`docs/mongo_schema_map.json` is executable, not documentation.** Both `mongo/01_collections_and_indexes.js` and `mongo_seeder.py` read it at runtime.
9. Single currency (INR). Seeded data is synthetic (`Faker`, seed 42) and reproducible.

## 5. Dataset

| Relation | Rows | | Collection | Documents |
|---|---:|---|---|---:|
| `orders` | 300,211 | | `Menus` | 1,000 |
| `wallet_audit_logs` | 150,211 | | `Reviews` | 200,000 |
| `users` | 50,000 | | `DriverPings` | 520,000 |
| `restaurants` | 1,000 | | | |

Brief requires 100,000+ ledger entries, 50,000+ orders, 500,000+ pings. All cleared.
**Every ledger row was written by the trigger** — three set-based `UPDATE` statements, one row-trigger firing per affected row. `COPY` fires INSERT triggers only, so it could not have produced them.

## 6. Performance proof

Raw logs: `performance/postgres_explain_analyzes.txt`, `performance/mongo_execution_stats.json`

| Query | Without index | With index | Gain |
|---|---|---|---|
| **WF2** 90-day revenue scan | Seq Scan, 91.201 ms | Index Only Scan, **29.250 ms** | 3.1× |
| **Materialized view** leaderboard | Seq Scan on 294,015 orders, 89.653 ms | Index Scan, **0.034 ms** | 2,600× |
| **Partial unique index** lookup | — | Index Scan, **0.011 ms** | — |
| **WF3** `$geoNear` 5 km | COLLSCAN, 520,000 docs, 244 ms | GEO_NEAR_2DSPHERE, **44,618 docs**, 91 ms | 11.7× fewer docs |
| **WF4** `$facet` | COLLSCAN, 200,000 docs, 49 ms | IXSCAN, **220 docs**, 1 ms | 909× fewer docs |

### Workflow 2 — Index Only Scan with an Index Cond

```
->  Index Only Scan using idx_orders_delivered_date_rest on public.orders o
      (cost=0.43..1526.35 rows=54081 width=18) (actual time=0.022..7.383 rows=49179 loops=1)
      Index Cond: ((o.created_at >= (CURRENT_DATE - '90 days'::interval))
               AND (o.created_at <  (CURRENT_DATE + '1 day'::interval)))
      Heap Fetches: 525
Execution Time: 29.250 ms
```

Control, index paths disabled with `enable_indexscan=off`:

```
->  Seq Scan on orders o  (actual time=0.006..66.167 rows=49179 loops=1)
Execution Time: 91.201 ms
```

### Workflow 3 — `GEO_NEAR_2DSPHERE`, no `COLLSCAN`

```
stage: GEO_NEAR_2DSPHERE   indexName: ix_pings_geo
totalDocsExamined: 44,618   of 520,000      executionTimeMillis: 91
```

`$geoNear` cannot run at all without the index — MongoDB rejects the pipeline:
`"$geoNear requires a 2d or 2dsphere index, but none were found"`.

### Workflow 4 — `IXSCAN`, and the anti-pattern measured

```
$match before $facet   IXSCAN ix_reviews_restaurant_recent      220 docs      1 ms
$match inside $facet   COLLSCAN                             200,000 docs    230 ms
```

`$facet` sub-pipelines cannot use indexes — only the stage immediately before `$facet` can. Moving the filter one stage inwards costs **909× the documents examined**.

## 7. Repository contents

```
README.md
docs/    relational_erd.png          generated from the live schema (eralchemy2 + Graphviz)
         mongo_schema_map.json       validators + index specs, read at runtime by mongo/01 and the seeder
sql/     01_schema_ddl.sql           4 tables, 12 CHECK constraints
         02_indexes.sql              6 indexes: 1 partial UNIQUE, 2 partial covering, 3 secondary
         03_triggers_and_audit.sql   audit trigger + 2 immutability guards; self-tests on load
         04_stored_procedures.sql    Workflow 1 — sp_execute_checkout, REPEATABLE READ
         05_materialized_views.sql   MV + REFRESH CONCURRENTLY as both FUNCTION and PROCEDURE
         06_window_analytics.sql     Workflow 2 — CTEs, RANGE frames, DENSE_RANK
mongo/   01_collections_and_indexes.js   collections, validators, 2dsphere, TTL 7200s
         02_workflow3_geonear.js         Workflow 3
         03_workflow4_facet.js           Workflow 4
data_generation/  postgres_seeder.py  mongo_seeder.py  requirements.txt
performance/      postgres_explain_analyzes.txt  mongo_execution_stats.json
```

## 8. Verification

The scripts assert their own correctness and fail loudly:

| Run | Asserts |
|---|---|
| `sql/03_triggers_and_audit.sql` | CREDIT/DEBIT logged correctly, no-op write logs nothing, ledger `UPDATE` rejected. Prints `self-test passed`. |
| `data_generation/postgres_seeder.py` | `users with >1 active order (must be 0): 0` |
| `mongo/01_collections_and_indexes.js` | 2dsphere present, TTL exactly 7200 s and single-field, 3 validators |
| `mongo/02` and `mongo/03` | throw unless `GEO_NEAR_2DSPHERE` / `IXSCAN` present and `COLLSCAN` absent |

Workflow 1 outcomes, by hand:

```
OK · ACTIVE_ORDER_EXISTS (23505) · INSUFFICIENT_FUNDS (23514)
AMOUNT_INVALID (22023) · BAD_REFERENCE (23503) · USER_NOT_FOUND
```

After the four failures the wallet balance and ledger row count are **unchanged** — atomicity.
`CALL` must run in autocommit; nested inside `BEGIN` it raises `2D000`.

## 9. Known limitations

- MV is refreshed manually; production would use `pg_cron` on a staleness budget.
- No cross-database referential integrity; divergence needs a reconciliation job.
- At 100× scale: partition `orders` by month, shard `DriverPings` on `driver_id`, replace the full MV refresh with incremental rollups.
