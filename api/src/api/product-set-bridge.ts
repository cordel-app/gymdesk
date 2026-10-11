import { Tx } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { ASSIGNMENT_CADENCE } from './assigned-plan-snapshot';
import {
  activateWithEvents, allocateItemSchedules, ensureSchedule, materialiseScheduledEvents,
  replaceFutureScheduledEvents,
} from './product-set-configuration';
import { PLAN_SCHEDULE_KEY } from '../domain/scheduleAllocation';
import { DraftRefusal, LockedDraft, isRefusal, lockDraft } from './product-set-draft';
import { ensureInitialEvent, initialCharge, loadEditLock } from './product-set-checkout';
import { cancelInFlight, createDraft, submitForPayment as submitSetForPayment } from './product-sets';
import { linkedDraftSetFor } from './assignment-draft-set';
import { syncDraftAssignment } from './product-set-projection';
import type { BlockingEvent } from '../domain/billingEventEditLock';

/**
 * #1325 PR 5 / PR 3 — the bridge between the assignment screens and ProductSets.
 *
 * The Admin's Assigned Plan card, *Assign New Plan*, the Plans page's bulk
 * assign and the Memberships modal all create and edit **assignment-keyed**
 * configuration (`user_membership_id`). Rather than rewriting every one of those
 * screens at once, the server hands each of them over to ProductSets at the two
 * moments that matter (unconditionally since PR 3 — the `PRODUCT_SET_BILLING`
 * flag that gated this in PR 5 is gone, because the assignment pass it kept
 * alive is gone with it):
 *
 *  - **commit** (`commitAssignment()`): the assignment's frozen configuration is
 *    imported as the owner's next ProductSet version (`importAssignmentAsProductSet`),
 *    so from the moment a plan is active its obligations are the ProductSet's
 *    persisted events and the assignment pass no longer sees it;
 *  - **edit**: a configuration write on an assignment a ProductSet projects is
 *    applied as a **new version** of that set (`reconfigureProjected`) — never
 *    written to the assignment's rows, which the next projection would overwrite.
 *
 * It is removed with the assignment-keyed screens.
 */

const todayUtc = () => new Date().toISOString().slice(0, 10);
const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/* ── Copying a version's configuration onto its successor ────────────────── */

/** The configuration of `fromSetId`, copied onto `toSetId` (a fresh Draft). */
export async function cloneConfiguration(tx: Tx, gymId: string, fromSetId: number, toSetId: number): Promise<void> {
  await tx.query(
    `INSERT INTO product_set_plan_snapshots
       (gym_id, product_set_id, schedule_id, plan_price_id, base_price, discount_reason, discount_expires_at,
        membership_fee_price, free_periods, paid_periods, bonus_periods, pay_beforehand_periods,
        personal_fee_benefit_action, personal_fee_benefit_value, auto_renew,
        recurring_billing_interval, recurring_billing_unit)
     SELECT gym_id, ?, schedule_id, plan_price_id, base_price, discount_reason, discount_expires_at,
            membership_fee_price, free_periods, paid_periods, bonus_periods, pay_beforehand_periods,
            personal_fee_benefit_action, personal_fee_benefit_value, auto_renew,
            recurring_billing_interval, recurring_billing_unit
       FROM product_set_plan_snapshots WHERE gym_id = ? AND product_set_id = ?`,
    [toSetId, gymId, fromSetId]);

  for (const [table, extra] of [
    ['user_membership_session', ', frequency'],
    ['user_membership_oneoff', ''],
    ['user_membership_periodical', ', schedule_id'],
  ] as const) {
    await tx.query(
      `INSERT INTO ${table}
         (gym_id, product_set_id, product_id, quantity, item_name, item_type, item_billing_frequency,
          unit_price, currency, \`action\`, \`value\`, mandatory${extra})
       SELECT gym_id, ?, product_id, quantity, item_name, item_type, item_billing_frequency,
              unit_price, currency, \`action\`, \`value\`, mandatory${extra}
         FROM ${table} WHERE gym_id = ? AND product_set_id = ?`,
      [toSetId, gymId, fromSetId]);
  }
  await tx.query(
    `INSERT INTO member_products_recurrent_snapshot
       (gym_id, product_set_id, product_id, quantity, starts_at, ends_at, item_name, item_type,
        unit_price, item_billing_frequency, currency, schedule_id)
     SELECT gym_id, ?, product_id, quantity, starts_at, ends_at, item_name, item_type,
            unit_price, item_billing_frequency, currency, schedule_id
       FROM member_products_recurrent_snapshot WHERE gym_id = ? AND product_set_id = ?`,
    [toSetId, gymId, fromSetId]);

  await copyApplications(tx, gymId, { productSetId: fromSetId }, { productSetId: toSetId });
}

