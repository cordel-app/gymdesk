/** #180: payment_methods — stores reusable provider tokens for MIT recurring charges */

exports.up = async (knex) => {
  const exists = await knex.schema.hasTable('payment_methods');
  if (exists) return;

  await knex.schema.createTable('payment_methods', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'CHAR(36)').notNullable();
    t.integer('member_id').unsigned().notNullable();
    t.string('provider', 32).notNullable().defaultTo('monei');
    t.string('payment_token', 255).nullable();
    t.string('sequence_id', 255).nullable();
    t.string('card_last4', 4).nullable();
    t.string('card_brand', 20).nullable();
    t.json('metadata').nullable();
    t.dateTime('created_at').defaultTo(knex.raw('CURRENT_TIMESTAMP'));

    t.unique(['gym_id', 'member_id', 'provider'], { indexName: 'uq_member_gym_provider' });
    t.foreign('gym_id').references('gyms.id').onDelete('CASCADE');
    t.foreign('member_id').references('members.id').onDelete('CASCADE');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('payment_methods');
};
