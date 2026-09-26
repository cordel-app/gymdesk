import { Tx } from '../infra/db';

/**
 * #114/#640/#787: allocation of a gapless receipt number for a Billing Event.
 *
 * Extracted from `POST /payments/:id/receipt` when #787 gave the nightly
 * billing run a second reason to issue one. The sequence is per gym and per
 * calendar year (`receipt_sequences`), and the number it hands out is the
 * identity of a *factura simplificada* — so the two callers must not each keep
 * their own copy of the arithmetic, and neither may allocate twice for the
 * same event.
 *
 * Gaplessness is what the transaction is for: the sequence bump and the stamp
 * on `billing_events` commit together, so a caller that rolls back gives the
 * number back rather than burning it. The caller owns the transaction, because
 * the run needs the allocation to sit in one it already has.
 */

export interface IssuedReceipt {
  receiptNumber: string;
  issuedAt: Date;
  /** False when the event already carried a number — nothing was allocated. */
  allocated: boolean;
}

/**
 * Returns the event's receipt number, allocating one on first call.
 *
 * Idempotent by design: the row is read `FOR UPDATE` before anything is
 * spent, so a second concurrent caller waits and then finds the number the
 * first one wrote instead of burning the next value in the sequence. Both the
 * on-demand route and the run rely on that — the run issues for an event it
 * has just created, but a retried request or a re-run must not produce a
 * second receipt for one payment.
 *
 * Throws when the event does not exist in this gym; callers check tenancy
 * first, so that is a programming error rather than a 404 path.
 */
export async function issueReceiptNumber(
  tx: Tx,
  gymId: string,
  billingEventId: number,
): Promise<IssuedReceipt> {
  const { rows: existing } = await tx.query<{ receipt_number: string | null; receipt_issued_at: Date | null }>(
    `SELECT receipt_number, receipt_issued_at FROM billing_events
      WHERE id = ? AND gym_id = ? FOR UPDATE`,
    [billingEventId, gymId],
  );
  if (existing.length === 0) {
    throw new Error(`Billing event ${billingEventId} not found in gym ${gymId}`);
  }
  if (existing[0].receipt_number) {
    return {
      receiptNumber: existing[0].receipt_number,
      issuedAt: new Date(existing[0].receipt_issued_at as any),
      allocated: false,
    };
  }

  // The year is the one the receipt is issued in, not the one the charge is
  // for: a January run settling a December cycle opens the new year's
  // sequence, which is what a gapless per-year series means.
  const year = new Date().getUTCFullYear();
  await tx.query(
    'INSERT IGNORE INTO receipt_sequences (gym_id, year, last_seq) VALUES (?, ?, 0)',
    [gymId, year],
  );
  await tx.query(
    'UPDATE receipt_sequences SET last_seq = last_seq + 1 WHERE gym_id = ? AND year = ?',
    [gymId, year],
  );
  const { rows: seqRows } = await tx.query<{ last_seq: number }>(
    'SELECT last_seq FROM receipt_sequences WHERE gym_id = ? AND year = ?',
    [gymId, year],
  );
  const receiptNumber = `${year}-${String(seqRows[0].last_seq).padStart(4, '0')}`;

  await tx.query(
    'UPDATE billing_events SET receipt_number = ?, receipt_issued_at = UTC_TIMESTAMP() WHERE id = ?',
    [receiptNumber, billingEventId],
  );
  // Read the stamp back rather than trusting the app clock: the PDF prints
  // this date and it has to be the one the ledger row carries.
  const { rows: stamped } = await tx.query<{ receipt_issued_at: Date }>(
    'SELECT receipt_issued_at FROM billing_events WHERE id = ?',
    [billingEventId],
  );

  return { receiptNumber, issuedAt: new Date(stamped[0].receipt_issued_at as any), allocated: true };
}
