// #2647 stage 1 — the pure half of Settings → Tax & Compliance: the subsections,
// the Tax Profile's field order and its form ↔ payload mapping. The accepted
// countries and identifier types are the API's (`GET /system/tax-compliance/profile/options`,
// `api/src/domain/taxProfile.ts`); nothing here keeps a list of its own.

export type TaxComplianceTab = 'profile' | 'configuration' | 'e_invoicing' | 'credentials' | 'history';

export const TAX_COMPLIANCE_TABS: readonly { id: TaxComplianceTab; labelKey: string }[] = [
  { id: 'profile', labelKey: 'tab_profile' },
  { id: 'configuration', labelKey: 'tab_configuration' },
  { id: 'e_invoicing', labelKey: 'tab_e_invoicing' },
  { id: 'credentials', labelKey: 'tab_credentials' },
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
export const KNOWN_COMPLIANCE_EVENT_TYPES = [
  'tax_profile_updated',
  'tax_configuration_updated',
  'integration_created',
  'integration_updated',
  'integration_enabled',
  'integration_disabled',
  'credential_uploaded',
  'credential_replaced',
  'credential_reference_created',
  'credential_updated',
  'credential_deleted',
] as const;

// ── #2647 stage 2: Tax Configuration and Electronic Invoicing ─────────────────
// The accepted values are the API's (`GET /system/tax-compliance/configuration/options`,
// `api/src/domain/taxConfiguration.ts`); nothing here keeps a list of its own.

export type Metadata = Record<string, unknown> | null;

export interface TaxConfiguration {
  tax_regime: string | null;
  tax_status: string | null;
  tax_calculation_method: string | null;
  additional_tax_identification: string | null;
  configuration_metadata: Metadata;
}

export interface TaxConfigurationOptions {
  tax_regimes: Record<string, string[]>;
  tax_statuses: string[];
  tax_calculation_methods: string[];
  providers: Record<string, string[]>;
  integration_types: Record<string, string[]>;
  authorization_statuses: string[];
}

export interface ComplianceIntegration {
  id: number;
  country_code: string;
  provider: string;
  integration_type: string;
  enabled: boolean;
  authorization_status: string;
  authorization_date: string | null;
  authorization_reference: string | null;
  activation_date: string | null;
  configuration_metadata: Metadata;
}

/** Metadata is edited as JSON text; an empty text is no metadata. */
export function metadataText(m: Metadata): string {
  return m && Object.keys(m).length > 0 ? JSON.stringify(m, null, 2) : '';
}

export function parseMetadataText(text: string): { ok: true; value: Metadata } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export interface TaxConfigurationForm {
  tax_regime: string;
  tax_status: string;
  tax_calculation_method: string;
  additional_tax_identification: string;
  metadata: string;
}

export const TAX_CONFIGURATION_FIELDS = ['tax_regime', 'tax_status', 'tax_calculation_method', 'additional_tax_identification'] as const;

export function toTaxConfigurationForm(c: TaxConfiguration): TaxConfigurationForm {
  return {
    tax_regime: c.tax_regime ?? '',
    tax_status: c.tax_status ?? '',
    tax_calculation_method: c.tax_calculation_method ?? '',
    additional_tax_identification: c.additional_tax_identification ?? '',
    metadata: metadataText(c.configuration_metadata),
  };
}

/** `null` when the metadata text is not a JSON object; a blank field clears its value. */
export function toTaxConfigurationPayload(f: TaxConfigurationForm): Record<string, unknown> | null {
  const meta = parseMetadataText(f.metadata);
  if (!meta.ok) return null;
  const blank = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    tax_regime: blank(f.tax_regime),
    tax_status: blank(f.tax_status),
    tax_calculation_method: blank(f.tax_calculation_method),
    additional_tax_identification: blank(f.additional_tax_identification),
    configuration_metadata: meta.value,
  };
}

/** The regimes the gym's fiscal country offers (the generic ones when it has none). */
export function regimeOptions(options: TaxConfigurationOptions | null, country: string | null): string[] {
  if (!options) return [];
  if (country && options.tax_regimes[country]) return options.tax_regimes[country];
  const any = Object.values(options.tax_regimes)[0] ?? [];
  // The generic regimes are the ones every country offers.
  return any.filter((r) => Object.values(options.tax_regimes).every((list) => list.includes(r)));
}

export interface IntegrationForm {
  country_code: string;
  provider: string;
  integration_type: string;
  authorization_status: string;
  authorization_date: string;
  authorization_reference: string;
  activation_date: string;
  metadata: string;
}

