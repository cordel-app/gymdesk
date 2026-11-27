/**
 * #3497 — a Member's Default Payment Method.
 *
 * `members.default_payment_method` holds the member's explicit preference
 * (`automated`, `members_app`, `cash` or `card`, declared in
 * `api/src/domain/memberDefaultPaymentMethod.ts`). NULL means no preference and
 * reads as Automated, which is what every existing member is: no backfill.
 * No CHECK (`ALTER TABLE members ADD CONSTRAINT` rebuilds the table with
 * ALGORITHM=COPY); the route is the one writer and validates the value.
 * Billing Events are deliberately untouched: the method is the member's.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('members', 'default_payment_method')) return;
  await knex.raw('ALTER TABLE members ADD COLUMN default_payment_method VARCHAR(50) NULL');
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('members', 'default_payment_method'))) return;
  await knex.raw('ALTER TABLE members DROP COLUMN default_payment_method');
};
