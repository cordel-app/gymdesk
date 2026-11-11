import { describe, it, expect } from 'vitest';
import {
  missingRequired,
  toTaxProfileForm,
  toTaxProfilePayload,
  withCountry,
  type TaxProfile,
} from '../app/[locale]/tax-compliance/taxComplianceView';

const OPTIONS = { countries: ['ES', 'DE'], tax_id_types: { ES: ['nif', 'nie', 'vat', 'other'], DE: ['vat', 'other'] } };
const PROFILE: TaxProfile = {
  legal_name: 'Gym SL', country_code: 'ES', tax_id_type: 'nie', cif: 'X1234567L', fiscal_address: 'Calle 1',
  fiscal_address_line2: null, fiscal_postal_code: null, fiscal_city: null, fiscal_region: null, tax_registration_date: null,
};

describe('taxComplianceView (#2647)', () => {
  it('round-trips a profile, sending a blank optional field as null', () => {
    const payload = toTaxProfilePayload(toTaxProfileForm(PROFILE));
    expect(payload).toEqual(PROFILE);
  });

  it('clears an identifier type the new country does not offer, and keeps one it does', () => {
    const form = toTaxProfileForm(PROFILE);
    expect(withCountry(form, 'DE', OPTIONS).tax_id_type).toBe('');
    expect(withCountry({ ...form, tax_id_type: 'vat' }, 'DE', OPTIONS).tax_id_type).toBe('vat');
  });

  it('names the required fields that are blank', () => {
    expect(missingRequired({ ...toTaxProfileForm(PROFILE), cif: ' ', legal_name: '' })).toEqual(['legal_name', 'cif']);
  });
});
