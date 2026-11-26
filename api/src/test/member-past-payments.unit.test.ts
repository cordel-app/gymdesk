// #3437 — the pure halves of Past Payments: the API's query rules
// (`domain/pastPaymentsQuery.ts`) and the Members App's request and list rules
// (`apps/member/src/lib/memberPastPayments.ts`, in the API suite because CI runs
// `npm test` in `api/` only).
import { describe, expect, it } from 'vitest';
import {
  PAST_PAYMENTS_DEFAULT_LIMIT,
  decodePastPaymentsCursor,
  encodePastPaymentsCursor,
  parsePastPaymentsQuery,
  pastPaymentsConditions,
} from '../domain/pastPaymentsQuery';
import {
  EMPTY_PAST_FILTERS,
  appendPastPage,
  hasPastFilters,
  pastFiltersError,
  pastPaymentsPath,
} from '../../../apps/member/src/lib/memberPastPayments';

describe('parsePastPaymentsQuery', () => {
  it('defaults to the first three, unfiltered', () => {
    expect(parsePastPaymentsQuery({})).toEqual({
      ok: true, query: { limit: PAST_PAYMENTS_DEFAULT_LIMIT, cursor: null, dateFrom: null, dateTo: null, productId: null },
    });
  });

  it('reads a cursor, a range and a Product', () => {
    const r = parsePastPaymentsQuery({ cursor: '2026-02-05:12', date_from: '2026-01-01', date_to: '2026-02-28', product_id: '7', limit: '5' });
    expect(r).toEqual({
      ok: true, query: { limit: 5, cursor: { date: '2026-02-05', id: 12 }, dateFrom: '2026-01-01', dateTo: '2026-02-28', productId: 7 },
    });
  });

  it.each([
    [{ limit: '0' }], [{ limit: '51' }], [{ limit: 'x' }], [{ cursor: '2026-02-30:1' }], [{ cursor: 'abc' }],
    [{ date_from: '2026-1-1' }], [{ date_to: '2026-02-31' }], [{ date_from: '2026-03-01', date_to: '2026-02-01' }],
    [{ product_id: '0' }], [{ product_id: '1.5' }], [{ product_id: ['1', '2'] }],
  ])('refuses %j', (q) => {
    expect(parsePastPaymentsQuery(q as any).ok).toBe(false);
  });

  it('round-trips a cursor', () => {
    expect(decodePastPaymentsCursor(encodePastPaymentsCursor({ date: '2026-11-26', id: 99 }))).toEqual({ date: '2026-11-26', id: 99 });
  });

  it('binds every filter and the cursor as parameters, in order', () => {
    const r = parsePastPaymentsQuery({ cursor: '2026-02-05:12', date_from: '2026-01-01', product_id: '7' });
    if (!r.ok) throw new Error('unexpected');
    const { sql, params } = pastPaymentsConditions(r.query);
    expect(sql).toHaveLength(4);
    expect(params).toEqual(['2026-01-01', 7, '2026-02-05', '2026-02-05', 12]);
  });
});

describe('Members App Past Payments', () => {
  it('builds the request for a page from the filters and the cursor', () => {
    expect(pastPaymentsPath(EMPTY_PAST_FILTERS)).toBe('/me/billing-events/past');
    expect(pastPaymentsPath({ dateFrom: '2026-01-01', dateTo: '', productId: '4' }, '2026-02-05:12'))
      .toBe('/me/billing-events/past?date_from=2026-01-01&product_id=4&cursor=2026-02-05%3A12');
  });

  it('knows when a filter is set and when a range is backwards', () => {
    expect(hasPastFilters(EMPTY_PAST_FILTERS)).toBe(false);
    expect(hasPastFilters({ ...EMPTY_PAST_FILTERS, productId: '3' })).toBe(true);
    expect(pastFiltersError({ dateFrom: '2026-03-01', dateTo: '2026-02-01', productId: '' })).toBe('payments.past_filter_range_invalid');
    expect(pastFiltersError({ dateFrom: '2026-02-01', dateTo: '2026-02-01', productId: '' })).toBeNull();
  });

  it('adds a page to the list without repeating a payment', () => {
    const e = (id: number) => ({ id } as any);
    expect(appendPastPage([e(5), e(4)], [e(4), e(3)]).map((x) => x.id)).toEqual([5, 4, 3]);
  });
});
