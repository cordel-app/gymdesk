import { Response, NextFunction } from 'express';
import { db } from './db';

/**
 * Inserts a row and returns it via a subsequent SELECT using the auto-increment insertId.
 * MySQL has no RETURNING clause — this is the standard substitute.
 */
export async function insertAndFetch<T = any>(
  insertSql: string,
  insertParams: any[],
  fetchSql: string,
  fetchParams: (id: number) => any[],
): Promise<T> {
  const { insertId } = await db.query(insertSql, insertParams);
  const { rows } = await db.query<T>(fetchSql, fetchParams(insertId));
  return rows[0];
}

/**
 * Handles a MySQL error inside an Express catch block.
 * Maps ER_DUP_ENTRY → 409 { error }; forwards everything else to next().
 */
export function handleDupEntry(
  err: any,
  res: Response,
  next: NextFunction,
  message: string,
): void {
  if (err.code === 'ER_DUP_ENTRY') {
    res.status(409).json({ error: message });
  } else {
    next(err);
  }
}

/**
 * Fetches a single row by id scoped to a gym.
 * Returns null when not found (let the caller return 404).
 * Pass `softDelete: true` for tables that have a deleted_at column so only
 * non-deleted rows are returned.
 */
export async function gymFetchOne<T = any>(
  table: string,
  id: string | number,
  gymId: string,
  opts: { softDelete?: boolean } = {},
): Promise<T | null> {
  const extra = opts.softDelete ? ' AND deleted_at IS NULL' : '';
  const { rows } = await db.query<T>(
    `SELECT * FROM ${table} WHERE id = ? AND gym_id = ?${extra}`,
    [id, gymId],
  );
  return rows[0] ?? null;
}
