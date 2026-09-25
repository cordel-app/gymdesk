import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { applyPeriodBenefit, PromotionBenefitAction } from '../domain/promotionBenefits';
import { resolveMembershipFee } from '../domain/billingSimulation';
import { toPlanDuration } from '../domain/planDuration';
import {
  AppliedPromotionForBilling,
  MembershipFeeBenefit,
} from '../domain/promotionApplication';
import { isDateAwareMembershipFeeEnabled } from '../infra/featureFlags';
import { regularMembershipFee } from './user-memberships';
import { validatePromotionStacking } from '../domain/promotionStacking';
import { canReapplyPromotion, promotionApplicationStatus } from '../domain/promotionApplicationStatus';
import { SellableItemBenefitCategory } from '../domain/sellableItemClassification';
import { loadPromotionGrantSnapshots } from './assigned-plan-snapshot';
import {
  isNewMember,
  isNewMemberForNewAssignment,
  NEW_MEMBERS_ONLY_ERROR,
} from './new-member-eligibility';

/**
 * P4.4: apply/revoke promotions on a user_membership.
 *
 * Server recomputes final_price from the plan's base_price + (#487 stage 3)
 * the Membership Fee Benefit of every currently-applied promo — one per
 * promotion since #635 stage 5. Recomputation is server-only; the ledger records
 * an 'adjustment' event. Recomputation only happens at these mutation points
 * (assignment, promotion apply/revoke) — there is no scheduled job that
 * reverts final_price on its own once a period benefit's duration_months
 * window lapses without a new mutation; that's a possible future stage 4/5.
 */

// #635 stage 7: `applied_by` stores the acting user's id (the same value
// `gym_memberships.user_id` carries), so the card can name who applied the
// Promotion — the "created by" of the expandable card the issue thread asks
// for. Resolved as a subquery rather than a JOIN because a staff member whose
// gym membership was since removed must still leave the application readable.
//
// #635 stage 9: the Promotion's *live* lifecycle and window come along under
// their own aliases. `starts_at`/`ends_at` are overwritten by the snapshot's
// agreed window in `withSnapshot()` — which is the point (§16) — so deciding
// whether the Promotion could be agreed *again today* needs the current ones
// kept separately. `ump.*` also carries migration 183's generated column, which
// `fetchAppliedPromotions()` (the only consumer) strips before responding — a
// second consumer would have to do the same.
const SELECT = `
  SELECT ump.*, p.name AS promotion_name, p.description AS promotion_description,
         p.stackable, p.starts_at, p.ends_at,
         p.lifecycle_status AS promotion_lifecycle_status,
         p.starts_at AS promotion_live_starts_at, p.ends_at AS promotion_live_ends_at,
         (SELECT gm.name FROM gym_memberships gm
           WHERE gm.user_id = ump.applied_by AND gm.gym_id = ump.gym_id LIMIT 1) AS applied_by_name
  FROM user_membership_promotions ump
  JOIN promotions p ON p.id = ump.promotion_id
`;

export const membershipPromotionsRouter = Router({ mergeParams: true });

