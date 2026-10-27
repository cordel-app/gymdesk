/**
 * #2123 stage 4: when a family change would move who pays, it must not leave a billable
 * obligation without a payer who can be charged. Pure — the SQL half is
 * `api/family-payer-change.ts`.
 *
 * A change moves the payer of some beneficiaries (a new owner takes over every member, a
 * removed member pays for themself, a dissolved family returns each member to themself).
 * It is refused when
 *  - a payment of an affected beneficiary is in flight (its outcome is unknown, and the
 *    charge guard would otherwise see two payers for one obligation), or
 *  - an affected beneficiary has scheduled or owed obligations and their new payer has no
 *    stored card (the nightly run skips a card-less payer silently).
 * Nothing is transferred: stored cards and every historical row stay as they are.
 */
export type PayerChangeBlockCode = 'payment_in_flight' | 'payer_without_card';

export interface AffectedBeneficiary {
  memberId: number;
  newPayerMemberId: number;
  hasObligations: boolean;
  paymentInFlight: boolean;
  newPayerHasCard: boolean;
}

export interface PayerChangeBlock {
  code: PayerChangeBlockCode;
  memberIds: number[];
}

export function payerChangeBlock(affected: AffectedBeneficiary[]): PayerChangeBlock | null {
  const inFlight = affected.filter((a) => a.paymentInFlight).map((a) => a.memberId);
  if (inFlight.length > 0) return { code: 'payment_in_flight', memberIds: inFlight };
  const noCard = affected.filter((a) => a.hasObligations && !a.newPayerHasCard).map((a) => a.memberId);
  if (noCard.length > 0) return { code: 'payer_without_card', memberIds: noCard };
  return null;
}

export const PAYER_CHANGE_MESSAGES: Record<PayerChangeBlockCode, string> = {
  payment_in_flight: 'A payment for this family is still being processed; try again once it is settled',
  payer_without_card: 'The member who would become the payer has no stored card but has scheduled or unsettled charges',
};
