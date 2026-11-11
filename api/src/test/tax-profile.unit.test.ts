import { describe, it, expect } from 'vitest';
import { parseTaxProfileInput, taxIdTypesFor, isValidTaxId, normalizeTaxId, type TaxProfile } from '../domain/taxProfile';

const EMPTY: TaxProfile = {
  legal_name: null, country_code: null, tax_id_type: null, cif: null, fiscal_address: null,
  fiscal_address_line2: null, fiscal_postal_code: null, fiscal_city: null, fiscal_region: null,
  tax_registration_date: null,
};
const VALID = { legal_name: 'Gym SL', country_code: 'es', tax_id_type: 'nif', cif: 'b-1234567.8', fiscal_address: 'Calle 1' };

describe('taxProfile (#2647)', () => {
  it('offers country-specific identifier types before the generic ones', () => {
    expect(taxIdTypesFor('ES')).toEqual(['nif', 'nie', 'vat', 'other']);
    expect(taxIdTypesFor('DE')).toEqual(['vat', 'other']);
  });

  it('normalises and validates an identifier per country and type', () => {
    expect(normalizeTaxId('b-1234567.8')).toBe('B12345678');
    expect(isValidTaxId('ES', 'nif', 'B12345678')).toBe(true);
    expect(isValidTaxId('ES', 'nie', 'B12345678')).toBe(false);
    expect(isValidTaxId('PT', 'nif', '123456789')).toBe(true);
    expect(isValidTaxId('PT', 'nif', 'B12345678')).toBe(false);
    expect(isValidTaxId('DE', 'vat', 'DE123456789')).toBe(true);
  });

  it('requires the legal name, country, tax id and address in the resulting profile', () => {
    expect(parseTaxProfileInput({ legal_name: 'Gym SL' }, EMPTY)).toEqual({ ok: false, error: 'country_code is required' });
    const ok = parseTaxProfileInput(VALID, EMPTY);
    expect(ok).toEqual({ ok: true, changes: { legal_name: 'Gym SL', country_code: 'ES', tax_id_type: 'nif', cif: 'B12345678', fiscal_address: 'Calle 1' } });
  });

  it('keeps an unmentioned field and clears an optional one on null', () => {
    const stored: TaxProfile = { ...EMPTY, legal_name: 'Gym SL', country_code: 'ES', tax_id_type: 'nif', cif: 'B12345678', fiscal_address: 'Calle 1', fiscal_city: 'Barcelona' };
    expect(parseTaxProfileInput({ fiscal_city: null }, stored)).toEqual({ ok: true, changes: { fiscal_city: null } });
    expect(parseTaxProfileInput({}, stored)).toEqual({ ok: true, changes: {} });
  });

  it('refuses a country change that leaves the stored type invalid, without coercing', () => {
    const stored: TaxProfile = { ...EMPTY, legal_name: 'Gym SL', country_code: 'ES', tax_id_type: 'nie', cif: 'X1234567L', fiscal_address: 'Calle 1' };
    expect(parseTaxProfileInput({ country_code: 'DE' }, stored)).toMatchObject({ ok: false });
  });

  it('refuses an unknown country, a malformed date and a non-string value', () => {
    for (const body of [{ country_code: 'XX' }, { tax_registration_date: '2026-02-30' }, { legal_name: 5 }]) {
      expect(parseTaxProfileInput({ ...VALID, ...body }, EMPTY)).toMatchObject({ ok: false });
    }
  });

  it('accepts a legacy identifier with no type when it is alphanumeric', () => {
    expect(parseTaxProfileInput({ ...VALID, tax_id_type: null }, EMPTY)).toMatchObject({ ok: true });
  });
});
