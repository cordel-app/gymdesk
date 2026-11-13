import { assignmentLineVersionId } from '../api/assignment-config';
import { db } from '../infra/db';
import { applyConsumption, ConsumedTotal, SPEND_ORDER } from './serviceConsumption';
import { familyWalletOf, inList } from '../api/family-wallet';
import { applyAdjustmentsToGrants, netAdjustments, MANUAL_ADJUSTMENT_KIND, MANUAL_ADJUSTMENT_REFERENCE_ID } from './professionalServiceAdjustments';
import { entitlingAssignmentSql } from './planAssignments';

/**
 * #647 stage 1: "which Professional Services does this Member have sessions
 * for, and how many?".
 *
 * The ticket's eligibility rule pairs a `calendar_event`'s Professional
 * Service (migration 168) with the Member's side of the same link. There is
 * no Member↔Professional Service table and no "wallet" — per the answers on
 * the issue thread, a Member reaches a Professional Service *through the
 * Products they hold*, and the counts add up across sources:
 *
 *   > user purchases a 10 class package (personal training) and the
 *   > membership plan contains also 4 personal training sessions […] member
 *   > will have 14 sessions of personal training
 *
 * Three sources hold session-type Products today, and each resolves to
 * Professional Services through `product_professional_services` (#546,
 * migration 153):
 *
 *   1. `user_class_packages` — a purchased package. `sessions_remaining` is
 *      the live, already-decremented balance kept by `package-credits.ts`,
 *      so this source reports what is actually left, not what was bought.
 *   2. `promotion_session` — Session benefits granted by a Promotion applied
 *      to an active assignment (#550). Read live through
 *      `user_membership_promotions`, exactly like
 *      `api/src/api/billing-simulation.ts` does, because the
 *      `user_membership_promotion_session_snapshot` table (migration 156) is
 *      still not written by anything.
 *   3. `member_products_recurrent_snapshot` — Additional Services attached directly to
 *      an assignment (#631), counted only while their window is open and
 *      only when the attached Product is itself a session package.
 *
 *   4. `user_membership_session` — the Session Benefits of the Membership
 *      Plan itself (#635/#918), added by #1189 stage 2. Read from the
 *      **Assigned Plan snapshot**, never the live `membership_plan_session`
 *      catalogue (#635 §13–§17), and counted only while the assignment is
 *      `active` — a Draft, a Pending Payment row, a paused or a cancelled one
 *      grants nothing. A renewing Frequency (#918) adds its quantity again on each
 *      renewal (#1227 stage 2: the `plan_allowance_renewals` rows the nightly
 *      run writes), so the grant is `quantity` plus those, less what the consumption ledger (#1189 stage 3) has spent.
 *
 * **Overlapping counts are intentional.** A session package is linked to
 * Professional Services many-to-many (a mixed PT + Physiotherapy package is
 * the case migration 153 calls out), and nothing records how a bundle's
 * sessions split between them. The same credits therefore back every service
 * the item is linked to, so `sessions` answers "how many sessions could be
 * spent on this service", and summing the field across services can exceed
 * the number of credits the Member actually holds. Every grant is listed in
 * `sources` so a caller that needs the underlying balance can see it.
 */

/**
 * #1196: an assignment grants its sessions while it is `active` and, once
 * cancelled, until the paid-through date it was closed with (`ends_at`,
 * inclusive). Wallet kinds that belong to no assignment (a purchased package, a
 * staff correction) are untouched and stay open indefinitely.
 *
 * #2125 M6b-4: only the Additional Services leg (the Product Set's recurring lines) still asks
 * this of `user_memberships`. The plan's own sessions and a Promotion's read the assignment's
 * current plan snapshot through `entitlingAssignmentSql()`, the access readers' predicate.
 */
const ENTITLED_ASSIGNMENT_SQL = "(um.status = 'active' OR (um.status IN ('active_cancel_at_period_end', 'cancelled', 'superseded') AND um.ends_at >= UTC_DATE()))";

export type ProfessionalServiceGrantKind =
  | 'class_package'
  | 'promotion_session'
  | 'membership_service'
  | 'plan_session'
  | 'manual_adjustment';

