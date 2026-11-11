// #2647 stage 2 — the pure rules of Tax Configuration and Electronic Invoicing.
import { describe, expect, it } from 'vitest';
import {
  EMPTY_TAX_CONFIGURATION,
  metadataError,
  parseIntegrationUpdateInput,
  parseNewIntegrationInput,
  parseTaxConfigurationInput,
  providersFor,
  taxRegimesFor,
} from '../domain/taxConfiguration';

describe('taxConfiguration', () => {
  it('offers country regimes before the generic ones, and only the generic ones with no country', () => {
    expect(taxRegimesFor('ES')).toEqual(['es_general', 'es_recargo_equivalencia', 'es_simplificado', 'standard', 'exempt', 'other']);
    expect(taxRegimesFor(null)).toEqual(['standard', 'exempt', 'other']);
    expect(providersFor('ES')).toEqual(['verifactu', 'other']);
    expect(providersFor('FR')).toEqual(['other']);
    expect(providersFor(null)).toEqual([]);
  });

  it('refuses metadata that is not an object, too large, or names a credential at any depth', () => {
    expect(metadataError({ a: 1 }, 'm')).toBeNull();
    expect(metadataError('x', 'm')).toMatch(/object/);
    expect(metadataError({ list: [{ apiKey: 'k' }] }, 'm')).toMatch(/credentials/);
    expect(metadataError({ PrivateKey: 'k' }, 'm')).toMatch(/credentials/);
    expect(metadataError({ big: 'x'.repeat(9000) }, 'm')).toMatch(/too large/);
  });

  it('keeps an unmentioned field, clears with null, and judges the resulting regime against the country', () => {
    const stored = { ...EMPTY_TAX_CONFIGURATION, tax_regime: 'es_general', tax_status: 'registered' };
    expect(parseTaxConfigurationInput({ tax_status: null }, stored, 'ES')).toEqual({ ok: true, changes: { tax_status: null } });
    // the country moved away from Spain: the stored Spanish regime is refused on the next save
    expect(parseTaxConfigurationInput({ tax_status: 'exempt' }, stored, 'FR')).toMatchObject({ ok: false });
    expect(parseTaxConfigurationInput({ tax_regime: null, tax_status: 'exempt' }, stored, 'FR')).toMatchObject({ ok: true });
    expect(parseTaxConfigurationInput({ tax_calculation_method: 'gross' }, stored, 'ES')).toMatchObject({ ok: false });
  });

  it('builds a new integration with defaults, and refuses a type the provider does not offer', () => {
    expect(parseNewIntegrationInput({ provider: 'verifactu', integration_type: 'invoice_reporting' }, 'ES')).toEqual({
      ok: true,
      value: {
        country_code: 'ES', provider: 'verifactu', integration_type: 'invoice_reporting', enabled: false,
        authorization_status: 'not_started', authorization_date: null, authorization_reference: null,
        activation_date: null, configuration_metadata: null,
      },
    });
    expect(parseNewIntegrationInput({ provider: 'verifactu', integration_type: 'e_invoicing' }, 'ES')).toMatchObject({ ok: false });
    expect(parseNewIntegrationInput({ provider: 'other', integration_type: 'e_invoicing', enabled: 'yes' }, 'IT')).toMatchObject({ ok: false });
  });

  it('an update cannot re-identify an integration nor clear its authorization status', () => {
    const stored = parseNewIntegrationInput({ provider: 'other', integration_type: 'e_invoicing' }, 'IT');
    if (!stored.ok) throw new Error('fixture');
    expect(parseIntegrationUpdateInput({ provider: 'other' }, stored.value)).toEqual({ ok: true, changes: {} });
    expect(parseIntegrationUpdateInput({ integration_type: 'invoice_reporting' }, stored.value)).toMatchObject({ ok: false });
    expect(parseIntegrationUpdateInput({ authorization_status: null }, stored.value)).toMatchObject({ ok: false });
  });
});