/** Copies applied Promotions (and the grants each froze) between two versions. */
async function copyApplications(tx: Tx, gymId: string, from: { productSetId: number }, to: { productSetId: number }) {
  const { rows } = await tx.query<any>(
    `SELECT id, promotion_id, created_by, applied_at, consumed_at, status, snapshot, revoked_at,
            modified_at, modified_by
       FROM user_membership_promotions WHERE gym_id = ? AND product_set_id = ?`, [gymId, from.productSetId]);
  for (const app of rows) {
    const { insertId } = await tx.query(
      `INSERT INTO user_membership_promotions
         (gym_id, product_set_id, promotion_id, created_by, applied_at, consumed_at, status, snapshot, revoked_at,
          modified_at, modified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, to.productSetId, app.promotion_id, app.created_by, app.applied_at, app.consumed_at, app.status,
        app.snapshot == null ? null : (typeof app.snapshot === 'string' ? app.snapshot : JSON.stringify(app.snapshot)),
        app.revoked_at, app.modified_at, app.modified_by]);
    for (const table of [
      'user_membership_promotion_session_snapshot',
      'user_membership_promotion_oneoff_snapshot',
      'user_membership_promotion_periodical_snapshot',
    ]) {
      await tx.query(
        `INSERT INTO ${table}
           (gym_id, user_membership_promotion_id, product_id, product_name, quantity, item_type,
            item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement)
         SELECT gym_id, ?, product_id, product_name, quantity, item_type,
                item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement
           FROM ${table} WHERE gym_id = ? AND user_membership_promotion_id = ?`,
        [insertId, gymId, app.id]);
    }
  }
}


/**
 * The first obligation of a version moving to Pending Payment, written before
 * any money moves (#1288's rule, one table over): what it owes on its start
 * date, with its lines. Nothing is written for a first cycle that owes nothing.
 */
async function writePendingInitialEvent(tx: Tx, gymId: string, setId: number, actor: string | null): Promise<void> {
  const { rows } = await tx.query<any>(
    'SELECT owner_member_id, starts_at FROM product_sets WHERE id = ? AND gym_id = ?', [setId, gymId]);
  if (!rows[0]) return;
  const startsAt = dateOnly(rows[0].starts_at);
  const charge = await initialCharge(gymId, setId, startsAt, tx);
  if (charge && charge.amount > 0) {
    const { rows: ct } = await tx.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
    await ensureInitialEvent(tx, {
      gymId, productSetId: setId, memberId: Number(rows[0].owner_member_id), startsAt, charge, chargeTypeId: ct[0]?.id ?? null, actor,
    });
  }
}

/* ── Commit: an assignment becomes a ProductSet version ──────────────────── */

/**
 * Moves the ProductSet version an assignment is linked to — created with it
 * (#1325 PR 3e) — on the two moments that call it, inside the assignment
 * transaction:
 *
 *  - **Save & Pay** (`submitForPayment()`, `pending: true`): the version is
 *    created `pending_payment` beside the Active one — nothing superseded, no
 *    obligations generated — and its **initial Billing Event is written now**,
 *    with its lines, so every payment request raised for the pending assignment
 *    (a staff link, the member's Pay now, a cash payment) is an attempt on that
 *    one event and the ledger never holds a money row with no ProductSet.
 *  - **commit** (`commitAssignment()`): a version already pending is activated
 *    (`activateWithEvents()`: the Active one superseded, its obsolete future
 *    events replaced, the new ones generated, the assignment re-projected);
 *    an assignment with no version yet — a free plan, a staff shortcut — gets
 *    one created `active` with its obligations generated.
 *
 * Idempotent: an assignment whose version is already active is left alone.
 */
export async function importAssignmentAsProductSet(
  tx: Tx, gymId: string, userMembershipId: number,
  opts: { pending?: boolean; /** #1182: the plain-text actor of the commit; omitted = System. */ actor?: string | null } = {},
): Promise<number | null> {
  const { rows: linked } = await tx.query<any>(
    'SELECT id, status FROM product_sets WHERE gym_id = ? AND user_membership_id = ? FOR UPDATE', [gymId, userMembershipId]);
  if (linked.length > 0) {
    const set = linked[0];
    // #1325 PR 3e: a Draft assignment is created set-first, so its version is
    // already the Draft here — Save & Pay moves it to Pending Payment with its
    // initial event, and a commit with nothing to pay activates it.
    if (set.status === 'draft' && opts.pending) {
      const moved = await submitSetForPayment(tx, gymId, Number(set.id));
      if (moved.kind !== 'ok') {
        throw Object.assign(new Error(`ProductSet ${set.id} could not be submitted: ${moved.kind}`), { status: moved.kind === 'expired' ? 410 : 409 });
      }
      await writePendingInitialEvent(tx, gymId, Number(set.id), opts.actor === undefined ? SYSTEM_ACTOR : opts.actor);
      return Number(set.id);
    }
    if (!opts.pending && (set.status === 'pending_payment' || set.status === 'draft')) {
      const out = await activateWithEvents(tx, { gymId, productSetId: Number(set.id), today: todayUtc(), actor: opts.actor });
      if (out.kind !== 'ok') {
        throw Object.assign(new Error(`ProductSet ${set.id} could not be activated: ${out.kind}`), { status: out.kind === 'expired' ? 410 : 409 });
      }
    }
    return Number(set.id);
  }

  // #1325 PR 3e-3: an assignment is created with its version (Admin, Members App)
  // or was given one by migration 258, so there is nothing to import from the
  // row any more. A row with none is a defect, not a legacy state.
  throw Object.assign(
    new Error('This assignment has no ProductSet version to commit'),
    { status: 409, code: 'no_product_set' },
  );
}

/**
 * The open initial Billing Event of the pending ProductSet an assignment is
 * linked to: what a payment request raised for a Pending Payment assignment is
 * an attempt on. `null` for an assignment with no pending version.
 */
export async function openInitialEventForAssignment(
  exec: { query: Tx['query'] }, gymId: string, userMembershipId: number,
): Promise<{ productSetId: number; eventId: number; amount: number } | null> {
  const { rows } = await exec.query<any>(
    `SELECT ps.id AS product_set_id, be.id AS event_id, be.amount
       FROM product_sets ps
       JOIN billing_events be ON be.product_set_id = ps.id AND be.gym_id = ps.gym_id
        AND be.event_type = 'payment_recorded'
        AND NOT EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.billing_event_id = be.id AND pr.status = 'completed')
      WHERE ps.gym_id = ? AND ps.user_membership_id = ? AND ps.status = 'pending_payment'
      ORDER BY be.id DESC LIMIT 1`,
    [gymId, userMembershipId]);
  if (!rows[0]) return null;
  return { productSetId: Number(rows[0].product_set_id), eventId: Number(rows[0].event_id), amount: Number(rows[0].amount) };
}

/**
 * A Pending Payment assignment closed or deleted before it was paid takes its
 * pending version with it (`cancelInFlight()`: the initial event and its
 * attempts go too, which that function allows only while no payment is in
 * flight or settled). `false` when the version could not be cancelled — the
 * payment is unresolved — so the caller refuses the close rather than leaving a
 * paid-for version behind.
 */
export async function cancelPendingSetForAssignment(tx: Tx, gymId: string, userMembershipId: number): Promise<boolean> {
  const { rows } = await tx.query<any>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND user_membership_id = ? AND status IN ('draft','pending_payment') FOR UPDATE`,
    [gymId, userMembershipId]);
  if (!rows[0]) return true;
  const setId = Number(rows[0].id);
  // The initial event's attempts are the set's: delete the ones nothing settled
  // (a `cancelInFlight` sees only the request the set names).
  const out = await cancelInFlight(tx, gymId, setId);
  if (out.kind === 'unresolved') return false;
  return true;
}

