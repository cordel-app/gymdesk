/**
 * #1234 — the dates behind a Member's Clerk status.
 *
 * `invited_at` is when the latest invitation was sent and `enrolled_at` is when
 * the Member linked their Clerk account. Both are history: they are kept after
 * `invitation_id` is cleared (accepted or revoked) and after anything else
 * changes, so neither is derived from `invitation_id` / `clerk_user_id`.
 * Existing rows stay NULL — the dates are not knowable for members who linked
 * or were invited before this migration, and inventing them would be wrong.
 * No CHECK (`ADD CONSTRAINT` would rebuild `members` under ALGORITHM=COPY).
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('members', 'invited_at'))) {
    await knex.raw('ALTER TABLE members ADD COLUMN invited_at DATETIME NULL');
  }
  if (!(await knex.schema.hasColumn('members', 'enrolled_at'))) {
    await knex.raw('ALTER TABLE members ADD COLUMN enrolled_at DATETIME NULL');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('members', 'enrolled_at')) {
    await knex.raw('ALTER TABLE members DROP COLUMN enrolled_at');
  }
  if (await knex.schema.hasColumn('members', 'invited_at')) {
    await knex.raw('ALTER TABLE members DROP COLUMN invited_at');
  }
};
