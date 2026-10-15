import { Router } from "express";
import { query } from "../db/postgres.js";

const router = Router();

function pageArgs(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(5, Number(req.query.limit || 20)));
  return { page, limit, offset: (page - 1) * limit };
}

router.get("/restaurants", async (req, res, next) => {
  try {
    const { page, limit, offset } = pageArgs(req);
    const q = String(req.query.q || "").trim();
    const active = req.query.active;
    const where = [];
    const params = [];
    if (q) { params.push(`%${q}%`); where.push(`(name ILIKE $${params.length} OR city ILIKE $${params.length})`); }
    if (active === "true" || active === "false") { params.push(active === "true"); where.push(`is_active = $${params.length}`); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await query(`SELECT COUNT(*)::int AS count FROM restaurants ${w}`, params);
    const rows = await query(
      `SELECT id, name, city, latitude, longitude, is_active, created_at
       FROM restaurants ${w} ORDER BY id LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows.rows, page, limit, total: count.rows[0].count });
  } catch (e) { next(e); }
});

router.get("/restaurants/:id", async (req, res, next) => {
  try {
    const r = await query("SELECT * FROM restaurants WHERE id=$1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Restaurant not found" });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.get("/users", async (req, res, next) => {
  try {
    const { page, limit, offset } = pageArgs(req);
    const q = String(req.query.q || "").trim();
    const params = [];
    let w = "";
    if (q) {
      params.push(`%${q}%`);
      w = `WHERE name ILIKE $1 OR email ILIKE $1`;
    }
    const count = await query(`SELECT COUNT(*)::int AS count FROM users ${w}`, params);
    const rows = await query(
      `SELECT id, name, email, wallet_balance, created_at FROM users ${w}
       ORDER BY id LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows.rows, page, limit, total: count.rows[0].count });
  } catch (e) { next(e); }
});

router.get("/users/:id", async (req, res, next) => {
  try {
    const r = await query("SELECT id,name,email,wallet_balance,created_at FROM users WHERE id=$1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "User not found" });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.get("/orders", async (req, res, next) => {
  try {
    const { page, limit, offset } = pageArgs(req);
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    const params = [];
    const where = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(o.id::text ILIKE $${params.length} OR u.name ILIKE $${params.length} OR r.name ILIKE $${params.length})`);
    }
    if (["PREPARING","DELIVERING","DELIVERED"].includes(status)) {
      params.push(status); where.push(`o.status = $${params.length}`);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await query(
      `SELECT COUNT(*)::int AS count FROM orders o JOIN users u ON u.id=o.user_id JOIN restaurants r ON r.id=o.restaurant_id ${w}`,
      params
    );
    const rows = await query(
      `SELECT o.id, o.user_id, u.name AS user_name, o.restaurant_id, r.name AS restaurant_name,
              o.total_amount, o.status, o.created_at, o.delivered_at
       FROM orders o JOIN users u ON u.id=o.user_id JOIN restaurants r ON r.id=o.restaurant_id
       ${w} ORDER BY o.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows.rows, page, limit, total: count.rows[0].count });
  } catch (e) { next(e); }
});

router.get("/orders/:id", async (req, res, next) => {
  try {
    const r = await query(
      `SELECT o.*, u.name AS user_name, u.wallet_balance, r.name AS restaurant_name, r.city
       FROM orders o JOIN users u ON u.id=o.user_id JOIN restaurants r ON r.id=o.restaurant_id
       WHERE o.id=$1`, [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Order not found" });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

export default router;
