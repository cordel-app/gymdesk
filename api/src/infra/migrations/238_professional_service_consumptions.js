/**
 * #1189 stage 3 — the Professional Service consumption ledger (#973 `Q2`:
 * booking never spends a session).
 *
 * One row records that one booking spent one session of one grant, and why:
 * `attendance` (staff marked the member present), `late_cancel` (the booking
 * was cancelled inside `CANCELLATION_NOTICE_HOURS` of the event, #1162) or
 * `no_show` (staff marked the member absent). `UNIQUE (calendar_event_booking_id)`
 * is the idempotency: a booking spends at most once, so a corrected attendance
 * roll can never double-spend. A session is *returned* (`returned_at`) only by
 * the explicit staff choice, never silently — the row stays as the record.
 *
 * The grant spent is named by `(source_kind, source_reference_id)`, the very
 * pair `domain/memberProfessionalServices.ts` reports each balance row under,
 * so the wallet is `grant - unreturned ledger rows` for the plan/promotion/
 * service kinds. A purchased package (`class_package`) keeps its live
 * `sessions_remaining` counter, which the writer decrements in the same
 * transaction, so that source is not subtracted twice.
 *
 * Append-only apart from `returned_at`/`returned_by`: `created_at` +
 * `created_by` (#1182's plain-text actor snapshot) and nothing else.
 */
const TABLE = 'professional_service_consumptions';

const REASONS = ['attendance', 'late_cancel', 'no_show'];
const KINDS = ['plan_session', 'promotion_session', 'membership_service', 'class_package'];

exports.up = async (knex) => {
  if (await knex.schema.hasTable(TABLE)) return;
  const reasons = REASONS.map((r) => `'${r}'`).join(', ');
  const kinds = KINDS.map((k) => `'${k}'`).join(', ');
  await knex.raw(`
    CREATE TABLE ${TABLE} (
      id                         INT UNSIGNED NOT NULL AUTO_INCREMENT,
      gym_id                     CHAR(36)     NOT NULL,
      member_id                  INT UNSIGNED NOT NULL,
      calendar_event_booking_id  INT UNSIGNED NOT NULL,
      calendar_event_id          INT UNSIGNED NOT NULL,
      professional_service_id    INT UNSIGNED NOT NULL,
      source_kind                VARCHAR(30)  NOT NULL,
      source_reference_id        INT UNSIGNED NOT NULL,
      product_id                 INT UNSIGNED NOT NULL,
      reason                     VARCHAR(20)  NOT NULL,
      created_at                 TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by                 VARCHAR(255) NULL,
      returned_at                TIMESTAMP    NULL,
      returned_by                VARCHAR(255) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY psc_one_per_booking (calendar_event_booking_id),
      KEY psc_member_source (gym_id, member_id, source_kind, source_reference_id),
      CONSTRAINT fk_psc_gym FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
      CONSTRAINT fk_psc_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
      CONSTRAINT fk_psc_booking FOREIGN KEY (calendar_event_booking_id)
        REFERENCES calendar_event_bookings (id) ON DELETE CASCADE,
      CONSTRAINT chk_psc_reason CHECK (reason IN (${reasons})),
      CONSTRAINT chk_psc_kind CHECK (source_kind IN (${kinds}))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};

exports.REASONS = REASONS;
exports.KINDS = KINDS;
