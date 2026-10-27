import { Tx } from '../infra/db';
import { createDraft } from './product-sets';
import { snapshotProductSetFromPlan } from './product-set-configuration';
import { syncDraftAssignment } from './product-set-projection';
import { syncMandatoryQuantities } from './product-set-draft';
import { cloneConfiguration } from './product-set-bridge';

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
    `SELECT ps.id, ps.user_membership_id
       FROM product_sets ps JOIN user_memberships um ON um.id = ps.user_membership_id AND um.gym_id = ps.gym_id
      WHERE ps.gym_id = ? AND ps.owner_member_id = ? AND ps.status = 'draft'
        AND um.status = 'draft' AND ps.user_membership_id <> ? FOR UPDATE`,
    [input.gymId, input.ownerMemberId, input.userMembershipId],
  );
  for (const old of stale) {
    await tx.query(`DELETE FROM product_sets WHERE id = ? AND gym_id = ? AND status = 'draft'`, [old.id, input.gymId]);
    await tx.query(`DELETE FROM user_memberships WHERE id = ? AND gym_id = ? AND status = 'draft'`,
      [old.user_membership_id, input.gymId]);
  }
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
  const setId = created.productSet.id;
  await tx.query(
    'UPDATE product_sets SET ends_at = ?, user_membership_id = ? WHERE id = ? AND gym_id = ?',
    [input.endsAt, input.userMembershipId, setId, input.gymId],
  );
  await snapshotProductSetFromPlan(tx, {
    gymId: input.gymId, productSetId: setId, membershipPlanId: input.membershipPlanId,
    membershipFeePrice: input.membershipFeePrice, startsAt: input.startsAt,
    declinedBenefits: input.declinedBenefits, origin: 'admin',
  });
  await tx.query(
    `UPDATE product_set_plan_snapshots
        SET plan_price_id = ?, base_price = ?, discount_reason = ?, discount_expires_at = ?
      WHERE product_set_id = ? AND gym_id = ?`,
    [input.planPriceId, input.basePrice, input.discountReason, input.discountExpiresAt, setId, input.gymId],
  );
  await tx.query(
    `INSERT IGNORE INTO product_set_members (gym_id, root_product_set_id, member_id, is_owner)
     VALUES (?, ?, ?, 1)`,
    [input.gymId, created.productSet.root_product_set_id, input.ownerMemberId],
  );
  await syncMandatoryQuantities(tx, input.gymId, setId, created.productSet.root_product_set_id ?? setId);
  await syncDraftAssignment(tx, input.gymId, setId);
  return setId;
}

/** The Draft version an assignment is linked to, locked; `null` for a legacy Draft with none. */
export async function linkedDraftSetFor(
  tx: Tx, gymId: string, userMembershipId: number,
): Promise<{ id: number; owner_member_id: number } | null> {
  const { rows } = await tx.query<{ id: number; owner_member_id: number }>(
    `SELECT id, owner_member_id FROM product_sets
      WHERE gym_id = ? AND user_membership_id = ? AND status = 'draft' FOR UPDATE`,
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
  await tx.query(
    `DELETE FROM product_sets WHERE gym_id = ? AND user_membership_id = ? AND status = 'draft'`,
    [gymId, userMembershipId],
  );
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
  await tx.query(
    `UPDATE product_set_plan_snapshots snap
       JOIN product_sets ps ON ps.id = snap.product_set_id
        SET snap.discount_reason = IF(?, ?, snap.discount_reason),
            snap.discount_expires_at = IF(?, ?, snap.discount_expires_at)
      WHERE ps.gym_id = ? AND ps.user_membership_id = ?
        AND ps.version = (SELECT MAX(p2.version) FROM product_sets p2
                           WHERE p2.gym_id = ps.gym_id AND p2.user_membership_id = ps.user_membership_id)`,
    [input.reason ? 1 : 0, input.reason?.value ?? null, input.expires ? 1 : 0, input.expires?.value ?? null,
      gymId, userMembershipId]);
}

/**
 * A Draft's dates are edited on the row by `PUT /user-memberships/:id`; its
 * version carries the same facts, so a write of them is mirrored onto it in the
 * same transaction.
 */
export async function syncDraftSetFromAssignment(tx: Tx, gymId: string, userMembershipId: number): Promise<void> {
  const draft = await linkedDraftSetFor(tx, gymId, userMembershipId);
  if (!draft) return;
  const { rows } = await tx.query<any>(
    'SELECT starts_at, ends_at FROM user_memberships WHERE id = ? AND gym_id = ?', [userMembershipId, gymId]);
  const um = rows[0];
  if (!um) return;
  const dateOnly = (v: unknown) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));
  const { rows: before } = await tx.query<any>(
    'SELECT starts_at, root_product_set_id FROM product_sets WHERE id = ? AND gym_id = ?', [draft.id, gymId]);
  const oldStart = dateOnly(before[0]?.starts_at);
  const newStart = dateOnly(um.starts_at);
  await tx.query('UPDATE product_sets SET starts_at = ?, ends_at = ? WHERE id = ? AND gym_id = ?',
    [newStart, dateOnly(um.ends_at), draft.id, gymId]);
  // A chain's schedules are never re-anchored once a version has billed on them
  // (a replacement keeps the chain's dates) — but a first version that has not
  // been committed yet is the only thing that anchored them, so moving its start
  // date moves them with it.
  if (oldStart && newStart && oldStart !== newStart && Number(before[0]?.root_product_set_id) === draft.id) {
    await tx.query(
      `UPDATE product_set_schedules SET anchor_date = ?
        WHERE gym_id = ? AND root_product_set_id = ? AND anchor_date = ?`,
      [newStart, gymId, draft.id, oldStart]);
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
  membershipPlanId: number | null; startsAt: string; endsAt: string | null;
  actor: { name: string | null; type?: string | null };
}): Promise<number> {
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
  const setId = created.productSet.id;
  await tx.query('UPDATE product_sets SET ends_at = ?, user_membership_id = ? WHERE id = ? AND gym_id = ?',
    [input.endsAt, input.userMembershipId, setId, input.gymId]);
  await cloneConfiguration(tx, input.gymId, input.activeSetId, setId);
  await syncDraftAssignment(tx, input.gymId, setId);
  return setId;
}
