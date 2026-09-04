\echo '=== 06_window_analytics.sql : Workflow 2, window analytics ==='

\echo ''
\echo '--- Q1: top 20 restaurants by 7-day moving average revenue (latest complete day)'

WITH daily AS (

    SELECT --take restaurant ids from orders table which are delivered
        o.restaurant_id,
        o.created_at::date        AS d,
        SUM(o.total_amount)       AS revenue,
        COUNT(*)                  AS order_count
    FROM orders o
    WHERE o.status = 'DELIVERED'
      AND o.created_at >= CURRENT_DATE - INTERVAL '90 days' --orders from 90 days are included
      AND o.created_at <  CURRENT_DATE + INTERVAL '1 day'
    GROUP BY o.restaurant_id, o.created_at::date -- count of orders delivered per each restaurant will be stored
),
calendar AS (
    SELECT dr.restaurant_id, gs::date AS d
    FROM (SELECT DISTINCT restaurant_id FROM daily) dr
    CROSS JOIN LATERAL generate_series(
        CURRENT_DATE - INTERVAL '90 days',
        CURRENT_DATE,
        INTERVAL '1 day'
    ) AS gs
),
filled AS (
    SELECT
        c.restaurant_id,
        c.d,
        COALESCE(dl.revenue, 0)     AS revenue,
        COALESCE(dl.order_count, 0) AS order_count
    FROM calendar c
    LEFT JOIN daily dl
           ON dl.restaurant_id = c.restaurant_id
          AND dl.d             = c.d
),
windowed AS (
    SELECT
        f.restaurant_id,
        f.d,
        f.revenue,
        f.order_count,

        AVG(f.revenue)      OVER w7 AS ma7_revenue,
        SUM(f.order_count)  OVER w7 AS orders_last_7d,

        -- Cumulative revenue since the start of the window: an unbounded frame.
        SUM(f.revenue) OVER (PARTITION BY f.restaurant_id ORDER BY f.d
                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                                    AS running_total,

        LAG(f.revenue, 7)  OVER (PARTITION BY f.restaurant_id ORDER BY f.d)
                                    AS revenue_same_day_last_week
    FROM filled f
    WINDOW w7 AS (
        PARTITION BY f.restaurant_id
        ORDER BY f.d
        RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
    )
)
SELECT
    w.d                              AS business_date,
    w.restaurant_id,
    r.name                           AS restaurant,
    r.city,
    w.revenue                        AS revenue_today,
    ROUND(w.ma7_revenue, 2)          AS ma7_revenue,
    w.orders_last_7d,

    DENSE_RANK()   OVER (PARTITION BY w.d ORDER BY w.ma7_revenue DESC) AS rank_by_ma7,
    RANK()         OVER (PARTITION BY w.d ORDER BY w.ma7_revenue DESC) AS rank_gapped,
    ROUND((PERCENT_RANK() OVER (PARTITION BY w.d ORDER BY w.ma7_revenue))::numeric, 4)
                                                                      AS pct_rank
FROM windowed w
JOIN restaurants r ON r.id = w.restaurant_id
WHERE w.d = CURRENT_DATE - 1
ORDER BY rank_by_ma7, w.restaurant_id
LIMIT 20;


\echo ''
\echo '--- Q2: last 14 days of the 7-day moving average, top 5 vendors'

WITH daily AS (
    SELECT o.restaurant_id, o.created_at::date AS d, SUM(o.total_amount) AS revenue
    FROM orders o
    WHERE o.status = 'DELIVERED'
      AND o.created_at >= CURRENT_DATE - INTERVAL '90 days'
      AND o.created_at <  CURRENT_DATE + INTERVAL '1 day'
    GROUP BY 1, 2
),
top5 AS ( --calculate total revenue for every restaurant and picks the five highest
    SELECT restaurant_id
    FROM daily
    GROUP BY restaurant_id
    ORDER BY SUM(revenue) DESC
    LIMIT 5
),
calendar AS (
    SELECT t.restaurant_id, gs::date AS d
    FROM top5 t
    CROSS JOIN LATERAL generate_series(CURRENT_DATE - INTERVAL '90 days',
                                       CURRENT_DATE, INTERVAL '1 day') gs
),
filled AS ( -- fill missing revenue as 0
    SELECT c.restaurant_id, c.d, COALESCE(dl.revenue, 0) AS revenue
    FROM calendar c
    LEFT JOIN daily dl ON dl.restaurant_id = c.restaurant_id AND dl.d = c.d
)
SELECT
    f.d AS business_date,
    r.name AS restaurant,
    f.revenue AS revenue_today,
    ROUND(AVG(f.revenue) OVER (PARTITION BY f.restaurant_id ORDER BY f.d
                               RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW), 2)
        AS ma7_revenue
FROM filled f
JOIN restaurants r ON r.id = f.restaurant_id
WHERE f.d > CURRENT_DATE - 15
ORDER BY r.name, f.d;

\echo ''
\echo '--- Q3: week-over-week revenue momentum, best and worst movers'

WITH weekly AS (
    SELECT
        o.restaurant_id,
        date_trunc('week', o.created_at)::date AS week_start, --converts an exact timestamp into the beginning of it's week
        SUM(o.total_amount)                    AS revenue -- calculates total weekly revenue
    FROM orders o
    WHERE o.status = 'DELIVERED'
      AND o.created_at >= CURRENT_DATE - INTERVAL '90 days'
    GROUP BY 1, 2
),
momentum AS (
    SELECT
        w.restaurant_id,
        w.week_start,
        w.revenue,
        LAG(w.revenue) OVER (PARTITION BY w.restaurant_id ORDER BY w.week_start) 
            AS prev_week_revenue,
        NTILE(4) OVER (PARTITION BY w.week_start ORDER BY w.revenue DESC)
            AS revenue_quartile
    FROM weekly w
),
scored AS (
    SELECT
        m.*,
        CASE WHEN m.prev_week_revenue IS NULL OR m.prev_week_revenue = 0 THEN NULL
             ELSE ROUND(100.0 * (m.revenue - m.prev_week_revenue) / m.prev_week_revenue, 1)
        END AS wow_pct_change
    FROM momentum m
)
SELECT s.week_start, r.name AS restaurant, s.revenue,
       s.prev_week_revenue, s.wow_pct_change, s.revenue_quartile
FROM scored s
JOIN restaurants r ON r.id = s.restaurant_id
WHERE s.week_start = (SELECT MAX(week_start) FROM weekly) - 7   -- last complete week
  AND s.wow_pct_change IS NOT NULL
ORDER BY s.wow_pct_change DESC NULLS LAST
LIMIT 10; -- shows only top 10 retaurants

\echo ''
\echo '--- 06_window_analytics.sql complete (3 queries)'
