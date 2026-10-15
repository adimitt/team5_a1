import { Router } from "express";
import { query } from "../db/postgres.js";

const router = Router();

router.get("/revenue", async (req, res, next) => {
  try {
    const r = await query(`
      WITH daily AS (
        SELECT o.restaurant_id, o.created_at::date AS d, SUM(o.total_amount) AS revenue, COUNT(*) AS order_count
        FROM orders o
        WHERE o.status='DELIVERED'
          AND o.created_at >= CURRENT_DATE - INTERVAL '90 days'
          AND o.created_at < CURRENT_DATE + INTERVAL '1 day'
        GROUP BY o.restaurant_id, o.created_at::date
      ),
      top5 AS (
        SELECT restaurant_id FROM daily GROUP BY restaurant_id ORDER BY SUM(revenue) DESC LIMIT 5
      ),
      calendar AS (
        SELECT t.restaurant_id, gs::date AS d
        FROM top5 t CROSS JOIN LATERAL generate_series(CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE, INTERVAL '1 day') gs
      ),
      filled AS (
        SELECT c.restaurant_id,c.d,COALESCE(d.revenue,0) AS revenue
        FROM calendar c LEFT JOIN daily d ON d.restaurant_id=c.restaurant_id AND d.d=c.d
      )
      SELECT f.d AS business_date, f.restaurant_id, r.name AS restaurant, r.city,
             ROUND(f.revenue::numeric,2) AS revenue_today,
             ROUND(AVG(f.revenue) OVER (
               PARTITION BY f.restaurant_id ORDER BY f.d
               RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
             )::numeric,2) AS ma7_revenue
      FROM filled f JOIN restaurants r ON r.id=f.restaurant_id
      WHERE f.d >= CURRENT_DATE - 14
      ORDER BY f.d, r.name
    `);
    res.json({ data: r.rows });
  } catch (e) { next(e); }
});

router.get("/rankings", async (req, res, next) => {
  try {
    const r = await query(`
      WITH daily AS (
        SELECT o.restaurant_id,o.created_at::date AS d,SUM(o.total_amount) AS revenue,COUNT(*) AS order_count
        FROM orders o
        WHERE o.status='DELIVERED'
          AND o.created_at >= CURRENT_DATE - INTERVAL '90 days'
          AND o.created_at < CURRENT_DATE + INTERVAL '1 day'
        GROUP BY o.restaurant_id,o.created_at::date
      ),
      calendar AS (
        SELECT dr.restaurant_id,gs::date AS d
        FROM (SELECT DISTINCT restaurant_id FROM daily) dr
        CROSS JOIN LATERAL generate_series(CURRENT_DATE - INTERVAL '90 days',CURRENT_DATE,INTERVAL '1 day') gs
      ),
      filled AS (
        SELECT c.restaurant_id,c.d,COALESCE(dl.revenue,0) AS revenue,COALESCE(dl.order_count,0) AS order_count
        FROM calendar c LEFT JOIN daily dl ON dl.restaurant_id=c.restaurant_id AND dl.d=c.d
      ),
      windowed AS (
        SELECT f.*,
          AVG(f.revenue) OVER w7 AS ma7_revenue,
          SUM(f.order_count) OVER w7 AS orders_last_7d
        FROM filled f
        WINDOW w7 AS (
          PARTITION BY f.restaurant_id ORDER BY f.d
          RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
        )
      )
      SELECT w.d AS business_date,w.restaurant_id,r.name AS restaurant,r.city,
             ROUND(w.revenue::numeric,2) AS revenue_today,
             ROUND(w.ma7_revenue::numeric,2) AS ma7_revenue,w.orders_last_7d,
             DENSE_RANK() OVER (PARTITION BY w.d ORDER BY w.ma7_revenue DESC) AS rank_by_ma7
      FROM windowed w JOIN restaurants r ON r.id=w.restaurant_id
      WHERE w.d=CURRENT_DATE-1
      ORDER BY rank_by_ma7,w.restaurant_id
      LIMIT 20
    `);
    res.json({ data: r.rows });
  } catch (e) { next(e); }
});

router.get("/summary", async (req, res, next) => {
  try {
    const r = await query(`
      SELECT restaurant_id,name,city,is_active,completed_orders,total_revenue,avg_order_value,last_order_at
      FROM mv_restaurant_performance
      ORDER BY total_revenue DESC LIMIT 20
    `);
    const refreshed = await query(`SELECT MAX(last_order_at) AS last_order_at FROM mv_restaurant_performance`);
    res.json({ data: r.rows, last_order_at: refreshed.rows[0]?.last_order_at || null });
  } catch (e) { next(e); }
});

router.post("/summary/refresh", async (req, res, next) => {
  try {
    await query("CALL sp_refresh_restaurant_performance()");
    res.json({ ok: true, message: "Restaurant performance materialized view refreshed." });
  } catch (e) { next(e); }
});

export default router;
