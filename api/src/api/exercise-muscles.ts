import { db, Tx } from '../infra/db';
import { ExerciseTables, LEGACY_EXERCISE_TABLES } from '../domain/exerciseTables';

import { BASE_LOCALE, SupportedLocale } from '../infra/locale';
import { translatedNameExpr } from '../domain/nameTranslations';
import { MUSCLE_TRANSLATIONS } from '../domain/muscleTranslations';

/**
 * #1368 stage 2 — `muscles` is the catalogue, `exercise_muscles.muscle_id` the link.
 *
 * This is the one place a muscle link is written and the one SQL spelling of
 * "the slug of a link", so no router carries its own. The API still speaks
 * slugs (`{ key, role }`), so the wire format is unchanged. The legacy
 * `exercise_muscles.muscle` text column is still filled (it is NOT NULL and a
 * later migration drops it, keeping rollback safe) but nothing reads it.
 */

/** `(SELECT slug …)` of a link — replaces every read of `em.muscle`. */
import { SYSTEM_ACTOR } from '../domain/auditActor';

export const MUSCLE_SLUG_SQL = '(SELECT m.slug FROM muscles m WHERE m.id = em.muscle_id)';

const humanize = (slug: string) =>
  slug.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Inserts one link. A slug the catalogue does not know yet (#964 §8: an imported
 * muscle is created, never dropped) becomes a catalogue row first.
 */
export async function insertExerciseMuscle(
  tx: Tx,
  gymId: string | null,
  exerciseId: number | string,
  slug: string,
  role: string,
  opts: { ignoreDuplicate?: boolean; tables?: ExerciseTables } = {},
): Promise<void> {
  const tables = opts.tables ?? LEGACY_EXERCISE_TABLES;
  await tx.query('INSERT IGNORE INTO muscles (slug, name, created_by) VALUES (?, ?, ?)', [slug, humanize(slug), SYSTEM_ACTOR]);
  if (!tables.musclesHaveGymId) {
    await tx.query(
      `INSERT ${opts.ignoreDuplicate ? 'IGNORE ' : ''}INTO ${tables.muscles} (exercise_id, muscle, muscle_id, role)
       SELECT ?, m.slug, m.id, ? FROM muscles m WHERE m.slug = ?`,
      [exerciseId, role, slug],
    );
    return;
  }
  await tx.query(
    `INSERT ${opts.ignoreDuplicate ? 'IGNORE ' : ''}INTO ${tables.muscles} (gym_id, exercise_id, muscle, muscle_id, role)
     SELECT ?, ?, m.slug, m.id, ? FROM muscles m WHERE m.slug = ?`,
    [gymId, exerciseId, role, slug],
  );
}

/** The catalogue as the pickers and `GET /muscles` offer it. */
export async function listMuscles(
  locale: SupportedLocale = BASE_LOCALE,
): Promise<{ key: string; name: string; display_name: string }[]> {
  // #2333: the name in the request's language comes from `muscle_translations`
  // (what Cordel → Muscles edits), falling back to `muscles.name`.
  const { rows } = await db.query(
    `SELECT m.slug, m.name, ${translatedNameExpr(MUSCLE_TRANSLATIONS, 'm', locale, 'display_name')}
       FROM muscles m ORDER BY m.id ASC`,
  );
  return (rows as { slug: string; name: string; display_name: string }[])
    .map((r) => ({ key: r.slug, name: r.name, display_name: r.display_name }));
}
