/**
 * #2123 stage 1 — Family as a first-class entity, independent of Product Sets.
 *
 *   families         one row per family: the gym, a display name and #1182's plain-text
 *                    created_by / modified_by.
 *   family_members   one row per member of a family. UNIQUE (member_id) = a member belongs
 *                    to at most one family; `owner_key` (generated, non-NULL only for the
 *                    owner row) is UNIQUE, so a family has at most one owner (migration
 *                    213's device). "Exactly one" (never zero) is the transactional half,
 *                    kept by api/src/api/families.ts.
 *
 * Legacy data: `product_set_members` has been used to express who covers whom. A group is
 * migrated only when the evidence is unambiguous (see `planLegacyFamilies`; soft-deleted members are excluded from the evidence); everything
 * else is logged and left for manual resolution, and no owner is ever guessed. Product Set
 * tables are not touched. No payer is derived from a family yet (stage 2).
 *
 * `down` drops the two tables: nothing else references them in stage 1, and the legacy
 * coverage they were derived from is untouched, so the backfill can be re-run.
 */

/**
 * rows: [{ root_product_set_id, member_id, is_owner, gym_id }] of product_set_members.
 * Returns { families: [{ gym_id, owner_member_id, member_ids }], ambiguous: [{ reason, roots, members }] }.
 *
 * A candidate is a chain with >= 2 members and exactly one owner row. Candidates sharing an
 * owner merge into that owner's family. A group is ambiguous (skipped whole) when a chain has
 * zero or several owners, a non-owner appears under two owners, or an owner is covered as a
 * non-owner under another owner.
 */
function planLegacyFamilies(rows) {
  const chains = new Map();
  for (const r of rows) {
    const k = `${r.gym_id}|${r.root_product_set_id}`;
    if (!chains.has(k)) chains.set(k, { gym_id: r.gym_id, root: r.root_product_set_id, members: [], owners: [] });
    const c = chains.get(k);
    c.members.push(Number(r.member_id));
    if (Number(r.is_owner) === 1) c.owners.push(Number(r.member_id));
  }
  const ambiguous = [];
  const byOwner = new Map(); // gym|owner -> { gym_id, owner, members:Set, roots:[] }
  for (const c of chains.values()) {
    if (new Set(c.members).size < 2) continue;
    if (c.owners.length !== 1) {
      ambiguous.push({ reason: c.owners.length === 0 ? 'no_owner' : 'several_owners', roots: [c.root], members: c.members });
      continue;
    }
    const key = `${c.gym_id}|${c.owners[0]}`;
    if (!byOwner.has(key)) byOwner.set(key, { gym_id: c.gym_id, owner: c.owners[0], members: new Set([c.owners[0]]), roots: [] });
    const g = byOwner.get(key);
    c.members.forEach((m) => g.members.add(m));
    g.roots.push(c.root);
  }
  // Who appears under which owner (gym-scoped).
  const appearances = new Map(); // gym|member -> Set(owner keys)
  for (const [key, g] of byOwner) {
    for (const m of g.members) {
      const mk = `${g.gym_id}|${m}`;
      if (!appearances.has(mk)) appearances.set(mk, new Set());
      appearances.get(mk).add(key);
    }
  }
  const bad = new Set();
  for (const [mk, owners] of appearances) {
    if (owners.size > 1) owners.forEach((o) => bad.add(o));
  }
  const families = [];
  for (const [key, g] of byOwner) {
    if (bad.has(key)) {
      ambiguous.push({ reason: 'member_in_several_groups', roots: g.roots, members: [...g.members] });
    } else {
      families.push({ gym_id: g.gym_id, owner_member_id: g.owner, member_ids: [...g.members] });
    }
  }
  return { families, ambiguous };
}
exports.planLegacyFamilies = planLegacyFamilies;

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('families'))) {
    await knex.raw(`
      CREATE TABLE families (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id      CHAR(36)     NOT NULL,
        name        VARCHAR(255) NOT NULL,
        created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by  VARCHAR(255) NULL,
        modified_at DATETIME     NULL,
        modified_by VARCHAR(255) NULL,
        PRIMARY KEY (id),
        KEY families_gym_index (gym_id),
        CONSTRAINT families_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }
  if (!(await knex.schema.hasTable('family_members'))) {
    await knex.raw(`
      CREATE TABLE family_members (
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id     CHAR(36)     NOT NULL,
        family_id  INT UNSIGNED NOT NULL,
        member_id  INT UNSIGNED NOT NULL,
        is_owner   TINYINT(1)   NOT NULL DEFAULT 0,
        owner_key  INT UNSIGNED GENERATED ALWAYS AS (IF(is_owner = 1, family_id, NULL)) VIRTUAL,
        created_at DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by VARCHAR(255) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY family_members_member_key (member_id),
        UNIQUE KEY family_members_one_owner (owner_key),
        KEY family_members_family_index (family_id),
        KEY family_members_gym_index (gym_id),
        CONSTRAINT family_members_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT family_members_family_fk FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE,
        CONSTRAINT family_members_member_fk FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  // Legacy backfill: conservative, idempotent (a member already in a family is skipped).
  if (!(await knex.schema.hasTable('product_set_members'))) return;
  const [legacy] = await knex.raw(`
    SELECT psm.gym_id, psm.root_product_set_id, psm.member_id, psm.is_owner
      FROM product_set_members psm
      JOIN members m ON m.id = psm.member_id AND m.gym_id = psm.gym_id AND m.deleted_at IS NULL`);
  const { families, ambiguous } = planLegacyFamilies(legacy);
  let created = 0;
  for (const f of families) {
    // One transaction per family (DML is transactional even though DDL is not): a crash
    // never leaves a half-built family that the "taken" guard would then skip for good.
    await knex.transaction(async (trx) => {
      const [[taken]] = await trx.raw(
        `SELECT COUNT(*) AS n FROM family_members WHERE member_id IN (${f.member_ids.map(() => '?').join(',')})`,
        f.member_ids);
      if (Number(taken.n) > 0) return;
      const [[owner]] = await trx.raw('SELECT name FROM members WHERE id = ? AND gym_id = ?', [f.owner_member_id, f.gym_id]);
      const [res] = await trx.raw('INSERT INTO families (gym_id, name, created_by) VALUES (?, ?, ?)',
        [f.gym_id, owner ? owner.name : 'Family', 'System']);
      for (const memberId of f.member_ids) {
        await trx.raw(
          'INSERT INTO family_members (gym_id, family_id, member_id, is_owner, created_by) VALUES (?, ?, ?, ?, ?)',
          [f.gym_id, res.insertId, memberId, memberId === f.owner_member_id ? 1 : 0, 'System']);
      }
      created += 1;
    });
  }
  console.log(`migration 344: ${created} famil(ies) created from product_set_members, ${ambiguous.length} ambiguous group(s) left for manual resolution`);
  for (const a of ambiguous) {
    console.log(`migration 344: ambiguous (${a.reason}) chains=${a.roots.join(',')} members=${a.members.join(',')}`);
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('family_members');
  await knex.schema.dropTableIfExists('families');
};