/** The ProductSet an assignment is linked to (pending first, then active), for a writer that needs one. */
export async function productSetIdForAssignment(
  exec: { query: Tx['query'] }, gymId: string, userMembershipId: number,
): Promise<number | null> {
  const { rows } = await exec.query<any>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND user_membership_id = ? AND status IN ('pending_payment','active')
      ORDER BY FIELD(status, 'pending_payment', 'active'), id DESC LIMIT 1`, [gymId, userMembershipId]);
    return rows[0] ? Number(rows[0].id) : null;
}

/** The owner's Active ProductSet, for a money row raised against a member rather than an assignment. */
export async function activeProductSetIdForMember(
  exec: { query: Tx['query'] }, gymId: string, memberId: number,
): Promise<number | null> {
  const { rows } = await exec.query<any>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active' LIMIT 1`, [gymId, memberId]);
  return rows[0] ? Number(rows[0].id) : null;
}


/**
 * The assignment's own first payment covers the first period of its plan
 * schedule. Linking it to that period is what stops the same period being
 * generated — and charged — a second time: any scheduled event the import already
 * generated for it (and that nothing has attempted) is removed, and the payment
 * becomes the period's event. Idempotent; a no-op for an assignment no set
 * projects or one with no unlinked first payment.
 *
 * Called by the import, and again by the one legacy path that records the cash
 * payment's event *after* the commit (`POST /:id/record-payment`).
 */
