import { db } from '../infra/db';

/**
 * #647 stage 1: "which Professional Services does this Member have sessions
 * for, and how many?".
 *
 * The ticket's eligibility rule pairs a `calendar_event`'s Professional
 * Service (migration 168) with the Member's side of the same link. There is
 * no Member↔Professional Service table and no "wallet" — per the answers on
 * the issue thread, a Member reaches a Professional Service *through the
 * Sellable Items they hold*, and the counts add up across sources:
 *
 *   > user purchases a 10 class package (personal training) and the
 *   > membership plan contains also 4 personal training sessions […] member
 *   > will have 14 sessions of personal training
 *
 * Three sources hold session-type Sellable Items today, and each resolves to
 * Professional Services through `sellable_item_professional_services` (#546,
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
 *   3. `user_membership_services` — Additional Services attached directly to
 *      an assignment (#631), counted only while their window is open and
 *      only when the attached Sellable Item is itself a session package.
 *
 * A fourth source lands with #635, which moves Session Benefits onto the
 * Membership Plan itself; `loadMemberProfessionalServiceGrants` is where it
 * will be added.
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

export type ProfessionalServiceGrantKind = 'class_package' | 'promotion_session' | 'membership_service';

/** One row as the three loader queries return it, before aggregation. */
export interface ProfessionalServiceGrantRow {
  professional_service_id: number;
  professional_service_name: string;
  kind: ProfessionalServiceGrantKind;
  /** Row id of the granting record — `user_class_packages.id`, `user_membership_promotions.id`, `user_membership_services.id`. */
  reference_id: number;
  sellable_item_id: number;
  sellable_item_name: string;
  sessions: number | string;
}

export interface ProfessionalServiceGrant {
  kind: ProfessionalServiceGrantKind;
  reference_id: number;
  sellable_item_id: number;
  sellable_item_name: string;
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
 * A grant is identified by (kind, reference_id, sellable_item_id) and counted
 * once per Professional Service. The de-duplication is what makes the result
 * independent of JOIN fan-out: two `gym_charges` rows tracing back to the same
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

    const key = `${row.professional_service_id}:${row.kind}:${row.reference_id}:${row.sellable_item_id}`;
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
      sellable_item_id: row.sellable_item_id,
      sellable_item_name: row.sellable_item_name,
      sessions,
    });
  }

  return [...byService.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every session-type Sellable Item the Member currently holds, expanded to
 * the Professional Services that deliver it.
 *
 * Only services that are visible to the gym and *enabled* for it
 * (`gym_professional_services.status = 'active'`) are returned, matching
 * `validateProfessionalServiceId()` in `professionalServices.ts`: a service
 * the gym has switched off must not make a slot eligible.
 *
 * `gym_charges` is not filtered on `deleted_at` — a package stays spendable
 * after the catalogue item behind it is retired, the same rule
 * `billing-simulation.ts` applies to granted items.
 */
export async function loadMemberProfessionalServiceGrants(
  gymId: string,
  memberId: number,
): Promise<ProfessionalServiceGrantRow[]> {
  // Resolving the Sellable Item behind a purchased package through
  // MIN(gc.id) rather than a plain join: `gym_charges.class_package_id` (the
  // traceability FK added by migration 103) carries no uniqueness
  // constraint, so a join could return the same package once per
  // duplicated catalogue row.
  const { rows: packageRows } = await db.query<ProfessionalServiceGrantRow>(
    `SELECT ps.id           AS professional_service_id,
            ps.name         AS professional_service_name,
            'class_package' AS kind,
            ucp.id          AS reference_id,
            gc.id           AS sellable_item_id,
            gc.name         AS sellable_item_name,
            ucp.sessions_remaining AS sessions
     FROM user_class_packages ucp
     JOIN gym_charges gc
       ON gc.id = (SELECT MIN(gc2.id) FROM gym_charges gc2
                   WHERE gc2.class_package_id = ucp.class_package_id AND gc2.gym_id = ucp.gym_id)
     JOIN sellable_item_professional_services sips
       ON sips.sellable_item_id = gc.id AND sips.gym_id = ucp.gym_id
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
            gc.id               AS sellable_item_id,
            gc.name             AS sellable_item_name,
            psn.quantity        AS sessions
     FROM user_memberships um
     JOIN user_membership_promotions ump
       ON ump.user_membership_id = um.id AND ump.gym_id = um.gym_id AND ump.status = 'applied'
     JOIN promotion_session psn
       ON psn.promotion_id = ump.promotion_id AND psn.gym_id = um.gym_id
     JOIN gym_charges gc ON gc.id = psn.gym_charge_id
     JOIN sellable_item_professional_services sips
       ON sips.sellable_item_id = gc.id AND sips.gym_id = um.gym_id
     JOIN professional_services ps
       ON ps.id = sips.professional_service_id AND ps.deleted_at IS NULL
     JOIN gym_professional_services gps
       ON gps.professional_service_id = ps.id AND gps.gym_id = um.gym_id AND gps.status = 'active'
     WHERE um.gym_id = ? AND um.member_id = ? AND um.status = 'active'`,
    [gymId, memberId],
  );

  // `gym_charges.units` is the number of sessions a Session item bundles
  // (migration 103 copies `class_packages.number_of_sessions` into it), so an
  // attachment of quantity 2 of a 10-session item is 20 sessions.
  const { rows: serviceRows } = await db.query<ProfessionalServiceGrantRow>(
    `SELECT ps.id                 AS professional_service_id,
            ps.name               AS professional_service_name,
            'membership_service'  AS kind,
            umsv.id               AS reference_id,
            gc.id                 AS sellable_item_id,
            gc.name               AS sellable_item_name,
            umsv.quantity * COALESCE(gc.units, 1) AS sessions
     FROM user_memberships um
     JOIN user_membership_services umsv
       ON umsv.user_membership_id = um.id AND umsv.gym_id = um.gym_id
     JOIN gym_charges gc ON gc.id = umsv.gym_charge_id AND gc.type = 'sessions'
     JOIN sellable_item_professional_services sips
       ON sips.sellable_item_id = gc.id AND sips.gym_id = um.gym_id
     JOIN professional_services ps
       ON ps.id = sips.professional_service_id AND ps.deleted_at IS NULL
     JOIN gym_professional_services gps
       ON gps.professional_service_id = ps.id AND gps.gym_id = um.gym_id AND gps.status = 'active'
     WHERE um.gym_id = ? AND um.member_id = ? AND um.status = 'active'
       AND umsv.starts_at <= UTC_DATE()
       AND (umsv.ends_at IS NULL OR umsv.ends_at >= UTC_DATE())`,
    [gymId, memberId],
  );

  return [...packageRows, ...promotionRows, ...serviceRows];
}

/** The Member's Professional Services with their session counts, ready to serve. */
export async function resolveMemberProfessionalServices(
  gymId: string,
  memberId: number,
): Promise<MemberProfessionalService[]> {
  return aggregateProfessionalServiceGrants(await loadMemberProfessionalServiceGrants(gymId, memberId));
}
