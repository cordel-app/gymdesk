/**
 * #1238 — a Member's Access Rights.
 *
 * Only the manual decision is stored: `granted` (every existing Member, the
 * default) or `revoked`. `to_be_reviewed` is derived on read from the Member's
 * Payment Status (domain/memberAccessRights.ts), so it returns to `granted` by
 * itself once the payment problem is settled and no settle path needs a hook.
 * Informational only: nothing is gated by it. No CHECK (`ADD CONSTRAINT`
 * rebuilds `members` under ALGORITHM=COPY); the router is the validator.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('members', 'access_rights'))) {
    await knex.raw("ALTER TABLE members ADD COLUMN access_rights VARCHAR(16) NOT NULL DEFAULT 'granted'");
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('members', 'access_rights')) {
    await knex.raw('ALTER TABLE members DROP COLUMN access_rights');
  }
};
