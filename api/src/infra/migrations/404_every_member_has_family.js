/**
 * #2670 stage 1 — every Member belongs to a Family.
 *
 * A family may hold one member (#2670 §1), so each member who belongs to no family gets a
 * family of their own, named after them, owned by them (`created_by = 'System'`).
 * Soft-deleted members are included, since a restore brings them back as members.
 * Existing families and their memberships are not touched. Nothing else changes: the
 * owner of a solo family is the member, so payer resolution (#2123 stage 2) answers the
 * member themself, as it did when they had no family.
 *
 * Idempotent: a member already in a family is skipped, including one whose family the
 * application created while this ran (the unique `member_id` key answers ER_DUP_ENTRY, and
 * the member's family is then simply theirs). Knex runs a migration in one transaction,
 * so the per-member blocks are savepoints and a crash rolls the whole backfill back.
 *
 * `down` is a no-op: a solo family is indistinguishable from one the application created
 * after the migration, and deleting families would break "every member has a family".
 */
exports.up = async (knex) => {
  const [rows] = await knex.raw(`
    SELECT m.id, m.gym_id, m.name
      FROM members m
     WHERE NOT EXISTS (SELECT 1 FROM family_members fm WHERE fm.member_id = m.id)
     ORDER BY m.id`);
  let created = 0;
  for (const m of rows) {
    await knex.transaction(async (trx) => {
      const [[taken]] = await trx.raw('SELECT COUNT(*) AS n FROM family_members WHERE member_id = ?', [m.id]);
      if (Number(taken.n) > 0) return;
      const [res] = await trx.raw('INSERT INTO families (gym_id, name, created_by) VALUES (?, ?, ?)',
        [m.gym_id, String(m.name || 'Family').slice(0, 255), 'System']);
      await trx.raw(
        'INSERT INTO family_members (gym_id, family_id, member_id, is_owner, created_by) VALUES (?, ?, ?, 1, ?)',
        [m.gym_id, res.insertId, m.id, 'System']);
      created += 1;
    }).catch((err) => {
      if (err && err.code === 'ER_DUP_ENTRY') return; // the application gave them one meanwhile
      throw err;
    });
  }
  console.log(`migration 404: ${created} solo famil(ies) created`);
};

exports.down = async () => {};
