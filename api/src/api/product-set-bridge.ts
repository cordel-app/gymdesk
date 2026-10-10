import { Tx } from '../infra/db';
import { ASSIGNMENT_CADENCE } from './assigned-plan-snapshot';
import {
  activateWithEvents, allocateItemSchedules, ensureSchedule, materialiseScheduledEvents,
  replaceFutureScheduledEvents,
} from './product-set-configuration';
import { PLAN_SCHEDULE_KEY } from '../domain/scheduleAllocation';
import { DraftRefusal, LockedDraft, isRefusal, lockDraft } from './product-set-draft';
import { loadEditLock } from './product-set-checkout';
import { createDraft } from './product-sets';
import type { BlockingEvent } from '../domain/billingEventEditLock';

/**
 * #1325 PR 5 — the bridge between the assignment screens and ProductSets.
 *
 * The Admin's Assigned Plan card, *Assign New Plan*, the Plans page's bulk
 * assign and the Memberships modal all create and edit **assignment-keyed**
 * configuration (`user_membership_id`). Rather than rewriting every one of those
 * screens at once, a deployment that sets `PRODUCT_SET_BILLING=true` makes the
 * server hand each of them over to ProductSets at the two moments that matter:
 *
 *  - **commit** (`commitAssignment()`): the assignment's frozen configuration is
 *    imported as the owner's next ProductSet version (`importAssignmentAsProductSet`),
 *    so from the moment a plan is active its obligations are the ProductSet's
 *    persisted events and the assignment pass no longer sees it;
 *  - **edit**: a configuration write on an assignment a ProductSet projects is
 *    applied as a **new version** of that set (`reconfigureProjected`) — never
 *    written to the assignment's rows, which the next projection would overwrite.
 *
 * Off (the default), nothing here runs and the assignment flow is exactly what it
 * was. It is removed with the legacy columns.
 */

export function productSetBillingEnabled(): boolean {
  return process.env.PRODUCT_SET_BILLING === 'true';
}

const todayUtc = () => new Date().toISOString().slice(0, 10);
const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/* ── Copying a version's configuration onto its successor ────────────────── */

