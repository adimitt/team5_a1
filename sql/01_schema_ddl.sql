-- 01_schema_ddl.sql -- BiteStream, Project 1
-- 4 tables, PK/FK and every CHECK constraint. Idempotent: drops before creating.
-- Run first. Nothing else in sql/ works until this succeeds.

\echo '=== 01_schema_ddl.sql : building relational schema ==='

-- -------------------------------------------------------------------------------------
-- 0. Clean slate.
-- -------------------------------------------------------------------------------------
DROP TABLE IF EXISTS orders             CASCADE;
DROP TABLE IF EXISTS wallet_audit_logs  CASCADE;
DROP TABLE IF EXISTS restaurants        CASCADE;
DROP TABLE IF EXISTS users              CASCADE;

-- users -- customers and their prepaid wallet
CREATE TABLE users (
    id              BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            VARCHAR(120)  NOT NULL,
    email           VARCHAR(160),
    wallet_balance  NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT ck_users_wallet_non_negative CHECK (wallet_balance >= 0.00),
    CONSTRAINT ck_users_name_not_blank      CHECK (length(btrim(name)) > 0)
);

COMMENT ON TABLE  users                IS 'BiteStream customers and their prepaid wallet balance.';
COMMENT ON COLUMN users.wallet_balance IS 'Exact decimal balance. CHECK >= 0 makes overdraft impossible at the storage layer.';


-- wallet_audit_logs -- append-only ledger, written only by the trigger
CREATE TABLE wallet_audit_logs (
    id              BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT        NOT NULL,
    amount_changed  NUMERIC(10,2) NOT NULL,
    action_type     VARCHAR(6)    NOT NULL,
    balance_after   NUMERIC(10,2) NOT NULL,
    "timestamp"     TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT fk_audit_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,

   
    CONSTRAINT ck_audit_amount_non_zero  CHECK (amount_changed <> 0),

    CONSTRAINT ck_audit_action_type      CHECK (action_type IN ('DEBIT','CREDIT')),


    CONSTRAINT ck_audit_balance_after    CHECK (balance_after >= 0.00),


    -- makes the DEBIT/CREDIT label impossible to falsify
    CONSTRAINT ck_audit_sign_matches_action CHECK (
        (action_type = 'CREDIT' AND amount_changed > 0) OR
        (action_type = 'DEBIT'  AND amount_changed < 0)
    )
);

COMMENT ON TABLE  wallet_audit_logs               IS 'Append-only ledger. Written exclusively by trg_wallet_audit; UPDATE/DELETE blocked in 03.';
COMMENT ON COLUMN wallet_audit_logs.amount_changed IS 'NEW.wallet_balance - OLD.wallet_balance. Signed: positive = CREDIT, negative = DEBIT.';
COMMENT ON COLUMN wallet_audit_logs.balance_after  IS 'NEW.wallet_balance, i.e. the balance once the change had been applied.';

-- restaurants -- vendors; lat/lon feed the MongoDB $geoNear search
CREATE TABLE restaurants (
    id         BIGINT           GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       VARCHAR(160)     NOT NULL,
    city       VARCHAR(80)      NOT NULL,
    latitude   DOUBLE PRECISION NOT NULL,
    longitude  DOUBLE PRECISION NOT NULL,
    is_active  BOOLEAN          NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ      NOT NULL DEFAULT now(),

    CONSTRAINT ck_rest_latitude  CHECK (latitude  BETWEEN  -90 AND  90),
    CONSTRAINT ck_rest_longitude CHECK (longitude BETWEEN -180 AND 180)
);

COMMENT ON TABLE restaurants IS 'Vendor list. latitude/longitude are the origin for the MongoDB $geoNear driver search.';

-- orders -- state machine: PREPARING -> DELIVERING -> DELIVERED
CREATE TABLE orders (
    id            BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT        NOT NULL,
    restaurant_id BIGINT        NOT NULL,
    total_amount  NUMERIC(10,2) NOT NULL,
    status        VARCHAR(12)   NOT NULL,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    delivered_at  TIMESTAMPTZ,

    CONSTRAINT fk_orders_user       FOREIGN KEY (user_id)       REFERENCES users(id),
    CONSTRAINT fk_orders_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),

    CONSTRAINT ck_orders_amount_positive CHECK (total_amount > 0),
    CONSTRAINT ck_orders_status          CHECK (status IN ('PREPARING','DELIVERING','DELIVERED')),
    -- a row cannot claim DELIVERED without recording when
    CONSTRAINT ck_orders_delivered_has_timestamp
        CHECK (status <> 'DELIVERED' OR delivered_at IS NOT NULL),
    CONSTRAINT ck_orders_delivered_after_created
        CHECK (delivered_at IS NULL OR delivered_at >= created_at)
);

COMMENT ON TABLE  orders        IS 'Order state machine: PREPARING -> DELIVERING -> DELIVERED.';
COMMENT ON COLUMN orders.status IS 'PREPARING and DELIVERING are the two ACTIVE states policed by idx_active_user_order.';

\echo '--- schema created: users, wallet_audit_logs, restaurants, orders'
