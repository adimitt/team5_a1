
\echo '=== 04_stored_procedures.sql : Workflow 1, atomic checkout ==='

CREATE TABLE IF NOT EXISTS checkout_attempts (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, --creates unique id for every checkout attempt
    user_id       BIGINT,
    restaurant_id BIGINT,
    amount        NUMERIC(10,2), --stores checkout amount
    outcome       VARCHAR(32) NOT NULL,
    sqlstate_code VARCHAR(5),
    order_id      BIGINT,
    attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now() --stores when checkout was committed
);

COMMENT ON TABLE checkout_attempts IS
    'Durable outcome log. Written after COMMIT/ROLLBACK so failures survive their own rollback.';

CREATE OR REPLACE PROCEDURE sp_execute_checkout( --main checkout procedure
    IN    p_user_id       BIGINT, -- customer id input
    IN    p_restaurant_id BIGINT, --restaurant id input
    IN    p_amount        NUMERIC(10,2), --amount to charge
    INOUT p_order_id      BIGINT DEFAULT NULL,
    INOUT p_status        TEXT   DEFAULT NULL
)
LANGUAGE plpgsql
AS $sp$
DECLARE
    v_failed  BOOLEAN := FALSE; --indicates failure
    v_sqlstate VARCHAR(5) := NULL; --indicates error codes
BEGIN
    COMMIT;                                            -- close the implicit txn CALL opened
    SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;   -- ets transaction's isolation level

    p_order_id := NULL;

    BEGIN
        IF p_amount IS NULL OR p_amount <= 0 THEN --checking if amount is valid
            RAISE EXCEPTION 'amount must be a positive value, got %', p_amount
                USING ERRCODE = '22023';               -- invalid_parameter_value
        END IF;

        UPDATE users
           SET wallet_balance = wallet_balance - p_amount --updating amount
         WHERE id = p_user_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'no such user: %', p_user_id
                USING ERRCODE = 'P0002';               -- no_data_found
        END IF;

        -- inserting the order
        INSERT INTO orders (user_id, restaurant_id, total_amount, status)
        VALUES (p_user_id, p_restaurant_id, p_amount, 'PREPARING')
        RETURNING id INTO p_order_id; -- returning the order ID

        p_status := 'OK';

    EXCEPTION -- checking all the edge cases and raising exceptions
        WHEN check_violation THEN
            v_failed := TRUE; v_sqlstate := SQLSTATE;
            -- checking if wallet balance is negative
            p_status := CASE WHEN SQLERRM LIKE '%ck_users_wallet_non_negative%'
                             THEN 'INSUFFICIENT_FUNDS' ELSE 'CHECK_FAILED' END;

        WHEN unique_violation THEN
            v_failed := TRUE; v_sqlstate := SQLSTATE; p_status := 'ACTIVE_ORDER_EXISTS';

        WHEN foreign_key_violation THEN
            v_failed := TRUE; v_sqlstate := SQLSTATE; p_status := 'BAD_REFERENCE';

        WHEN serialization_failure THEN
            v_failed := TRUE; v_sqlstate := SQLSTATE; p_status := 'RETRY';

        WHEN invalid_parameter_value THEN
            v_failed := TRUE; v_sqlstate := SQLSTATE; p_status := 'AMOUNT_INVALID';

        WHEN no_data_found THEN
            v_failed := TRUE; v_sqlstate := SQLSTATE; p_status := 'USER_NOT_FOUND';

        WHEN OTHERS THEN
            v_failed := TRUE; v_sqlstate := SQLSTATE; p_status := 'ERROR:' || SQLERRM;
    END;

    IF v_failed THEN
        p_order_id := NULL;
        ROLLBACK;      -- discards the debit, the order AND the trigger's ledger row
    ELSE
        COMMIT;
    END IF;

    -- records the result for successful checkout
    INSERT INTO checkout_attempts (user_id, restaurant_id, amount, outcome, sqlstate_code, order_id)
    VALUES (p_user_id, p_restaurant_id, p_amount, p_status, v_sqlstate, p_order_id);
    COMMIT;
END;
$sp$;

COMMENT ON PROCEDURE sp_execute_checkout(BIGINT, BIGINT, NUMERIC, BIGINT, TEXT) IS
    'Workflow 1. REPEATABLE READ debit-and-order. Returns p_status; never leaves partial state.';


-- moving an order through it's life cycle
CREATE OR REPLACE PROCEDURE sp_advance_order_status(IN p_order_id BIGINT) -- p_order_id gives order ID
LANGUAGE plpgsql
AS $sp$
DECLARE v_status VARCHAR(12); -- stores current order status
BEGIN
    SELECT status INTO v_status FROM orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no such order: %', p_order_id USING ERRCODE = 'P0002';
    END IF;

    IF v_status = 'PREPARING' THEN
        UPDATE orders SET status = 'DELIVERING' WHERE id = p_order_id;
    ELSIF v_status = 'DELIVERING' THEN
        UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE id = p_order_id;
    END IF;   -- DELIVERED is terminal: no-op
END;
$sp$;

\echo '--- procedures created: sp_execute_checkout, sp_advance_order_status'
