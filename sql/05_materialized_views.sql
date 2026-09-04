\echo '=== 05_materialized_views.sql : restaurant performance MV ==='

DROP MATERIALIZED VIEW IF EXISTS mv_restaurant_performance CASCADE; -- if exists delete materialized view

CREATE MATERIALIZED VIEW mv_restaurant_performance AS -- create a materialized view mv_restaurant_performance
SELECT
    r.id                                             AS restaurant_id,
    r.name,
    r.city,
    r.is_active,
    COUNT(o.id)                                      AS completed_orders,
    COALESCE(SUM(o.total_amount), 0)::NUMERIC(14,2)  AS total_revenue,
    COALESCE(AVG(o.total_amount), 0)::NUMERIC(10,2)  AS avg_order_value,
    MAX(o.created_at)                                AS last_order_at
FROM restaurants r
LEFT JOIN orders o
       ON o.restaurant_id = r.id
      AND o.status = 'DELIVERED'          -- Restaurants with NULL or delivered status will be stored as it is left join
GROUP BY r.id, r.name, r.city, r.is_active
WITH DATA;                                -- Grouping all orders of the same restaurant

COMMENT ON MATERIALIZED VIEW mv_restaurant_performance IS
    'Snapshot of lifetime delivered-order count and revenue per restaurant. Refresh via sp_refresh_restaurant_performance().';

CREATE UNIQUE INDEX ux_mv_rest_perf ON mv_restaurant_performance (restaurant_id); -- for unique restaurant id

CREATE INDEX idx_mv_rest_perf_revenue ON mv_restaurant_performance (total_revenue DESC); -- unique reference for total revenue

CREATE OR REPLACE PROCEDURE sp_refresh_restaurant_performance() -- create or replace a stored procedure
LANGUAGE plpgsql
AS $sp$
DECLARE
    v_started  TIMESTAMPTZ := clock_timestamp(); -- current actual time
    v_rows     BIGINT;
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_restaurant_performance; --rebuilds the materialized view using the latest data without blocking readers

    SELECT count(*) INTO v_rows FROM mv_restaurant_performance; -- stores rows count in view in v_rows
    RAISE NOTICE 'mv_restaurant_performance refreshed CONCURRENTLY: % rows in %',
                 v_rows, (clock_timestamp() - v_started); --prints message for the user
END;
$sp$;

COMMENT ON PROCEDURE sp_refresh_restaurant_performance() IS
    'REFRESH MATERIALIZED VIEW CONCURRENTLY wrapper. Call from autocommit: CALL sp_refresh_restaurant_performance();';

CREATE OR REPLACE FUNCTION fn_refresh_restaurant_performance()
RETURNS BIGINT
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_started TIMESTAMPTZ := clock_timestamp(); -- stores current actual time
    v_rows    BIGINT;
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_restaurant_performance; -- refresh materialized view concurrently

    SELECT count(*) INTO v_rows FROM mv_restaurant_performance; -- stores the rows count
    RAISE NOTICE 'mv_restaurant_performance refreshed CONCURRENTLY: % rows in %',
                 v_rows, (clock_timestamp() - v_started); --prints for the user
    RETURN v_rows;
END;
$fn$;

COMMENT ON FUNCTION fn_refresh_restaurant_performance() IS
    'REFRESH MATERIALIZED VIEW CONCURRENTLY, as a FUNCTION per the brief. Runs inside the caller transaction; see sp_refresh_restaurant_performance() for the standalone form.';