// mysql2 may return DATE columns as Date objects rather than strings depending
// on the connection's timezone config (same note as user-memberships.ts) — the
// fee resolver compares dates as strings.
function toDateOnly(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

// #635 stage 5: a Promotion's Membership Fee Benefit — one row per Promotion
// in `promotion_membership_fee_benefits` (migration 179). The snapshot used to
// carry three arrays (`charge_benefits`, `period_benefits`,
// `included_benefits`) keyed to the `charge_types` pseudo-catalog; only their
// `membership_fee` entries ever meant anything to billing, and all three
// tables are gone. Snapshots written before this stage keep their old shape —
// `membershipFeeBenefitsFromSnapshot()` below is what reads them.
export interface SnapshotMembershipFeeBenefit {
  quantity: number;
  frequency_interval: number;
  frequency_unit: string;
  enabled: boolean;
  action: string | null;
  value: number | null;
  duration_months: number | null;
}

interface PromotionSnapshot {
  name: string;
  description: string | null;
  stackable: boolean;
  starts_at: string;
  ends_at: string;
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  // 0 or 1 entry: a Promotion has at most one Membership Fee Benefit. An
  // array rather than a nullable object because a *legacy* snapshot could
  // carry two (a Charge Benefit and a Period Benefit on the membership fee,
  // both applied), and folding them loses what that assignment was charged.
  membership_fee_benefits: SnapshotMembershipFeeBenefit[];
}

type Queryable = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

type LiveBenefits = Pick<PromotionSnapshot, 'membership_fee_benefits'>;

// Shared by buildPromotionSnapshot (below, applied at INSERT time) and the
// GET / handler's live-join fallback for rows applied before migration 149
// (snapshot IS NULL) — those never got a snapshot, so their benefit
// breakdown can only be read from the promotion's *current* definition.
// Exported for reuse by user-memberships.ts's Billing Events range
// computation (#511 stage 3), which needs the same Membership Fee benefit
// for legacy (snapshot IS NULL) promotion applications.
export async function fetchLiveBenefits(exec: Queryable, promotionId: number): Promise<LiveBenefits> {
  const { rows } = await exec.query(
    `SELECT quantity, frequency_interval, frequency_unit, enabled, action, value, duration_months
     FROM promotion_membership_fee_benefits
     WHERE promotion_id = ?`,
    [promotionId],
  );
  return {
    membership_fee_benefits: rows.map((r: any) => ({
      quantity: r.quantity, frequency_interval: r.frequency_interval, frequency_unit: r.frequency_unit,
      enabled: !!r.enabled, action: r.action ?? null,
      value: r.value != null ? parseFloat(r.value) : null,
      duration_months: r.duration_months ?? null,
    })),
  };
}

/**
 * #635 stage 5: the Membership Fee benefits an applied Promotion froze onto
 * itself, read out of `user_membership_promotions.snapshot` in whichever
 * shape that snapshot was written in.
 *
 * Snapshots written from this stage on carry `membership_fee_benefits`
 * directly. Older ones carry `charge_benefits` and `period_benefits` arrays
 * keyed to the `charge_types` catalog, of which only the `membership_fee`
 * entries ever affected billing. A legacy Charge Benefit applied for as long
 * as the promotion did, which is exactly an enabled benefit with no duration
 * — so it reads back here as one, and prices identically wherever a
 * Membership Fee Benefit prices at all.
 *
 * The one place it does not is the Billing Simulation, which resolves the
 * first entry through the Promotion's timeline (#625: a benefit belongs to a
 * promotional period). A snapshot carrying only a Charge Benefit therefore
 * projects like any other Membership Fee Benefit from #635 stage 5 on, rather
 * than applying in free/bonus/regular periods too — see migration 179's
 * header for why that is the intended end state.
 */
export function membershipFeeBenefitsFromSnapshot(snap: any): SnapshotMembershipFeeBenefit[] {
  if (!snap) return [];
  if (Array.isArray(snap.membership_fee_benefits)) return snap.membership_fee_benefits;

  const isMembershipFee = (b: any) => b?.charge_type_code === 'membership_fee';
  const legacyCharge: SnapshotMembershipFeeBenefit[] = (snap.charge_benefits ?? [])
    .filter(isMembershipFee)
    .map((b: any) => ({
      quantity: 1, frequency_interval: 1, frequency_unit: 'month',
      enabled: true, action: b.action ?? null, value: b.value ?? null, duration_months: null,
    }));
  const legacyPeriod: SnapshotMembershipFeeBenefit[] = (snap.period_benefits ?? [])
    .filter(isMembershipFee)
    .map((b: any) => ({
      quantity: b.quantity ?? 1, frequency_interval: b.frequency_interval ?? 1,
      frequency_unit: b.frequency_unit ?? 'month', enabled: !!b.enabled,
      action: b.action ?? null, value: b.value ?? null, duration_months: b.duration_months ?? null,
    }));
  // Period benefit first: it is the one the Promotion timeline reads (see
  // cachePromotionTimeline in domain/billingSimulation.ts), and a legacy
  // Charge Benefit stacked on top of it rather than replacing it.
  return [...legacyPeriod, ...legacyCharge];
}

// #511 (stage 2): captures everything needed to reproduce what a promotion
// granted at the moment it's applied to an Assigned Plan, so a later edit to
// the promotion's own definition (rename, discount change, deactivation)
// never rewrites the Assigned Plan's historical record. Modelled on the
// assignment-time snapshot pattern #376 introduced for Plan Charge Benefits
// (retired in #635 stage 4), just as a single JSON column instead of
// relational rows, since this data is display/history-only and never joined
// against for business logic.
async function buildPromotionSnapshot(tx: Tx, gymId: string, promotionId: number): Promise<PromotionSnapshot | null> {
  const { rows: promoRows } = await tx.query(
    `SELECT name, description, stackable, starts_at, ends_at, free_months, paid_months, bonus_months
     FROM promotions WHERE id = ? AND gym_id = ?`,
    [promotionId, gymId],
  );
  if (promoRows.length === 0) return null;
  const promo = promoRows[0];
  const benefits = await fetchLiveBenefits(tx, promotionId);

  return {
    name: promo.name,
    description: promo.description ?? null,
    stackable: !!promo.stackable,
    starts_at: promo.starts_at,
    ends_at: promo.ends_at,
    free_months: promo.free_months ?? null,
    paid_months: promo.paid_months ?? null,
    bonus_months: promo.bonus_months ?? null,
    ...benefits,
  };
}

// #635 stage 2 — the Sellable Items a Promotion grants, frozen onto the
// application the moment it is applied.
//
// Migration 156 created these three tables for exactly this and left them
// unwritten ("the assignment flow that populates these is out of scope for
// this ticket"), with only the item's name and quantity. Migration 174 adds
// the pricing columns, because a name and a quantity cannot reproduce a
// charge: §16/§17 require that repricing a Sellable Item, or editing the
// Promotion's benefits, leave an already-applied Promotion alone.
//
// `gym_charges` is joined without a `deleted_at` filter (as everywhere else a
// snapshot is taken) so an item retired later still reads back with its real
// name and price rather than disappearing from the record. `gym_charge_name`
// is NOT NULL while `gym_charges.name`/`.type` are nullable (a system charge
// displays under its `charge_types` name), so both resolve the same fallback
// `assigned-plan-snapshot.ts` and migration 174 use — otherwise applying a
// Promotion that grants a system item would fail on the insert.
const PROMOTION_GRANT_SNAPSHOTS: {
  category: SellableItemBenefitCategory; source: string; target: string;
}[] = [
  { category: 'session', source: 'promotion_session', target: 'user_membership_promotion_session_snapshot' },
  { category: 'oneoff', source: 'promotion_oneoff', target: 'user_membership_promotion_oneoff_snapshot' },
  { category: 'periodical', source: 'promotion_periodical', target: 'user_membership_promotion_periodical_snapshot' },
];

async function snapshotPromotionGrants(
  tx: Tx, gymId: string, userMembershipPromotionId: number, promotionId: number,
): Promise<void> {
  for (const { source, target } of PROMOTION_GRANT_SNAPSHOTS) {
    await tx.query(
      `INSERT INTO ${target}
         (gym_id, user_membership_promotion_id, gym_charge_id, gym_charge_name, quantity,
          item_type, item_billing_frequency, unit_price, currency)
       SELECT ?, ?, b.gym_charge_id,
              COALESCE(gc.name, ct.name, CONCAT('Sellable Item #', gc.id)), b.quantity,
              COALESCE(gc.type, 'other'), gc.billing_frequency,
              COALESCE(gc.amount, 0), gc.currency
       FROM ${source} b
       JOIN gym_charges gc ON gc.id = b.gym_charge_id
       LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
       WHERE b.promotion_id = ? AND b.gym_id = ?`,
      [gymId, userMembershipPromotionId, promotionId, gymId],
    );
  }
}

// Merges a row's `snapshot` (if present — only populated going forward, see
// migration 149) over its live-joined promotion fields, so historically
// applied promotions display what was actually granted rather than the
// promotion's current, possibly since-edited, definition. Rows applied
// before migration 149 have no snapshot; the caller (GET / below) fills
// their benefit arrays from a live join instead.
async function withSnapshot(row: any) {
  const snap = row.snapshot as PromotionSnapshot | null;
  if (snap) {
    return {
      ...row,
      promotion_name: snap.name,
      promotion_description: snap.description,
      stackable: snap.stackable,
      starts_at: snap.starts_at,
      ends_at: snap.ends_at,
      free_months: snap.free_months,
      paid_months: snap.paid_months,
      bonus_months: snap.bonus_months,
      membership_fee_benefits: membershipFeeBenefitsFromSnapshot(snap),
    };
  }
  const live = await fetchLiveBenefits(db, row.promotion_id);
  return { ...row, ...live };
}

/**
 * Which `(application, duration_months)` pairs are still inside their window,
 * as MySQL itself decides it: `applied_at + INTERVAL n MONTH > NOW()`.
 *
 * The durations come out of each application's snapshot JSON, so the check
 * cannot be a plain join any more (#635 stage 7) — but it stays in SQL rather
 * than being re-derived in JS, because `applied_at` is a database timestamp
 * and month arithmetic clamps at end of month. One round trip for the whole
 * set; a benefit with no duration never reaches here (it never expires).
 */
async function effectiveDurations(
  tx: Tx, pairs: { applicationId: number; months: number }[],
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const { rows } = await tx.query(
    pairs.map(() => `
      SELECT ? AS application_id, ? AS months,
             (applied_at + INTERVAL ? MONTH > NOW()) AS in_effect
      FROM user_membership_promotions WHERE id = ?`).join(' UNION ALL '),
    pairs.flatMap((p) => [p.applicationId, p.months, p.months, p.applicationId]),
  );
  return new Set(
    (rows as any[])
      .filter((r) => Number(r.in_effect) === 1)
      .map((r) => `${r.application_id}:${r.months}`),
  );
}

/**
 * Every application still standing on this assignment, as the shared fee rule
 * needs it — read inside the caller's transaction, because `computeFinalPrice`
 * runs immediately after the apply/revoke that changed the set (the `db`-scoped
 * `loadPromotionApplications` would not see it yet).
 *
 * §16 precedence, the same as everywhere else: the application's own snapshot
 * owns its benefits *and* its Free/Paid/Bonus months; only an application with
 * no snapshot at all (applied before migration 149) reads the Promotion live.
 * `pay_beforehand_months` was never snapshotted, so it is always live.
 */
async function loadStandingApplicationsForPricing(
  tx: Tx, gymId: string, userMembershipId: number,
): Promise<AppliedPromotionForBilling[]> {
  const { rows } = await tx.query(
    `SELECT ump.id, ump.promotion_id, ump.snapshot, ump.applied_at, ump.revoked_at,
            p.name AS promotion_name, p.free_months, p.paid_months, p.bonus_months,
            p.pay_beforehand_months
     FROM user_membership_promotions ump
     LEFT JOIN promotions p ON p.id = ump.promotion_id
     WHERE ump.user_membership_id = ? AND ump.gym_id = ? AND ump.status = 'applied'
     ORDER BY ump.applied_at ASC, ump.id ASC`,
    [userMembershipId, gymId],
  );
  return Promise.all(rows.map(async (row: any) => {
    const snap = row.snapshot as PromotionSnapshot | null;
    const benefits = snap
      ? membershipFeeBenefitsFromSnapshot(snap)
      : (await fetchLiveBenefits(tx, row.promotion_id)).membership_fee_benefits;
    const num = (v: unknown) => Math.max(0, Math.trunc(Number(v)) || 0);
    return {
      name: (snap?.name as string | undefined) ?? row.promotion_name ?? null,
      appliedAt: toDateOnly(row.applied_at),
      revokedAt: row.revoked_at != null ? toDateOnly(row.revoked_at) : null,
      freeMonths: num(snap?.free_months ?? row.free_months),
      paidMonths: num(snap?.paid_months ?? row.paid_months),
      bonusMonths: num(snap?.bonus_months ?? row.bonus_months),
      payBeforehandMonths: num(row.pay_beforehand_months),
      membershipFeeBenefits: benefits.map((b): MembershipFeeBenefit => ({
        action: (b.action ?? null) as MembershipFeeBenefit['action'],
        value: b.value ?? null,
        enabled: !!b.enabled,
        durationMonths: b.duration_months ?? null,
      })),
    };
  }));
}

/**
 * The cycle `final_price` speaks for: the next one this assignment will actually
 * be charged. "The agreed price" is only meaningful on a date once a Promotion's
 * benefit can end (#635 stage 12), and this is the date the member's next charge
 * falls on.
 *
 * Never a date already past, even when `next_billing_date` is (an assignment
 * whose run was missed, or a fixture): the column is read as "what this member
 * pays now", so pricing it on a cycle from before the Promotion was even applied
 * would report a discount the staff screen had just been asked to add. And never
 * before `starts_at` — nothing is waived, or discounted, before the contract it
 * belongs to begins.
 */
function pricingDateFor(um: any): string {
  const startsAt = toDateOnly(um.starts_at);
  const today = new Date().toISOString().slice(0, 10);
  const next = um.next_billing_date != null ? toDateOnly(um.next_billing_date) : startsAt;
  const date = next > today ? next : today;
  return date > startsAt ? date : startsAt;
}

async function computeFinalPrice(tx: Tx, gymId: string, userMembershipId: number) {
  const { rows: umRows } = await tx.query(
    `SELECT um.id, um.member_id, um.membership_plan_id, um.base_price, um.final_price,
            um.membership_fee_price, um.starts_at, um.next_billing_date,
            um.free_months, um.paid_months, um.bonus_months, um.pay_beforehand_months,
            p.free_months AS plan_free_months,
            p.paid_months AS plan_paid_months,
            p.bonus_months AS plan_bonus_months,
            p.pay_beforehand_months AS plan_pay_beforehand_months,
            (um.free_months IS NOT NULL OR um.paid_months IS NOT NULL OR um.pay_beforehand_months IS NOT NULL
             OR um.bonus_months IS NOT NULL OR um.recurring_billing_interval IS NOT NULL
             OR um.recurring_billing_unit IS NOT NULL OR um.membership_fee_price IS NOT NULL
            ) AS has_billing_snapshot
     FROM user_memberships um
     LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
     WHERE um.id = ? AND um.gym_id = ?`,
    [userMembershipId, gymId],
  );
  if (umRows.length === 0) return null;
  const um = umRows[0];
  const previousFinal = um.final_price != null ? parseFloat(um.final_price) : null;

  // #635 stage 12 — the corrected rule: the fee this assignment owes on the
  // cycle it is about to be charged, resolved by `resolveMembershipFee`, so a
  // Promotion's Membership Fee Benefit stops with the Promotion's own
  // Free/Paid/Bonus timeline instead of surviving forever in this column.
  //
  // The regular price it starts from is `regularMembershipFee()` — the assignment's
  // own frozen fee (§13), else its Plan's price window — never `base_price`: that
  // column is snapshotted from `effectivePrice()`, which has returned a constant 0
  // since migration 058 dropped `membership_plans.base_price`, so the legacy path
  // below discounts from zero for every assignment created through the API.
  if (await isDateAwareMembershipFeeEnabled()) {
    const regular = (await regularMembershipFee(gymId, um, toDateOnly(um.starts_at)))
      ?? parseFloat(um.base_price);
    const charge = resolveMembershipFee(regular, pricingDateFor(um), {
      startsAt: toDateOnly(um.starts_at),
      planDuration: Number(um.has_billing_snapshot) === 1
        ? toPlanDuration(um.free_months, um.paid_months, um.bonus_months, um.pay_beforehand_months)
        : toPlanDuration(um.plan_free_months, um.plan_paid_months, um.plan_bonus_months, um.plan_pay_beforehand_months),
      promotions: await loadStandingApplicationsForPricing(tx, gymId, userMembershipId),
    });
    return { price: charge.amount, member_id: um.member_id, previousFinal };
  }
  // ── The pre-stage-12 rule, kept until the flag above is switched on ──────
  //
  // A standing application's Membership Fee Benefit applies whatever the date,
  // gated only by its own `duration_months`: a Promotion whose promotional
  // months have elapsed keeps discounting. That is the overcharge/undercharge
  // the drift report quantifies before the corrected rule moves any money.
  //
  // base_price is snapshotted onto the membership at assignment time (see
  // effectivePrice() in user-memberships.ts) and is never null — membership_plans
  // itself has carried no price column since migration 058, so there is no plan
  // fallback to join for.
  let price = parseFloat(um.base_price);

  // #487 stage 3: the Membership Fee Benefit's action/value affects real
  // billing, gated by `duration_months` counted from when the promotion was
  // applied (`ump.applied_at`); a NULL duration means no expiration.
  // `quantity`/`frequency_interval`/`frequency_unit` are left alone here:
  // they describe how a count-based benefit recurs, not whether the
  // Membership Fee action is currently in effect.
  //
  // #635 stage 5: one benefit, one table. This used to be two — the same
  // benefit was configurable as a `promotion_charge_benefits` row (applying
  // for as long as the promotion was applied) *and* as a
  // `promotion_period_benefits` row, and both were applied in turn. Both
  // tables are gone (migration 179) and their membership-fee rows migrated
  // into `promotion_membership_fee_benefits`.
  //
  // #635 stage 7: it is read from the *application's* snapshot rather than
  // joined live off the Promotion. This was the last path by which editing a
  // Promotion could still move an existing assignment's price (§13/§16):
  // final_price is recomputed at every apply/revoke, so a Promotion repriced
  // between two of them used to reprice everything already applied. Only an
  // application with no snapshot (applied before migration 149) still reads
  // the Promotion's current definition — it has nothing else to read.
  const { rows: applications } = await tx.query(
    `SELECT id, promotion_id, snapshot
     FROM user_membership_promotions
     WHERE user_membership_id = ? AND gym_id = ? AND status = 'applied'
     ORDER BY applied_at ASC, id ASC`,
    [userMembershipId, gymId],
  );
  const perApplication = await Promise.all(applications.map(async (app: any) => ({
    id: app.id as number,
    benefits: app.snapshot
      ? membershipFeeBenefitsFromSnapshot(app.snapshot)
      : (await fetchLiveBenefits(tx, app.promotion_id)).membership_fee_benefits,
  })));
  const effective = await effectiveDurations(
    tx,
    perApplication.flatMap(({ id, benefits }) => benefits
      .filter((b) => b.enabled && b.action != null && b.duration_months != null)
      .map((b) => ({ applicationId: id, months: b.duration_months as number }))),
  );
  for (const { id, benefits } of perApplication) {
    for (const b of benefits) {
      if (!b.enabled || b.action == null) continue;
      if (b.duration_months != null && !effective.has(`${id}:${b.duration_months}`)) continue;
      price = applyPeriodBenefit(price, b.action as PromotionBenefitAction, b.value ?? null);
    }
  }

  return { price, member_id: um.member_id, previousFinal };
}

/**
 * #628: validates a whole set of Promotions against the Membership Plan they
 * are about to be assigned with, *before* anything is written.
 *
 * It re-states, over N promotions at once, exactly the per-promotion checks
 * `applyPromotionToMembership` runs one at a time (exists / active / inside
 * its window / targets this plan), plus the cross-promotion stacking rule
 * from `validatePromotionStacking`. Assigning a Plan creates the membership
 * first and applies the Promotions right after, so an invalid selection has
 * to be rejected up front — otherwise the assignment would already be
 * persisted by the time the first apply fails.
 */
export async function validatePromotionSelection(
  gymId: string,
  membershipPlanId: number,
  promotionIds: number[],
  memberId: number,
): Promise<{ status: number; error: string } | null> {
  if (promotionIds.length === 0) return null;

  const placeholders = promotionIds.map(() => '?').join(',');
  const { rows } = await db.query(
    `SELECT id, stackable, lifecycle_status, starts_at, ends_at, only_applicable_for_new_members
     FROM promotions
     WHERE id IN (${placeholders}) AND gym_id = ? AND lifecycle_status != 'deleted'`,
    [...promotionIds, gymId],
  );

  const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));
  const now = new Date();
  for (const id of promotionIds) {
    const promo = byId.get(id);
    if (!promo) return { status: 404, error: `Promotion ${id} not found` };
    if (promo.lifecycle_status !== 'active') return { status: 400, error: `Promotion ${id} is inactive` };
    if (new Date(promo.starts_at) > now || new Date(promo.ends_at) < now) {
      return { status: 400, error: `Promotion ${id} is outside its active window` };
    }
  }

  const { rows: targeted } = await db.query(
    `SELECT promotion_id FROM promotion_membership_plans
     WHERE promotion_id IN (${placeholders}) AND membership_plan_id = ? AND gym_id = ?`,
    [...promotionIds, membershipPlanId, gymId],
  );
  const targetedIds = new Set(targeted.map((r: any) => Number(r.promotion_id)));
  for (const id of promotionIds) {
    if (!targetedIds.has(id)) {
      return { status: 400, error: `Promotion ${id} doesn't target this membership's plan` };
    }
  }

  // #634 §3: the assignment this selection is validated for does not exist yet
  // — it is created right after — so it is evaluated as a pending one, which
  // makes this answer identical to the one `applyPromotionToMembership` reaches
  // on the real row moments later. Every plan the Member already holds counts
  // against them. Evaluated once for the whole selection, and only when some
  // promotion actually asks for it.
  if (promotionIds.some((id) => !!byId.get(id).only_applicable_for_new_members)) {
    const isNew = await isNewMemberForNewAssignment(db, gymId, memberId);
    if (!isNew) {
      const blocked = promotionIds.find((id) => !!byId.get(id).only_applicable_for_new_members);
      return { status: 400, error: `Promotion ${blocked} is only applicable for new members` };
    }
  }

  const stacking = validatePromotionStacking(
    promotionIds.map((id) => ({ id, stackable: !!byId.get(id).stackable })),
  );
  if (!stacking.ok) return { status: 400, error: stacking.error };

  return null;
}

