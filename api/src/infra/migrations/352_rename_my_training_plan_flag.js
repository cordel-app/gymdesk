/**
 * #2227 — the Members App section behind `member_web.my_training_plan` is
 * called My Products, so the flag takes that name.
 *
 * The flag is one row per key (`feature_flags_feature_key_unique`), so this is
 * an UPDATE: the enabled/disabled choice and who last changed it travel with
 * the key. If a row for the new key already exists (it cannot today) the old
 * row is dropped rather than violating the UNIQUE key.
 */
const OLD = 'member_web.my_training_plan';
const NEW = 'member_web.my_products';

exports.up = async (knex) => {
  const existing = await knex('feature_flags').where({ feature_key: NEW }).first();
  if (existing) {
    await knex('feature_flags').where({ feature_key: OLD }).del();
    return;
  }
  await knex('feature_flags').where({ feature_key: OLD }).update({ feature_key: NEW });
};

exports.down = async (knex) => {
  await knex('feature_flags').where({ feature_key: NEW }).update({ feature_key: OLD });
};
