import { describe, expect, it } from 'vitest';
import {
  EMPTY_BILLING_EVENT_FILTERS, amountParam, appendApiFilters, billingEventIdFilter, filtersFromUrl, filtersToUrl, hasActiveFilter,
} from '../app/[locale]/payments/billing-events/billingEventFilters';

describe('#2886 billing event filters', () => {
  it('round-trips every filter through the page URL', () => {
    const f = {
      ...EMPTY_BILLING_EVENT_FILTERS,
      id: '153', memberId: 7, memberName: 'Ana', product: 'locker', processedBy: 'Alice', paymentMethod: 'card',
      from: '2026-01-01', to: '2026-02-01', amountMin: '10', amountMax: '99.5', status: ['paid', 'failed'],
    };
    expect(filtersFromUrl(filtersToUrl(f))).toEqual(f);
  });

  it('sends the API names and drops an amount that is not a number', () => {
    const p = new URLSearchParams();
    appendApiFilters(p, { ...EMPTY_BILLING_EVENT_FILTERS, memberId: 3, processedBy: 'Alice', amountMin: '12,5', amountMax: 'abc', status: ['paid'] });
    expect(p.get('member_id')).toBe('3');
    expect(p.get('processed_by')).toBe('Alice');
    expect(p.get('amount_min')).toBe('12.5');
    expect(p.has('amount_max')).toBe(false);
    expect(p.getAll('status')).toEqual(['paid']);
  });

  it('clearing one filter keeps the others', () => {
    const f = { ...EMPTY_BILLING_EVENT_FILTERS, product: 'pt', from: '2026-01-01' };
    const cleared = { ...f, product: '' };
    expect(filtersToUrl(cleared).toString()).toBe('from=2026-01-01');
    expect(hasActiveFilter(cleared)).toBe(true);
    expect(hasActiveFilter(EMPTY_BILLING_EVENT_FILTERS)).toBe(false);
  });

  it('amountParam reads blank as no bound', () => {
    expect(amountParam('  ')).toBeNull();
    expect(amountParam('0')).toBe('0');
  });

  it('#3510 reads ?id= into the ID filter and sends it with the other filters', () => {
    const f = filtersFromUrl(new URLSearchParams('id=153&product=locker'));
    expect(f.id).toBe('153');
    const p = new URLSearchParams();
    appendApiFilters(p, f);
    expect(p.get('id')).toBe('153');
    expect(p.get('product')).toBe('locker');
  });

  it('#3510 a cleared ID filter sends no id and leaves the URL to the others', () => {
    const f = { ...EMPTY_BILLING_EVENT_FILTERS, id: '153', from: '2026-01-01' };
    const cleared = { ...f, id: '' };
    const p = new URLSearchParams();
    appendApiFilters(p, cleared);
    expect(p.has('id')).toBe(false);
    expect(filtersToUrl(cleared).toString()).toBe('from=2026-01-01');
    expect(hasActiveFilter({ ...EMPTY_BILLING_EVENT_FILTERS, id: '7' })).toBe(true);
  });

  it('#3510 an ID no event can have is invalid and is never sent', () => {
    expect(billingEventIdFilter('')).toEqual({ kind: 'none' });
    expect(billingEventIdFilter(' #42 ')).toEqual({ kind: 'valid', id: 42 });
    for (const bad of ['abc', '0', '-3', '1.5', '99999999999999999999']) {
      expect(billingEventIdFilter(bad)).toEqual({ kind: 'invalid' });
      const p = new URLSearchParams();
      appendApiFilters(p, { ...EMPTY_BILLING_EVENT_FILTERS, id: bad });
      expect(p.has('id')).toBe(false);
    }
  });
});
