/**
 * #2221 — load reviewed Spanish and Catalan names onto Base Exercises.
 *
 *   npm run exercises:backfill-names              # dry run (default)
 *   npm run exercises:backfill-names -- --execute # write
 *
 * The bundled content (`src/data/base-exercise-names.json`) is
 * `{ "<base exercise slug>": { "es": "...", "ca": "..." } }` for every Free
 * Exercise DB Base Exercise, written with the terminology used in gyms rather
 * than a literal translation. Only Base Exercises (`gym_id IS NULL` rows of
 * `base_exercises`) are touched; the English `name` is never written. Like the
 * description backfill it only fills what is missing: an existing translation
 * (a human correction) is never overwritten, so the script is safe to re-run.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { TRANSLATABLE_LOCALES } from '../infra/locale';
import bundledNames from '../data/base-exercise-names.json';

async function main() {
  const execute = process.argv.includes('--execute');
  const content = bundledNames as Record<string, Record<string, string>>;
  const created: Record<string, number> = {};
  let missing = 0, complete = 0;

  for (const [slug, byLocale] of Object.entries(content)) {
    const { rows } = await db.query<any>(
      "SELECT id FROM base_exercises WHERE slug = ? AND status != 'deleted'",
      [slug],
    );
    if (rows.length === 0) { missing += 1; console.log(`missing ${slug} — no Base Exercise with this slug`); continue; }
    const id = rows[0].id;
    const { rows: existing } = await db.query<any>(
      'SELECT locale FROM base_exercise_translations WHERE exercise_id = ?', [id],
    );
    const have = new Set(existing.map((r: any) => r.locale));
    const todo = (TRANSLATABLE_LOCALES as string[]).filter((l) => !have.has(l) && byLocale[l]?.trim());
    if (todo.length === 0) { complete += 1; continue; }
    for (const l of todo) created[l] = (created[l] ?? 0) + 1;
    console.log(`${execute ? 'fill      ' : 'would fill'} ${slug}: ${todo.join(',')}`);
    if (!execute) continue;
    await db.transaction(async (tx) => {
      for (const l of todo) {
        await tx.query(
          'INSERT IGNORE INTO base_exercise_translations (exercise_id, locale, name) VALUES (?, ?, ?)',
          [id, l, byLocale[l].trim()],
        );
      }
    });
  }

  const { rows: bases } = await db.query<any>("SELECT COUNT(*) AS n FROM base_exercises WHERE status != 'deleted'");
  console.log(`\n${execute ? 'Executed' : 'Dry run'}: ${Object.entries(created).map(([l, n]) => `${n} ${l}`).join(', ') || 'nothing to fill'}; ${complete} already complete; ${missing} slug(s) not found; ${bases[0].n} Base Exercises in total.`);
  await db.end();
  if (execute && missing > 0) process.exit(1);
}

main().catch(async (err) => { console.error(err); await db.end().catch(() => {}); process.exit(1); });
