/**
 * #1459 — what a Billing Event payment action sends. JSX-free and decides
 * nothing about eligibility: whether an action is offered is the API's flag
 * (`can_pay_cash` / `can_pay_card` / `can_waive` / `first_payment`), and the
 * amount a confirmation shows is the event's own, never recomputed here.
 */

export type PaymentActionKind = 'cash' | 'card' | 'waive';

export interface ActionableRow {
  id: number;
  user_membership_id: number | null;
  /** The API's flag: this payment is a membership's first one, settled through its own route. */
  first_payment?: boolean;
}

export interface ActionRequest {
  path: string;
  body: Record<string, unknown>;
}

/**
 * The request an Accept sends. Cash and card settle through the same manual
 * route (a `method` says which — no online provider is ever called for either);
 * a first payment of a membership awaiting payment goes through that
 * membership's `record-payment`, which also activates it. No amount is sent:
 * the full outstanding amount is the server's.
 */
export function actionRequest(kind: PaymentActionKind, row: ActionableRow, input: { reason?: string } = {}): ActionRequest {
  if (kind === 'waive') {
    return { path: `/payments/billing-events/${row.id}/waive`, body: { reason: (input.reason ?? '').trim() } };
  }
  const method = kind === 'card' ? 'card_terminal' : 'cash';
  if (row.first_payment && row.user_membership_id != null) {
    return { path: `/user-memberships/${row.user_membership_id}/record-payment`, body: { method } };
  }
  return { path: `/payments/billing-events/${row.id}/manual-payment`, body: { method } };
}

/** Waiving needs a written reason; cash and card need nothing beyond Accept. */
export function canAccept(kind: PaymentActionKind, reason: string, busy: boolean): boolean {
  if (busy) return false;
  return kind === 'waive' ? reason.trim().length > 0 : true;
}