export async function linkInitialPaymentToSet(tx: Tx, gymId: string, userMembershipId: number): Promise<void> {
  const { rows: sets } = await tx.query<any>(
    `SELECT id, root_product_set_id, starts_at FROM product_sets
      WHERE gym_id = ? AND user_membership_id = ? AND status = 'active' LIMIT 1`, [gymId, userMembershipId]);
  const set = sets[0];
  if (!set) return;
  const { rows: ev } = await tx.query<any>(
    `SELECT id FROM billing_events
      WHERE gym_id = ? AND product_set_id = ? AND event_type = 'payment_recorded' AND schedule_id IS NULL
      ORDER BY id ASC LIMIT 1 FOR UPDATE`, [gymId, set.id]);
  if (!ev[0]) return;
  const startsAt = dateOnly(set.starts_at);
  const { rows: sch } = await tx.query<any>(
    'SELECT id FROM product_set_schedules WHERE root_product_set_id = ? AND schedule_key = ?',
    [set.root_product_set_id, PLAN_SCHEDULE_KEY]);
  const scheduleId = sch[0] ? Number(sch[0].id) : null;
  if (scheduleId != null) {
    await tx.query(
      `DELETE FROM billing_events
        WHERE gym_id = ? AND schedule_id = ? AND period_start = ? AND is_scheduled = 1
          AND NOT EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.billing_event_id = billing_events.id)`,
      [gymId, scheduleId, startsAt]);
  }
  await tx.query(
    `UPDATE billing_events SET product_set_id = ?, schedule_id = ?, period_start = ?, billing_date = ?
      WHERE id = ?`, [set.id, scheduleId, startsAt, startsAt, ev[0].id]);
}

/* ── Edit: an assignment write becomes a new version ─────────────────────── */

