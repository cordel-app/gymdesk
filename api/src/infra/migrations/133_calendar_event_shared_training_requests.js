/**
 * #360 stage 2 (schema): calendar_event_shared_training_requests — the
 * calendar_events-scoped equivalent of shared_training_requests (#323/#324),
 * which is scoped to class_sessions. See docs/architecture.md's "Planned:
 * CalendarEvent Unification" section and docs/decisions.md #10.
 *
 * Same shape as shared_training_requests, with class_session_id renamed to
 * calendar_event_id. Schema-only — shared_training_requests continues to
 * serve all shared-training traffic until a later stage moves the approval
 * logic over.
 *
 * Every step below is guarded independently (not just a single hasTable
 * check up front) — DDL is non-transactional in MySQL, so a retry after a
 * partial failure must be able to pick up from wherever it stopped.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('calendar_event_shared_training_requests'))) {
    await knex.schema.createTable('calendar_event_shared_training_requests', (t) => {
      t.increments('id').primary();
      // Table name is long, so every FK is given a short explicit key name —
      // knex's default <table>_<column>_foreign pattern exceeds MySQL's
      // 64-character identifier limit here.
      t.string('gym_id', 36).notNullable().references('id').inTable('gyms')
        .onDelete('CASCADE').withKeyName('fk_cestr_gym');
      t.integer('calendar_event_id').unsigned().notNullable().references('id').inTable('calendar_events')
        .withKeyName('fk_cestr_event');
      t.integer('requesting_member_id').unsigned().notNullable().references('id').inTable('members')
        .withKeyName('fk_cestr_member');
      t.integer('activity_type_id').unsigned().notNullable().references('id').inTable('activity_types')
        .withKeyName('fk_cestr_activity_type');
      t.string('status', 20).notNullable().defaultTo('pending');
      // Reviewed by a gym_membership (trainer or admin) — staff actor, not a member.
      t.integer('reviewed_by_membership_id').unsigned().nullable().references('id').inTable('gym_memberships').onDelete('SET NULL')
        .withKeyName('fk_cestr_reviewed_by');
      t.datetime('reviewed_at').nullable();
      t.text('notes').nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['gym_id', 'calendar_event_id', 'requesting_member_id'], 'uq_cestr_gym_event_member');
    });
  }

  const [[{ cnt: cntStatusCheck }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_shared_training_requests'
       AND CONSTRAINT_NAME = 'chk_cestr_status'`,
  );
  if (cntStatusCheck === 0) {
    await knex.raw(
      "ALTER TABLE calendar_event_shared_training_requests ADD CONSTRAINT chk_cestr_status " +
      "CHECK (status IN ('pending','approved','rejected','cancelled'))",
    );
  }

  const [[{ cnt: cntGymEventIdx }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_shared_training_requests'
       AND INDEX_NAME = 'cestr_gym_event_idx'`,
  );
  if (cntGymEventIdx === 0) {
    await knex.raw(
      'ALTER TABLE calendar_event_shared_training_requests ADD INDEX cestr_gym_event_idx (gym_id, calendar_event_id)',
    );
  }

  const [[{ cnt: cntMemberIdx }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_shared_training_requests'
       AND INDEX_NAME = 'cestr_member_idx'`,
  );
  if (cntMemberIdx === 0) {
    await knex.raw(
      'ALTER TABLE calendar_event_shared_training_requests ADD INDEX cestr_member_idx (gym_id, requesting_member_id)',
    );
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('calendar_event_shared_training_requests');
};
