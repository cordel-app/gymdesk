import { calendarAnchorOnOrBefore } from '../domain/calendarSchedule';
import { PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL, nameAssignmentSnapshot } from './plan-assignment-sync';
import { deleteDraftAssignments } from './assignment-lifecycle-writer';
import { Tx } from '../infra/db';
import { createDraft } from './product-sets';
import { staffProductDraftSql } from './editable-draft';
import { snapshotProductSetFromPlan } from './product-set-configuration';
import { syncDraftAssignment } from './product-set-projection';
import { syncMandatoryQuantities } from './product-set-draft';
import { cloneConfiguration } from './product-set-bridge';
import { ownAssignmentPlanSnapshot, ownAssignmentSnapshot, ownPrimaryPlanSnapshot, discardDraftSet } from './plan-snapshot-ownership';
import { planSnapshotOfAssignment, primaryPlanSnapshotSql } from './plan-snapshot-lines';
import { linkCancellingPlans } from './entitlement-plan-links';
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';

/**
 * #1325 PR 3e — the Draft assignment of the Admin is created **set-first**.
 *
 * The three Admin entry points (*Assign New Plan*, `POST /user-memberships`, the
 * Plans page's bulk assign) used to create the assignment row and its frozen
 * configuration, and hand the whole thing to a ProductSet only at Save & Pay
 * (`importAssignmentAsProductSet`). A Draft assignment now **is** a ProductSet
 * Draft from the moment it exists, linked to its row (`product_sets.
 * user_membership_id`): the Draft writers of `/product-sets` edit it, the
 * assignment row is a cache re-derived from it (`syncDraftAssignment()`), and
 * the commit moves the version it already is.
 *
 * What this carries with it is the rules the ProductSet model approved for any
 * version, and they are deliberate behaviour changes for the Admin's Drafts:
 * one in-flight (Draft or Pending Payment) version per owner, and a Draft that
 * is idle for two hours expires.
 */

export interface DraftSetInput {
  gymId: string;
  userMembershipId: number;
  ownerMemberId: number;
  membershipPlanId: number;
  startsAt: string;
  endsAt: string | null;
  /** The regular fee frozen onto the version (a negotiated fee included). */
  membershipFeePrice: number | null;
  basePrice: number | null;
  planPriceId: number | null;
  discountReason: string | null;
  discountExpiresAt: string | null;
  declinedBenefits?: Array<{ section: string; product_id: number }>;
  actor: { name: string | null; type?: string | null };
}

/**
 * Creates the Draft version for a just-inserted Draft assignment, freezes the
 * plan onto it, links the two and re-derives the row from it. Throws `409
 * in_flight` (rolling the caller's transaction back) when the owner already has
 * a version in flight — the database's own one-in-flight rule, said in words.
 */
