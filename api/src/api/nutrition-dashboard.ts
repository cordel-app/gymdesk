/**
 * #809: Nutrition → Dashboard.
 *
 * Read-only aggregation over the Nutrition domain. Nothing here writes, and no
 * Nutrition Plan / Template behaviour changes — the endpoint only counts what
 * `member-nutrition-plans.ts` and `nutrition-plan-templates.ts` already own.
 *
 * Mounted under the Nutrition group feature flag (not `nutrition.nutrition_plans`),
 * so the Dashboard keeps working for a gym that has the Nutrition Plans page
 * switched off — the same choice #638's Finance Dashboard made.
 */
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { latestEnrollmentStatusSql } from '../domain/memberEnrollment';

export const nutritionDashboardRouter = Router();

export interface NutritionPlanCard {
  /** The Nutrition Plan Template the assignments were created from; null = the no-template bucket. */
  template_id: number | null;
  /** The Template's name; null for the no-template bucket, which the frontend labels. */
  name: string | null;
  /** active | inactive | draft | deleted (nutrition_plan_templates.status); null for the bucket. */
  status: string | null;
  active_members: number;
}

/**
 * GET /nutrition/dashboard/nutrition-plans
 *
 * One card per Nutrition Plan Template that at least one active member holds an
 * active Nutrition Plan from, plus one bucket card for the plans created from
 * scratch (`member_nutrition_plans.template_id IS NULL`), which the issue owner
 * asked for by name ("No base nutrition template plan").
 *
 * The query is driven by the assignments rather than by the Templates, which
 * gives three properties the ticket asks for in one `GROUP BY` (§11: no N+1):
 *
 * - A card only exists where a counted member exists, so a Template with no
 *   active members is never rendered as an empty `0` card (§4).
 * - The Template's own status is never the filter (§7) — an `inactive` or
 *   `draft` Template shows as long as an active member is on it, and its status
 *   is what the card's badge reports (§5). A Template soft-deleted while members
 *   still hold plans from it keeps its card, with `deleted` as that status:
 *   dropping the card would silently remove those members from the overview.
 * - A plan whose Template row belongs to neither this gym nor the platform
 *   (`gym_id IS NULL`, a Cordel base template a gym may assign from) resolves to
 *   no Template and falls into the bucket, so no other gym's Template name can
 *   be read off this endpoint.
 *
 * "Active member" is the Members page's `enrollment_status = 'active'` — the
 * member's latest `user_memberships` row — via `latestEnrollmentStatusSql()`,
 * plus `members.deleted_at IS NULL`. Only `active` Nutrition Plans count:
 * a `completed` one is no longer currently assigned (§3) and a `deleted` one is
 * gone from every other screen. The count is of **members**, so a member
 * holding two plans from the same Template counts once — the card's own label.
 */
nutritionDashboardRouter.get('/nutrition-plans', async (req, res) => {
  const { gymId } = getTenantContext(req);

  const { rows } = await db.query<{
    template_id: number | null;
    name: string | null;
    status: string | null;
    active_members: number | string;
  }>(
    `SELECT npt.id AS template_id,
            npt.name,
            npt.status,
            COUNT(DISTINCT mnp.member_id) AS active_members
       FROM member_nutrition_plans mnp
       JOIN members m
         ON m.id = mnp.member_id
        AND m.gym_id = mnp.gym_id
        AND m.deleted_at IS NULL
       LEFT JOIN nutrition_plan_templates npt
         ON npt.id = mnp.template_id
        AND (npt.gym_id = mnp.gym_id OR npt.gym_id IS NULL)
      WHERE mnp.gym_id = ?
        AND mnp.status = 'active'
        AND ${latestEnrollmentStatusSql('m')} = 'active'
      GROUP BY npt.id, npt.name, npt.status
      ORDER BY (npt.id IS NULL) ASC, npt.name ASC`,
    [gymId],
  );

  res.json(rows.map((r) => ({
    template_id: r.template_id ?? null,
    name: r.name ?? null,
    status: r.status ?? null,
    active_members: Number(r.active_members),
  })));
});
