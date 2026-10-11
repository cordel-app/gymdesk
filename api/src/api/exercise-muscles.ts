import { db, Tx } from '../infra/db';

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
  opts: { ignoreDuplicate?: boolean } = {},
): Promise<void> {
  await tx.query('INSERT IGNORE INTO muscles (slug, name) VALUES (?, ?)', [slug, humanize(slug)]);
  await tx.query(
    `INSERT ${opts.ignoreDuplicate ? 'IGNORE ' : ''}INTO exercise_muscles (gym_id, exercise_id, muscle, muscle_id, role)
     SELECT ?, ?, m.slug, m.id, ? FROM muscles m WHERE m.slug = ?`,
    [gymId, exerciseId, role, slug],
  );
}

/** The catalogue as the pickers and `GET /muscles` offer it. */
export async function listMuscles(): Promise<{ key: string; name: string }[]> {
  const { rows } = await db.query('SELECT slug, name FROM muscles ORDER BY id ASC');
  return (rows as { slug: string; name: string }[]).map((r) => ({ key: r.slug, name: r.name }));
}