export async function createDraftSetForAssignment(tx: Tx, input: DraftSetInput): Promise<number> {
  // #1707: a Draft is editable until it is committed, so assigning (or
  // re-assigning) a plan while the owner's Draft assignment is still open
  // replaces that Draft — one Draft per owner stays true, and nothing was billed.
  // A Pending Payment version, or a Draft that is not an assignment's (it holds
  // product lines), is left alone and still answers `in_flight`.
  const { rows: stale } = await tx.query<{ id: number; user_membership_id: number }>(
    // #2125 M6b-51d-3: read and locked on the stale Draft's anchor (the set's link), not `user_memberships`.
    `SELECT ps.id, a.source_user_membership_id AS user_membership_id
       FROM product_sets ps JOIN plan_snapshots a ON a.id = ps.plan_assignment_id AND a.gym_id = ps.gym_id
      WHERE ps.gym_id = ? AND ps.owner_member_id = ? AND ps.status = 'in_cart'
        AND a.assignment_status = 'in_cart' AND a.source_user_membership_id <> ? FOR UPDATE`,
    [input.gymId, input.ownerMemberId, input.userMembershipId],
  );
  for (const old of stale) {
    await discardDraftSet(tx, input.gymId, Number(old.id));
    await deleteDraftAssignments(tx, input.gymId, [Number(old.user_membership_id)]);
  }
  // #2966: the owner's live plain Draft with no Membership Plan yet (their cart of recurring
  // Products) is the cart this plan joins — adopted, never a competing version. Its lines, quantities
  // and Promotions stay as they were; the plan is frozen onto it below like onto a fresh Draft.
  const { rows: cart } = await tx.query<{ id: number }>(
    `SELECT ps.id FROM product_sets ps
      WHERE ps.gym_id = ? AND ps.owner_member_id = ? AND ${staffProductDraftSql('ps')}
        AND ps.plan_assignment_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots cj WHERE cj.product_set_id = ps.id)
      FOR UPDATE`,
    [input.gymId, input.ownerMemberId],
  );
  let setId: number;
  if (cart[0]) {
    setId = Number(cart[0].id);
    await tx.query(
      `UPDATE product_sets SET membership_plan_id = ?, starts_at = ?, last_activity_at = UTC_TIMESTAMP()
        WHERE id = ? AND gym_id = ?`, [input.membershipPlanId, input.startsAt, setId, input.gymId]);
  } else {
    const created = await createDraft(tx, {
      gymId: input.gymId, ownerMemberId: input.ownerMemberId, membershipPlanId: input.membershipPlanId,
      startsAt: input.startsAt, actor: input.actor,
    });
    if (created.kind === 'in_flight') {
      throw Object.assign(
        new Error('This member already has a ProductSet version in flight'),
        { status: 409, code: 'in_flight', productSetId: created.productSetId },
      );
    }
    setId = created.productSet.id;
  }
  await tx.query(
    `UPDATE product_sets SET ends_at = ?, ${PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL} WHERE id = ? AND gym_id = ?`,
    [input.endsAt, input.userMembershipId, setId, input.gymId],
  );
  await snapshotProductSetFromPlan(tx, {
    gymId: input.gymId, productSetId: setId, membershipPlanId: input.membershipPlanId,
    membershipFeePrice: input.membershipFeePrice, startsAt: input.startsAt,
    declinedBenefits: input.declinedBenefits, origin: 'admin',
  });
  // #2125 M6b-44: the plan snapshot names the new assignment as soon as it exists, so its anchor does too.
  await nameAssignmentSnapshot(tx, input.gymId, setId, input.userMembershipId);
  await tx.query(
    `UPDATE plan_snapshots
        SET plan_price_id = ?, base_price = ?, discount_reason = ?, discount_expires_at = ?
      WHERE id = ${primaryPlanSnapshotSql('?', '?')}`,
    [input.planPriceId, input.basePrice, input.discountReason, input.discountExpiresAt, setId, input.gymId],
  );
  await syncMandatoryQuantities(tx, input.gymId, setId);
  // #2659 stage 3: Add Membership Plan's Draft carries the owner's plans cancelling at their period
  // end, for entitlement only (never billed, charged or projected). The Active plans join it at the
  // commit, as before (`mergeActiveVersionIntoDraft()`).
  await linkCancellingPlans(tx, input.gymId, setId);
  await syncDraftAssignment(tx, input.gymId, setId);
  return setId;
}

/** The Draft version an assignment is linked to, locked; `null` for a legacy Draft with none. */
export async function linkedDraftSetFor(
  tx: Tx, gymId: string, userMembershipId: number,
): Promise<{ id: number; owner_member_id: number } | null> {
  const { rows } = await tx.query<{ id: number; owner_member_id: number }>(
    `SELECT id, owner_member_id FROM product_sets ps
      WHERE gym_id = ? AND ${productSetOfLegacyAssignmentSql('?')} AND status = 'in_cart' FOR UPDATE`,
    [gymId, userMembershipId],
  );
  return rows[0] ? { id: Number(rows[0].id), owner_member_id: Number(rows[0].owner_member_id) } : null;
}

/**
 * Discarding a Draft assignment takes its version with it: a Draft is a hard
 * delete (#1240), and the version would otherwise sit as the owner's one
 * in-flight version, locking them out of starting another.
 */