/** One row as the three loader queries return it, before aggregation. */
export interface ProfessionalServiceGrantRow {
  professional_service_id: number;
  professional_service_name: string;
  kind: ProfessionalServiceGrantKind;
  /** Row id of the granting record — `user_class_packages.id`, `user_membership_promotions.id`, `member_products_recurrent_snapshot.id` (read as `product_periodical_snapshots.source_id`). */
  reference_id: number;
  product_id: number;
  product_name: string;
  sessions: number | string;
  /**
   * #2670 stage 2: the family member who holds the grant (the package's buyer, the
   * assignment's owner, the plan's beneficiary). A family wallet holds every member's
   * grants, and the same plan line covering two members is two grants — the sum the
   * members held before the wallet became the family's. Absent on a manual-adjustment
   * row, which is the family's own.
   */
  holder_member_id?: number;
}

export interface ProfessionalServiceGrant {
  kind: ProfessionalServiceGrantKind;
  reference_id: number;
  product_id: number;
  product_name: string;
  sessions: number;
}

export interface MemberProfessionalService {
  professional_service_id: number;
  name: string;
  /** Sessions spendable on this service. See the overlap note above. */
  sessions: number;
  sources: ProfessionalServiceGrant[];
}

/**
 * Fold grant rows into one entry per Professional Service.
 *
 * Pure — the SQL lives in `loadMemberProfessionalServiceGrants` below, so the
 * counting rules are unit-testable without a database.
 *
 * A grant is identified by (kind, reference_id, product_id) and counted
 * once per Professional Service. The de-duplication is what makes the result
 * independent of JOIN fan-out: two `products` rows tracing back to the same
 * `class_packages` row, or a grant row returned twice by a widening join, must
 * not double the Member's session count.
 *
 * Rows with a non-positive session count are dropped — a consumed package or
 * a zero-quantity benefit grants nothing, and listing it as a source with
 * `sessions: 0` would suggest the service is available when it is not.
 */
