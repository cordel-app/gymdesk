import { db, Tx } from '../infra/db';
import { AffectedBeneficiary, PayerChangeBlock, payerChangeBlock } from '../domain/familyPayerChange';

type Q = Pick<Tx, 'query'> | typeof db;

/**
 * Checks a family change before it is applied. `newPayers` maps each beneficiary whose payer
 * moves to the member who will pay for them afterwards; members whose payer stays the same
 * are left out by the caller. Same notion of "owed" as `loadCardRemovalBlock()`: a scheduled
 * event, or a failed one with no completed attempt, of the beneficiary's active ProductSet.
 */
export async function checkFamilyPayerChange(
  q: Q,
  gymId: string,
  newPayers: Map<number, number>,
): Promise<PayerChangeBlock | null> {
  if (newPayers.size === 0) return null;
  const affected: AffectedBeneficiary[] = [];
  for (const [memberId, newPayerMemberId] of newPayers) {
    const { rows: owed } = await q.query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM billing_events be JOIN product_sets ps ON ps.id = be.product_set_id
        WHERE be.gym_id = ? AND ps.owner_member_id = ? AND ps.status = 'active'
          AND (be.is_scheduled = 1 OR (be.event_type = 'failed_billing'
               AND NOT EXISTS (SELECT 1 FROM payment_requests pr
                                WHERE pr.billing_event_id = be.id AND pr.status = 'completed')))`,
      [gymId, memberId]);
    const { rows: pending } = await q.query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM payment_requests pr JOIN billing_events be ON be.id = pr.billing_event_id
        WHERE pr.gym_id = ? AND be.member_id = ? AND pr.status = 'pending'`,
      [gymId, memberId]);
    const { rows: cards } = await q.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM payment_methods WHERE gym_id = ? AND member_id = ?', [gymId, newPayerMemberId]);
    affected.push({
      memberId,
      newPayerMemberId,
      hasObligations: Number(owed[0]?.n ?? 0) > 0,
      paymentInFlight: Number(pending[0]?.n ?? 0) > 0,
      newPayerHasCard: Number(cards[0]?.n ?? 0) > 0,
    });
  }
  return payerChangeBlock(affected);
}
