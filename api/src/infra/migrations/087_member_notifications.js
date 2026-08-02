/**
 * #194: member_notifications — in-app notification log for booking lifecycle events.
 * Notifications are written fire-and-forget by the booking/cancel/cancel-session paths.
 * The member reads them via GET /me/notifications and marks them read individually or in bulk.
 */
exports.up = async (knex) => {
  await knex.schema.createTableIfNotExists('member_notifications', (t) => {
    t.increments('id').unsigned().primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('member_id').unsigned().notNullable()
      .references('id').inTable('members').onDelete('CASCADE');
    t.string('type', 50).notNullable();
    t.string('entity_type', 20).nullable();
    t.integer('entity_id').unsigned().nullable();
    t.json('payload').nullable();
    t.datetime('read_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['gym_id', 'member_id', 'created_at'], 'mn_gym_member_created_idx');
  });

  const [[{ cnt }]] = await knex.raw(
    "SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS " +
    "WHERE CONSTRAINT_SCHEMA = DATABASE() " +
    "  AND TABLE_NAME = 'member_notifications' " +
    "  AND CONSTRAINT_NAME = 'chk_member_notifications_type'",
  );
  if (cnt === 0) {
    await knex.raw(
      "ALTER TABLE member_notifications ADD CONSTRAINT chk_member_notifications_type " +
      "CHECK (type IN ('booking_confirmed','waitlist_joined','promoted_from_waitlist'," +
      "'event_cancelled','event_updated','booking_reminder_24h','booking_reminder_1h'))",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE member_notifications DROP CHECK chk_member_notifications_type').catch(() => {});
  await knex.schema.dropTableIfExists('member_notifications');
};
