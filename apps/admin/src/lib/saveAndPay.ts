/**
 * #1108 stage 2 — what the Member-level **Save & Pay** action area says, and
 * when it says it.
 *
 * The one place that decides the state the action area is in: the labels are
 * locale **keys** and the money is already resolved by the server, so this module
 * resolves no `t()`, computes no amount and names no endpoint — the component
 * beside it draws and the page owns the request. It is the split
 * `lib/memberPayments.ts` / `MemberPaymentsCard.tsx` uses one app over (#1123),
 * for the same reason: the rule is assertable with no DOM.
 *
 * §7 puts this in the general Member window rather than inside the Membership
 * Plans section, which is why it is a module of its own and not a branch inside
 * the Assigned Plan card: a card that renders one assignment cannot be the place
 * a Member-level action lives, and the Assigned Plan card's own `⋮ → Activate`
 * is gone with stage 1's placeholder.
 */

/** The assignment the action area is about, as the server reports it. */
export interface SaveAndPayAssignment {
  id: number;
  /** `draft` or `pending_payment` — the route answers nothing else. */
  status: string;
  plan_name: string | null;
  /** What Save & Pay will charge now, VAT-inclusive euros. `0` is a real answer. */
  amount_due: number;
  currency: string;
}

/** The outstanding charge of a locked assignment. */
export interface SaveAndPayPayment {
  id: number;
  status: string;
  amount: number;
  created_at: string;
  /** `null` once the hosted page's token can no longer be opened (#789). */
  checkout_url: string | null;
}

/** `GET /user-memberships/member/:memberId/save-and-pay`. */
export interface SaveAndPayState {
  assignment: SaveAndPayAssignment | null;
  payment?: SaveAndPayPayment | null;
}

export const DRAFT_STATUS = 'draft';
export const PENDING_PAYMENT_STATUS = 'pending_payment';

/**
 * What the action area offers.
 *
 *  * `none` — the Member has nothing waiting to be committed, so the area is
 *    absent rather than empty: a row of buttons that can do nothing is the thing
 *    #1073's rule refuses one layer over.
 *  * `commit` — a Draft. The primary action is **Save & Pay**, and §6 is explicit
 *    that it is not called *Save*.
 *  * `awaiting` — already locked. The configuration cannot move, so the primary
 *    action is a fresh payment link rather than a second commit: the hosted page's
 *    token lives ten minutes, so an abandoned checkout is the ordinary case and a
 *    Pending Payment nobody could re-charge would be a membership nobody can
 *    rescue.
 */
export type SaveAndPayMode = 'none' | 'commit' | 'awaiting';

export function saveAndPayMode(state: SaveAndPayState | null): SaveAndPayMode {
  const status = state?.assignment?.status;
  if (status === DRAFT_STATUS) return 'commit';
  if (status === PENDING_PAYMENT_STATUS) return 'awaiting';
  return 'none';
}

/** The primary button's locale key, in the `members` namespace. */
export function saveAndPayActionKey(mode: SaveAndPayMode): string | null {
  if (mode === 'commit') return 'save_and_pay';
  if (mode === 'awaiting') return 'save_and_pay_new_link';
  return null;
}

/** The sentence above it, which says what committing will do. */
export function saveAndPayNoticeKey(mode: SaveAndPayMode): string | null {
  if (mode === 'commit') return 'save_and_pay_draft_notice';
  if (mode === 'awaiting') return 'save_and_pay_awaiting_notice';
  return null;
}

/**
 * Is there a charge to make at all?
 *
 * A first cycle that owes nothing — a Free Period, a Promotion that waives the
 * first months — is committed outright by the server with no payment raised, and
 * the caption says so rather than quoting €0.00 as a price somebody has to pay.
 */
export function saveAndPayChargesNothing(assignment: SaveAndPayAssignment | null): boolean {
  return assignment != null && !(Number(assignment.amount_due) > 0);
}

/**
 * The amount, formatted, or `null` when there is nothing to charge.
 *
 * Euros from the server, formatted and never derived: no tax arithmetic and no
 * second rounding in a page (#817's rule).
 */
export function formatSaveAndPayAmount(
  amount: number | null | undefined, locale?: string,
): string | null {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' })
    .format(Number(amount));
}

/**
 * Is this outstanding charge still payable from the link we hold?
 *
 * The server already answers `checkout_url: null` for a token that cannot be
 * opened, so this is only the question of whether to render the link at all —
 * never a second expiry rule in the browser.
 */
export function hasOpenableCheckout(payment: SaveAndPayPayment | null | undefined): boolean {
  return payment?.checkout_url != null && payment.checkout_url !== '';
}