export async function deleteLinkedDraftSet(tx: Tx, gymId: string, userMembershipId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT id FROM product_sets ps WHERE gym_id = ? AND ${productSetOfLegacyAssignmentSql('?')} AND status = 'in_cart'`,
    [gymId, userMembershipId],
  );
  for (const r of rows) await discardDraftSet(tx, gymId, Number(r.id));
}

/**
 * The negotiated fee's reason and expiry are the version's (the row carries
 * neither since migration 258): written on the latest version linked to the
 * assignment, a request that mentions only one of the two leaving the other as
 * it was. Reference text that prices nothing, so it is written in place.
 */
export async function writeDiscountOnVersion(tx: Tx, gymId: string, userMembershipId: number, input: {
  reason: { value: string | null } | null; expires: { value: string | null } | null;
}): Promise<void> {
  if (!input.reason && !input.expires) return;
  // M4b-2: the assignment's own plan is the one edited, owned by the version it is read from.
  const target = await ownAssignmentSnapshot(tx, gymId, userMembershipId);
  if (target == null) return;
  await tx.query(
    `UPDATE plan_snapshots
        SET discount_reason = IF(?, ?, discount_reason),
            discount_expires_at = IF(?, ?, discount_expires_at)
      WHERE id = ? AND gym_id = ?`,
    [input.reason ? 1 : 0, input.reason?.value ?? null, input.expires ? 1 : 0, input.expires?.value ?? null,
      target, gymId]);
}

/**
 * #2125 M6b-51b — a Draft's dates, edited by `PUT /user-memberships/:id`, are written on the Draft's
 * own plan snapshot (owned first, so a snapshot another Product Set links is never moved) and then
 * mirrored onto its version from that snapshot. `startsAt` null keeps the stored start; `endsAt` null
 * keeps the stored end, `{ value: null }` clears it. Nothing is written for an assignment no Draft
 * version is linked to.
 */
export async function writeDraftAssignmentDates(tx: Tx, gymId: string, userMembershipId: number, input: {
  startsAt: string | null; endsAt: { value: string | null } | null;
}): Promise<void> {
  if (input.startsAt == null && !input.endsAt) return;
  const draft = await linkedDraftSetFor(tx, gymId, userMembershipId);
  if (!draft) return;
  const target = await ownAssignmentPlanSnapshot(tx, gymId, draft.id, userMembershipId);
  if (target == null) return;
  const day = (v: string | null) => (v == null ? null : String(v).slice(0, 10));
  await tx.query(
    `UPDATE plan_snapshots
        SET starts_at = COALESCE(?, starts_at), ends_at = IF(?, ?, ends_at)
      WHERE id = ? AND gym_id = ?`,
    [day(input.startsAt), input.endsAt ? 1 : 0, day(input.endsAt?.value ?? null), target, gymId]);
  await syncDraftSetFromAssignment(tx, gymId, userMembershipId);
}

/**
 * A Draft's version carries the same dates as its assignment, so a write of them is mirrored onto
 * it in the same transaction. #2125 M6b-51b: the dates are read from the Draft's plan snapshot that
 * names the assignment (where `writeDraftAssignmentDates()` wrote them), never `user_memberships`.
 */
export async function syncDraftSetFromAssignment(tx: Tx, gymId: string, userMembershipId: number): Promise<void> {
  const draft = await linkedDraftSetFor(tx, gymId, userMembershipId);
  if (!draft) return;
  const snapshotId = await planSnapshotOfAssignment(tx, gymId, draft.id, userMembershipId);
  if (snapshotId == null) return;
  const { rows } = await tx.query<any>(
    'SELECT starts_at, ends_at FROM plan_snapshots WHERE id = ? AND gym_id = ?', [snapshotId, gymId]);
  const um = rows[0];
  if (!um) return;
  const dateOnly = (v: unknown) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));
  const { rows: before } = await tx.query<any>(
    'SELECT starts_at, previous_product_set_id FROM product_sets WHERE id = ? AND gym_id = ?', [draft.id, gymId]);
  const oldStart = dateOnly(before[0]?.starts_at);
  const newStart = dateOnly(um.starts_at);
  await tx.query('UPDATE product_sets SET starts_at = ?, ends_at = ? WHERE id = ? AND gym_id = ?',
    [newStart, dateOnly(um.ends_at), draft.id, gymId]);
  // A chain's schedules are never re-anchored once a version has billed on them
  // (a replacement keeps the chain's dates) — but a first version that has not
  // been committed yet is the only thing that anchored them, so moving its start
  // date moves them with it.
  // #2125 M5c — the anchors are calendar-grid dates, so a schedule moves when its anchor is the grid
  // date of the old start, and moves to the grid date of the new one.
  if (oldStart && newStart && oldStart !== newStart && before[0] && before[0].previous_product_set_id == null) {
    const { rows: schedules } = await tx.query<any>(
      `SELECT id, anchor_date, cadence_interval, cadence_unit FROM product_set_schedules
        WHERE gym_id = ? AND opened_by_product_set_id = ?`, [gymId, draft.id]);
    for (const s of schedules) {
      const cadence = { interval: Number(s.cadence_interval), unit: String(s.cadence_unit) };
      if (dateOnly(s.anchor_date) !== calendarAnchorOnOrBefore(cadence, oldStart)) continue;
      await tx.query('UPDATE product_set_schedules SET anchor_date = ? WHERE id = ?',
        [calendarAnchorOnOrBefore(cadence, newStart), s.id]);
    }
  }
}


/**
 * #2091 — `⋮ → Edit` on a running plan: a Draft assignment whose version is a
 * **copy of the Active version's own configuration** (`cloneConfiguration()`),
 * never re-frozen from the catalogue Plan. The Active version, its assignment
 * and its billing stay exactly as they are until the Draft completes Save & Pay.
 */
export async function createDraftSetFromActive(tx: Tx, input: {
  gymId: string; userMembershipId: number; ownerMemberId: number; activeSetId: number;
  /** The running assignment being edited, whose Plan Promotions the Draft carries (#2946). */
  editedUserMembershipId: number;
  membershipPlanId: number | null; startsAt: string; endsAt: string | null;
  actor: { name: string | null; type?: string | null };
}): Promise<number> {
  // #2966: the owner's live plain Draft with no Membership Plan yet (their cart of recurring
  // Products) is the cart this plan joins — adopted, never a competing version. Its lines, quantities
  // and Promotions stay as they were; the plan is frozen onto it below like onto a fresh Draft.
  const { rows: cart } = await tx.query<{ id: number }>(
    `SELECT ps.id FROM product_sets ps
      WHERE ps.gym_id = ? AND ps.owner_member_id = ? AND ${staffProductDraftSql('ps')}
        AND ps.plan_assignment_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots cj WHERE cj.product_set_id = ps.id)
      FOR UPDATE`,
    [input.gymId, input.ownerMemberId],
  );
  let setId: number;
  if (cart[0]) {
    setId = Number(cart[0].id);
    await tx.query(
      `UPDATE product_sets SET membership_plan_id = ?, starts_at = ?, last_activity_at = UTC_TIMESTAMP()
        WHERE id = ? AND gym_id = ?`, [input.membershipPlanId, input.startsAt, setId, input.gymId]);
  } else {
    const created = await createDraft(tx, {
      gymId: input.gymId, ownerMemberId: input.ownerMemberId, membershipPlanId: input.membershipPlanId,
      startsAt: input.startsAt, actor: input.actor,
    });
    if (created.kind === 'in_flight') {
      throw Object.assign(
        new Error('This member already has a ProductSet version in flight'),
        { status: 409, code: 'in_flight', productSetId: created.productSetId },
      );
    }
    setId = created.productSet.id;
  }
  await tx.query(`UPDATE product_sets SET ends_at = ?, ${PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL} WHERE id = ? AND gym_id = ?`,
    [input.endsAt, input.userMembershipId, setId, input.gymId]);
  await cloneConfiguration(tx, input.gymId, input.activeSetId, setId);
  // #2125 M4b-3: the clone links the running plan's snapshot, which is the running assignment's
  // contract; this Draft is a **new** assignment (its own `user_memberships` row, which replaces the
  // running one when it commits), so its plan is a proposed change by construction and is copied
  // now — the sync below then names the Draft assignment on the copy. Any other plan stays shared.
  await ownPrimaryPlanSnapshot(tx, input.gymId, setId);
  // #2125 M6b-44: the owned copy names the Draft assignment before the sync (which reads the anchor).
  await nameAssignmentSnapshot(tx, input.gymId, setId, input.userMembershipId);
  await syncDraftAssignment(tx, input.gymId, setId);
  return setId;
}

/**
 * #2858 — `⋮ → Edit` on a running plan while the owner already holds a plain Draft (the
 * recurring-products Draft, a clone of the same Active version): that Draft **is** the edit, so it
 * is linked to the new Draft assignment instead of a second version being created. Its products,
 * quantities and Promotions stay exactly as they were, and its id does not change. The primary plan
 * is owned and re-derived exactly as `createDraftSetFromActive()` does for a fresh clone.
 */
export async function adoptDraftForEdit(tx: Tx, input: {
  gymId: string; userMembershipId: number; draftSetId: number;
  /** The Active version the plain Draft was cloned from, and the running assignment being edited (#2946). */
  activeSetId: number; editedUserMembershipId: number;
}): Promise<number> {
  await tx.query(
    `UPDATE product_sets SET ${PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL}, last_activity_at = UTC_TIMESTAMP()
      WHERE id = ? AND gym_id = ? AND status = 'in_cart' AND plan_assignment_id IS NULL`,
    [input.userMembershipId, input.draftSetId, input.gymId]);
  await ownPrimaryPlanSnapshot(tx, input.gymId, input.draftSetId);
  await nameAssignmentSnapshot(tx, input.gymId, input.draftSetId, input.userMembershipId);
  await syncDraftAssignment(tx, input.gymId, input.draftSetId);
  return input.draftSetId;
}
