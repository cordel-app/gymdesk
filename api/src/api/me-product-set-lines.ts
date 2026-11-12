import { db } from '../infra/db';
import { draftExpiresInSeconds, DRAFT_TTL_MINUTES } from '../domain/productSet';
import { loadRecurringLinePromotions } from './member-product-promotions';
import { assignedMemberSql } from '../domain/productAssignee';
import { planSnapshotInheritedSql, PLAN_LINE_CATEGORIES, PLAN_LINE_TABLE } from './plan-snapshot-lines';
import { LIFECYCLE_STATUS_SQL } from './user-memberships';
import { currentMembershipFees } from './membership-fee-pricing';

/**
 * #2496 stage 2 — the member's own view of one Product Set version, read from
 * its frozen line snapshots and each
 * line's applied Promotions' own grant snapshots, so a Draft the Members App
 * builds is shown with the figures that will be committed. Nothing here
 * prices: the unit price, the list price and the direct discount are the
 * line's frozen columns, the Promotion steps are `loadRecurringLinePromotions()`
 * (the Admin's Products list reads the same), and the only live columns read are
 * the Product's own presentation (description and picture).
 *
 * A line is `added` when the version's predecessor has no line with its
 * `line_ref`, else `inherited`; a predecessor line the version no longer
 * carries is listed under `removed_lines`, since a Draft deletes a removed line
 * outright (#1882). `expires_in_seconds` is the server's own countdown (#2477),
 * for a Draft only.
 *
 * #2126 stage 3e: the lines are read from `product_periodical_snapshots`, the
 * recurring Product snapshot table kept equal to each version's lines by stage 2's
 * dual-write (`syncProductSnapshotsOfVersion()`). A line's `id` is still the
 * legacy line id (`source_id`), which the Promotion applications and the line
 * routes are keyed on.
 */
export interface MemberProductSetLine {
  id: number;
  product_id: number;
  product_name: string;
  product_type: string | null;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  quantity: number;
  billing_frequency: string | null;
  starts_at: string | null;
  currency: string;
  unit_price: number;
  list_unit_price: number | null;
  regular_amount: number;
  direct_discount_percent: number | null;
  final_amount: number;
  promotions: unknown[];
  change: 'added' | 'inherited';
  assigned_member_id: number | null;
}

const LINE_COLUMNS = `s.source_id AS id, s.product_id, s.quantity, s.product_name AS item_name,
  p.sharing_type AS sharing_type,
  s.product_type AS item_type, s.unit_price, s.list_price AS list_unit_price, s.direct_discount_percent,
  s.billing_frequency AS item_billing_frequency, s.currency,
  s.starts_at, COALESCE(s.line_ref, s.source_id) AS line_ref,
  p.description, p.image_url, p.image_thumbnail_url`;

async function linesOf(gymId: string, setId: number, ownerSql: string): Promise<any[]> {
  const { rows } = await db.query<any>(
    `SELECT ${LINE_COLUMNS}, ${assignedMemberSql('s', ownerSql)} AS assigned_member_id
       FROM product_periodical_snapshots s
       JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id
       LEFT JOIN products p ON p.id = s.product_id AND p.gym_id = s.gym_id
      WHERE s.gym_id = ? AND s.product_set_id = ? AND s.source_id IS NOT NULL
        AND (s.ends_at IS NULL OR s.ends_at >= CURDATE())
      ORDER BY s.created_at ASC, s.source_id ASC`,
    [gymId, setId],
  );
  return rows;
}

