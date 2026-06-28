/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('fares', {
    id:         { type: 'serial', primaryKey: true },
    gym_id:     { type: 'uuid', notNull: true, references: 'gyms', onDelete: 'CASCADE' },
    name:       { type: 'text', notNull: true },
    price:      { type: 'numeric(10,2)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addColumn('members', {
    fare_id: { type: 'integer', references: 'fares', onDelete: 'SET NULL' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('members', 'fare_id');
  pgm.dropTable('fares');
};
