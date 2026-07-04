import mysql from 'mysql2/promise';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
  /** AUTO_INCREMENT id of the inserted row (0 for non-insert statements) */
  insertId: number;
}

// timezone 'Z': DATETIME columns are UTC by convention (docs/architecture.md)
// FOUND_ROWS: UPDATE rowCount counts matched rows (pg parity), not only changed rows
const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  timezone: 'Z',
  flags: ['+FOUND_ROWS'],
  connectionLimit: 10,
});

async function run<T = any>(
  executor: mysql.Pool | mysql.PoolConnection,
  sql: string,
  params: any[] = [],
): Promise<QueryResult<T>> {
  const [result] = await executor.execute(sql, params);
  if (Array.isArray(result)) {
    return { rows: result as T[], rowCount: result.length, insertId: 0 };
  }
  const header = result as mysql.ResultSetHeader;
  return { rows: [], rowCount: header.affectedRows, insertId: header.insertId };
}

export interface Tx {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
}

export const db = {
  query<T = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    return run<T>(pool, sql, params);
  },

  /** Runs fn inside a transaction on a single connection. */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn({ query: (sql, params) => run(conn, sql, params ?? []) });
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  end(): Promise<void> {
    return pool.end();
  },
};