function dateOnly(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One Membership Plan of the version, as the Members App's *My Plans* draws it (#2663). */
export interface MemberProductSetPlan {
  plan_snapshot_id: number;
  membership_plan_id: number | null;
  plan_name: string | null;
  plan_description: string | null;
  /** #2744 — the Plan's picture and cadence, so *My Plans* draws the Add Plan catalogue's card. */
  plan_image_url: string | null;
  plan_image_thumbnail_url: string | null;
  billing_interval: number | null;
  billing_unit: string | null;
  change: 'added' | 'inherited';
  /** The assignment's own lifecycle status, else the version's status for a plan no assignment holds yet. */
  status: string;
  entitlement_only: boolean;
  starts_at: string | null;
  ends_at: string | null;
  membership_fee: number | null;
  discount_reason: string | null;
  beneficiaries: { member_id: number; name: string | null; is_owner: boolean }[];
  benefits: { category: string; product_id: number; name: string; quantity: number; billing_frequency: string | null; unit_price: number; mandatory: boolean }[];
}

/**
 * #2663 — who is reading: the version's owner reads every plan and every line;
 * a covered family member reads only the plans they are a beneficiary of and the
 * lines that are theirs (assigned to them) or the family's (`sharing_type =
 * 'shared'`), so another member's Individual Product is never exposed.
 */
export interface MemberProductSetViewer { memberId: number; ownerMemberId: number }

export async function loadMemberProductSetView(
  gymId: string,
  set: { id: number; status: string; previous_product_set_id: number | null; user_membership_id?: number | null },
  viewer?: MemberProductSetViewer,
) {
  const isOwnerView = !viewer || viewer.memberId === viewer.ownerMemberId;
  const allLines = await linesOf(gymId, Number(set.id), 'ps.owner_member_id');
  const lines = isOwnerView ? allLines : allLines.filter((r) =>
    r.sharing_type === 'shared' || Number(r.assigned_member_id) === viewer!.memberId);
  const previous = set.previous_product_set_id != null
    ? await linesOf(gymId, Number(set.previous_product_set_id), 'ps.owner_member_id') : [];
  const previousRefs = new Set(previous.map((r) => Number(r.line_ref)));
  const currentRefs = new Set(allLines.map((r) => Number(r.line_ref)));

  const promos = await loadRecurringLinePromotions(gymId, lines.map((r) => {
    const unit = Number(r.unit_price);
    return {
      id: Number(r.id), productId: Number(r.product_id),
      listUnit: r.list_unit_price == null ? unit : Number(r.list_unit_price),
      quantity: Number(r.quantity) || 1,
      pct: r.direct_discount_percent == null ? null : Number(r.direct_discount_percent),
    };
  }));

  const shapeLine = (r: any, change: 'added' | 'inherited'): MemberProductSetLine => {
    const quantity = Number(r.quantity) || 1;
    const unit = Number(r.unit_price);
    const listUnit = r.list_unit_price == null ? null : Number(r.list_unit_price);
    const lp = promos.get(Number(r.id));
    return {
      id: Number(r.id),
      product_id: Number(r.product_id),
      product_name: r.item_name,
      product_type: r.item_type ?? null,
      description: r.description ?? null,
      image_url: r.image_url ?? null,
      image_thumbnail_url: r.image_thumbnail_url ?? r.image_url ?? null,
      quantity,
      billing_frequency: r.item_billing_frequency ?? null,
      starts_at: dateOnly(r.starts_at),
      currency: r.currency ?? 'EUR',
      unit_price: unit,
      list_unit_price: listUnit,
      regular_amount: round2((listUnit ?? unit) * quantity),
      direct_discount_percent: r.direct_discount_percent == null ? null : Number(r.direct_discount_percent),
      final_amount: lp?.final ?? round2(unit * quantity),
      promotions: lp?.promotions ?? [],
      change,
      assigned_member_id: r.assigned_member_id == null ? null : Number(r.assigned_member_id),
    };
  };

  let expiresIn: number | null = null;
  if (set.status === 'draft') {
    const { rows } = await db.query<any>(
      `SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), last_activity_at + INTERVAL ${DRAFT_TTL_MINUTES} MINUTE) AS s
         FROM product_sets WHERE id = ? AND gym_id = ?`, [Number(set.id), gymId]);
    expiresIn = draftExpiresInSeconds(rows[0]?.s);
  }

  // #2496 stage 4 — the version's Membership Plans, in link order: `added` for
  // a plan this Draft took (the Members App's Add Plan, removable), `inherited`
  // for the plan the member already holds. #2663: with each plan's status,
  // dates, fee, beneficiaries and included Products, all read off this
  // version's own plan snapshot (and the assignment it names), so *My Plans*
  // never reads a plan from another version. Entitlement-only links (#2659
  // stage 3: a plan that cancels on its end date) are listed too, flagged.
  const { rows: planRows } = await db.query<any>(
    `SELECT s.id AS plan_snapshot_id, s.membership_plan_id, mp.name AS plan_name, mp.description AS plan_description,
            mp.image_url AS plan_image_url, mp.image_thumbnail_url AS plan_image_thumbnail_url,
            COALESCE(s.recurring_billing_interval, bp.recurring_billing_interval) AS billing_interval,
            COALESCE(s.recurring_billing_unit, bp.recurring_billing_unit) AS billing_unit,
            ${planSnapshotInheritedSql('s', 'j.product_set_id')} AS inherited, j.entitlement_only,
            s.starts_at AS snapshot_starts_at, s.ends_at AS snapshot_ends_at,
            s.membership_fee_price, s.discount_reason,
            um.id AS user_membership_id, um.starts_at AS um_starts_at, um.ends_at AS um_ends_at,
            CASE WHEN um.id IS NULL THEN NULL ELSE ${LIFECYCLE_STATUS_SQL} END AS lifecycle_status
       FROM product_set_plan_snapshots j
       JOIN plan_snapshots s ON s.id = j.plan_snapshot_id AND s.gym_id = ?
       JOIN product_sets ps ON ps.id = j.product_set_id
       LEFT JOIN user_memberships um ON um.id = COALESCE(s.source_user_membership_id, ps.user_membership_id) AND um.gym_id = s.gym_id
       LEFT JOIN membership_plans mp ON mp.id = s.membership_plan_id AND mp.gym_id = s.gym_id
       LEFT JOIN billing_policies bp ON bp.membership_plan_id = s.membership_plan_id AND bp.gym_id = s.gym_id
      WHERE j.product_set_id = ? ORDER BY j.entitlement_only, j.id`, [gymId, Number(set.id)]);
  const snapshotIds = planRows.map((r) => Number(r.plan_snapshot_id));
  const beneficiaries = new Map<number, MemberProductSetPlan['beneficiaries']>();
  const benefits = new Map<number, MemberProductSetPlan['benefits']>();
  if (snapshotIds.length > 0) {
    const marks = snapshotIds.map(() => '?').join(',');
    const { rows: bRows } = await db.query<any>(
      `SELECT b.plan_snapshot_id, b.member_id, b.is_owner, m.name
         FROM plan_snapshot_beneficiaries b LEFT JOIN members m ON m.id = b.member_id AND m.gym_id = b.gym_id
        WHERE b.gym_id = ? AND b.plan_snapshot_id IN (${marks}) ORDER BY b.is_owner DESC, b.id`, [gymId, ...snapshotIds]);
    for (const r of bRows) {
      const list = beneficiaries.get(Number(r.plan_snapshot_id)) ?? [];
      list.push({ member_id: Number(r.member_id), name: r.name ?? null, is_owner: Number(r.is_owner) === 1 });
      beneficiaries.set(Number(r.plan_snapshot_id), list);
    }
    for (const category of PLAN_LINE_CATEGORIES) {
      const { rows: lRows } = await db.query<any>(
        `SELECT plan_snapshot_id, product_id, item_name, quantity, item_billing_frequency, unit_price, mandatory
           FROM ${PLAN_LINE_TABLE[category]} WHERE gym_id = ? AND plan_snapshot_id IN (${marks}) ORDER BY item_name, id`,
        [gymId, ...snapshotIds]);
      for (const r of lRows) {
        const list = benefits.get(Number(r.plan_snapshot_id)) ?? [];
        list.push({
          category, product_id: Number(r.product_id), name: r.item_name, quantity: Number(r.quantity) || 1,
          billing_frequency: r.item_billing_frequency ?? null, unit_price: Number(r.unit_price),
          mandatory: Number(r.mandatory) !== 0,
        });
        benefits.set(Number(r.plan_snapshot_id), list);
      }
    }
  }
  // The fee of a plan the version bills now is the one resolver's (#635 stage 12);
  // a Draft's or a pending version's plan is not charged yet, so it reads the
  // regular fee frozen on its own snapshot rather than a running assignment's.
  const pricedIds = set.status === 'active'
    ? planRows.filter((r) => r.user_membership_id != null && Number(r.entitlement_only) === 0).map((r) => Number(r.user_membership_id))
    : [];
  const fees = pricedIds.length > 0 ? await currentMembershipFees(gymId, pricedIds) : new Map<number, number>();
  const plans: MemberProductSetPlan[] = planRows
    .map((r) => {
      const umId = r.user_membership_id == null ? null : Number(r.user_membership_id);
      const fee = umId != null && fees.has(umId) ? fees.get(umId)!
        : r.membership_fee_price != null ? Number(r.membership_fee_price) : null;
      return {
        plan_snapshot_id: Number(r.plan_snapshot_id),
        membership_plan_id: r.membership_plan_id == null ? null : Number(r.membership_plan_id),
        plan_name: r.plan_name ?? null,
        plan_description: r.plan_description ?? null,
        plan_image_url: r.plan_image_url ?? null,
        plan_image_thumbnail_url: r.plan_image_thumbnail_url ?? r.plan_image_url ?? null,
        billing_interval: r.billing_interval == null ? null : Number(r.billing_interval),
        billing_unit: r.billing_unit ?? null,
        change: Number(r.inherited) === 1 ? 'inherited' as const : 'added' as const,
        status: r.lifecycle_status ?? String(set.status),
        entitlement_only: Number(r.entitlement_only) === 1,
        starts_at: dateOnly(r.um_starts_at ?? r.snapshot_starts_at),
        ends_at: dateOnly(r.um_ends_at ?? r.snapshot_ends_at),
        membership_fee: fee == null ? null : round2(fee),
        discount_reason: r.discount_reason ?? null,
        beneficiaries: beneficiaries.get(Number(r.plan_snapshot_id)) ?? [],
        benefits: benefits.get(Number(r.plan_snapshot_id)) ?? [],
      };
    })
    .filter((p) => isOwnerView || p.beneficiaries.some((b) => b.member_id === viewer!.memberId));

  return {
    expires_in_seconds: expiresIn,
    plans,
    lines: lines.map((r) => shapeLine(r, set.previous_product_set_id != null && previousRefs.has(Number(r.line_ref)) ? 'inherited' : 'added')),
    removed_lines: !isOwnerView ? [] : previous
      .filter((r) => !currentRefs.has(Number(r.line_ref)))
      .map((r) => ({
        line_ref: Number(r.line_ref),
        product_id: Number(r.product_id),
        product_name: r.item_name,
        image_thumbnail_url: r.image_thumbnail_url ?? r.image_url ?? null,
        quantity: Number(r.quantity) || 1,
        billing_frequency: r.item_billing_frequency ?? null,
      })),
  };
}
