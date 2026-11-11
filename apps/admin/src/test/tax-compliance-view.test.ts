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

// ── #2647 stage 2 ─────────────────────────────────────────────────────────────
import {
  parseMetadataText,
  regimeOptions,
  toIntegrationPayload,
  toTaxConfigurationPayload,
  withIntegrationIdentity,
  newIntegrationForm,
  type TaxConfigurationOptions,
} from '../app/[locale]/tax-compliance/taxComplianceView';

const CONFIG_OPTIONS: TaxConfigurationOptions = {
  tax_regimes: { ES: ['es_general', 'standard', 'exempt', 'other'], FR: ['standard', 'exempt', 'other'] },
  tax_statuses: ['registered'],
  tax_calculation_methods: ['inclusive', 'exclusive'],
  providers: { ES: ['verifactu', 'other'], FR: ['other'] },
  integration_types: { verifactu: ['invoice_reporting'], other: ['invoice_reporting', 'e_invoicing'] },
  authorization_statuses: ['not_started'],
};

describe('Tax Configuration / Electronic Invoicing view (#2647 stage 2)', () => {
  it('reads metadata as a JSON object or nothing, and refuses anything else', () => {
    expect(parseMetadataText('  ')).toEqual({ ok: true, value: null });
    expect(parseMetadataText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseMetadataText('[1]')).toEqual({ ok: false });
    expect(parseMetadataText('{oops')).toEqual({ ok: false });
    expect(toTaxConfigurationPayload({ tax_regime: '', tax_status: 'registered', tax_calculation_method: '', additional_tax_identification: ' ', metadata: 'x' })).toBeNull();
    expect(toTaxConfigurationPayload({ tax_regime: '', tax_status: 'registered', tax_calculation_method: '', additional_tax_identification: ' ', metadata: '' }))
      .toEqual({ tax_regime: null, tax_status: 'registered', tax_calculation_method: null, additional_tax_identification: null, configuration_metadata: null });
  });

  it('offers the country regimes, or only the generic ones with no country', () => {
    expect(regimeOptions(CONFIG_OPTIONS, 'ES')).toContain('es_general');
    expect(regimeOptions(CONFIG_OPTIONS, null)).toEqual(['standard', 'exempt', 'other']);
  });

  it('clears a provider the new country lacks and picks the only type a provider offers', () => {
    const f = withIntegrationIdentity(newIntegrationForm('ES'), { provider: 'verifactu' }, CONFIG_OPTIONS);
    expect(f.integration_type).toBe('invoice_reporting');
    const moved = withIntegrationIdentity(f, { country_code: 'FR' }, CONFIG_OPTIONS);
    expect(moved.provider).toBe('');
    expect(moved.integration_type).toBe('');
  });

  it('sends the identity only on create', () => {
    const f = { ...newIntegrationForm('ES'), provider: 'verifactu', integration_type: 'invoice_reporting' };
    expect(toIntegrationPayload(f, true)).toMatchObject({ provider: 'verifactu', country_code: 'ES' });
    expect(toIntegrationPayload(f, false)).not.toHaveProperty('provider');
  });
});
