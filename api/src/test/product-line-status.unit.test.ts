// #2781 — a Product line's status on the Members App card is the line's own,
// never its Product Set's.
import { describe, expect, it } from 'vitest';
import { productLineStatus } from '../domain/productLineStatus';

const today = '2026-11-13';
const base = { today, endsAt: null, startsAt: '2026-10-01' };

describe('productLineStatus', () => {
  it('reads an inherited line of a Draft as active, not as the Draft', () => {
    expect(productLineStatus({ ...base, setStatus: 'draft', change: 'inherited' })).toBe('active');
    expect(productLineStatus({ ...base, setStatus: 'pending_payment', change: 'inherited' })).toBe('active');
  });
  it('reads a line the Draft or pending version added as not yet contracted', () => {
    expect(productLineStatus({ ...base, setStatus: 'draft', change: 'added' })).toBe('draft');
    expect(productLineStatus({ ...base, setStatus: 'pending_payment', change: 'added' })).toBe('pending_payment');
  });
  it('reads a line of an Active version as active, whichever version added it', () => {
    expect(productLineStatus({ ...base, setStatus: 'active', change: 'added' })).toBe('active');
  });
  it('reads a removed line running to its end date as cancels on end date', () => {
    expect(productLineStatus({ ...base, endsAt: '2026-11-30', setStatus: 'active', change: 'inherited' })).toBe('cancels_on_end_date');
  });
  it('reads a line starting later as pending', () => {
    expect(productLineStatus({ ...base, startsAt: '2026-12-01', setStatus: 'active', change: 'inherited' })).toBe('pending');
  });
  it('gives two lines of one version their own statuses', () => {
    const a = productLineStatus({ ...base, setStatus: 'active', change: 'inherited' });
    const b = productLineStatus({ ...base, endsAt: '2026-11-20', setStatus: 'active', change: 'inherited' });
    expect([a, b]).toEqual(['active', 'cancels_on_end_date']);
  });
});
