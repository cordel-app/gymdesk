/**
 * #1360 stage 1 — `exercises.category` is stored lowercase and trimmed.
 *
 * Recorded Metrics are derived from the category (stage 2), so `Cardio` and
 * `cardio ` must be one value. This only rewrites the case and the surrounding
 * whitespace of non-NULL values: it never maps a value onto a supported
 * category, so a spelling variant (`olympic-weightlifting`) or an unsupported
 * value stays exactly what it was and is reported by
 * `npm run exercises:audit-categories` before anyone decides what it means.
 * There is no unique index on the column, so normalizing cannot collide.
 * Empty strings are left alone for the same reason (the audit lists them).
 */

exports.up = async (knex) => {
  await knex.raw(
    `UPDATE exercises
        SET category = LOWER(TRIM(category))
      WHERE category IS NOT NULL
        AND category <> ''
        AND category <> LOWER(TRIM(category))`,
  );
};

// The original casing is not recoverable and the normalized value is valid.
exports.down = async () => {};
