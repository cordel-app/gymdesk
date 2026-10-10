/**
 * #1360 — read-only audit of `exercises.category`.
 *
 *   npm run exercises:audit-categories
 *
 * Lists every exercise whose category is not already one of the seven supported
 * values, grouped by case: valid after lowercasing/trimming, spelling variant,
 * NULL or empty, unsupported. For each: id, name, stored value, Base or Gym
 * exercise (and gym id), reason, whether it has `exercise_allowed_result_types`
 * rows and which, and the likely source. It writes nothing and guesses nothing —
 * run it before migration 257 and before stage 2's backfill.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { classifyStoredCategory, type CategoryAuditIssue } from '../domain/exerciseCategories';

const REASONS: Record<Exclude<CategoryAuditIssue, 'valid'>, string> = {
  valid_after_normalization: 'differs from a supported value only in case or surrounding whitespace',
  spelling_variant: 'differs from a supported value only in separators or punctuation',
  missing: 'NULL or empty',
  unsupported: 'not one of the seven supported categories after normalization',
};

async function main() {
  const { rows } = await db.query<any>(
    `SELECT e.id, e.name, e.category, e.gym_id, e.source, e.cloned_from_id,
            (SELECT GROUP_CONCAT(rt.slug ORDER BY rt.id)
               FROM exercise_allowed_result_types eart
               JOIN result_types rt ON rt.id = eart.result_type_id
              WHERE eart.exercise_id = e.id) AS metrics
       FROM exercises e
      WHERE e.status != 'deleted'
      ORDER BY e.id`,
  );
  const groups = new Map<CategoryAuditIssue, any[]>();
  for (const r of rows) {
    const { issue, suggestion } = classifyStoredCategory(r.category);
    if (issue === 'valid') continue;
    const origin = r.source ? `imported (${r.source})` : r.cloned_from_id ? 'cloned from a Base Exercise' : r.gym_id === null ? 'created in Cordel' : 'created in the gym';
    const entry = {
      id: r.id,
      name: r.name,
      stored: r.category === null ? 'NULL' : JSON.stringify(r.category),
      scope: r.gym_id === null ? 'Base' : `Gym ${r.gym_id}`,
      reason: REASONS[issue],
      suggestion,
      metrics: r.metrics ?? '(none)',
      likelySource: origin,
    };
    groups.set(issue, [...(groups.get(issue) ?? []), entry]);
  }
  let total = 0;
  for (const issue of ['valid_after_normalization', 'spelling_variant', 'missing', 'unsupported'] as const) {
    const list = groups.get(issue) ?? [];
    total += list.length;
    console.log(`\n## ${issue} — ${list.length}`);
    for (const e of list) console.log(JSON.stringify(e));
  }
  console.log(`\nTotal affected exercises: ${total} of ${rows.length}`);
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  await db.end().catch(() => {});
  process.exit(1);
});
