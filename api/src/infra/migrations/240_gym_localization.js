/**
 * #1246 stage 1 — a gym's Time & Localization settings.
 *
 * Six columns on `gyms`. Existing gyms get the defaults, which are what the
 * product already assumed (Madrid, Monday-first, euros, DD/MM/YYYY, 24h, comma
 * decimal), so no data is rewritten and nothing changes until a gym edits them.
 * `first_day_of_week` uses the project's weekday base (0=Sunday), so Monday=1.
 * No CHECKs (`ADD CONSTRAINT` would rebuild `gyms` under ALGORITHM=COPY): the
 * accepted sets live in `api/src/domain/gymLocalization.ts`.
 */
const COLUMNS = [
  ['time_zone', "VARCHAR(64) NOT NULL DEFAULT 'Europe/Madrid'"],
  ['first_day_of_week', 'TINYINT NOT NULL DEFAULT 1'],
  ['currency', "CHAR(3) NOT NULL DEFAULT 'EUR'"],
  ['date_format', "VARCHAR(16) NOT NULL DEFAULT 'DD/MM/YYYY'"],
  ['time_format', "VARCHAR(8) NOT NULL DEFAULT '24h'"],
  ['number_format', "VARCHAR(16) NOT NULL DEFAULT 'comma_decimal'"],
];

exports.up = async (knex) => {
  for (const [name, def] of COLUMNS) {
    if (!(await knex.schema.hasColumn('gyms', name))) {
      await knex.raw(`ALTER TABLE gyms ADD COLUMN ${name} ${def}`);
    }
  }
};

exports.down = async (knex) => {
  for (const [name] of [...COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('gyms', name)) {
      await knex.raw(`ALTER TABLE gyms DROP COLUMN ${name}`);
    }
  }
};
