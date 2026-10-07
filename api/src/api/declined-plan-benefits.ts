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
