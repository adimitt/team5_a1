import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "bitestream",
  user: process.env.PGUSER || "bs",
  password: process.env.PGPASSWORD || "bs",
  max: 10
});

export async function query(text, params = []) {
  return pool.query(text, params);
}
