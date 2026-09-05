/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.schema.alterTable('members', (t) => {
    t.string('deleted_by_name', 255).nullable().after('deleted_at');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.schema.alterTable('members', (t) => {
    t.dropColumn('deleted_by_name');
  });
};
