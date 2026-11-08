/**
 * #2333 — seed `muscle_translations` (migration 371, created empty) with the
 * Spanish and Catalan names the Admin locale files already carry under
 * `muscles.<key>`, so Cordel → Muscles shows what Base Exercises shows.
 *
 * `INSERT IGNORE` on the (muscle_id, locale) key: a name an administrator has
 * already saved is never overwritten, and a muscle with no listed slug (or a
 * re-run) changes nothing. The English value stays `muscles.name`.
 */
const NAMES = [
  ['chest', 'Pecho', 'Pit'],
  ['back', 'Espalda', 'Esquena'],
  ['shoulders', 'Hombros', 'Espatlles'],
  ['biceps', 'Bíceps', 'Bíceps'],
  ['triceps', 'Tríceps', 'Tríceps'],
  ['quads', 'Cuádriceps', 'Quàdriceps'],
  ['hamstrings', 'Isquiotibiales', 'Isquiotibials'],
  ['glutes', 'Glúteos', 'Glutis'],
  ['calves', 'Gemelos', 'Bessons'],
  ['core', 'Core', 'Core'],
  ['lats', 'Dorsales', 'Dorsals'],
  ['middle_back', 'Espalda media', 'Esquena mitjana'],
  ['lower_back', 'Lumbares', 'Lumbars'],
  ['traps', 'Trapecios', 'Trapezis'],
  ['forearms', 'Antebrazos', 'Avantbraços'],
  ['adductors', 'Aductores', 'Adductors'],
  ['abductors', 'Abductores', 'Abductors'],
  ['neck', 'Cuello', 'Coll'],
];

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('muscle_translations'))) return;
  for (const [slug, es, ca] of NAMES) {
    for (const [locale, name] of [['es', es], ['ca', ca]]) {
      await knex.raw(
        `INSERT IGNORE INTO muscle_translations (muscle_id, locale, name)
         SELECT id, ?, ? FROM muscles WHERE slug = ?`,
        [locale, name, slug],
      );
    }
  }
};

// Data seed: nothing to undo without deleting names an administrator may have edited.
exports.down = async () => {};
