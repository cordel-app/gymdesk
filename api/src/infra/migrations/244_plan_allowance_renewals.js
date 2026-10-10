/**
 * #1227 stage 2 — renewal of a Membership Plan's Session Benefit allowance.
 *
 * One append-only row per renewal of a renewing Session Benefit line
 * (`user_membership_session.frequency`, #918). The row is the grant (the plan
 * session balance is the line's quantity plus the sum of its renewals) and the
 * history entry; nothing else records a renewal. `UNIQUE (line, date)` makes
 * the nightly run idempotent. Rows cascade away with the line they renew.
 */
const TABLE = 'plan_allowance_renewals';

exports.up = async (knex) => {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.raw(`
    CREATE TABLE ${TABLE} (
      id                         INT UNSIGNED NOT NULL AUTO_INCREMENT,
      gym_id                     CHAR(36)     NOT NULL,
      user_membership_session_id INT UNSIGNED NOT NULL,
      renewal_date               DATE         NOT NULL,
      quantity                   INT UNSIGNED NOT NULL,
      created_at                 TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY par_line_date (user_membership_session_id, renewal_date),
      KEY par_gym (gym_id),
      CONSTRAINT fk_par_gym FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
      CONSTRAINT fk_par_line FOREIGN KEY (user_membership_session_id)
        REFERENCES user_membership_session (id) ON DELETE CASCADE,
      CONSTRAINT chk_par_quantity CHECK (quantity > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};
