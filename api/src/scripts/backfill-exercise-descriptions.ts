/**
 * #1419 — load reviewed multilingual descriptions onto Base Exercises.
 *
 *   npm run exercises:backfill-descriptions -- --file content.json              # dry run (default)
 *   npm run exercises:backfill-descriptions -- --file content.json --execute    # write
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

async function main() {
  const execute = process.argv.includes('--execute');
  const fileIdx = process.argv.indexOf('--file');
  const file = fileIdx >= 0 ? process.argv[fileIdx + 1] : undefined;
  if (!file) throw new Error('--file <content.json> is required');
  const content = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, any>>;

  let filled = 0, unchanged = 0, missing = 0, warned = 0;
  for (const [slug, byLocale] of Object.entries(content)) {
    const { rows } = await db.query<any>(
      "SELECT id, name, description, short_description FROM exercises WHERE slug = ? AND gym_id IS NULL AND status != 'deleted'",
      [slug],
    );
    if (rows.length === 0) { missing += 1; console.log(`missing ${slug} — no Base Exercise with this slug`); continue; }
    const ex = rows[0];
    const { rows: trs } = await db.query<any>(
      'SELECT locale, short_description, description FROM exercise_description_translations WHERE exercise_id = ?',
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
            'UPDATE exercises SET short_description = COALESCE(?, short_description), description = COALESCE(?, description), modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ?',
            [w.short_description ?? null, w.description ?? null, 'System', ex.id],
          );
        } else {
          await tx.query(
            `INSERT INTO exercise_description_translations (exercise_id, locale, short_description, description)
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
  await db.end();
}

main().catch(async (err) => { console.error(err); await db.end().catch(() => {}); process.exit(1); });
