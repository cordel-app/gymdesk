/**
 * #2173: Training → Dashboard.
 *
 * Read-only aggregation over the Assigned Training Plans. Nothing is stored and
 * no assignment structure is duplicated: "an active assigned plan" is the very
 * predicate `GET /me/training-plans` applies for today (`training_plans.status =
 * 'active'`, inside its dates, with an `active` `member_training_plans` row), so
 * the dashboard cannot disagree with what a member is shown.
 *
 * Mounted under the Training module/feature, like the Nutrition dashboard.
 */
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { getRequestLocale } from '../infra/locale';
import { gymToday } from '../domain/workoutProgress';
import { latestEnrollmentStatusSql } from '../domain/memberEnrollment';
import { localizedExerciseNameSql } from '../domain/exerciseTranslations';
import { effectiveImageThumbnailUrlSql } from '../domain/effectiveExerciseImage';

export const trainingDashboardRouter = Router();

export const TOP_EXERCISES_LIMIT = 5;

/** `x / total` as a percentage rounded to one decimal; 0 when there is nothing to divide by. */
export function percentOf(part: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Currently active assignments of this gym on `?`-bound `today` (bind order: gym, today, today).
 * A member who was soft-deleted has no plans to speak of, so their plans are excluded everywhere.
 */
const activePlansFrom = (extraJoins = '') => `
  FROM training_plans tp
  JOIN members m ON m.id = tp.member_id AND m.gym_id = tp.gym_id AND m.deleted_at IS NULL${extraJoins}
 WHERE tp.gym_id = ?
   AND tp.status = 'active'
   AND (tp.start_date IS NULL OR tp.start_date <= ?)
   AND (tp.end_date IS NULL OR tp.end_date >= ?)
   AND EXISTS (SELECT 1 FROM member_training_plans mtp
                WHERE mtp.training_plan_id = tp.id AND mtp.gym_id = tp.gym_id AND mtp.status = 'active')`;

const EXERCISE_TREE_JOINS = `
  JOIN workouts w ON w.training_plan_id = tp.id AND w.deleted_at IS NULL
  JOIN workout_blocks b ON b.workout_id = w.id AND b.deleted_at IS NULL
  JOIN workout_exercises we ON we.workout_block_id = b.id AND we.deleted_at IS NULL`;

/**
 * GET /training/dashboard/summary
 *
 * Every figure is aggregated in SQL. Exercise identity is `COALESCE(base_exercise_id,
 * exercise_id)` (a System exercise and a gym's own never share an id, #1849), counted
 * once per assigned plan however many times the plan repeats it.
 */
trainingDashboardRouter.get('/summary', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    const locale = getRequestLocale(req);
    const tzRows = await db.query<{ time_zone: string | null }>('SELECT time_zone FROM gyms WHERE id = ?', [gymId]);
    const today = gymToday(new Date(), tzRows.rows[0]?.time_zone ?? 'Europe/Madrid');
    const bind = [gymId, today, today];

    const [{ rows: members }, { rows: totals }, { rows: pairs }, { rows: top }] = await Promise.all([
      db.query<{ active_members: number | string; with_plan: number | string }>(
        `SELECT COUNT(*) AS active_members,
                COALESCE(SUM(EXISTS (SELECT 1 FROM training_plans tp
                   WHERE tp.member_id = m.id AND tp.gym_id = m.gym_id AND tp.status = 'active'
                     AND (tp.start_date IS NULL OR tp.start_date <= ?)
                     AND (tp.end_date IS NULL OR tp.end_date >= ?)
                     AND EXISTS (SELECT 1 FROM member_training_plans mtp
                                  WHERE mtp.training_plan_id = tp.id AND mtp.gym_id = tp.gym_id AND mtp.status = 'active'))), 0) AS with_plan
           FROM members m
          WHERE m.gym_id = ? AND m.deleted_at IS NULL
            AND ${latestEnrollmentStatusSql('m')} = 'active'`,
        [today, today, gymId],
      ),
      db.query<{ assignments: number | string; plans_in_use: number | string; assigned_members: number | string }>(
        `SELECT COUNT(*) AS assignments,
                COUNT(DISTINCT COALESCE(CONCAT('t', tp.template_id), CONCAT('p', tp.id))) AS plans_in_use,
                COUNT(DISTINCT tp.member_id) AS assigned_members
           ${activePlansFrom()}`,
        bind,
      ),
      db.query<{ pairs: number | string }>(
        `SELECT COUNT(*) AS pairs FROM (
           SELECT DISTINCT tp.id, COALESCE(we.base_exercise_id, we.exercise_id) AS ex
             ${activePlansFrom(EXERCISE_TREE_JOINS)}
         ) x`,
        bind,
      ),
      db.query<{ exercise_id: number; name: string; image: string | null; uses: number | string }>(
        `SELECT e.id AS exercise_id, ${localizedExerciseNameSql('e', locale)} AS name,
                ${effectiveImageThumbnailUrlSql('e')} AS image, u.uses
           FROM (
             SELECT COALESCE(we.base_exercise_id, we.exercise_id) AS ex, COUNT(DISTINCT tp.id) AS uses
               ${activePlansFrom(EXERCISE_TREE_JOINS)}
              GROUP BY ex
              ORDER BY uses DESC, ex ASC
              LIMIT ${TOP_EXERCISES_LIMIT}
           ) u
           JOIN exercise_catalogue e ON e.id = u.ex
          ORDER BY u.uses DESC, e.id ASC`,
        bind,
      ),
    ]);

    const activeMembers = Number(members[0]?.active_members ?? 0);
    const withPlan = Number(members[0]?.with_plan ?? 0);
    const assignments = Number(totals[0]?.assignments ?? 0);
    const exercisePairs = Number(pairs[0]?.pairs ?? 0);

    res.json({
      adoption: { active_members: activeMembers, members_with_plan: withPlan, percent: percentOf(withPlan, activeMembers) },
      members_with_active_plans: Number(totals[0]?.assigned_members ?? 0),
      active_assignments: assignments,
      plans_in_use: Number(totals[0]?.plans_in_use ?? 0),
      avg_exercises_per_plan: assignments > 0 ? Math.round((exercisePairs / assignments) * 10) / 10 : 0,
      top_exercises: top.map((r, i) => ({
        rank: i + 1,
        exercise_id: r.exercise_id,
        name: r.name,
        image_thumbnail_url: r.image ?? null,
        uses: Number(r.uses),
        percent: percentOf(Number(r.uses), assignments),
      })),
    });
  } catch (err) { next(err); }
});
