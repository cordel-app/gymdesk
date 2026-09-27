import { describe, expect, it } from 'vitest';
import { selectPlanTaxRates, TaxRateCandidate } from '../domain/planTaxRate';

// #817 §2 — the Current price shows the tax-inclusive total *and* the net, which
// means the split has to be computable for every Plan that has a price, including
// one that never picked a Tax rate of its own ("Default" in the Pricing editor).
//
// Pure rule, so no DB and no HTTP: `enrichPlan()` hands it the rows of the one
// query it already makes and reads `own` for what the card displays and
// `effective` for what `computePriceFields()` splits at.

function rate(overrides: Partial<TaxRateCandidate> = {}): TaxRateCandidate {
  return { id: 1, name: 'Standard VAT', rate_percent: '21.00', is_system: 1, deleted_at: null, ...overrides };
}

const systemRate = rate({ id: 1, name: 'Standard VAT', rate_percent: '21.00', is_system: 1 });
const reducedRate = rate({ id: 7, name: 'Reduced', rate_percent: '10.00', is_system: 0 });

describe('selectPlanTaxRates (#817)', () => {
  it('a Plan with its own rate displays and bills at that rate', () => {
    const { own, effective } = selectPlanTaxRates([systemRate, reducedRate], 7);
    expect(own).toBe(reducedRate);
    expect(effective).toBe(reducedRate);
  });

  it('a Plan on "Default" displays no rate of its own but bills at the gym system rate', () => {
    // This is the case that used to render "—" for the Current price: no rate
    // meant no split, even though the Plan has a price.
    const { own, effective } = selectPlanTaxRates([systemRate, reducedRate], null);
    expect(own).toBeNull();
    expect(effective).toBe(systemRate);
  });

  it('treats undefined the same as null', () => {
    expect(selectPlanTaxRates([systemRate], undefined).effective).toBe(systemRate);
  });

  it('compares ids numerically, so a string id from the driver still matches', () => {
    const { own } = selectPlanTaxRates([systemRate, reducedRate], '7' as unknown as number);
    expect(own).toBe(reducedRate);
  });

  it('never picks a soft-deleted rate as the gym default', () => {
    const deletedSystem = rate({ id: 2, is_system: 1, deleted_at: new Date('2026-01-01') });
    const { own, effective } = selectPlanTaxRates([deletedSystem], null);
    expect(own).toBeNull();
    expect(effective).toBeNull();
  });

  it('still reports a soft-deleted rate the Plan itself references', () => {
    // It is what is configured; `validateTaxRateId()` is what stops a new one
    // being set. Nothing falls back to the system rate here, because the Plan
    // is not on "Default".
    const deleted = rate({ id: 9, name: 'Old VAT', rate_percent: '18.00', is_system: 0, deleted_at: '2026-01-01' });
    const { own, effective } = selectPlanTaxRates([deleted, systemRate], 9);
    expect(own).toBe(deleted);
    expect(effective).toBe(deleted);
  });

  it('falls back to nothing when the gym has no system rate at all', () => {
    const { own, effective } = selectPlanTaxRates([reducedRate], null);
    expect(own).toBeNull();
    expect(effective).toBeNull();
  });

  it('falls back to the gym default when the Plan points at a row that is not there', () => {
    // The query selects the Plan's own id explicitly and an FK guards the column,
    // so this is an impossible state rather than a real one — it must still leave
    // the card with a price to show rather than throwing or reading "—".
    const { own, effective } = selectPlanTaxRates([systemRate], 404);
    expect(own).toBeNull();
    expect(effective).toBe(systemRate);
  });
});