export async function applyPromotionToMembership(
  gymId: string,
  userId: string,
  source: string,
  umId: number,
  promotionId: number,
): Promise<{ user_membership_id: number; promotion_id: number; final_price: number }> {
  return db.transaction(async (tx) => {
    const { rows: umRows } = await tx.query(
      'SELECT id, member_id, membership_plan_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
      [umId, gymId],
    );
    if (umRows.length === 0) throw Object.assign(new Error('Membership not found'), { status: 404 });
    const um = umRows[0];

    const { rows: promoRows } = await tx.query(
      `SELECT id, stackable, lifecycle_status, starts_at, ends_at, only_applicable_for_new_members
       FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'`,
      [promotionId, gymId],
    );
    if (promoRows.length === 0) throw Object.assign(new Error('Promotion not found'), { status: 404 });
    const promo = promoRows[0];
    if (promo.lifecycle_status !== 'active') throw Object.assign(new Error('Promotion is inactive'), { status: 400 });
    const now = new Date();
    if (new Date(promo.starts_at) > now || new Date(promo.ends_at) < now) {
      throw Object.assign(new Error('Promotion is outside its active window'), { status: 400 });
    }

    const { rows: matchRows } = await tx.query(
      'SELECT 1 FROM promotion_membership_plans WHERE promotion_id = ? AND membership_plan_id = ? AND gym_id = ?',
      [promotionId, um.membership_plan_id, gymId],
    );
    if (matchRows.length === 0) {
      throw Object.assign(new Error("Promotion doesn't target this membership's plan"), { status: 400 });
    }

    // #634 §3 — "Only applicable for new members", excluding the assignment
    // being configured (see new-member-eligibility.ts).
    if (promo.only_applicable_for_new_members && !(await isNewMember(tx, gymId, um.member_id, umId))) {
      throw Object.assign(new Error(NEW_MEMBERS_ONLY_ERROR), { status: 400 });
    }

    if (!promo.stackable) {
      const { rows: existing } = await tx.query(
        "SELECT id FROM user_membership_promotions WHERE user_membership_id = ? AND status = 'applied'",
        [umId],
      );
      if (existing.length > 0) throw Object.assign(new Error('This promotion is not stackable with another already applied'), { status: 409 });
    }

    // #635 stage 9, as in the POST handler above: only a *standing* application
    // blocks the pair (`ump_one_standing_per_promotion`, migration 183), and a
    // re-apply is a new application carrying its own snapshot.
    const { rows: standing } = await tx.query(
      "SELECT id FROM user_membership_promotions WHERE user_membership_id = ? AND promotion_id = ? AND gym_id = ? AND status = 'applied'",
      [umId, promotionId, gymId],
    );
    if (standing.length > 0) {
      throw Object.assign(new Error('This promotion is already applied to this membership'), { status: 409 });
    }

    const snapshot = await buildPromotionSnapshot(tx, gymId, promotionId);
    let applicationId: number;
    try {
      const { insertId } = await tx.query(
        "INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status, snapshot) VALUES (?, ?, ?, ?, 'applied', ?)",
        [gymId, umId, promotionId, userId, snapshot != null ? JSON.stringify(snapshot) : null],
      );
      applicationId = insertId;
    } catch (e: any) {
      if (e.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('This promotion is already applied to this membership'), { status: 409 });
      throw e;
    }
    await snapshotPromotionGrants(tx, gymId, applicationId, promotionId);

    const calc = await computeFinalPrice(tx, gymId, umId);
    if (!calc) throw Object.assign(new Error('Recompute failed'), { status: 500 });
    const prevFinal = calc.previousFinal;
    await tx.query('UPDATE user_memberships SET final_price = ? WHERE id = ? AND gym_id = ?', [calc.price, umId, gymId]);

    if (prevFinal !== null && Math.abs(prevFinal - calc.price) > 0.001) {
      const { rows: ctRows } = await tx.query("SELECT id FROM charge_types WHERE code = 'membership_fee'");
      const chargeTypeId = ctRows[0]?.id ?? null;
      await tx.query(
        `INSERT INTO billing_events
         (gym_id, user_membership_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
         VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, 'Promotion applied')`,
        [gymId, umId, calc.member_id, chargeTypeId, source, userId, calc.price - prevFinal],
      );
    }
    return { user_membership_id: umId, promotion_id: promotionId, final_price: calc.price };
  });
}

