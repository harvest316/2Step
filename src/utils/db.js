/**
 * Database Utilities — PostgreSQL (pg.Pool)
 *
 * Single `mmo` database with schemas:
 *   twostep — 2Step application data (sites, videos, keywords, etc.)
 *   msgs    — shared cross-project (messages, opt_outs, pricing, suppression)
 *
 * Schema-prefixed queries (msgs.messages, msgs.opt_outs) work unchanged —
 * search_path resolves unqualified names to twostep first.
 *
 * Environment variables:
 *   DATABASE_URL       — PostgreSQL connection string (e.g. postgresql:///mmo)
 *   PG_SEARCH_PATH     — schema search path (default: twostep, msgs)
 *   PG_POOL_MAX        — max pool connections (default: 10)
 *   PGHOST, PGDATABASE, PGUSER, PG_PASSWORD — fallback individual vars
 */

import pg from 'pg';

let pool;

/**
 * Validate search_path schemas against injection.
 * SET doesn't support parameterised values, so we whitelist identifiers.
 */
function validateSearchPath(path) {
  const schemas = path.split(',').map(s => s.trim());
  const valid = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  for (const s of schemas) {
    if (!valid.test(s)) throw new Error(`Invalid schema name in PG_SEARCH_PATH: "${s}"`);
  }
  return schemas.join(', ');
}

/**
 * Get or create the shared connection pool.
 * @returns {pg.Pool}
 */
export function getPool() {
  if (!pool) {
    const poolMax = parseInt(process.env.PG_POOL_MAX || '10', 10);

    const poolConfig = {
      max: poolMax,
      idleTimeoutMillis: 300_000,     // 5 min — long-running pipeline processes
      connectionTimeoutMillis: 5_000,
    };

    if (process.env.DATABASE_URL) {
      poolConfig.connectionString = process.env.DATABASE_URL;
    } else {
      poolConfig.host = process.env.PGHOST || '/run/postgresql';
      poolConfig.database = process.env.PGDATABASE || 'mmo';
      poolConfig.user = process.env.PGUSER || 'jason';
      if (process.env.PG_PASSWORD) poolConfig.password = process.env.PG_PASSWORD;
    }

    pool = new pg.Pool(poolConfig);

    const searchPath = validateSearchPath(
      process.env.PG_SEARCH_PATH || 'twostep, msgs'
    );

    pool.on('connect', (client) => {
      client.query(`SET search_path TO ${searchPath}, public`);
      client.query('SET timezone TO \'UTC\'');
      client.query('SET statement_timeout = 30000');
    });

    // Prevent process crash on idle client errors
    pool.on('error', (err) => {
      console.error('[db] Pool error on idle client:', err.message);
    });
  }
  return pool;
}

/**
 * Run a query and return the full pg Result.
 * @param {string} text — SQL with $1, $2 placeholders
 * @param {any[]} [params]
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  return await getPool().query(text, params);
}

/**
 * Run a SELECT and return the first row, or null.
 * @param {string} text
 * @param {any[]} [params]
 * @returns {Promise<object|null>}
 */
export async function getOne(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

/**
 * Run a SELECT and return all rows.
 * @param {string} text
 * @param {any[]} [params]
 * @returns {Promise<object[]>}
 */
export async function getAll(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

/**
 * Run an INSERT/UPDATE/DELETE and return { changes, lastInsertRowid }.
 * For INSERTs that need the new id, add RETURNING id to the SQL.
 * @param {string} text
 * @param {any[]} [params]
 * @returns {Promise<{changes: number, lastInsertRowid: number|undefined}>}
 */
export async function run(text, params) {
  const { rowCount, rows } = await query(text, params);
  return { changes: rowCount, lastInsertRowid: rows[0]?.id };
}

/**
 * Execute a function inside a transaction.
 * The callback receives a dedicated client (not from the pool query shortcut).
 * On error, ROLLBACK is issued and the error re-thrown.
 *
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 30000');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    failed = true;
    try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
    throw e;
  } finally {
    // Destroy broken connections instead of returning them to pool
    client.release(failed);
  }
}

/**
 * Gracefully shut down the pool. Call from process exit handlers.
 * @returns {Promise<void>}
 */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export default {
  getPool,
  query,
  getOne,
  getAll,
  run,
  withTransaction,
  closePool,
};