export type ReconfigureOutcome =
  | { kind: 'not_projected' }
  | { kind: 'edit_locked'; blocking: BlockingEvent[] }
  | { kind: 'in_flight'; productSetId: number }
  | { kind: 'ok'; productSetId: number }
  | DraftRefusal;

/** The Active ProductSet an assignment is the projection of, if any. */
export async function projectedSetFor(tx: Tx, gymId: string, userMembershipId: number): Promise<{ id: number; owner_member_id: number; membership_plan_id: number | null } | null> {
  const { rows } = await tx.query<any>(
    `SELECT id, owner_member_id, membership_plan_id FROM product_sets
      WHERE gym_id = ? AND user_membership_id = ? AND status = 'active' FOR UPDATE`, [gymId, userMembershipId]);
  return rows[0] ? { id: Number(rows[0].id), owner_member_id: Number(rows[0].owner_member_id), membership_plan_id: rows[0].membership_plan_id != null ? Number(rows[0].membership_plan_id) : null } : null;
}

/**
 * Applies `mutate` as a new version of the Active set an assignment projects:
 * clone its configuration into the next Draft, edit the Draft, activate it (the
 * previous version is superseded, its obsolete future events replaced and the
 * assignment re-projected). One transaction, so a refused edit leaves the set
 * exactly as it was. The editing lock is checked first, as on every other path.
 */
export async function reconfigureProjected(
  tx: Tx,
  input: { gymId: string; userMembershipId: number; actor: { name: string | null; type?: string | null };
    mutate: (tx: Tx, draft: LockedDraft) => Promise<{ ok: true } | DraftRefusal> },
): Promise<ReconfigureOutcome> {
  // #1325 PR 3e: an assignment whose Draft version is linked to it is edited on
  // that Draft, in place — the Draft writers' own locks and two-hour expiry —
  // and the row is re-derived from it. A Draft with no version (a legacy row)
  // falls through as `not_projected` and the route writes its own tables.
  const draft = await linkedDraftSetFor(tx, input.gymId, input.userMembershipId);
  if (draft) {
    const locked = await lockDraft(tx, input.gymId, draft.id);
    if (isRefusal(locked)) return locked;
    const edited = await input.mutate(tx, locked);
    if ('kind' in edited) return edited;
    await syncDraftAssignment(tx, input.gymId, locked.id, input.actor.name);
    return { kind: 'ok', productSetId: locked.id };
  }

  const set = await projectedSetFor(tx, input.gymId, input.userMembershipId);
  if (!set) return { kind: 'not_projected' };
  // A closed assignment is not a live projection whatever its set says: the
  // legacy route refuses the edit with the reason it always gave.
  const { rows: umRows } = await tx.query<any>('SELECT status FROM user_memberships WHERE id = ? AND gym_id = ?', [input.userMembershipId, input.gymId]);
  if (!umRows[0] || umRows[0].status === 'cancelled' || umRows[0].status === 'expired') return { kind: 'not_projected' };

  const blocking = await loadEditLock(input.gymId, set.owner_member_id, todayUtc());
  if (blocking.length > 0) return { kind: 'edit_locked', blocking };

  const { rows: setRows } = await tx.query<any>('SELECT starts_at, ends_at FROM product_sets WHERE id = ?', [set.id]);
  const created = await createDraft(tx, {
    gymId: input.gymId, ownerMemberId: set.owner_member_id, membershipPlanId: set.membership_plan_id,
    startsAt: dateOnly(setRows[0].starts_at), actor: input.actor,
  });
  if (created.kind === 'in_flight') return { kind: 'in_flight', productSetId: created.productSetId };

  const draftId = created.productSet.id;
  await tx.query('UPDATE product_sets SET user_membership_id = NULL, ends_at = ? WHERE id = ?',
    [setRows[0].ends_at == null ? null : dateOnly(setRows[0].ends_at), draftId]);
  await cloneConfiguration(tx, input.gymId, set.id, draftId);

  const locked = await lockDraft(tx, input.gymId, draftId);
  if (isRefusal(locked)) return locked;
  const edited = await input.mutate(tx, locked);
  if ('kind' in edited) return edited;

  // The new version takes over the same assignment (it is the same contract).
  await tx.query('UPDATE product_sets SET user_membership_id = ? WHERE id = ?', [input.userMembershipId, draftId]);
  await tx.query('UPDATE product_sets SET user_membership_id = NULL WHERE id = ?', [set.id]);
  const out = await activateWithEvents(tx, { gymId: input.gymId, productSetId: draftId, today: todayUtc(), actor: input.actor.name });
  if (out.kind !== 'ok') return { kind: 'not_a_draft', status: out.kind };
  return { kind: 'ok', productSetId: draftId };
}