/* ── Stage 7: what an application granted, for the Assigned Plan card ────── */

/** One Sellable Item an applied Promotion granted, at the price it was agreed at. */
export interface AppliedPromotionGrant {
  gym_charge_id: number | null;
  item_name: string;
  quantity: number;
  item_billing_frequency: string | null;
  unit_price: number;
}

export type AppliedPromotionGrants = Record<'session_grants' | 'oneoff_grants' | 'periodical_grants', AppliedPromotionGrant[]>;

const GRANT_FIELD: Record<SellableItemBenefitCategory, keyof AppliedPromotionGrants> = {
  session: 'session_grants',
  oneoff: 'oneoff_grants',
  periodical: 'periodical_grants',
};

function emptyGrants(): AppliedPromotionGrants {
  return { session_grants: [], oneoff_grants: [], periodical_grants: [] };
}

/**
 * #635 stage 7 — the Sellable Items each application granted, keyed by
 * `user_membership_promotions.id`.
 *
 * The rows come from the application's own snapshot
 * (`snapshotPromotionGrants()` above), which is why a later rename, reprice or
 * deletion of the Sellable Item — or an edit to the Promotion's own benefits —
 * leaves them where they were (§16/§17). Reusing
 * `loadPromotionGrantSnapshots()` keeps the card and the Billing Simulation
 * reading one loader, so they can never disagree about what was granted.
 *
 * An application with no snapshot rows at all predates the snapshot flow; it
 * falls back to the Promotion's live benefits, exactly as the simulation's
 * caller does, so history still shows something rather than nothing.
 */
