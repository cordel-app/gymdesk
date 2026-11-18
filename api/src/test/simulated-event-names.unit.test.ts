import { describe, expect, it } from 'vitest';
import { simulatedEventNames } from '../domain/billingEventName';

describe('simulatedEventNames (#3045)', () => {
  it('names monthly dates on the 1st like real events', () => {
    expect(simulatedEventNames([{ date: '2026-12-01' }, { date: '2027-01-01' }], 'Cordel'))
      .toEqual(['Cordel - December', 'Cordel - January']);
  });
  it('carries the date for 4-weekly dates', () => {
    expect(simulatedEventNames([{ date: '2026-11-30' }, { date: '2026-12-28' }], 'Cordel'))
      .toEqual(['Cordel - November (30/11/2026)', 'Cordel - December (28/12/2026)']);
  });
  it('names the initial payment Initial Engagement', () => {
    expect(simulatedEventNames([{ date: '2026-11-18', kind: 'initial_payment' }, { date: '2026-12-01' }], 'Cordel'))
      .toEqual(['Initial Engagement', 'Cordel - December']);
  });
});