/** The configuration of `fromSetId`, copied onto `toSetId` (a fresh Draft). */
export async function cloneConfiguration(tx: Tx, gymId: string, fromSetId: number, toSetId: number): Promise<void> {
  await tx.query(
    `INSERT INTO product_set_plan_snapshots
       (gym_id, product_set_id, schedule_id, plan_price_id, base_price, discount_reason, discount_expires_at,
        membership_fee_price, free_periods, paid_periods, bonus_periods, pay_beforehand_periods,
        personal_fee_benefit_action, personal_fee_benefit_value, auto_renew)
     SELECT gym_id, ?, schedule_id, plan_price_id, base_price, discount_reason, discount_expires_at,
            membership_fee_price, free_periods, paid_periods, bonus_periods, pay_beforehand_periods,
            personal_fee_benefit_action, personal_fee_benefit_value, auto_renew
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
    `INSERT INTO user_membership_services
       (gym_id, product_set_id, product_id, quantity, starts_at, ends_at, item_name, item_type,
        unit_price, item_billing_frequency, currency, schedule_id)
     SELECT gym_id, ?, product_id, quantity, starts_at, ends_at, item_name, item_type,
            unit_price, item_billing_frequency, currency, schedule_id
       FROM user_membership_services WHERE gym_id = ? AND product_set_id = ?`,
    [toSetId, gymId, fromSetId]);

  await copyApplications(tx, gymId, { productSetId: fromSetId }, { productSetId: toSetId });
}

type Owner = { productSetId: number } | { userMembershipId: number };

/** Copies applied Promotions (and the grants each froze) between two owners. */
async function copyApplications(tx: Tx, gymId: string, from: Owner, to: Owner) {
  const col = (o: Owner) => ('productSetId' in o ? 'product_set_id' : 'user_membership_id');
  const val = (o: Owner) => ('productSetId' in o ? o.productSetId : o.userMembershipId);
  const { rows } = await tx.query<any>(
    `SELECT id, promotion_id, applied_by, applied_at, consumed_at, status, snapshot, revoked_at
       FROM user_membership_promotions WHERE gym_id = ? AND ${col(from)} = ?`, [gymId, val(from)]);
  for (const app of rows) {
    const { insertId } = await tx.query(
      `INSERT INTO user_membership_promotions
         (gym_id, ${col(to)}, promotion_id, applied_by, applied_at, consumed_at, status, snapshot, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, val(to), app.promotion_id, app.applied_by, app.applied_at, app.consumed_at, app.status,
        app.snapshot == null ? null : (typeof app.snapshot === 'string' ? app.snapshot : JSON.stringify(app.snapshot)),
        app.revoked_at]);
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

/* ── Commit: an assignment becomes a ProductSet version ──────────────────── */

/**
 * Imports a just-committed assignment as the owner's next ProductSet version,
 * `active`, with its obligations generated. Idempotent: an assignment a set
 * already projects is left alone. Called inside `commitAssignment()`'s
 * transaction, after the assignment is `active`.
 *
 * What moves the billing off the assignment pass: `next_billing_date` is cleared
 * (the pass selects `IS NOT NULL`), and the assignment's own initial payment — if
 * Save & Pay wrote one — is linked to the first period of the plan schedule, so
 * the period it already paid is never generated and charged a second time.
 */
export async function importAssignmentAsProductSet(tx: Tx, gymId: string, userMembershipId: number): Promise<number | null> {
  const { rows: linked } = await tx.query('SELECT id FROM product_sets WHERE gym_id = ? AND user_membership_id = ?', [gymId, userMembershipId]);
  if (linked.length > 0) return Number(linked[0].id);

  const { rows } = await tx.query<any>(
    `SELECT um.id, um.member_id, um.membership_plan_id, um.starts_at, um.ends_at,
            um.base_price, um.plan_price_id, um.discount_reason, um.discount_expires_at,
            um.membership_fee_price, um.free_periods, um.paid_periods, um.bonus_periods,
            um.pay_beforehand_periods, um.auto_renew, um.personal_fee_benefit_action,
            um.personal_fee_benefit_value, um.created_by_name, um.created_by_type,
            ${ASSIGNMENT_CADENCE.interval()} AS cadence_interval, ${ASSIGNMENT_CADENCE.unit()} AS cadence_unit
       FROM user_memberships um
       LEFT JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id AND bp.gym_id = um.gym_id
      WHERE um.id = ? AND um.gym_id = ? FOR UPDATE`, [userMembershipId, gymId]);
  const um = rows[0];
  if (!um || um.membership_plan_id == null) return null;
  const startsAt = dateOnly(um.starts_at);

  // The chain: the owner's Active version is superseded by this one.
  const { rows: prevRows } = await tx.query<any>(
    `SELECT id, root_product_set_id, version FROM product_sets
      WHERE gym_id = ? AND owner_member_id = ? AND status = 'active' FOR UPDATE`, [gymId, um.member_id]);
  const prev = prevRows[0] ?? null;
  if (prev) {
    await tx.query(`UPDATE product_sets SET status = 'superseded', superseded_at = UTC_TIMESTAMP() WHERE id = ?`, [prev.id]);
  }
  const { insertId: setId } = await tx.query(
    `INSERT INTO product_sets
       (gym_id, owner_member_id, root_product_set_id, previous_product_set_id, version, status,
        membership_plan_id, starts_at, ends_at, user_membership_id, activated_at, created_by_name, created_by_type)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)`,
    [gymId, um.member_id, prev ? prev.root_product_set_id : null, prev ? prev.id : null,
      prev ? Number(prev.version) + 1 : 1, um.membership_plan_id, startsAt, um.ends_at ? dateOnly(um.ends_at) : null,
      userMembershipId, um.created_by_name, um.created_by_type]);
  if (!prev) await tx.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [setId]);
  const rootId = prev ? Number(prev.root_product_set_id) : Number(setId);

  let scheduleId: number | null = null;
  if (um.cadence_interval != null && um.cadence_unit != null) {
    scheduleId = await ensureSchedule(tx, {
      gymId, rootProductSetId: rootId, key: PLAN_SCHEDULE_KEY, anchorDate: startsAt,
      cadenceInterval: Number(um.cadence_interval), cadenceUnit: String(um.cadence_unit),
    });
  }
  await tx.query(
    `INSERT INTO product_set_plan_snapshots
       (gym_id, product_set_id, schedule_id, plan_price_id, base_price, discount_reason, discount_expires_at,
        membership_fee_price, free_periods, paid_periods, bonus_periods, pay_beforehand_periods,
        personal_fee_benefit_action, personal_fee_benefit_value, auto_renew)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [gymId, setId, scheduleId, um.plan_price_id, um.base_price, um.discount_reason, um.discount_expires_at,
      um.membership_fee_price, um.free_periods, um.paid_periods, um.bonus_periods, um.pay_beforehand_periods,
      um.personal_fee_benefit_action ?? 'no_benefit', um.personal_fee_benefit_value, um.auto_renew ?? 0]);

  for (const [table, extra] of [
    ['user_membership_session', ', frequency'],
    ['user_membership_oneoff', ''],
    ['user_membership_periodical', ''],
  ] as const) {
    await tx.query(
      `INSERT INTO ${table}
         (gym_id, product_set_id, product_id, quantity, item_name, item_type, item_billing_frequency,
          unit_price, currency, \`action\`, \`value\`, mandatory${extra})
       SELECT gym_id, ?, product_id, quantity, item_name, item_type, item_billing_frequency,
              unit_price, currency, \`action\`, \`value\`, mandatory${extra}
         FROM ${table} WHERE gym_id = ? AND user_membership_id = ?`,
      [setId, gymId, userMembershipId]);
  }
  await tx.query(
    `INSERT INTO user_membership_services
       (gym_id, product_set_id, product_id, quantity, starts_at, ends_at, item_name, item_type,
        unit_price, item_billing_frequency, currency)
     SELECT gym_id, ?, product_id, quantity, starts_at, ends_at, item_name, item_type,
            unit_price, item_billing_frequency, currency
       FROM user_membership_services WHERE gym_id = ? AND user_membership_id = ?`,
    [setId, gymId, userMembershipId]);
  await copyApplications(tx, gymId, { userMembershipId }, { productSetId: Number(setId) });
  await tx.query(
    `INSERT IGNORE INTO product_set_members (gym_id, root_product_set_id, member_id, is_owner)
     SELECT gym_id, ?, member_id, is_owner FROM user_membership_members WHERE gym_id = ? AND user_membership_id = ?`,
    [rootId, gymId, userMembershipId]);
  await tx.query(
    `INSERT IGNORE INTO product_set_members (gym_id, root_product_set_id, member_id, is_owner) VALUES (?, ?, ?, 1)`,
    [gymId, rootId, um.member_id]);
  await allocateItemSchedules(tx, gymId, Number(setId));

  await linkInitialPaymentToSet(tx, gymId, userMembershipId);

  // Off the assignment pass for good.
  await tx.query(
    `UPDATE user_memberships SET next_billing_date = NULL, failed_attempts = 0, last_failed_at = NULL
      WHERE id = ? AND gym_id = ?`, [userMembershipId, gymId]);

  if (prev) {
    await replaceFutureScheduledEvents(tx, { gymId, previousProductSetId: Number(prev.id), today: todayUtc() });
  }
  await materialiseScheduledEvents(tx, { gymId, productSetId: Number(setId), today: todayUtc() });
  return Number(setId);
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
      WHERE gym_id = ? AND user_membership_id = ? AND event_type = 'payment_recorded' AND product_set_id IS NULL
      ORDER BY id ASC LIMIT 1 FOR UPDATE`, [gymId, userMembershipId]);
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
  input: { gymId: string; userMembershipId: number; actor: { name: string | null; type: string | null };
    mutate: (tx: Tx, draft: LockedDraft) => Promise<{ ok: true } | DraftRefusal> },
): Promise<ReconfigureOutcome> {
  const set = await projectedSetFor(tx, input.gymId, input.userMembershipId);
  if (!set) return { kind: 'not_projected' };

  const blocking = await loadEditLock(input.gymId, set.owner_member_id, todayUtc());
  if (blocking.length > 0) return { kind: 'edit_locked', blocking };

  const { rows: setRows } = await tx.query<any>('SELECT starts_at FROM product_sets WHERE id = ?', [set.id]);
  const created = await createDraft(tx, {
    gymId: input.gymId, ownerMemberId: set.owner_member_id, membershipPlanId: set.membership_plan_id,
    startsAt: dateOnly(setRows[0].starts_at), actor: input.actor,
  });
  if (created.kind === 'in_flight') return { kind: 'in_flight', productSetId: created.productSetId };

  const draftId = created.productSet.id;
  await tx.query('UPDATE product_sets SET user_membership_id = NULL WHERE id = ?', [draftId]);
  await cloneConfiguration(tx, input.gymId, set.id, draftId);

  const locked = await lockDraft(tx, input.gymId, draftId);
  if (isRefusal(locked)) return locked;
  const edited = await input.mutate(tx, locked);
  if ('kind' in edited) return edited;

  // The new version takes over the same assignment (it is the same contract).
  await tx.query('UPDATE product_sets SET user_membership_id = ? WHERE id = ?', [input.userMembershipId, draftId]);
  await tx.query('UPDATE product_sets SET user_membership_id = NULL WHERE id = ?', [set.id]);
  const out = await activateWithEvents(tx, { gymId: input.gymId, productSetId: draftId, today: todayUtc() });
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
  input: { gymId: string; userMembershipId: number; actor: { name: string | null; type: string | null } },
): Promise<ReconfigureOutcome> {
  const set = await projectedSetFor(tx, input.gymId, input.userMembershipId);
  if (!set) return { kind: 'not_projected' };
  const created = await createDraft(tx, {
    gymId: input.gymId, ownerMemberId: set.owner_member_id, membershipPlanId: null,
    startsAt: todayUtc(), actor: input.actor,
  });
  if (created.kind === 'in_flight') return { kind: 'in_flight', productSetId: created.productSetId };
  const out = await activateWithEvents(tx, { gymId: input.gymId, productSetId: created.productSet.id, today: todayUtc() });
  if (out.kind !== 'ok') return { kind: 'not_a_draft', status: out.kind };
  return { kind: 'ok', productSetId: created.productSet.id };
}

/* ── Mutators for the edits that are not plain Draft writers ─────────────── */

/** Applies a Promotion to the version being edited (the Draft writer's own rules). */
export function applyPromotionMutator(gymId: string, userId: string | null, promotionId: number) {
  return async (tx: Tx, draft: LockedDraft): Promise<{ ok: true } | DraftRefusal> => {
    if (draft.membership_plan_id == null) {
      return { kind: 'invalid', message: 'A ProductSet without a Membership Plan takes no Promotion' };
    }
    const { applyPromotionToProductSet, validatePromotionSelection } = await import('./membership-promotions');
    const refusal = await validatePromotionSelection(gymId, draft.membership_plan_id, [promotionId], draft.owner_member_id);
    if (refusal) return { kind: 'invalid', message: refusal.error };
    try {
      await applyPromotionToProductSet(tx, gymId, userId ?? 'unknown', draft.id, promotionId);
    } catch (err: any) {
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
export function revokePromotionMutator(promotionId: number) {
  return async (tx: Tx, draft: LockedDraft): Promise<{ ok: true } | DraftRefusal> => {
    const { rowCount } = await tx.query(
      `UPDATE user_membership_promotions SET status = 'revoked', revoked_at = UTC_TIMESTAMP()
        WHERE gym_id = ? AND product_set_id = ? AND promotion_id = ? AND status = 'applied'`,
      [draft.gym_id, draft.id, promotionId]);
    if (rowCount === 0) return { kind: 'not_found' };
    return { ok: true };
  };
}
