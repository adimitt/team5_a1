-- Display on the terminal
\echo '=== 03_triggers_and_audit.sql : audit trigger + immutability guards ==='

CREATE OR REPLACE FUNCTION fn_log_wallet_change() --creates a function fn_log_wallet_change if it doesn't exist, or replaces it if it already exists
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public -- this controls where to look for database objects
AS $fn$ -- indicates start of the function body
BEGIN --starts procedural statements
    INSERT INTO wallet_audit_logs (user_id, amount_changed, action_type, balance_after)
    VALUES ( 
        NEW.id,
        NEW.wallet_balance - OLD.wallet_balance,
        CASE WHEN NEW.wallet_balance > OLD.wallet_balance THEN 'CREDIT' ELSE 'DEBIT' END,
        NEW.wallet_balance
    );

    RETURN NULL;   
END;
$fn$; --end of function body

COMMENT ON FUNCTION fn_log_wallet_change() IS
    'Writes one wallet_audit_logs row per changed users.wallet_balance. Fired by trg_wallet_audit.';


DROP TRIGGER IF EXISTS trg_wallet_audit ON users; --if trigger already exists remove it

CREATE TRIGGER trg_wallet_audit --trigger creation
    AFTER UPDATE OF wallet_balance ON users --gets triggered only if update of wallet_balance is performed
    FOR EACH ROW
    WHEN (OLD.wallet_balance IS DISTINCT FROM NEW.wallet_balance)
    EXECUTE FUNCTION fn_log_wallet_change();

REVOKE UPDATE, DELETE, TRUNCATE ON wallet_audit_logs FROM PUBLIC; -- removing permissions for update delete and truncate

CREATE OR REPLACE FUNCTION fn_block_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
    RAISE EXCEPTION
        'wallet_audit_logs is append-only: % is not permitted on this table', TG_OP
        USING ERRCODE = '42501',          -- insufficient_privilege
              HINT    = 'Correct a wallet by posting a compensating balance change; the trigger will log it.';
END;
$fn$;

COMMENT ON FUNCTION fn_block_audit_mutation() IS
    'Guard body shared by the row-level and statement-level immutability triggers.';

DROP TRIGGER IF EXISTS trg_audit_block_row_change ON wallet_audit_logs; --drop the trigger if it exists. 
CREATE TRIGGER trg_audit_block_row_change --Before updates or deletes are performed, this function is called
    BEFORE UPDATE OR DELETE ON wallet_audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION fn_block_audit_mutation();

DROP TRIGGER IF EXISTS trg_audit_block_truncate ON wallet_audit_logs;
CREATE TRIGGER trg_audit_block_truncate -- triggered before truncating and calls the block function
    BEFORE TRUNCATE ON wallet_audit_logs
    FOR EACH STATEMENT --because trigger is performed statement wise
    EXECUTE FUNCTION fn_block_audit_mutation();


DO $selftest$ --This block allows to execute procedural SQL without permanently creating a function
DECLARE
    v_user   BIGINT;
    v_rows   INT;
    v_before INT;
BEGIN
    INSERT INTO users (name, wallet_balance) VALUES ('trigger-selftest', 100.00)
        RETURNING id INTO v_user; --stores newly generated userID

    UPDATE users SET wallet_balance = wallet_balance + 250.00 WHERE id = v_user;  -- CREDIT
    UPDATE users SET wallet_balance = wallet_balance -  40.50 WHERE id = v_user;  -- DEBIT

    SELECT count(*) INTO v_rows FROM wallet_audit_logs WHERE user_id = v_user; --audit entries
    ASSERT v_rows = 2, format('expected 2 ledger rows, found %s', v_rows); --if it isn't exactly 2 audits, it fails

    PERFORM 1 FROM wallet_audit_logs --checking whether the CREDIT record exists
      WHERE user_id = v_user AND action_type = 'CREDIT'
        AND amount_changed = 250.00 AND balance_after = 350.00;
    ASSERT FOUND, 'CREDIT row missing or wrong';

    PERFORM 1 FROM wallet_audit_logs
      WHERE user_id = v_user AND action_type = 'DEBIT' --checking whether the DEBIT record exists
        AND amount_changed = -40.50 AND balance_after = 309.50;
    ASSERT FOUND, 'DEBIT row missing or wrong';

    -- checking if extra row is created when no operation is done
    SELECT count(*) INTO v_before FROM wallet_audit_logs WHERE user_id = v_user;
    UPDATE users SET wallet_balance = wallet_balance WHERE id = v_user;
    SELECT count(*) INTO v_rows   FROM wallet_audit_logs WHERE user_id = v_user;
    ASSERT v_rows = v_before, 'no-op wallet write incorrectly produced a ledger row';

    --the ledger rejects mutation even for the table owner
    BEGIN
        UPDATE wallet_audit_logs SET amount_changed = 0 WHERE user_id = v_user;
        RAISE EXCEPTION 'immutability guard did NOT fire';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;   -- expected
    END;

    RAISE NOTICE 'self-test passed: audit trigger, WHEN suppression and immutability all verified';
    RAISE EXCEPTION 'rollback-selftest';         -- undo everything this block did
EXCEPTION
    WHEN OTHERS THEN
        IF SQLERRM <> 'rollback-selftest' THEN RAISE; END IF;
END;
$selftest$;

\echo '--- trigger trg_wallet_audit + 2 immutability guards installed and self-tested'
