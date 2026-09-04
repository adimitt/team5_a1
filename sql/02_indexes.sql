-- 02_indexes.sql -- BiteStream, Project 1
-- 6 indexes: 1 partial UNIQUE, 2 partial covering, 3 secondary.
-- Run AFTER the seeder: loading into six indexes is far slower, and the partial
-- unique index would abort the COPY midway.
\echo '=== 02_indexes.sql : creating indexes ==='
-- drop first, so this file is re-runnable
DROP INDEX IF EXISTS idx_active_user_order;
DROP INDEX IF EXISTS idx_orders_delivered_rest_date;
DROP INDEX IF EXISTS idx_orders_delivered_date_rest;
DROP INDEX IF EXISTS idx_orders_user_created;
DROP INDEX IF EXISTS idx_audit_user_ts;
DROP INDEX IF EXISTS idx_restaurants_active;


-- the business rule: at most one active order per user.
-- Must be a partial unique INDEX -- a UNIQUE constraint cannot take a WHERE clause.
CREATE UNIQUE INDEX idx_active_user_order
    ON orders (user_id)
    WHERE status IN ('PREPARING', 'DELIVERING');

COMMENT ON INDEX idx_active_user_order IS
    'Business rule: at most one PREPARING/DELIVERING order per user. Raises 23505.';



-- restaurant-leading: serves the materialized view and per-vendor drilldown
CREATE INDEX idx_orders_delivered_rest_date
    ON orders (restaurant_id, created_at)
    INCLUDE (total_amount)
    WHERE status = 'DELIVERED';

COMMENT ON INDEX idx_orders_delivered_rest_date IS
    'Partial covering index, restaurant-leading. Serves the MV and per-vendor drilldown.';



-- date-leading: Workflow 2 ranges over created_at, and a B-tree can only
-- range-scan on its leading column. Target: Index Only Scan + Index Cond.
CREATE INDEX idx_orders_delivered_date_rest
    ON orders (created_at, restaurant_id)
    INCLUDE (total_amount)
    WHERE status = 'DELIVERED';

COMMENT ON INDEX idx_orders_delivered_date_rest IS
    'Partial covering index, date-leading. Target for Workflow 2: Index Only Scan + Index Cond on created_at.';


-- per-user order history, newest first
CREATE INDEX idx_orders_user_created
    ON orders (user_id, created_at DESC);



-- per-user ledger replay, newest first
CREATE INDEX idx_audit_user_ts
    ON wallet_audit_logs (user_id, "timestamp" DESC);


-- partial index on a boolean predicate
CREATE INDEX idx_restaurants_active
    ON restaurants (id)
    WHERE is_active;

\echo '--- indexes created: 6 (4 partial, 2 covering, 1 unique-partial)'
