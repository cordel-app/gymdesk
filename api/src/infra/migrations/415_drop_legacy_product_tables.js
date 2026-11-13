/**
 * #2126 stage 5d-6 — drops the three legacy Product tables.
 *
 * `member_products_oneoff_snapshot` (a one-time purchase), `member_products_oneoff_promotion_snapshot`
 * (a Promotion frozen onto one) and `member_products_recurrent_snapshot` (a recurring Product line) have
 * been read by nothing since stage 3v, written by nothing since stage 5d-5 and pointed at by no foreign
 * key since stage 5d-1 (migration 411). Every id they allocated lives on in the Product snapshot tables:
 * a purchase's in `product_purchase_ids` (migration 413), a purchase Promotion's in
 * `product_promotion_snapshots` (migration 414), a recurring line's in `product_periodical_snapshots`
 * (migration 412). A purchase reaches its payment through its snapshot's Billing Event junction
 * (`billing_event_{oneoff,session}_snapshots`, stage 5a, migration 408).
 *
 * The migration refuses to run — dropping nothing — while a legacy row that must still have its snapshot
 * has none. Since stage 5d-5 the delete paths remove only the snapshot, so a legacy row with no snapshot
 * is not by itself a gap; the guard refuses only where a delete cannot explain it:
 *   - a purchase whose legacy status is `active` or `cancelled` (`deletePurchase()` removes a snapshot only
 *     while it is `draft` or `pending_payment`, and a purchase's status only moves forward, so such a
 *     purchase's snapshot can never have been deleted);
 *   - a Promotion frozen onto such a purchase;
 *   - such a purchase that is not linked to the Billing Event of the payment request it names.
 * Everything else is counted in the log line and dropped with the tables: a legacy draft or pending
 * purchase (and its Promotions) whose snapshot a Cancel or a Pay of a draft removed; a recurring line with
 * no snapshot (a line removed from a Draft since stage 5d-5 is indistinguishable from one, and every reader
 * has asked the snapshot alone since stage 5c, so none of them is readable today); a recurring line whose
 * Product Set no longer exists; a purchase whose payment request has no Billing Event (unreachable since
 * stage 5a). Unlike the retired `product-snapshots:validate` report, a purchase's snapshot may sit in either
 * purchase table, as every reader unions the two.
 *
 * Deploy: the API running while this migrates must already be stage 5d-5 or later (it neither reads nor
 * writes these tables); the three tables are dropped in one `DROP TABLE` statement, which InnoDB applies
 * atomically, so a failure leaves all three or none.
 *
 * One-way: the rows are the frozen record of what was written before stage 5d-5 and every fact a reader
 * used is already in the snapshot tables; recreating empty tables on rollback would only look like a restore
 * (and the `down` of migrations 411 and 413 needs the tables anyway, so nothing rolls back past this).
 */

const LEGACY_TABLES = [
  // Children first: the Promotion table has an FK to the purchase table.
  'member_products_oneoff_promotion_snapshot',
  'member_products_oneoff_snapshot',
  'member_products_recurrent_snapshot',
];

const count = async (knex, sql) => {
  const [rows] = await knex.raw(sql);
  return Number(rows[0].n);
};

exports.up = async (knex) => {
  const present = [];
  for (const table of LEGACY_TABLES) if (await knex.schema.hasTable(table)) present.push(table);
  if (present.length === 0) return;
  if (present.length !== LEGACY_TABLES.length) {
    // The drop is one atomic statement, so this is a hand-made state, not a half-run of this migration.
    throw new Error(`migration 415: only some legacy Product tables exist (${present.join(', ')}); resolve by hand`);
  }

  const SETTLED = "('active', 'cancelled')";
  const missing = {
    settled_purchases_without_snapshot: await count(knex,
      `SELECT COUNT(*) n FROM member_products_oneoff_snapshot mp
        WHERE mp.status IN ${SETTLED}
          AND NOT EXISTS (SELECT 1 FROM product_session_snapshots s WHERE s.source_id = mp.id AND s.gym_id = mp.gym_id)
          AND NOT EXISTS (SELECT 1 FROM product_oneoff_snapshots s WHERE s.source_id = mp.id AND s.gym_id = mp.gym_id)`),
    settled_purchase_promotions_without_snapshot: await count(knex,
      `SELECT COUNT(*) n FROM member_products_oneoff_promotion_snapshot l
         JOIN member_products_oneoff_snapshot mp ON mp.id = l.member_product_id
        WHERE mp.status IN ${SETTLED}
          AND NOT EXISTS (SELECT 1 FROM product_promotion_snapshots p WHERE p.source_purchase_promotion_id = l.id)`),
    settled_purchases_not_linked_to_their_billing_event: await count(knex,
      `SELECT COUNT(*) n FROM member_products_oneoff_snapshot mp
         JOIN payment_requests pr ON pr.id = mp.payment_request_id AND pr.gym_id = mp.gym_id
        WHERE mp.status IN ${SETTLED} AND pr.billing_event_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM product_oneoff_snapshots s
                            JOIN billing_event_oneoff_snapshots j ON j.product_oneoff_snapshot_id = s.id
                           WHERE s.source_id = mp.id AND s.gym_id = mp.gym_id AND j.billing_event_id = pr.billing_event_id)
          AND NOT EXISTS (SELECT 1 FROM product_session_snapshots s
                            JOIN billing_event_session_snapshots j ON j.product_session_snapshot_id = s.id
                           WHERE s.source_id = mp.id AND s.gym_id = mp.gym_id AND j.billing_event_id = pr.billing_event_id)`),
  };
  if (Object.values(missing).some((n) => n > 0)) {
    throw new Error(`migration 415: legacy Product rows have no snapshot, nothing dropped: ${JSON.stringify(missing)}`);
  }

  const dropped = {
    unsettled_purchases_without_snapshot: await count(knex,
      `SELECT COUNT(*) n FROM member_products_oneoff_snapshot mp
        WHERE mp.status NOT IN ${SETTLED}
          AND NOT EXISTS (SELECT 1 FROM product_session_snapshots s WHERE s.source_id = mp.id AND s.gym_id = mp.gym_id)
          AND NOT EXISTS (SELECT 1 FROM product_oneoff_snapshots s WHERE s.source_id = mp.id AND s.gym_id = mp.gym_id)`),
    recurring_lines_without_snapshot: await count(knex,
      `SELECT COUNT(*) n FROM member_products_recurrent_snapshot l
        WHERE NOT EXISTS (SELECT 1 FROM product_periodical_snapshots s WHERE s.source_id = l.id AND s.gym_id = l.gym_id)`),
    recurring_lines_without_product_set: await count(knex,
      `SELECT COUNT(*) n FROM member_products_recurrent_snapshot l
        WHERE NOT EXISTS (SELECT 1 FROM product_sets ps WHERE ps.id = l.product_set_id AND ps.gym_id = l.gym_id)`),
    purchases_whose_request_has_no_billing_event: await count(knex,
      `SELECT COUNT(*) n FROM member_products_oneoff_snapshot mp
         JOIN payment_requests pr ON pr.id = mp.payment_request_id AND pr.gym_id = mp.gym_id
        WHERE pr.billing_event_id IS NULL`),
  };
  console.log(`migration 415: dropping the legacy Product tables ${JSON.stringify(dropped)}`);

  // Children first (the Promotion table's FK names the purchase table); one atomic statement.
  await knex.raw(`DROP TABLE ${LEGACY_TABLES.join(', ')}`);
};

exports.down = async () => {
  throw new Error('415 is one-way: the legacy Product tables are retired; their rows live on as Product snapshots');
};
