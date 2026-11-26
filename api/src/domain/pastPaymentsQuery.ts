/**
 * #3437 — what a page of the member's **Past Payments** is: which Billing
 * Events are past, in what order, from where the next page starts, and which
 * filters narrow them. Pure; `GET /me/billing-events/past` is its one caller.
 *
 * Four answers are the rule rather than the implementation.
 *
 *  - **"Past" is #3297's rule, in SQL.** An event is past when its scheduled
 *    execution date (`billing_date`, else the UTC day it was written —
 *    `scheduledExecutionDate()`) is before today, or is today and the event is
 *    not a persisted obligation still awaiting execution (`is_scheduled = 0`),
 *    exactly as `isPlannedPayment()` in the Members App splits the ledger.
 *  - **The order is stable and unique**: execution date, newest first, then the
 *    event id, so the cursor (`<date>:<id>`) names one position and no event is
 *    repeated or skipped between pages, whatever is written meanwhile.
 *  - **Filters are applied before the page is cut**, so every page belongs to
 *    the same filtered result set: a date range on the execution date (both
 *    ends inclusive) and a Product, matched by a line of the event that names
 *    it (`billing_event_lines.product_id`).
 *  - **Input is judged, never coerced**: an unreadable date, cursor, Product id
 *    or limit is a 400.
 */

export const PAST_PAYMENTS_DEFAULT_LIMIT = 3;
export const PAST_PAYMENTS_MAX_LIMIT = 50;

/** The scheduled execution date of `be`, as a DATE, in UTC (`scheduledExecutionDate()`'s rule). */
export const EXECUTION_DATE_SQL = 'COALESCE(be.billing_date, DATE(be.created_at))';

/** Past: executed before today, or today and no longer awaiting execution. */
export const PAST_EVENT_SQL =
  `(${EXECUTION_DATE_SQL} < UTC_DATE() OR (${EXECUTION_DATE_SQL} = UTC_DATE() AND be.is_scheduled = 0))`;

export interface PastPaymentsCursor {
  date: string;
  id: number;
}

export interface PastPaymentsQuery {
  limit: number;
  cursor: PastPaymentsCursor | null;
  dateFrom: string | null;
  dateTo: string | null;
  productId: number | null;
}

export type ParseResult = { ok: true; query: PastPaymentsQuery } | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function single(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  return value.trim();
}

export function encodePastPaymentsCursor(cursor: PastPaymentsCursor): string {
  return `${cursor.date}:${cursor.id}`;
}

export function decodePastPaymentsCursor(value: string): PastPaymentsCursor | null {
  const match = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(value);
  if (!match || !isDate(match[1])) return null;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) && id > 0 ? { date: match[1], id } : null;
}

/** Judges `GET /me/billing-events/past`'s query string. */
export function parsePastPaymentsQuery(q: Record<string, unknown>): ParseResult {
  const limitText = single(q.limit);
  let limit = PAST_PAYMENTS_DEFAULT_LIMIT;
  if (limitText != null && limitText !== '') {
    if (!/^\d+$/.test(limitText)) return { ok: false, error: 'limit must be a positive integer' };
    limit = Number(limitText);
    if (limit < 1 || limit > PAST_PAYMENTS_MAX_LIMIT) {
      return { ok: false, error: `limit must be between 1 and ${PAST_PAYMENTS_MAX_LIMIT}` };
    }
  } else if (limitText === null) {
    return { ok: false, error: 'limit must be a positive integer' };
  }

  const cursorText = single(q.cursor);
  let cursor: PastPaymentsCursor | null = null;
  if (cursorText === null) return { ok: false, error: 'cursor is invalid' };
  if (cursorText) {
    cursor = decodePastPaymentsCursor(cursorText);
    if (!cursor) return { ok: false, error: 'cursor is invalid' };
  }

  const dates: Record<'date_from' | 'date_to', string | null> = { date_from: null, date_to: null };
  for (const key of ['date_from', 'date_to'] as const) {
    const text = single(q[key]);
    if (text === null) return { ok: false, error: `${key} must be a date (YYYY-MM-DD)` };
    if (text) {
      if (!isDate(text)) return { ok: false, error: `${key} must be a date (YYYY-MM-DD)` };
      dates[key] = text;
    }
  }
  if (dates.date_from && dates.date_to && dates.date_from > dates.date_to) {
    return { ok: false, error: 'date_from must not be after date_to' };
  }

  const productText = single(q.product_id);
  let productId: number | null = null;
  if (productText === null) return { ok: false, error: 'product_id must be a positive integer' };
  if (productText) {
    if (!/^\d+$/.test(productText) || Number(productText) < 1 || !Number.isSafeInteger(Number(productText))) {
      return { ok: false, error: 'product_id must be a positive integer' };
    }
    productId = Number(productText);
  }

  return { ok: true, query: { limit, cursor, dateFrom: dates.date_from, dateTo: dates.date_to, productId } };
}

/** The filter and cursor conditions (each ANDed after the member's own scope), with their params. */
export function pastPaymentsConditions(query: PastPaymentsQuery): { sql: string[]; params: Array<string | number> } {
  const sql: string[] = [PAST_EVENT_SQL];
  const params: Array<string | number> = [];
  if (query.dateFrom) { sql.push(`${EXECUTION_DATE_SQL} >= ?`); params.push(query.dateFrom); }
  if (query.dateTo) { sql.push(`${EXECUTION_DATE_SQL} <= ?`); params.push(query.dateTo); }
  if (query.productId != null) {
    sql.push(`EXISTS (SELECT 1 FROM billing_event_lines bel
                       WHERE bel.billing_event_id = be.id AND bel.gym_id = be.gym_id AND bel.product_id = ?)`);
    params.push(query.productId);
  }
  if (query.cursor) {
    sql.push(`(${EXECUTION_DATE_SQL} < ? OR (${EXECUTION_DATE_SQL} = ? AND be.id < ?))`);
    params.push(query.cursor.date, query.cursor.date, query.cursor.id);
  }
  return { sql, params };
}

/** The page's ORDER BY: newest execution date first, then the unique id. */
export const PAST_PAYMENTS_ORDER_SQL = `${EXECUTION_DATE_SQL} DESC, be.id DESC`;