export function newIntegrationForm(country: string | null): IntegrationForm {
  return {
    country_code: country ?? '',
    provider: '',
    integration_type: '',
    authorization_status: 'not_started',
    authorization_date: '',
    authorization_reference: '',
    activation_date: '',
    metadata: '',
  };
}

export function toIntegrationForm(i: ComplianceIntegration): IntegrationForm {
  return {
    country_code: i.country_code,
    provider: i.provider,
    integration_type: i.integration_type,
    authorization_status: i.authorization_status,
    authorization_date: i.authorization_date ?? '',
    authorization_reference: i.authorization_reference ?? '',
    activation_date: i.activation_date ?? '',
    metadata: metadataText(i.configuration_metadata),
  };
}

/**
 * The body of a create (`identity: true`) or an update. An update never sends the
 * provider, type or country: they identify the row and the API refuses a change.
 */
export function toIntegrationPayload(f: IntegrationForm, identity: boolean): Record<string, unknown> | null {
  const meta = parseMetadataText(f.metadata);
  if (!meta.ok) return null;
  const blank = (v: string) => (v.trim() === '' ? null : v.trim());
  const body: Record<string, unknown> = {
    authorization_status: f.authorization_status,
    authorization_date: blank(f.authorization_date),
    authorization_reference: blank(f.authorization_reference),
    activation_date: blank(f.activation_date),
    configuration_metadata: meta.value,
  };
  if (identity) {
    body.country_code = f.country_code;
    body.provider = f.provider;
    body.integration_type = f.integration_type;
  }
  return body;
}

/** Changing the country or the provider clears a choice the new one does not offer. */
export function withIntegrationIdentity(
  f: IntegrationForm,
  patch: Partial<Pick<IntegrationForm, 'country_code' | 'provider'>>,
  options: TaxConfigurationOptions | null,
): IntegrationForm {
  const next = { ...f, ...patch };
  const providers = options?.providers[next.country_code] ?? [];
  if (!providers.includes(next.provider)) next.provider = '';
  const types = options?.integration_types[next.provider] ?? [];
  if (!types.includes(next.integration_type)) next.integration_type = types.length === 1 ? types[0] : '';
  return next;
}

// ── #2647 stage 3: Certificates & Credentials ─────────────────────────────────
// What a credential is and what may be uploaded are the API's
// (`GET /system/tax-compliance/credentials/options`, `api/src/domain/complianceCredentials.ts`).
// A credential row never carries its file, its password or where it is stored.

export interface ComplianceCredential {
  id: number;
  integration_id: number | null;
  credential_type: 'certificate' | 'external_reference';
  label: string | null;
  status: 'active' | 'inactive';
  effective_status: 'active' | 'inactive' | 'expired' | 'not_yet_valid';
  expires_soon: boolean;
  has_material: boolean;
  external_reference: string | null;
  file_name: string | null;
  certificate_subject: string | null;
  certificate_serial_number: string | null;
  certificate_issuer: string | null;
  certificate_fingerprint: string | null;
  valid_from: string | null;
  expires_at: string | null;
  created_at: string;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
}

export interface CredentialOptions {
  credential_types: readonly string[];
  statuses: readonly string[];
  certificate_extensions: readonly string[];
  certificate_max_bytes: number;
  expiry_warning_days: number;
}

/** The name a credential is shown under: its label, else what it says about itself. */
export function credentialTitle(c: ComplianceCredential): string {
  return c.label ?? c.certificate_subject ?? c.external_reference ?? `#${c.id}`;
}

/** The `StatusBadge` tone a credential's effective status wears (no colour of its own). */
export function credentialBadgeStatus(c: ComplianceCredential): 'active' | 'inactive' | 'expired' | 'pending' {
  return c.effective_status === 'not_yet_valid' ? 'pending' : c.effective_status;
}

/** The locale key explaining why a picked file cannot be uploaded, or null. */
export function certificateFileError(
  file: { name: string; size: number } | null,
  options: CredentialOptions | null,
): string | null {
  if (!file) return 'error_certificate_file_required';
  const name = file.name.toLowerCase();
  const exts = options?.certificate_extensions ?? ['.p12', '.pfx'];
  if (!exts.some((e) => name.endsWith(e))) return 'error_certificate_file_type';
  if (file.size === 0) return 'error_certificate_file_required';
  if (options && file.size > options.certificate_max_bytes) return 'error_certificate_file_size';
  return null;
}
