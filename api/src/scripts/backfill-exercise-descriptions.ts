/**
 * #1419 — load reviewed multilingual descriptions onto Base Exercises.
 *
 *   npm run exercises:backfill-descriptions -- --file content.json              # dry run (default)
 *   npm run exercises:backfill-descriptions -- --file content.json --execute    # write
 *
 * With no `--file` the bundled catalogue content (`src/data/base-exercise-descriptions.json`,
 * #1608: EN/ES/CA short and full description for every Free Exercise DB Base Exercise)
 * is used, so the compiled script runs from the deployed image. Every run ends with a
 * completeness report of the six values per Base Exercise; the process exits
 * non-zero on an `--execute` run that leaves any of them empty.
 *
 * The content file is `{ "<base exercise slug>": { "en": { "short_description", "description" },
 * "es": {...}, "ca": {...} } }`. Only Base Exercises (`gym_id IS NULL`) are
 * touched — a gym's own exercises are never part of a platform backfill — and
 * only empty values are filled (`planDescriptionBackfill()`): re-running after a
 * review never overwrites a correction. A slug that matches no Base Exercise is
 * reported, not created.
 */
import 'dotenv/config';
import fs from 'fs';
import { db } from '../infra/db';
import { BASE_LOCALE, TRANSLATABLE_LOCALES } from '../infra/locale';
import { planDescriptionBackfill } from '../domain/exerciseDescriptionBackfill';
import bundledContent from '../data/base-exercise-descriptions.json';

async function main() {
  const execute = process.argv.includes('--execute');
  const fileIdx = process.argv.indexOf('--file');
  const file = fileIdx >= 0 ? process.argv[fileIdx + 1] : undefined;
  const content = (file ? JSON.parse(fs.readFileSync(file, 'utf8')) : bundledContent) as Record<string, Record<string, any>>;

  let filled = 0, unchanged = 0, missing = 0, warned = 0;
  for (const [slug, byLocale] of Object.entries(content)) {
    const { rows } = await db.query<any>(
      "SELECT id, name, description, short_description FROM base_exercises WHERE slug = ? AND status != 'deleted'",
      [slug],
    );
    if (rows.length === 0) { missing += 1; console.log(`missing ${slug} — no Base Exercise with this slug`); continue; }
    const ex = rows[0];
    const { rows: trs } = await db.query<any>(
      'SELECT locale, short_description, description FROM base_exercise_description_translations WHERE exercise_id = ?',
      [ex.id],
    );
    const existing: Record<string, any> = { [BASE_LOCALE]: ex };
    for (const t of trs) existing[t.locale] = t;
    const known = Object.fromEntries(Object.entries(byLocale).filter(([l]) => l === BASE_LOCALE || (TRANSLATABLE_LOCALES as string[]).includes(l)));
    const plan = planDescriptionBackfill(existing, known);
    for (const w of plan.warnings) { warned += 1; console.log(`warn   ${slug}: ${w}`); }
    const locales = Object.keys(plan.writes);
    if (locales.length === 0) { unchanged += 1; continue; }
    filled += 1;
    console.log(`${execute ? 'fill  ' : 'would fill'} ${slug}: ${locales.join(',')}`);
    if (!execute) continue;
    await db.transaction(async (tx) => {
      for (const [locale, w] of Object.entries(plan.writes)) {
        if (locale === BASE_LOCALE) {
          await tx.query(
            'UPDATE base_exercises SET short_description = COALESCE(?, short_description), description = COALESCE(?, description), modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ?',
            [w.short_description ?? null, w.description ?? null, 'System', ex.id],
          );
        } else {
          await tx.query(
            `INSERT INTO base_exercise_description_translations (exercise_id, locale, short_description, description)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               short_description = COALESCE(NULLIF(short_description, ''), VALUES(short_description)),
               description = COALESCE(NULLIF(description, ''), VALUES(description)),
               modified_at = UTC_TIMESTAMP()`,
            [ex.id, locale, w.short_description ?? null, w.description ?? null],
          );
        }
      }
    });
  }
  console.log(`\n${execute ? 'Executed' : 'Dry run'}: ${filled} filled, ${unchanged} already complete, ${missing} slug(s) not found, ${warned} warning(s).`);

  // Completeness: all six values (short + full in the base locale and each translatable one).
  const locales = [BASE_LOCALE, ...(TRANSLATABLE_LOCALES as string[])];
  const { rows: bases } = await db.query<any>(
    "SELECT id, slug, name, short_description, description FROM base_exercises WHERE status != 'deleted'",
  );
  const { rows: all } = await db.query<any>(
    'SELECT t.exercise_id, t.locale, t.short_description, t.description FROM base_exercise_description_translations t',
  );
  const byEx = new Map<number, Record<string, any>>();
  for (const t of all) (byEx.get(t.exercise_id) ?? byEx.set(t.exercise_id, {}).get(t.exercise_id)!)[t.locale] = t;
  const incomplete: string[] = [];
  for (const ex of bases) {
    const gaps: string[] = [];
    for (const l of locales) {
      const v = l === BASE_LOCALE ? ex : byEx.get(ex.id)?.[l];
      for (const f of ['short_description', 'description']) if (!v?.[f] || String(v[f]).trim() === '') gaps.push(`${l}.${f}`);
    }
    if (gaps.length) incomplete.push(`${ex.slug ?? ex.name}: ${gaps.join(', ')}`);
  }
  console.log(`Completeness: ${bases.length - incomplete.length}/${bases.length} Base Exercises have all ${locales.length * 2} values.`);
  for (const line of incomplete) console.log(`incomplete ${line}`);
  await db.end();
  if (execute && (incomplete.length > 0 || missing > 0)) process.exit(1);
}

main().catch(async (err) => { console.error(err); await db.end().catch(() => {}); process.exit(1); });
