/**
 * #1108 stage 2 — the two statuses an Assigned Plan passes through before it is
 * the Member's, and which of them may still be configured.
 *
 * Stage 1 made a newly assigned plan a `draft` and gave it one explicit commit.
 * Stage 2 puts the payment in front of that commit, which the owner's Q1 answer
 * spells as a lifecycle rather than as a synchronous charge:
 *
 *   Draft -> Save & Pay -> Pending Payment -> Active
 *
 * The admin app cannot take a card — by design, so card data never reaches a
 * Gymdesk server — so "process the payment" is the hosted page the member opens
 * and the webhook that reports it. *Pending Payment* is the window between the
 * two, and it exists so that the one thing §6 calls "the point of no return" is
 * visible in the data: the configuration is locked from the moment Save & Pay
 * raises the charge, not from the moment the money lands.
 *
 * This module is the **pure** half — what the statuses are, which of them is
 * configurable, and the SQL fragment that excludes both — with
 * `api/src/api/assignment-commit.ts` as the I/O half that performs the
 * transition. The same split stage 1 used for `oneActivePlan`/`one-active-plan`,
 * for the same reason: the rule is assertable with no database.
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * **A Draft is configurable and a Pending Payment is not.** Both are
 * pre-activation and both are invisible wherever "does this member have a plan"
 * is asked, so most of the codebase wants them as a pair — but every editing
 * path wants them apart, which is why `isConfigurableAssignmentStatus()` exists
 * beside `isPreActivationStatus()` rather than callers testing for `'draft'`.
 * The editing allowlists (`SNAPSHOT_EDITABLE_STATUSES`, `ATTACHABLE_STATUSES`)
 * stay allowlists and simply do not name `pending_payment`, so the lock is the
 * absence of a grant rather than a second rule they each have to remember; what
 * needed saying explicitly is `PUT /user-memberships/:id`, which is not gated on
 * a status list at all.
 *
 * **Nothing goes back.** There is no `pending_payment -> draft`: unlocking a
 * configuration the member is already being asked to pay for would let the
 * amount on the hosted page stop matching the plan it buys. Staff get out of a
 * Pending Payment the way they get out of a Draft nobody commits — by closing
 * it (`CLOSEABLE_FROM`) — and a fresh Save & Pay is how an expired checkout link
 * is replaced, because re-raising the charge for the same locked configuration
 * is not a modification of it.
 *
 * **The commit still happens exactly once, in one place.** Save & Pay does not
 * activate anything: it locks, raises the charge and stops. The `-> active`
 * write is `commitAssignment()`'s alone, called by the webhook when the money
 * arrives, by Save & Pay itself when the first cycle owes nothing (a Plan sold
 * with a Free Period has no payment to wait for, and without this branch such a
 * plan could never be activated at all), and by `POST /:id/activate`.
 *
 * **A Draft that is never paid for cancels nothing.** #956's replacement is
 * therefore still part of the commit and not of Save & Pay (stage 1's rule,
 * unchanged): Save & Pay surfaces the 409 so staff see what committing will
 * cancel and have to confirm it, but the superseding UPDATE runs when the
 * transition does. A member who abandons the checkout page leaves their current
 * plan exactly as it was.
 */

/** The configuration state an assignment is created in (#1108 stage 1). */
export const DRAFT_ASSIGNMENT_STATUS = 'draft';

/** Committed and charged, waiting for the provider to confirm (#1108 stage 2). */
export const PENDING_PAYMENT_ASSIGNMENT_STATUS = 'pending_payment';

/**
 * Both states in front of activation. Neither is live, neither is bookable and
 * neither bills anything, so every "is this the member's plan" reader excludes
 * the pair.
 */
export const PRE_ACTIVATION_STATUSES = [
  DRAFT_ASSIGNMENT_STATUS,
  PENDING_PAYMENT_ASSIGNMENT_STATUS,
] as const;

export type PreActivationStatus = (typeof PRE_ACTIVATION_STATUSES)[number];

/** Is this one of the two states in front of activation? */
export function isPreActivationStatus(value: unknown): value is PreActivationStatus {
  return typeof value === 'string'
    && (PRE_ACTIVATION_STATUSES as readonly string[]).includes(value);
}

/**
 * May this assignment's configuration still be changed?
 *
 * True for a Draft and false for everything else *in front of activation* — an
 * `active` or `paused` assignment is editable under the snapshot rules (#635
 * §13–§17) and is not this question's business, so callers that mean "is the
 * configuration locked" ask `preActivationLockReason()` below.
 */
export function isConfigurableAssignmentStatus(value: unknown): boolean {
  return value === DRAFT_ASSIGNMENT_STATUS;
}

/**
 * Why this assignment may not be written to, or `null` when the status is not a
 * locked one. One sentence, in one place, so every refusal reads the same and
 * names the way out.
 */
export function preActivationLockReason(status: unknown): string | null {
  if (status !== PENDING_PAYMENT_ASSIGNMENT_STATUS) return null;
  return 'This membership is awaiting payment, so its configuration is locked. '
    + 'Close it to configure a different plan, or wait for the payment to be confirmed.';
}

/**
 * `um.status NOT IN ('draft','pending_payment')` — the pair excluded in SQL.
 *
 * A fragment with no bound parameters, because its two callers append it to
 * statements whose parameter lists are built elsewhere (`GET /members`'
 * enrollment subquery is interpolated into a larger SELECT, and the member's own
 * current-assignment read already carries its own two). The values are this
 * module's own constants rather than request input.
 */
export function excludePreActivationSql(alias = 'um'): string {
  const list = PRE_ACTIVATION_STATUSES.map((s) => `'${s}'`).join(', ');
  return `${alias}.status NOT IN (${list})`;
}
