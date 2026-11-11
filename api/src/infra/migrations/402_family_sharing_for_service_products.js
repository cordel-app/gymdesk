/**
 * #2662: a Product linked to one or more Professional Services is always
 * Family (`sharing_type = 'shared'`, which the UI now labels Family). The
 * routes enforce it from now on (`decideProductSharingType()`); this moves the
 * existing linked Products that are still `individual` onto it, once.
 *
 * Only the column moves: no link, price, quantity, purchase or plan line is
 * touched, and `modified_at`/`modified_by` are left alone because no person
 * edited the Product. Idempotent (a second run matches nothing).
 *
 * `down` is a no-op: which rows were `individual` before is not recorded, and
 * moving every linked Product back would break the rule for Products created
 * Family on purpose.
 */
exports.up = async (knex) => {
  await knex.raw(
    `UPDATE products p
        SET p.sharing_type = 'shared'
      WHERE p.sharing_type <> 'shared'
        AND EXISTS (SELECT 1 FROM product_professional_services pps WHERE pps.product_id = p.id)`);
};

exports.down = async () => {};
