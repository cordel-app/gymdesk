/**
 * #2670 stage 2 — the Professional Services wallet belongs to the Family.
 *
 * The balance has no stored record: it is derived on every read from the grants the
 * members hold, less the consumption ledger, the reservations and the staff corrections
 * (#1189, #1227, #2605). Stage 2 scopes that derivation to the family, so the three ledger
 * tables learn which family a row belongs to:
 *
 *   professional_service_consumptions.family_id
 *   professional_service_reservations.family_id
 *   professional_service_adjustments.family_id
 *
 * `member_id` keeps its meaning on each table (the holder of the grant spent or reserved,
 * the member whose card a correction was entered from); the booking that spent a session
 * still names the member who booked through `calendar_event_booking_id`.
 *
 * Backfill: each row takes its member's current family (#2670 stage 1 gave every member
 * one). Nothing is copied between members and no value moves: a family's balance is the
 * sum of what its members held, so no unit is lost or duplicated.
 *
 * Nullable with `ON DELETE SET NULL`: a family is deleted when its only member joins another
 * family or when it is dissolved, and api/src/api/families.ts re-points the rows before it
 * deletes it; the SET NULL is the safety net, never the path.
 */
const TABLES = [
  ['professional_service_consumptions', 'psc'],
  ['professional_service_reservations', 'psr'],
  ['professional_service_adjustments', 'psa'],
];

exports.up = async (knex) => {
  for (const [table, prefix] of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'family_id'))) {
      await knex.raw(`ALTER TABLE ${table}
        ADD COLUMN family_id INT UNSIGNED NULL AFTER member_id,
        ADD KEY ${prefix}_gym_family (gym_id, family_id),
        ADD CONSTRAINT ${prefix}_family_fk FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE SET NULL`);
    }
    await knex.raw(`UPDATE ${table} t
        JOIN family_members fm ON fm.member_id = t.member_id
         SET t.family_id = fm.family_id
       WHERE t.family_id IS NULL`);
  }
};

exports.down = async (knex) => {
  for (const [table, prefix] of TABLES) {
    if (await knex.schema.hasColumn(table, 'family_id')) {
      await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY ${prefix}_family_fk, DROP KEY ${prefix}_gym_family, DROP COLUMN family_id`);
    }
  }
};
