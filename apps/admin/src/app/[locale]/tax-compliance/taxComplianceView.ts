// #2647 stage 1 — the pure half of Settings → Tax & Compliance: the subsections,
// the Tax Profile's field order and its form ↔ payload mapping. The accepted
// countries and identifier types are the API's (`GET /system/tax-compliance/profile/options`,
// `api/src/domain/taxProfile.ts`); nothing here keeps a list of its own.

export type TaxComplianceTab = 'profile' | 'history';

export const TAX_COMPLIANCE_TABS: readonly { id: TaxComplianceTab; labelKey: string }[] = [
  { id: 'profile', labelKey: 'tab_profile' },
  { id: 'history', labelKey: 'tab_history' },
];

export interface TaxProfile {
  legal_name: string | null;
  country_code: string | null;
  tax_id_type: string | null;
  cif: string | null;
  fiscal_address: string | null;
  fiscal_address_line2: string | null;
  fiscal_postal_code: string | null;
  fiscal_city: string | null;
  fiscal_region: string | null;
  tax_registration_date: string | null;
}

export interface TaxProfileOptions {
  countries: string[];
  tax_id_types: Record<string, string[]>;
}

export type TaxProfileField = keyof TaxProfile;

/** The order both halves (read-only and Edit) render, with which are required. */
export const TAX_PROFILE_LAYOUT: readonly { key: TaxProfileField; required: boolean; full?: boolean }[] = [
  { key: 'legal_name', required: true, full: true },
  { key: 'country_code', required: true },
  { key: 'tax_id_type', required: false },
  { key: 'cif', required: true },
  { key: 'tax_registration_date', required: false },
  { key: 'fiscal_address', required: true, full: true },
  { key: 'fiscal_address_line2', required: false, full: true },
  { key: 'fiscal_postal_code', required: false },
  { key: 'fiscal_city', required: false },
  { key: 'fiscal_region', required: false },
];

export type TaxProfileForm = Record<TaxProfileField, string>;

export function toTaxProfileForm(p: TaxProfile): TaxProfileForm {
  const form = {} as TaxProfileForm;
  for (const { key } of TAX_PROFILE_LAYOUT) form[key] = p[key] ?? '';
  return form;
}

/** Every field is sent; a blank one clears an optional value (the API's rule). */
export function toTaxProfilePayload(f: TaxProfileForm): Record<TaxProfileField, string | null> {
  const out = {} as Record<TaxProfileField, string | null>;
  for (const { key } of TAX_PROFILE_LAYOUT) out[key] = f[key].trim() === '' ? null : f[key].trim();
  return out;
}

/** The identifier types the chosen country offers; none until a country is chosen. */
export function taxIdTypeOptions(options: TaxProfileOptions | null, country: string): string[] {
  if (!options || !country) return [];
  return options.tax_id_types[country] ?? [];
}

/**
 * Changing the country clears an identifier type the new country does not offer,
 * so the form never submits a pair the API would refuse for that reason alone.
 */
export function withCountry(f: TaxProfileForm, country: string, options: TaxProfileOptions | null): TaxProfileForm {
  const types = taxIdTypeOptions(options, country);
  return { ...f, country_code: country, tax_id_type: types.includes(f.tax_id_type) ? f.tax_id_type : '' };
}

/** Client-side required check, mirroring the API; the API stays the authority. */
export function missingRequired(f: TaxProfileForm): TaxProfileField[] {
  return TAX_PROFILE_LAYOUT.filter((l) => l.required && f[l.key].trim() === '').map((l) => l.key);
}

/** The event types the history knows a label for; any other reads as stored. */
export const KNOWN_COMPLIANCE_EVENT_TYPES = ['tax_profile_updated'] as const;
