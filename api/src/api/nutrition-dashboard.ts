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
import { planEffectiveOnSql } from '../domain/nutritionPlanDates';

export const nutritionDashboardRouter = Router();

/** The UTC date `planEffectiveOnSql()` is asked about (`YYYY-MM-DD`). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

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
 * #2172: a plan counts when it is **currently assigned** — `planEffectiveOnSql()`
 * (#1957) for today: status `active`, started, not ended — held by a member who
 * is not soft-deleted. The member's Membership enrollment is deliberately NOT a
 * condition any more: #809 required `enrollment_status = 'active'`, so a member
 * with a plan but no Active Membership Plan (a staff-assigned plan, a lapsed or
 * pending membership) made the Dashboard claim nothing was assigned while the
 * Assigned Nutrition Plans page listed them. A `completed` plan is no longer
 * currently assigned and a `deleted` one is gone from every other screen. The
 * count is of **members**, so a member holding two plans from the same Template
 * counts once — the card's own label.
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
        AND ${planEffectiveOnSql('mnp')}
      GROUP BY npt.id, npt.name, npt.status
      ORDER BY (npt.id IS NULL) ASC, npt.name ASC`,
    [gymId, todayUtc(), todayUtc()],
  );

  res.json(rows.map((r) => ({
    template_id: r.template_id ?? null,
    name: r.name ?? null,
    status: r.status ?? null,
    active_members: Number(r.active_members),
  })));
});

/**
 * GET /nutrition/dashboard/summary  (#2172)
 *
 * The headline numbers of both halves of the Nutrition & Goals Dashboard, all
 * aggregated in SQL. "Current" is one rule per half and the same one the rest of
 * the product uses: a Nutrition Plan is current through `planEffectiveOnSql()`
 * (#1957); a Personal Goal assignment is current through `isLiveAssignment()`'s
 * predicate (not deleted, `status = 'in_progress'`). A soft-deleted member holds
 * nothing. Nothing is stored and no status is introduced.
 *
 * Goal identity: a gym's imported copy records its System template in
 * `personal_goals.base_personal_goal_id` (#1850), so the copy and the template
 * are one goal — `COALESCE(base_personal_goal_id, id)`, safe because Base ids are
 * drawn from the gym-owned sequence and the two id spaces never overlap. A
 * custom gym goal is its own identity. The most popular goal is the one held by
 * the most distinct members; a tie goes to the lowest identity, so the answer is
 * deterministic.
 */
nutritionDashboardRouter.get('/summary', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const today = todayUtc();

  const { rows: planRows } = await db.query<{
    members: number | string; assignments: number | string; plans_in_use: number | string;
  }>(
    `SELECT COUNT(DISTINCT mnp.member_id) AS members,
            COUNT(*) AS assignments,
            COUNT(DISTINCT mnp.template_id) AS plans_in_use
       FROM member_nutrition_plans mnp
       JOIN members m
         ON m.id = mnp.member_id AND m.gym_id = mnp.gym_id AND m.deleted_at IS NULL
      WHERE mnp.gym_id = ?
        AND ${planEffectiveOnSql('mnp')}`,
    [gymId, today, today],
  );

  const goalIdentity = 'COALESCE(pg.base_personal_goal_id, pg.id)';
  const goalFrom = `
       FROM member_personal_goals mpg
       JOIN members m
         ON m.id = mpg.member_id AND m.gym_id = mpg.gym_id AND m.deleted_at IS NULL
       JOIN personal_goal_catalogue pg
         ON pg.id = COALESCE(mpg.base_personal_goal_id, mpg.personal_goal_id)
        AND (pg.gym_id IS NULL OR pg.gym_id = mpg.gym_id)
      WHERE mpg.gym_id = ?
        AND mpg.deleted_at IS NULL
        AND mpg.status = 'in_progress'`;

  const { rows: goalTotals } = await db.query<{
    members: number | string; assignments: number | string; goals_in_use: number | string;
  }>(
    `SELECT COUNT(DISTINCT mpg.member_id) AS members,
            COUNT(*) AS assignments,
            COUNT(DISTINCT ${goalIdentity}) AS goals_in_use
       ${goalFrom}`,
    [gymId],
  );

  const { rows: top } = await db.query<{
    goal_id: number; name: string; slug: string | null; members: number | string;
  }>(
    `SELECT ${goalIdentity} AS goal_id,
            COALESCE(MAX(bpg.name), MAX(pg.name)) AS name,
            COALESCE(MAX(bpg.slug), MAX(pg.slug)) AS slug,
            COUNT(DISTINCT mpg.member_id) AS members
       ${goalFrom.replace('WHERE mpg.gym_id', `LEFT JOIN base_personal_goals bpg ON bpg.id = ${goalIdentity}
      WHERE mpg.gym_id`)}
      GROUP BY ${goalIdentity}
      ORDER BY members DESC, goal_id ASC
      LIMIT 1`,
    [gymId],
  );

  const goalMembers = Number(goalTotals[0]?.members ?? 0);
  const goalAssignments = Number(goalTotals[0]?.assignments ?? 0);

  res.json({
    nutrition_plans: {
      members: Number(planRows[0]?.members ?? 0),
      assignments: Number(planRows[0]?.assignments ?? 0),
      plans_in_use: Number(planRows[0]?.plans_in_use ?? 0),
    },
    personal_goals: {
      members: goalMembers,
      goals_in_use: Number(goalTotals[0]?.goals_in_use ?? 0),
      average_per_member: goalMembers > 0 ? Math.round((goalAssignments / goalMembers) * 10) / 10 : 0,
      most_popular: top[0]
        ? { goal_id: Number(top[0].goal_id), name: top[0].name, slug: top[0].slug ?? null, members: Number(top[0].members) }
        : null,
    },
  });
});