async function loadAppliedPromotionGrants(
  gymId: string, applications: { id: number; promotion_id: number }[],
): Promise<Map<number, AppliedPromotionGrants>> {
  const byApplication = new Map<number, AppliedPromotionGrants>();
  if (applications.length === 0) return byApplication;

  const snapshots = await loadPromotionGrantSnapshots(gymId, applications.map((a) => a.id));
  for (const [applicationId, grants] of snapshots) {
    const shaped = emptyGrants();
    for (const g of grants) {
      shaped[GRANT_FIELD[g.category]].push({
        gym_charge_id: g.gymChargeId || null,
        item_name: g.name,
        quantity: g.quantity,
        item_billing_frequency: g.billingFrequency,
        unit_price: g.unitPrice,
      });
    }
    byApplication.set(applicationId, shaped);
  }

  const legacy = applications.filter((a) => !byApplication.has(a.id));
  if (legacy.length === 0) return byApplication;

  const promotionIds = [...new Set(legacy.map((a) => a.promotion_id))];
  const marks = promotionIds.map(() => '?').join(',');
  const { rows } = await db.query(
    PROMOTION_GRANT_SNAPSHOTS.map(({ category, source }) => `
      SELECT '${category}' AS category, b.promotion_id, b.gym_charge_id, b.quantity,
             COALESCE(gc.name, ct.name, CONCAT('Sellable Item #', gc.id)) AS item_name,
             gc.billing_frequency AS item_billing_frequency, COALESCE(gc.amount, 0) AS unit_price
      FROM ${source} b
      JOIN gym_charges gc ON gc.id = b.gym_charge_id
      LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
      WHERE b.gym_id = ? AND b.promotion_id IN (${marks})`).join(' UNION ALL '),
    PROMOTION_GRANT_SNAPSHOTS.flatMap(() => [gymId, ...promotionIds]),
  );
  const livePerPromotion = new Map<number, AppliedPromotionGrants>();
  for (const row of rows as any[]) {
    const shaped = livePerPromotion.get(row.promotion_id) ?? emptyGrants();
    shaped[GRANT_FIELD[row.category as SellableItemBenefitCategory]].push({
      gym_charge_id: row.gym_charge_id ?? null,
      item_name: row.item_name,
      quantity: Number(row.quantity),
      item_billing_frequency: row.item_billing_frequency ?? null,
      unit_price: row.unit_price != null ? Number(row.unit_price) : 0,
    });
    livePerPromotion.set(row.promotion_id, shaped);
  }
  for (const application of legacy) {
    byApplication.set(application.id, livePerPromotion.get(application.promotion_id) ?? emptyGrants());
  }
  return byApplication;
}

