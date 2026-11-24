/**
 * #3284 stage 2 — the SQL half of the staff Initial Payment waive: the one reader and the one writer
 * of `initial_payment_waivers`. What a line's identity is and whether it may be waived is
 * `domain/initialPaymentWaiver.ts`; this only stores and reads the waived line keys of a Product
 * Set's cart (`product_sets.purchase_id`, #3251).
 */
import type { Tx } from '../infra/db';

type Exec = { query: Tx['query'] };

/** The waived line keys of the cart the Product Set belongs to; empty for a set no cart holds. */
export async function loadInitialPaymentWaivers(exec: Exec, gymId: string, productSetId: number): Promise<Set<string>> {
  const { rows } = await exec.query<{ line_key: string }>(
    `SELECT w.line_key FROM initial_payment_waivers w
       JOIN product_sets ps ON ps.purchase_id = w.purchase_id AND ps.gym_id = w.gym_id
      WHERE ps.id = ? AND ps.gym_id = ?`,
    [productSetId, gymId]);
  return new Set(rows.map((r) => String(r.line_key)));
}

export async function insertInitialPaymentWaiver(tx: Tx, gymId: string, purchaseId: number, lineKey: string): Promise<void> {
  await tx.query(
    'INSERT IGNORE INTO initial_payment_waivers (gym_id, purchase_id, line_key) VALUES (?, ?, ?)',
    [gymId, purchaseId, lineKey]);
}

/** Removes a waiver; `false` when the line was not waived. */
export async function deleteInitialPaymentWaiver(tx: Tx, gymId: string, purchaseId: number, lineKey: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    'DELETE FROM initial_payment_waivers WHERE gym_id = ? AND purchase_id = ? AND line_key = ?',
    [gymId, purchaseId, lineKey]);
  return rowCount > 0;
}
