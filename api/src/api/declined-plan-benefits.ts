// #1184 stage 3 — the SQL half of `domain/declinedPlanBenefits.ts`: reads the
// Plan's benefit lines and applies the one rule to a request's selection.
import { db } from '../infra/db';
import {
  parseDeclinedBenefits, declinedBenefitsError,
  type DeclinedBenefit, type PlanBenefitLine,
} from '../domain/declinedPlanBenefits';
import { toPlanBenefitMandatory } from '../domain/planBenefitMandatory';

const PLAN_TABLES: Array<[PlanBenefitLine['section'], string]> = [
  ['session', 'membership_plan_session'],
  ['oneoff', 'membership_plan_oneoff'],
  ['periodical', 'membership_plan_periodical'],
];

export async function loadPlanBenefitLines(gymId: string | number, planId: number): Promise<PlanBenefitLine[]> {
  const lines: PlanBenefitLine[] = [];
  for (const [section, table] of PLAN_TABLES) {
    const { rows } = await db.query(
      `SELECT product_id, mandatory FROM ${table} WHERE membership_plan_id = ? AND gym_id = ?`,
      [planId, gymId],
    );
    for (const r of rows) {
      lines.push({ section, product_id: Number(r.product_id), mandatory: toPlanBenefitMandatory(r.mandatory) });
    }
  }
  return lines;
}

/** Parses and validates `body.declined_benefits` for an assignment of `planId`. */
export async function resolveDeclinedBenefits(
  gymId: string | number, planId: number, raw: unknown,
): Promise<{ declined: DeclinedBenefit[]; error?: undefined } | { error: string }> {
  const parsed = parseDeclinedBenefits(raw);
  if (!parsed.ok) return { error: parsed.error };
  if (parsed.declined.length === 0) return { declined: [] };
  const error = declinedBenefitsError(await loadPlanBenefitLines(gymId, planId), parsed.declined);
  return error ? { error } : { declined: parsed.declined };
}

export interface NamedPlanBenefitLine extends PlanBenefitLine { product_name: string }

/**
 * #1184 stage 3b — the benefit lines of several Plans with the Product's name,
 * for the Members App's picker. Same tables, same `mandatory` reading as
 * `loadPlanBenefitLines()`, so what the member sees to untick is what
 * `declinedBenefitsError()` will accept.
 */
export async function loadNamedPlanBenefitLines(
  gymId: string | number, planIds: number[],
): Promise<Map<number, NamedPlanBenefitLine[]>> {
  const byPlan = new Map<number, NamedPlanBenefitLine[]>();
  if (planIds.length === 0) return byPlan;
  const marks = planIds.map(() => '?').join(',');
  for (const [section, table] of PLAN_TABLES) {
    const { rows } = await db.query(
      `SELECT b.membership_plan_id, b.product_id, b.mandatory, p.name AS product_name
         FROM ${table} b
         JOIN products p ON p.id = b.product_id AND p.gym_id = b.gym_id
        WHERE b.gym_id = ? AND b.membership_plan_id IN (${marks})
        ORDER BY p.name ASC`,
      [gymId, ...planIds],
    );
    for (const r of rows) {
      const list = byPlan.get(Number(r.membership_plan_id)) ?? [];
      list.push({
        section, product_id: Number(r.product_id), product_name: String(r.product_name),
        mandatory: toPlanBenefitMandatory(r.mandatory),
      });
      byPlan.set(Number(r.membership_plan_id), list);
    }
  }
  return byPlan;
}
