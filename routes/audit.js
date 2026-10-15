import { Router } from "express";
import { query } from "../db/postgres.js";

const router = Router();

router.get("/users/:id/audit", async (req, res, next) => {
  try {
    const params = [req.params.id];
    let dateFilter = "";
    if (req.query.from) { params.push(req.query.from); dateFilter += ` AND "timestamp" >= $${params.length}::date`; }
    if (req.query.to) { params.push(req.query.to); dateFilter += ` AND "timestamp" < ($${params.length}::date + INTERVAL '1 day')`; }

    const r = await query(
      `SELECT id,user_id,amount_changed,action_type,balance_after,"timestamp"
       FROM wallet_audit_logs
       WHERE user_id=$1 ${dateFilter}
       ORDER BY "timestamp" ASC, id ASC`, params
    );
    res.json({ data: r.rows });
  } catch (e) { next(e); }
});

export default router;
