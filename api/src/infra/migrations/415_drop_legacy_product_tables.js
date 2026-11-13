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
 * The migration refuses to run — dropping nothing — while a legacy row the application could still read
 * through its snapshot has none: a purchase with no `product_{session,oneoff}_snapshots` row, a purchase
 * Promotion with no `product_promotion_snapshots` row, a recurring line of a Product Set with no
 * `product_periodical_snapshots` row, or a purchase whose payment request belongs to a Billing Event its
 * snapshot is not linked to. That is the check `npm run product-snapshots:validate` made (the script is
 * retired with the tables), so a database that passed it passes this. Two kinds of legacy row are not a
 * reason to refuse, because nothing has been able to read them since before this stage: a recurring line
 * whose Product Set no longer exists, and a purchase whose payment request has no Billing Event. They are
 * counted in the log line and dropped with the tables.
 *
 * One-way: the rows are the frozen record of what was written before stage 5d-5 and every fact a reader
 * used is already in the snapshot tables; recreating empty tables on rollback would only look like a restore.
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
    // A partial drop can only be a re-run of this migration after a failure between two DROPs; what is
    // left was already checked, so finish the job.
    for (const table of present) await knex.raw(`DROP TABLE ${table}`);
    return;
  }

  const missing = {
    purchases_without_snapshot: await count(knex,
      `SELECT COUNT(*) n FROM member_products_oneoff_snapshot mp
        WHERE NOT EXISTS (SELECT 1 FROM product_session_snapshots s WHERE s.source_id = mp.id AND s.gym_id = mp.gym_id)
          AND NOT EXISTS (SELECT 1 FROM product_oneoff_snapshots s WHERE s.source_id = mp.id AND s.gym_id = mp.gym_id)`),
    purchase_promotions_without_snapshot: await count(knex,
      `SELECT COUNT(*) n FROM member_products_oneoff_promotion_snapshot l
        WHERE NOT EXISTS (SELECT 1 FROM product_promotion_snapshots p WHERE p.source_purchase_promotion_id = l.id)`),
    recurring_lines_without_snapshot: await count(knex,
      `SELECT COUNT(*) n FROM member_products_recurrent_snapshot l
         JOIN product_sets ps ON ps.id = l.product_set_id AND ps.gym_id = l.gym_id
        WHERE NOT EXISTS (SELECT 1 FROM product_periodical_snapshots s WHERE s.source_id = l.id AND s.gym_id = l.gym_id)`),
    purchases_not_linked_to_their_billing_event: await count(knex,
      `SELECT COUNT(*) n FROM member_products_oneoff_snapshot mp
         JOIN payment_requests pr ON pr.id = mp.payment_request_id AND pr.gym_id = mp.gym_id
        WHERE pr.billing_event_id IS NOT NULL
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

  const unreadable = {
    recurring_lines_without_product_set: await count(knex,
      `SELECT COUNT(*) n FROM member_products_recurrent_snapshot l
        WHERE NOT EXISTS (SELECT 1 FROM product_sets ps WHERE ps.id = l.product_set_id AND ps.gym_id = l.gym_id)`),
    purchases_whose_request_has_no_billing_event: await count(knex,
      `SELECT COUNT(*) n FROM member_products_oneoff_snapshot mp
         JOIN payment_requests pr ON pr.id = mp.payment_request_id AND pr.gym_id = mp.gym_id
        WHERE pr.billing_event_id IS NULL`),
  };
  console.log(`migration 415: dropping the legacy Product tables ${JSON.stringify(unreadable)}`);

  for (const table of LEGACY_TABLES) await knex.raw(`DROP TABLE ${table}`);
};

exports.down = async () => {
  throw new Error('415 is one-way: the legacy Product tables are retired; their rows live on as Product snapshots');
};
