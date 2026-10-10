/**
 * #1325 — the development billing reset: what it deletes, in what order, and
 * when it may run.
 *
 * Pure. `api/src/scripts/reset-dev-billing.ts` is the I/O half. The reset exists
 * because the development database is full of test assignments and ledger rows
 * that predate the ProductSet model (#1325 §8, decisions Q6/Q7): they are
 * deleted, not backfilled. It is **never** a migration, a route or a UI button,
 * and it must not be able to run against a database that is not the development
 * one — which is what `evaluateResetGuard()` decides.
 *
 * The list below is the one the ticket's participants confirmed
 * (https://github.com/cordel-app/gymdesk/issues/1325, 2026-10-10). A table
 * outside it is preserved by construction: members, Membership Plans and their
 * prices/benefits, Promotions, Products, tax rates, charge types, stored cards,
 * `receipt_sequences`, gyms, centers and every catalogue.
 */

export interface ResetStep {
  /** Table to empty. Fixed identifiers only — never built from input. */
  table: string;
  /** Why this table is in the reset, for the printed report. */
  reason: string;
  /** Skipped when the table does not exist yet (it is created by a later PR). */
  optional?: boolean;
}

/** Children before parents, so no statement depends on a cascade. */
export const RESET_STEPS: readonly ResetStep[] = [
  { table: 'billing_event_lines', reason: 'child of billing_events', optional: true },
  { table: 'member_product_promotions', reason: 'child of member_products' },
  { table: 'member_products', reason: 'purchases hang from the payments being deleted' },
  { table: 'payment_requests', reason: 'would survive with no billing event (all sources, card_update included)' },
  { table: 'billing_events', reason: 'the ledger being reset' },
  { table: 'user_membership_promotion_oneoff_snapshot', reason: 'child of applied promotions' },
  { table: 'user_membership_promotion_periodical_snapshot', reason: 'child of applied promotions' },
  { table: 'user_membership_promotion_session_snapshot', reason: 'child of applied promotions' },
  { table: 'user_membership_promotions', reason: 'applied promotions of the assignments' },
  { table: 'user_membership_session', reason: 'assignment benefit rows' },
  { table: 'user_membership_oneoff', reason: 'assignment benefit rows' },
  { table: 'user_membership_periodical', reason: 'assignment benefit rows' },
  { table: 'user_membership_services', reason: 'assignment service rows' },
  { table: 'user_membership_members', reason: 'family coverage of the assignments' },
  { table: 'user_memberships', reason: 'the assigned Membership Plans' },
  { table: 'product_set_members', reason: 'ProductSet rows created since PR 1', optional: true },
  { table: 'product_set_plan_snapshots', reason: 'ProductSet rows created since PR 1', optional: true },
  { table: 'product_set_schedules', reason: 'ProductSet rows created since PR 1', optional: true },
  { table: 'product_sets', reason: 'ProductSet rows created since PR 1', optional: true },
];

/**
 * `audit_logs.entity_type` values that name a row of a table above. Their audit
 * rows are deleted with the entities (the ticket's participants asked for it):
 * an audit row whose subject no longer exists resolves to nothing and only
 * clutters the Audit Log. Catalogue types (`membership_plan`, `promotion`,
 * `product`, …) are NOT in this list — those rows describe records that stay.
 */
export const RESET_AUDIT_ENTITY_TYPES: readonly string[] = [
  'user_membership',
  'billing_event',
  'payment_request',
  'member_product',
  'product_set',
];

export const RESET_CONFIRMATION = 'DELETE-DEV-BILLING-DATA';

export interface ResetGuardInput {
  /** The host the script is connected to (`CORDEL_FITNESS_DB_HOST`). */
  connectedHost: string | undefined;
  /** The `RESET_CONFIRM` environment value. */
  confirmation: string | undefined;
  /** `true` reports counts and deletes nothing. */
  dryRun: boolean;
}

export type ResetGuardResult = { allowed: true } | { allowed: false; reason: string };

/**
 * May the reset delete rows? A dry run only counts and is always allowed. A real
 * run needs the target database identified and the explicit confirmation
 * string. Which database it can reach is the *caller's* binding, not a variable
 * this module reads: the workflow is bound to the GitHub environment `dev`
 * (whose secrets are the only credentials it has), and a local run reaches only
 * the database in the shell's own environment. Anything missing fails closed.
 */
export function evaluateResetGuard(input: ResetGuardInput): ResetGuardResult {
  if (input.dryRun) return { allowed: true };
  if (!input.connectedHost || !input.connectedHost.trim()) {
    return { allowed: false, reason: 'CORDEL_FITNESS_DB_HOST is not set; the target database cannot be identified.' };
  }
  if (input.confirmation !== RESET_CONFIRMATION) {
    return { allowed: false, reason: `RESET_CONFIRM must equal ${RESET_CONFIRMATION}; refusing to delete.` };
  }
  return { allowed: true };
}
