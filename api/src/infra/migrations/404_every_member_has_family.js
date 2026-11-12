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
 * Idempotent: a member already in a family is skipped, and each family is written in its
 * own transaction, so a re-run after a crash finishes the rest.
 *
 * `down` removes only the solo families this migration could have created: single-member
 * families created by 'System' whose name is still the member's own. It cannot tell them
 * apart from a solo family created the same way by hand, which is the same shape.
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
    });
  }
  console.log(`migration 404: ${created} solo famil(ies) created`);
};

exports.down = async (knex) => {
  await knex.raw(`
    DELETE f FROM families f
      JOIN family_members fm ON fm.family_id = f.id AND fm.is_owner = 1
      JOIN members m ON m.id = fm.member_id
     WHERE f.created_by = 'System' AND f.name = m.name
       AND (SELECT COUNT(*) FROM family_members x WHERE x.family_id = f.id) = 1`);
};