export function aggregateProfessionalServiceGrants(
  rows: ProfessionalServiceGrantRow[],
): MemberProfessionalService[] {
  const byService = new Map<number, MemberProfessionalService>();
  const seen = new Set<string>();

  for (const row of rows) {
    const sessions = Number(row.sessions);
    // #1986: a debt (negative manual-adjustment row) is kept; every other
    // non-positive row grants nothing and is dropped.
    if (!Number.isFinite(sessions)) continue;
    if (sessions <= 0 && !(sessions < 0 && row.kind === 'manual_adjustment')) continue;

    const key = `${row.professional_service_id}:${row.kind}:${row.reference_id}:${row.product_id}:${row.holder_member_id ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let entry = byService.get(row.professional_service_id);
    if (!entry) {
      entry = {
        professional_service_id: row.professional_service_id,
        name: row.professional_service_name,
        sessions: 0,
        sources: [],
      };
      byService.set(row.professional_service_id, entry);
    }
    entry.sessions += sessions;
    entry.sources.push({
      kind: row.kind,
      reference_id: row.reference_id,
      product_id: row.product_id,
      product_name: row.product_name,
      sessions,
    });
  }

  return [...byService.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every session-type Product the Member currently holds, expanded to
 * the Professional Services that deliver it.
 *
 * Only services that are visible to the gym and *enabled* for it
 * (`gym_professional_services.status = 'active'`) are returned, matching
 * `validateProfessionalServiceId()` in `professionalServices.ts`: a service
 * the gym has switched off must not make a slot eligible.
 *
 * `products` is not filtered on `deleted_at` — a package stays spendable
 * after the catalogue item behind it is retired, the same rule
 * `billing-simulation.ts` applies to granted items.
 */
export async function loadMemberProfessionalServiceGrants(
  gymId: string,
  memberId: number,
): Promise<ProfessionalServiceGrantRow[]> {
  // #2670 stage 2: the wallet is the Family's — every member's grants, the family's ledger.
  const wallet = await familyWalletOf(db, gymId, memberId);
  const ids = wallet.memberIds;
  const IN = inList(ids);
  // Resolving the Product behind a purchased package through
  // MIN(gc.id) rather than a plain join: `products.class_package_id` (the
  // traceability FK added by migration 103) carries no uniqueness
  // constraint, so a join could return the same package once per
  // duplicated catalogue row.
  const { rows: packageRows } = await db.query<ProfessionalServiceGrantRow>(
    `SELECT ps.id           AS professional_service_id,
            ps.name         AS professional_service_name,
            'class_package' AS kind,
            ucp.id          AS reference_id,
            gc.id           AS product_id,
            gc.name         AS product_name,
            ucp.sessions_remaining AS sessions,
            ucp.member_id   AS holder_member_id
     FROM user_class_packages ucp
     JOIN products gc
       ON gc.id = (SELECT MIN(gc2.id) FROM products gc2
                   WHERE gc2.class_package_id = ucp.class_package_id AND gc2.gym_id = ucp.gym_id)
     JOIN product_professional_services sips
       ON sips.product_id = gc.id AND sips.gym_id = ucp.gym_id
     JOIN professional_services ps
       ON ps.id = sips.professional_service_id AND ps.deleted_at IS NULL
     JOIN gym_professional_services gps
       ON gps.professional_service_id = ps.id AND gps.gym_id = ucp.gym_id AND gps.status = 'active'
     WHERE ucp.gym_id = ? AND ucp.member_id IN ${IN} AND ucp.status = 'active'
       AND ucp.sessions_remaining > 0 AND ucp.expires_at >= UTC_DATE()`,
    [gymId, ...ids],
  );

  // reference_id is the *application* (`user_membership_promotions.id`), not
  // the benefit row: the same Promotion applied to two active assignments
  // grants its sessions twice, and keying on the benefit row would collapse
  // them into one.
  const { rows: promotionRows } = await db.query<ProfessionalServiceGrantRow>(
    `SELECT ps.id               AS professional_service_id,
            ps.name             AS professional_service_name,
            'promotion_session' AS kind,
            ump.id              AS reference_id,
            gc.id               AS product_id,
            gc.name             AS product_name,
            psn.quantity        AS sessions,
            pa.member_id        AS holder_member_id
     FROM plan_snapshots pa
     JOIN user_membership_promotions ump
       ON ump.user_membership_id = pa.source_user_membership_id AND ump.gym_id = pa.gym_id AND ump.status IN ('applied', 'superseded')
     JOIN promotion_session psn
       ON psn.promotion_id = ump.promotion_id AND psn.gym_id = pa.gym_id
     JOIN products gc ON gc.id = psn.product_id
     JOIN product_professional_services sips
       ON sips.product_id = gc.id AND sips.gym_id = pa.gym_id
     JOIN professional_services ps
       ON ps.id = sips.professional_service_id AND ps.deleted_at IS NULL
     JOIN gym_professional_services gps
       ON gps.professional_service_id = ps.id AND gps.gym_id = pa.gym_id AND gps.status = 'active'
     WHERE pa.gym_id = ? AND pa.member_id IN ${IN} AND ${entitlingAssignmentSql('pa')}`,
    [gymId, ...ids],
  );

  // `products.units` is the number of sessions a Session item bundles
  // (migration 103 copies `class_packages.number_of_sessions` into it), so an
  // attachment of quantity 2 of a 10-session item is 20 sessions.
  //
  // #2126 stage 3j: the lines are read from `product_periodical_snapshots`, kept
  // equal to each version's recurring lines by stage 2's dual-write. The grant is
  // still identified by the legacy line id (`source_id`), which is what the
  // consumption ledger's `source_reference_id` holds for this kind.
  const { rows: serviceRows } = await db.query<ProfessionalServiceGrantRow>(
    `SELECT ps.id                 AS professional_service_id,
            ps.name               AS professional_service_name,
            'membership_service'  AS kind,
            umsv.source_id        AS reference_id,
            gc.id                 AS product_id,
            gc.name               AS product_name,
            umsv.quantity * COALESCE(gc.units, 1) AS sessions,
            um.member_id          AS holder_member_id
     FROM user_memberships um
     JOIN product_set_periodical_snapshots umsvl ON umsvl.product_set_id = ${assignmentLineVersionId('um.id')}
     JOIN product_periodical_snapshots umsv
       ON umsv.id = umsvl.product_periodical_snapshot_id AND umsv.gym_id = um.gym_id
          AND umsv.source_id IS NOT NULL
     JOIN products gc ON gc.id = umsv.product_id AND gc.type = 'sessions'
     JOIN product_professional_services sips
       ON sips.product_id = gc.id AND sips.gym_id = um.gym_id
     JOIN professional_services ps
       ON ps.id = sips.professional_service_id AND ps.deleted_at IS NULL
     JOIN gym_professional_services gps
       ON gps.professional_service_id = ps.id AND gps.gym_id = um.gym_id AND gps.status = 'active'
     WHERE um.gym_id = ? AND um.member_id IN ${IN} AND ${ENTITLED_ASSIGNMENT_SQL}
       AND umsv.starts_at <= UTC_DATE()
       AND (umsv.ends_at IS NULL OR umsv.ends_at >= UTC_DATE())`,
    [gymId, ...ids],
  );

  const { rows: planRows } = await db.query<ProfessionalServiceGrantRow>(
    `SELECT ps.id             AS professional_service_id,
            ps.name           AS professional_service_name,
            'plan_session'    AS kind,
            umss.id           AS reference_id,
            gc.id             AS product_id,
            gc.name           AS product_name,
            umss.quantity + COALESCE((SELECT SUM(par.quantity) FROM plan_allowance_renewals par
                                      WHERE par.plan_session_snapshot_id = umss.id), 0) AS sessions,
            umm.member_id     AS holder_member_id
     FROM plan_snapshots pa
     JOIN plan_snapshot_beneficiaries umm
       ON umm.plan_snapshot_id = pa.id AND umm.gym_id = pa.gym_id AND umm.member_id IN ${IN}
     JOIN plan_session_snapshots umss
       ON umss.plan_snapshot_id = pa.id AND umss.gym_id = pa.gym_id
     JOIN products gc ON gc.id = umss.product_id
     JOIN product_professional_services sips
       ON sips.product_id = gc.id AND sips.gym_id = pa.gym_id
     JOIN professional_services ps
       ON ps.id = sips.professional_service_id AND ps.deleted_at IS NULL
     JOIN gym_professional_services gps
       ON gps.professional_service_id = ps.id AND gps.gym_id = pa.gym_id AND gps.status = 'active'
     WHERE pa.gym_id = ? AND ${entitlingAssignmentSql('pa')}
       AND pa.starts_at <= UTC_DATE()
       AND (pa.ends_at IS NULL OR pa.ends_at >= UTC_DATE())`,
    [...ids, gymId],
  );

  // #1189 stage 3: the sessions already spent from the grants that carry no
  // counter of their own. A returned row (`returned_at`) no longer counts.
  // #2670 stage 2: a grant's spends are the rows naming its holder (`member_id`); the
  // manual-adjustment grant is the family's, so its spends are the family's rows.
  const { rows: consumed } = await db.query<ConsumedTotal>(
    `SELECT psc.source_kind, psc.source_reference_id, psc.professional_service_id, ps.name,
            IF(psc.source_kind = 'manual_adjustment', NULL, psc.member_id) AS member_id, COUNT(*) AS consumed
       FROM professional_service_consumptions psc
       JOIN professional_services ps ON ps.id = psc.professional_service_id
      WHERE psc.gym_id = ? AND psc.returned_at IS NULL
        AND psc.source_kind <> 'class_package'
        AND ${walletLedgerScope('psc', wallet.familyId, IN)}
      GROUP BY psc.source_kind, psc.source_reference_id, psc.professional_service_id, ps.name,
               IF(psc.source_kind = 'manual_adjustment', NULL, psc.member_id)`,
    [gymId, ...walletLedgerParams(wallet.familyId, ids)],
  );

  // #1227 stage 1: staff corrections are one more source of the same balance.
  // Consumption is applied to the derived grants first, then the net
  // adjustment per service is folded in, then the sessions spent from the
  // manual-adjustment grant itself are taken off it.
  const { rows: adjustments } = await db.query(
    `SELECT psa.professional_service_id, psa.delta, ps.name
       FROM professional_service_adjustments psa
       JOIN professional_services ps ON ps.id = psa.professional_service_id AND ps.deleted_at IS NULL
       JOIN gym_professional_services gps
         ON gps.professional_service_id = ps.id AND gps.gym_id = psa.gym_id AND gps.status = 'active'
      WHERE psa.gym_id = ? AND ${walletAdjustmentScope('psa', wallet.familyId, IN)}`,
    [gymId, ...walletAdjustmentParams(wallet.familyId, ids)],
  );
  const derived = applyConsumption(
    [...packageRows, ...promotionRows, ...serviceRows, ...planRows],
    consumed.filter((c) => c.source_kind !== MANUAL_ADJUSTMENT_KIND),
  );
  const manualConsumed = consumed.filter((c) => c.source_kind === MANUAL_ADJUSTMENT_KIND);
  if (adjustments.length === 0 && manualConsumed.length === 0) return derived;
  const names = new Map<number, string>(adjustments.map((a: { professional_service_id: number; name: string }) => [a.professional_service_id, a.name]));
  const withAdjustments = applyAdjustmentsToGrants(derived, netAdjustments(adjustments), names, SPEND_ORDER);
  // #1986: sessions spent against a service the Member had no balance on (a
  // staff booking that accepted a negative balance) are consumption of the
  // manual-adjustment grant at reference 0. Where no such grant exists they are
  // a debt, reported as one negative row so the balance reads below zero and a
  // later purchase or correction pays it off.
  const withDebt = [...withAdjustments];
  for (const c of manualConsumed) {
    if (Number(c.source_reference_id) !== MANUAL_ADJUSTMENT_REFERENCE_ID) continue;
    const serviceId = Number(c.professional_service_id);
    if (!Number.isInteger(serviceId) || serviceId <= 0) continue;
    if (withDebt.some((r) => r.professional_service_id === serviceId && r.kind === MANUAL_ADJUSTMENT_KIND)) continue;
    withDebt.push({
      professional_service_id: serviceId,
      professional_service_name: c.name ?? '',
      kind: MANUAL_ADJUSTMENT_KIND,
      reference_id: MANUAL_ADJUSTMENT_REFERENCE_ID,
      product_id: 0,
      product_name: '',
      sessions: 0,
    });
  }
  return applyConsumption(withDebt, manualConsumed);
}

/**
 * #2670 stage 2: which ledger rows (consumptions, reservations) belong to a wallet. A
 * grant's rows follow its holder (`member_id IN` the family), so a grant and its spends
 * move together; the family's own manual-adjustment rows are the family's (`family_id`).
 */
export function walletLedgerScope(alias: string, familyId: number | null, memberIn: string): string {
  return familyId != null
    ? `((${alias}.source_kind <> 'manual_adjustment' AND ${alias}.member_id IN ${memberIn})
        OR (${alias}.source_kind = 'manual_adjustment'
            AND (${alias}.family_id = ? OR (${alias}.family_id IS NULL AND ${alias}.member_id IN ${memberIn}))))`
    : `${alias}.member_id IN ${memberIn}`;
}

export function walletLedgerParams(familyId: number | null, memberIds: number[]): unknown[] {
  return familyId != null ? [...memberIds, familyId, ...memberIds] : [...memberIds];
}

/**
 * #2670 stage 2: the staff corrections of a wallet are the family's (`family_id`); a row
 * written with no family (a writer predating the column) is its member's.
 */
export function walletAdjustmentScope(alias: string, familyId: number | null, memberIn: string): string {
  return familyId != null
    ? `(${alias}.family_id = ? OR (${alias}.family_id IS NULL AND ${alias}.member_id IN ${memberIn}))`
    : `${alias}.member_id IN ${memberIn}`;
}

export function walletAdjustmentParams(familyId: number | null, memberIds: number[]): unknown[] {
  return familyId != null ? [familyId, ...memberIds] : [...memberIds];
}

/** The Member's Professional Services with their session counts, ready to serve. */
export async function resolveMemberProfessionalServices(
  gymId: string,
  memberId: number,
): Promise<MemberProfessionalService[]> {
  return aggregateProfessionalServiceGrants(await loadMemberProfessionalServiceGrants(gymId, memberId));
}
