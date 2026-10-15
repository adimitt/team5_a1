import { Router } from "express";
import { query } from "../db/postgres.js";

const router = Router();

router.post("/checkout", async (req, res, next) => {
  try {
    const userId = Number(req.body.user_id);
    const restaurantId = Number(req.body.restaurant_id);
    const amount = Number(req.body.amount);
    if (!Number.isInteger(userId) || !Number.isInteger(restaurantId) || !Number.isFinite(amount)) {
      return res.status(400).json({ error: "Choose a valid user, restaurant and amount." });
    }

    const before = await query("SELECT id,name,wallet_balance FROM users WHERE id=$1", [userId]);
    if (!before.rowCount) return res.status(404).json({ error: "User not found." });
    const balanceBefore = Number(before.rows[0].wallet_balance);

    // The database procedure owns the atomic checkout and all business rules.
    const result = await query(
      "CALL sp_execute_checkout($1, $2, $3, NULL, NULL)",
      [userId, restaurantId, amount]
    );
    const callRow = result.rows[0] || {};
    const status = callRow.p_status || callRow.status || "ERROR";
    const orderId = callRow.p_order_id ?? null;

    const after = await query("SELECT id,name,wallet_balance FROM users WHERE id=$1", [userId]);
    const balanceAfter = Number(after.rows[0].wallet_balance);

    let audit = null;
    if (balanceAfter !== balanceBefore) {
      const a = await query(
        `SELECT id,user_id,amount_changed,action_type,balance_after,"timestamp"
         FROM wallet_audit_logs WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [userId]
      );
      audit = a.rows[0] || null;
    }

    const messages = {
      OK: "Checkout completed successfully.",
      INSUFFICIENT_FUNDS: "Checkout failed: the wallet does not have enough balance.",
      ACTIVE_ORDER_EXISTS: "Checkout failed: this user already has an active order.",
      BAD_REFERENCE: "Checkout failed: the selected restaurant or user is invalid.",
      AMOUNT_INVALID: "Checkout failed: amount must be positive.",
      USER_NOT_FOUND: "Checkout failed: user does not exist.",
      RETRY: "Checkout was rolled back because of a serialization conflict. Please retry."
    };

    res.json({
      ok: status === "OK",
      status,
      message: messages[status] || "Checkout failed and was rolled back.",
      order_id: orderId,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      audit
    });
  } catch (e) { next(e); }
});

router.post("/orders/:id/advance", async (req, res, next) => {
  try {
    await query("CALL sp_advance_order_status($1)", [req.params.id]);
    const r = await query(
      `SELECT o.id,o.status,o.delivered_at,u.name AS user_name,r.name AS restaurant_name
       FROM orders o JOIN users u ON u.id=o.user_id JOIN restaurants r ON r.id=o.restaurant_id
       WHERE o.id=$1`, [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Order not found." });
    res.json({ message: "Order status advanced.", order: r.rows[0] });
  } catch (e) { next(e); }
});

export default router;
