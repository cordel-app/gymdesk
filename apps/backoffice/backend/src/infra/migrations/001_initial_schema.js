/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('gyms', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name:       { type: 'text', notNull: true },
    slug:       { type: 'text', notNull: true, unique: true },
    plan:       { type: 'text', notNull: true, default: 'free' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('gym_memberships', {
    id:         { type: 'serial', primaryKey: true },
    user_id:    { type: 'text', notNull: true },
    gym_id:     { type: 'uuid', notNull: true, references: 'gyms', onDelete: 'CASCADE' },
    role:       { type: 'text', notNull: true, check: "role IN ('admin','coach','staff')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('gym_memberships', 'gym_memberships_user_gym_unique', 'UNIQUE (user_id, gym_id)');

  pgm.createTable('members', {
    id:         { type: 'serial', primaryKey: true },
    gym_id:     { type: 'uuid', references: 'gyms' },
    name:       { type: 'text', notNull: true },
    email:      { type: 'text', notNull: true, unique: true },
    phone:      { type: 'text' },
    deleted_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('classes', {
    id:          { type: 'serial', primaryKey: true },
    gym_id:      { type: 'uuid', references: 'gyms' },
    name:        { type: 'text', notNull: true },
    description: { type: 'text' },
    capacity:    { type: 'integer', notNull: true, default: 10 },
    starts_at:   { type: 'timestamptz', notNull: true },
    ends_at:     { type: 'timestamptz', notNull: true },
    created_at:  { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('bookings', {
    id:         { type: 'serial', primaryKey: true },
    gym_id:     { type: 'uuid', references: 'gyms' },
    member_id:  { type: 'integer', notNull: true, references: 'members', onDelete: 'CASCADE' },
    class_id:   { type: 'integer', notNull: true, references: 'classes', onDelete: 'CASCADE' },
    status:     { type: 'text', notNull: true, default: 'confirmed' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('bookings', 'bookings_member_class_unique', 'UNIQUE (member_id, class_id)');

  pgm.createTable('subscriptions', {
    id:         { type: 'serial', primaryKey: true },
    gym_id:     { type: 'uuid', references: 'gyms' },
    member_id:  { type: 'integer', notNull: true, references: 'members', onDelete: 'CASCADE' },
    plan:       { type: 'text', notNull: true },
    starts_at:  { type: 'date', notNull: true },
    ends_at:    { type: 'date' },
    status:     { type: 'text', notNull: true, default: 'active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('subscriptions');
  pgm.dropTable('bookings');
  pgm.dropTable('members');
  pgm.dropTable('classes');
  pgm.dropTable('gym_memberships');
  pgm.dropTable('gyms');
};
