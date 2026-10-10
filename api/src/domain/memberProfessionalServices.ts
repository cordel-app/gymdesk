import { db } from '../infra/db';
import { applyConsumption, ConsumedTotal, SPEND_ORDER } from './serviceConsumption';
import { applyAdjustmentsToGrants, netAdjustments, MANUAL_ADJUSTMENT_KIND } from './professionalServiceAdjustments';

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
  /** Row id of the granting record — `user_class_packages.id`, `user_membership_promotions.id`, `member_products_recurrent_snapshot.id`. */
  reference_id: number;
  product_id: number;
  product_name: string;
  sessions: number | string;
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
    if (!Number.isFinite(sessions) || sessions <= 0) continue;

    const key = `${row.professional_service_id}:${row.kind}:${row.reference_id}:${row.product_id}`;
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
            ucp.sessions_remaining AS sessions
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
     WHERE ucp.gym_id = ? AND ucp.member_id = ? AND ucp.status = 'active'
       AND ucp.sessions_remaining > 0 AND ucp.expires_at >= UTC_DATE()`,
    [gymId, memberId],
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
            psn.quantity        AS sessions
     FROM user_memberships um
     JOIN user_membership_promotions ump
       ON ump.user_membership_id = um.id AND ump.gym_id = um.gym_id AND ump.status = 'applied'
     JOIN promotion_session psn
       ON psn.promotion_id = ump.promotion_id AND psn.gym_id = um.gym_id
     JOIN products gc ON gc.id = psn.product_id
     JOIN product_professional_services sips
       ON sips.product_id = gc.id AND sips.gym_id = um.gym_id
     JOIN professional_services ps
       ON ps.id = sips.professional_service_id AND ps.deleted_at IS NULL
     JOIN gym_professional_services gps
       ON gps.professional_service_id = ps.id AND gps.gym_id = um.gym_id AND gps.status = 'active'
     WHERE um.gym_id = ? AND um.member_id = ? AND um.status = 'active'`,
    [gymId, memberId],
  );

  // `products.units` is the number of sessions a Session item bundles
  // (migration 103 copies `class_packages.number_of_sessions` into it), so an
  // attachment of quantity 2 of a 10-session item is 20 sessions.
  const { rows: serviceRows } = await db.query<ProfessionalServiceGrantRow>(
    `SELECT ps.id                 AS professional_service_id,
            ps.name               AS professional_service_name,
            'membership_service'  AS kind,
            umsv.id               AS reference_id,
            gc.id                 AS product_id,
            gc.name               AS product_name,
            umsv.quantity * COALESCE(gc.units, 1) AS sessions
     FROM user_memberships um
     JOIN member_products_recurrent_snapshot umsv
       ON umsv.user_membership_id = um.id AND umsv.gym_id = um.gym_id
     JOIN products gc ON gc.id = umsv.product_id AND gc.type = 'sessions'
     JOIN product_professional_services sips
       ON sips.product_id = gc.id AND sips.gym_id = um.gym_id
     JOIN professional_services ps
       ON ps.id = sips.professional_service_id AND ps.deleted_at IS NULL
     JOIN gym_professional_services gps
       ON gps.professional_service_id = ps.id AND gps.gym_id = um.gym_id AND gps.status = 'active'
     WHERE um.gym_id = ? AND um.member_id = ? AND um.status = 'active'
       AND umsv.starts_at <= UTC_DATE()
       AND (umsv.ends_at IS NULL OR umsv.ends_at >= UTC_DATE())`,
    [gymId, memberId],
  );

  const { rows: planRows } = await db.query<ProfessionalServiceGrantRow>(
    `SELECT ps.id             AS professional_service_id,
            ps.name           AS professional_service_name,
            'plan_session'    AS kind,
            umss.id           AS reference_id,
            gc.id             AS product_id,
            gc.name           AS product_name,
            umss.quantity + COALESCE((SELECT SUM(par.quantity) FROM plan_allowance_renewals par
                                      WHERE par.user_membership_session_id = umss.id), 0) AS sessions
     FROM user_memberships um
     JOIN user_membership_session umss
       ON umss.user_membership_id = um.id AND umss.gym_id = um.gym_id
     JOIN products gc ON gc.id = umss.product_id
     JOIN product_professional_services sips
       ON sips.product_id = gc.id AND sips.gym_id = um.gym_id
     JOIN professional_services ps
       ON ps.id = sips.professional_service_id AND ps.deleted_at IS NULL
     JOIN gym_professional_services gps
       ON gps.professional_service_id = ps.id AND gps.gym_id = um.gym_id AND gps.status = 'active'
     WHERE um.gym_id = ? AND um.status = 'active'
       AND (um.member_id = ?
            OR EXISTS (SELECT 1 FROM user_membership_members umm
                       WHERE umm.user_membership_id = um.id AND umm.member_id = ?))
       AND um.starts_at <= UTC_DATE()
       AND (um.ends_at IS NULL OR um.ends_at >= UTC_DATE())`,
    [gymId, memberId, memberId],
  );

  // #1189 stage 3: the sessions already spent from the grants that carry no
  // counter of their own. A returned row (`returned_at`) no longer counts.
  const { rows: consumed } = await db.query<ConsumedTotal>(
    `SELECT source_kind, source_reference_id, COUNT(*) AS consumed
       FROM professional_service_consumptions
      WHERE gym_id = ? AND member_id = ? AND returned_at IS NULL
        AND source_kind <> 'class_package'
      GROUP BY source_kind, source_reference_id`,
    [gymId, memberId],
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
      WHERE psa.gym_id = ? AND psa.member_id = ?`,
    [gymId, memberId],
  );
  const derived = applyConsumption(
    [...packageRows, ...promotionRows, ...serviceRows, ...planRows],
    consumed.filter((c) => c.source_kind !== MANUAL_ADJUSTMENT_KIND),
  );
  if (adjustments.length === 0) return derived;
  const names = new Map<number, string>(adjustments.map((a: { professional_service_id: number; name: string }) => [a.professional_service_id, a.name]));
  return applyConsumption(
    applyAdjustmentsToGrants(derived, netAdjustments(adjustments), names, SPEND_ORDER),
    consumed.filter((c) => c.source_kind === MANUAL_ADJUSTMENT_KIND),
  );
}

/** The Member's Professional Services with their session counts, ready to serve. */
export async function resolveMemberProfessionalServices(
  gymId: string,
  memberId: number,
): Promise<MemberProfessionalService[]> {
  return aggregateProfessionalServiceGrants(await loadMemberProfessionalServiceGrants(gymId, memberId));
}
