/**
 * #2886: the filters of the Billing Events list (`GET /payments/billing-events`),
 * spelled once as SQL over `billing_events be`.
 *
 * Every filter narrows; they combine with AND, and an absent one does nothing.
 * Status stays the route's own (it is derived in JS from the latest attempt,
 * `deriveBillingEventStatus()`), so it is not here.
 *
 * - `product`: partial, case-insensitive text matched against the event's own
 *   lines (`billing_event_lines.item_name`, the names the Billing Event Lines
 *   section shows) and, for a one-time purchase, the purchase snapshot linked to
 *   the event (`billing_event_{oneoff,session}_snapshots`). Never the live catalogue.
 * - `processed_by`: the plain-text actor (#1182) who created the event or any of
 *   its payment attempts.
 * - `payment_method`: the method code snapshotted on the latest attempt that
 *   carries one — the same attempt the list's Payment method column reads (#2451).
 * - `date_from` / `date_to`: the event's billing date as the list shows it
 *   (`billing_date`, else the day the ledger row was created), inclusive.
 * - `amount_min` / `amount_max`: the event's total (`billing_events.amount`),
 *   never a line amount, inclusive.
 */
export interface BillingEventListFilter {
  product?: string;
  processed_by?: string;
  payment_method?: string;
  date_from?: string;
  date_to?: string;
  amount_min?: number;
  amount_max?: number;
}

/** The date the list shows for an event (`billing_date`, else its creation day). */
export const EVENT_LIST_DATE_SQL = 'COALESCE(be.billing_date, DATE(be.created_at))';

/** The latest attempt's snapshotted payment method code (the column's own attempt). */
export const LATEST_PAYMENT_METHOD_CODE_SQL = `(SELECT pr.payment_method_code FROM payment_requests pr
   WHERE pr.billing_event_id = be.id AND pr.payment_method_name IS NOT NULL
   ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1)`;

/** Escapes `%`, `_` and `\` so a typed value matches literally inside LIKE. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function billingEventListFilterSql(f: BillingEventListFilter): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const product = f.product?.trim();
  if (product) {
    const like = likeContains(product);
    clauses.push(`(EXISTS (SELECT 1 FROM billing_event_lines bel
                            WHERE bel.billing_event_id = be.id AND bel.item_name LIKE ?)
                   OR EXISTS (SELECT 1 FROM billing_event_oneoff_snapshots jo
                                JOIN product_oneoff_snapshots pos ON pos.id = jo.product_oneoff_snapshot_id
                               WHERE jo.billing_event_id = be.id AND pos.product_name LIKE ?)
                   OR EXISTS (SELECT 1 FROM billing_event_session_snapshots js
                                JOIN product_session_snapshots pss ON pss.id = js.product_session_snapshot_id
                               WHERE js.billing_event_id = be.id AND pss.product_name LIKE ?))`);
    params.push(like, like, like);
  }

  const processedBy = f.processed_by?.trim();
  if (processedBy) {
    clauses.push(`(be.created_by = ?
                   OR EXISTS (SELECT 1 FROM payment_requests prb
                               WHERE prb.billing_event_id = be.id AND prb.created_by = ?))`);
    params.push(processedBy, processedBy);
  }

  const method = f.payment_method?.trim();
  if (method) {
    clauses.push(`${LATEST_PAYMENT_METHOD_CODE_SQL} = ?`);
    params.push(method);
  }

  if (f.date_from) { clauses.push(`${EVENT_LIST_DATE_SQL} >= ?`); params.push(f.date_from); }
  if (f.date_to) { clauses.push(`${EVENT_LIST_DATE_SQL} <= ?`); params.push(f.date_to); }
  if (f.amount_min !== undefined) { clauses.push('be.amount >= ?'); params.push(f.amount_min); }
  if (f.amount_max !== undefined) { clauses.push('be.amount <= ?'); params.push(f.amount_max); }

  return { clauses, params };
}