// #511 (stage 3): shared by GET / here and GET /user-memberships/:id's
// expanded-detail response (see user-memberships.ts), so both surfaces list
// exactly the same applied-promotions data instead of duplicating the query.
//
// #635 stage 7 adds what the Assigned Plan's expandable Promotion card shows:
// who applied it, how it reads today (`display_status`), and the Sellable
// Items it granted at their agreed prices — all of it from the application's
// own snapshot, so the Promotion may be edited or deleted without moving it.
//
// #635 stage 9 adds `can_reapply`: whether a spent application's checkbox may be
// ticked again (the thread's Q2 answer, "selectable and deselectable"). Decided
// by `canReapplyPromotion()` so the card states it rather than deriving it.
export async function fetchAppliedPromotions(gymId: string, umId: string | number) {
  const { rows } = await db.query(
    `${SELECT} WHERE ump.user_membership_id = ? AND ump.gym_id = ? ORDER BY ump.applied_at DESC, ump.id DESC`,
    [umId, gymId],
  );
  const merged = await Promise.all(rows.map(withSnapshot));
  const grants = await loadAppliedPromotionGrants(
    gymId, merged.map((r: any) => ({ id: r.id, promotion_id: r.promotion_id })),
  );
  // One instant for the whole list, so two applications with the same agreed
  // window can never read differently.
  const now = new Date();
  // Since stage 9 the same Promotion can appear twice on one assignment (one
  // spent application plus the one that replaced it). The standing one holds
  // the pair — `ump_one_standing_per_promotion`, migration 183 — so only a
  // Promotion with none of its own may be selected again.
  const standing = new Set(
    merged
      .filter((row: any) => promotionApplicationStatus(row, now) !== 'inactive')
      .map((row: any) => Number(row.promotion_id)),
  );
  return merged.map((row: any) => {
    const display_status = promotionApplicationStatus(row, now);
    // `standing_promotion_key` is migration 183's generated column — the
    // database's own copy of (assignment, promotion) while the row stands. It
    // rides along on `ump.*` and means nothing to a client, so it is dropped
    // rather than published as part of the card's shape.
    const { standing_promotion_key: _standingKey, ...application } = row;
    return {
      ...application,
      display_status,
      can_reapply: canReapplyPromotion({
        displayStatus: display_status,
        hasStandingApplication: standing.has(Number(row.promotion_id)),
        promotionLifecycleStatus: row.promotion_lifecycle_status ?? null,
        promotionStartsAt: row.promotion_live_starts_at ?? null,
        promotionEndsAt: row.promotion_live_ends_at ?? null,
      }, now),
      ...(grants.get(row.id) ?? emptyGrants()),
    };
  });
}

membershipPromotionsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const umId = (req.params as any).id;
  res.json(await fetchAppliedPromotions(gymId, umId));
});

membershipPromotionsRouter.post('/', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const umId = parseInt((req.params as any).id, 10);
  const { promotion_id } = req.body;
  if (!promotion_id) return res.status(400).json({ error: 'promotion_id is required' });

  try {
    const applied = await db.transaction(async (tx) => {
      // Load target membership
      const { rows: umRows } = await tx.query(
        'SELECT id, member_id, membership_plan_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
        [umId, gymId],
      );
      if (umRows.length === 0) throw Object.assign(new Error('Membership not found'), { status: 404 });
      const um = umRows[0];

      // Load promotion
      const { rows: promoRows } = await tx.query(
        `SELECT id, stackable, lifecycle_status, starts_at, ends_at, only_applicable_for_new_members
         FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'`,
        [promotion_id, gymId],
      );
      if (promoRows.length === 0) throw Object.assign(new Error('Promotion not found'), { status: 404 });
      const promo = promoRows[0];
      if (promo.lifecycle_status !== 'active') throw Object.assign(new Error('Promotion is inactive'), { status: 400 });
      const now = new Date();
      if (new Date(promo.starts_at) > now || new Date(promo.ends_at) < now) {
        throw Object.assign(new Error('Promotion is outside its active window'), { status: 400 });
      }

      // Check plan targeting
      const { rows: matchRows } = await tx.query(
        'SELECT 1 FROM promotion_membership_plans WHERE promotion_id = ? AND membership_plan_id = ? AND gym_id = ?',
        [promotion_id, um.membership_plan_id, gymId],
      );
      if (matchRows.length === 0) {
        throw Object.assign(new Error("Promotion doesn't target this membership's plan"), { status: 400 });
      }

      // #634 §3 — "Only applicable for new members": the Member must not have
      // held another Membership Plan in the trailing 12 months. The assignment
      // this promotion is being added to never counts against them.
      if (promo.only_applicable_for_new_members && !(await isNewMember(tx, gymId, um.member_id, umId))) {
        throw Object.assign(new Error(NEW_MEMBERS_ONLY_ERROR), { status: 400 });
      }

      // Stackability
      if (!promo.stackable) {
        const { rows: existing } = await tx.query(
          "SELECT id FROM user_membership_promotions WHERE user_membership_id = ? AND status = 'applied'",
          [umId],
        );
        if (existing.length > 0) throw Object.assign(new Error('This promotion is not stackable with another already applied'), { status: 409 });
      }

      // #635 stage 9: a Promotion that is *standing* on this assignment cannot
      // be applied a second time; one that was revoked can (the thread's Q2
      // answer — "selectable and deselectable"). Since migration 183 the
      // database enforces exactly that, through
      // `ump_one_standing_per_promotion`; this check is what turns it into the
      // message below instead of a raw duplicate-key error.
      const { rows: standing } = await tx.query(
        "SELECT id FROM user_membership_promotions WHERE user_membership_id = ? AND promotion_id = ? AND gym_id = ? AND status = 'applied'",
        [umId, promotion_id, gymId],
      );
      if (standing.length > 0) {
        throw Object.assign(new Error('This promotion is already applied to this membership'), { status: 409 });
      }

      // Insert row. Re-applying writes a *new* application rather than
      // resurrecting the revoked one: the row owns the snapshot of the
      // Promotion it was agreed with (§16) and its `[applied_at, revoked_at]`
      // window is what the Billing Events range reads, so reusing it would
      // rewrite what the member was already billed under. The snapshot is
      // therefore the Promotion as it is *now* — this is a new agreement, made
      // now, the same rule stage 6 applies to a newly added benefit line.
      const snapshot = await buildPromotionSnapshot(tx, gymId, promotion_id);
      let applicationId: number;
      try {
        const { insertId } = await tx.query(
          "INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status, snapshot) VALUES (?, ?, ?, ?, 'applied', ?)",
          [gymId, umId, promotion_id, userId, snapshot != null ? JSON.stringify(snapshot) : null],
        );
        applicationId = insertId;
      } catch (e: any) {
        if (e.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('This promotion is already applied to this membership'), { status: 409 });
        throw e;
      }
      await snapshotPromotionGrants(tx, gymId, applicationId, Number(promotion_id));

      // Recompute final_price
      const calc = await computeFinalPrice(tx, gymId, umId);
      if (!calc) throw Object.assign(new Error('Recompute failed'), { status: 500 });
      const prevFinal = calc.previousFinal;
      await tx.query(
        'UPDATE user_memberships SET final_price = ? WHERE id = ? AND gym_id = ?',
        [calc.price, umId, gymId],
      );

      // Ledger: adjustment for the delta
      if (prevFinal !== null && Math.abs(prevFinal - calc.price) > 0.001) {
        const { rows: ctRows } = await tx.query("SELECT id FROM charge_types WHERE code = 'membership_fee'");
        const chargeTypeId = ctRows[0]?.id ?? null;
        await tx.query(
          `INSERT INTO billing_events
           (gym_id, user_membership_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
           VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, 'Promotion applied')`,
          [gymId, umId, calc.member_id, chargeTypeId, role === 'admin' ? 'admin' : 'employee', userId, calc.price - prevFinal],
        );
      }
      return { user_membership_id: umId, promotion_id, final_price: calc.price };
    });
    recordAudit(req, { action: 'apply_promotion', entityType: 'user_membership', entityId: umId, next: applied });
    res.status(201).json(applied);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

membershipPromotionsRouter.delete('/:promotionId', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const umId = parseInt((req.params as any).id, 10);
  const promotionId = parseInt(String(req.params.promotionId), 10);
  try {
    const result = await db.transaction(async (tx) => {
      // #511 (stage 3): revoked_at stamps precisely when this promotion
      // stopped affecting billing, so the Billing Events range calculation
      // (assignedPlanBillingEvents.ts) can tell which persisted events fell
      // inside vs. outside its applied window, independent of the row's
      // `status` (kept for backward compatibility / existing callers).
      const { rowCount } = await tx.query(
        "UPDATE user_membership_promotions SET status = 'revoked', revoked_at = UTC_TIMESTAMP() WHERE user_membership_id = ? AND promotion_id = ? AND gym_id = ? AND status = 'applied'",
        [umId, promotionId, gymId],
      );
      if (rowCount === 0) return null;
      const calc = await computeFinalPrice(tx, gymId, umId);
      if (!calc) return null;
      const prevFinal = calc.previousFinal;
      await tx.query('UPDATE user_memberships SET final_price = ? WHERE id = ? AND gym_id = ?', [calc.price, umId, gymId]);
      if (prevFinal !== null && Math.abs(prevFinal - calc.price) > 0.001) {
        const { rows: ctRows } = await tx.query("SELECT id FROM charge_types WHERE code = 'membership_fee'");
        const chargeTypeId = ctRows[0]?.id ?? null;
        await tx.query(
          `INSERT INTO billing_events
           (gym_id, user_membership_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
           VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, 'Promotion revoked')`,
          [gymId, umId, calc.member_id, chargeTypeId, role === 'admin' ? 'admin' : 'employee', userId, calc.price - prevFinal],
        );
      }
      return { final_price: calc.price };
    });
    if (!result) return res.status(404).json({ error: 'Applied promotion not found' });
    recordAudit(req, { action: 'revoke_promotion', entityType: 'user_membership', entityId: umId, next: { promotion_id: promotionId, ...result } });
    res.status(200).json(result);
  } catch (err) { next(err); }
});
