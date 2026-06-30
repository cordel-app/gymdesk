exports.up = (pgm) => {
  pgm.alterColumn('gym_memberships', 'role', {
    type: 'text',
    notNull: true,
    check: "role IN ('admin','coach','staff','member')",
  });
  pgm.addColumn('members', {
    clerk_user_id: { type: 'text', unique: true },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('members', 'clerk_user_id');
  pgm.alterColumn('gym_memberships', 'role', {
    type: 'text',
    notNull: true,
    check: "role IN ('admin','coach','staff')",
  });
};
