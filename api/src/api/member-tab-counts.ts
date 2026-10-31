import { db } from '../infra/db';
import { canAccess, type AppRole } from '../infra/permissions';
import { MEMBER_MEMBERSHIP_SQL } from '../domain/assignmentRelationship';
import { resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';
import { loadFailedPaymentsAttention } from './payments';

/**
 * #2182 — the counts the Member card's tab badges show.
 *
 * One read, derived on every call and stored nowhere. Each count reuses the
 * predicate of the screen it badges (live plan statuses, the live in-progress
 * goal, the Assigned Training Plan's own status, the failed-payments attention
 * rule), and a count is present only when the caller's role can open the module
 * of that tab — an absent key means "show no badge", never zero.
 */
export type MemberTabCountKey =
  | 'family' | 'products_services' | 'professional_services' | 'nutrition'
  | 'personal_goals' | 'training_plan' | 'progress' | 'payments';

export type MemberTabCounts = Partial<Record<MemberTabCountKey, number>>;

const n = (v: unknown) => Number(v ?? 0);

export async function loadMemberTabCounts(
  gymId: string, memberId: number, role: AppRole, isSuperadmin: boolean,
): Promise<MemberTabCounts> {
  const may = (m: Parameters<typeof canAccess>[1]) => isSuperadmin || canAccess(role, m);
  const out: MemberTabCounts = {};
  const jobs: Promise<void>[] = [];

  // Family and Products are MEMBERS' own tabs (the route's gate).
  jobs.push((async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS c FROM family_members
        WHERE gym_id = ? AND family_id = (SELECT family_id FROM family_members WHERE gym_id = ? AND member_id = ?)`,
      [gymId, gymId, memberId]);
    out.family = n(rows[0]?.c);
  })());
  jobs.push((async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS c FROM user_memberships um
        WHERE um.gym_id = ? AND um.status = 'active' AND ${MEMBER_MEMBERSHIP_SQL}`,
      [gymId, memberId, memberId]);
    out.products_services = n(rows[0]?.c);
  })());
  jobs.push((async () => {
    out.professional_services = (await resolveMemberProfessionalServices(gymId, memberId)).length;
  })());

  if (may('NUTRITION')) {
    jobs.push((async () => {
      const { rows } = await db.query(
        "SELECT COUNT(*) AS c FROM member_nutrition_plans WHERE gym_id = ? AND member_id = ? AND status = 'active'",
        [gymId, memberId]);
      out.nutrition = n(rows[0]?.c);
    })());
    jobs.push((async () => {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS c FROM member_personal_goals
          WHERE gym_id = ? AND member_id = ? AND deleted_at IS NULL AND status = 'in_progress'`,
        [gymId, memberId]);
      out.personal_goals = n(rows[0]?.c);
    })());
  }
  if (may('TRAINING')) {
    jobs.push((async () => {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS c FROM member_training_plans mtp
           JOIN training_plans tp ON tp.id = mtp.training_plan_id
          WHERE mtp.member_id = ? AND mtp.gym_id = ?
            AND CASE WHEN tp.status IN ('draft', 'completed', 'expired') THEN tp.status ELSE mtp.status END = 'active'`,
        [memberId, gymId]);
      out.training_plan = n(rows[0]?.c);
    })());
    jobs.push((async () => {
      // The Progress tab lists exercises with at least one performed (not skipped) log.
      const { rows } = await db.query(
        `SELECT COUNT(DISTINCT COALESCE(base_exercise_id, exercise_id)) AS c FROM exercise_logs
          WHERE gym_id = ? AND member_id = ? AND skipped = 0`,
        [gymId, memberId]);
      out.progress = n(rows[0]?.c);
    })());
  }
  if (may('PAYMENTS')) {
    jobs.push((async () => {
      out.payments = (await loadFailedPaymentsAttention(gymId, memberId)).count;
    })());
  }
  await Promise.all(jobs);
  return out;
}