/**
 * Ends a projected plan: a new, empty, plan-less version. Its activation closes
 * the assignment (the projection), supersedes the previous version and deletes
 * its obsolete future events, so nothing more is billed.
 */
export async function retireProjected(
  tx: Tx,
  input: { gymId: string; userMembershipId: number; actor: { name: string | null; type?: string | null } },
): Promise<ReconfigureOutcome> {
  const set = await projectedSetFor(tx, input.gymId, input.userMembershipId);
  if (!set) return { kind: 'not_projected' };
  const created = await createDraft(tx, {
    gymId: input.gymId, ownerMemberId: set.owner_member_id, membershipPlanId: null,
    startsAt: todayUtc(), actor: input.actor,
  });
  if (created.kind === 'in_flight') return { kind: 'in_flight', productSetId: created.productSetId };
  const out = await activateWithEvents(tx, { gymId: input.gymId, productSetId: created.productSet.id, today: todayUtc(), actor: input.actor.name });
  if (out.kind !== 'ok') return { kind: 'not_a_draft', status: out.kind };
  return { kind: 'ok', productSetId: created.productSet.id };
}

/* ── Mutators for the edits that are not plain Draft writers ─────────────── */

/** Applies a Promotion to the version being edited (the Draft writer's own rules). */
export function applyPromotionMutator(gymId: string, actor: string | null, promotionId: number) {
  return async (tx: Tx, draft: LockedDraft): Promise<{ ok: true } | DraftRefusal> => {
    if (draft.membership_plan_id == null) {
      return { kind: 'invalid', message: 'A ProductSet without a Membership Plan takes no Promotion' };
    }
    const { applyPromotionToProductSet, validatePromotionSelection } = await import('./membership-promotions');
    const { assignmentBeingEdited } = await import('./membership-promotions');
    const refusal = await validatePromotionSelection(gymId, draft.membership_plan_id, [promotionId], draft.owner_member_id,
      await assignmentBeingEdited(tx, draft.id));
    if (refusal) return { kind: 'invalid', message: refusal.error };
    try {
      await applyPromotionToProductSet(tx, gymId, actor, draft.id, promotionId);
    } catch (err: any) {
      if (err?.status === 409) return { kind: 'conflict', error: err.message, message: err.message };
      if (err?.status) return { kind: 'invalid', message: err.message };
      throw err;
    }
    return { ok: true };
  };
}

/**
 * Revokes an applied Promotion on the new version: the application is kept with
 * `status = 'revoked'` and the moment, because the Billing Events ledger tags a
 * charge by the window the application stood (#635 stage 9) — a committed
 * version's history is never a deletion.
 */
export function revokePromotionMutator(promotionId: number, actor: string | null) {
  return async (tx: Tx, draft: LockedDraft): Promise<{ ok: true } | DraftRefusal> => {
    const { rowCount } = await tx.query(
      `UPDATE user_membership_promotions
          SET status = 'revoked', revoked_at = UTC_TIMESTAMP(),
              modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE gym_id = ? AND product_set_id = ? AND promotion_id = ? AND status = 'applied'`,
      [actor, draft.gym_id, draft.id, promotionId]);
    if (rowCount === 0) return { kind: 'not_found' };
    return { ok: true };
  };
}
