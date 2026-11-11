// #2647 stage 2 — a gym's Tax Configuration and its Electronic Invoicing integrations.
//
// Pure — no DB, no HTTP. The one place that decides which tax regimes, VAT statuses
// and calculation methods a gym may configure, which compliance providers exist,
// which countries and integration types each serves, which authorization statuses
// an integration may be in, and how a request's values are judged.
//
// Country-agnostic by construction: the shared model is the generic lists below,
// and a jurisdiction adds entries to `COUNTRY_TAX_REGIMES` / `COMPLIANCE_PROVIDERS`
// rather than a column or a branch. Nothing here prices or taxes anything: storing a
// configuration changes no invoice, payment or tax calculation (#2647 §1.B.4).
import { TAX_COUNTRIES, type TaxCountry } from './taxProfile';

/** Regimes every country offers. */
export const GENERIC_TAX_REGIMES = ['standard', 'exempt', 'other'] as const;

/** Country-specific regimes, offered before the generic ones. */
const COUNTRY_TAX_REGIMES: Partial<Record<TaxCountry, readonly string[]>> = {
  // Spain: régimen general, recargo de equivalencia, régimen simplificado.
  ES: ['es_general', 'es_recargo_equivalencia', 'es_simplificado'],
};

export function taxRegimesFor(country: string | null | undefined): string[] {
  const own = country ? COUNTRY_TAX_REGIMES[country as TaxCountry] ?? [] : [];
  return [...own, ...GENERIC_TAX_REGIMES];
}

/** Tax registration / VAT status. */
export const TAX_STATUSES = ['registered', 'not_registered', 'exempt'] as const;

/**
 * Default tax calculation method: the same pair a Product's `tax_behavior` already
 * stores (prices include or exclude tax), so the vocabulary is not a second one.
 */
export const TAX_CALCULATION_METHODS = ['inclusive', 'exclusive'] as const;

/** What an integration does. */
export const INTEGRATION_TYPES = ['invoice_reporting', 'e_invoicing'] as const;

/**
 * Where an integration stands with its authority; each country's procedure differs.
 * Mirrored by `chk_compliance_integrations_authorization_status` (migration 392).
 */
export const AUTHORIZATION_STATUSES = ['not_started', 'pending', 'authorized', 'rejected', 'revoked'] as const;

/**
 * The compliance providers a gym may configure, the countries each serves and the
 * integration types it offers. `other` is any provider not modelled yet.
 */
export const COMPLIANCE_PROVIDERS: readonly { key: string; countries: readonly string[] | 'any'; types: readonly string[] }[] = [
  { key: 'verifactu', countries: ['ES'], types: ['invoice_reporting'] },
  { key: 'other', countries: 'any', types: INTEGRATION_TYPES },
];

export function providersFor(country: string | null | undefined): string[] {
  if (!country) return [];
  return COMPLIANCE_PROVIDERS
    .filter((p) => p.countries === 'any' || p.countries.includes(country))
    .map((p) => p.key);
}

export function integrationTypesFor(provider: string): string[] {
  return [...(COMPLIANCE_PROVIDERS.find((p) => p.key === provider)?.types ?? [])];
}

/** Metadata stays small and never holds a secret (credentials are stage 3's). */
export const METADATA_MAX_BYTES = 8192;
const SECRET_KEY_PATTERN = /pass(word)?|secret|private[_-]?key|token|api[_-]?key|pin\b|credential/i;

/** Returns an error, or `null` when the value is a plain JSON object fit to store. */
export function metadataError(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${field} must be an object`;
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > METADATA_MAX_BYTES) return `${field} is too large`;
  const walk = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === 'object') {
      return Object.entries(v).some(([k, inner]) => SECRET_KEY_PATTERN.test(k) || walk(inner));
    }
    return false;
  };
  if (walk(value)) return `${field} must not contain credentials`;
  return null;
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

type Parse<T> = { ok: true; changes: Partial<T> } | { ok: false; error: string };

/** Reads an optional enumerated string: absent keeps, null/'' clears, unknown is an error. */
function readEnum(b: Record<string, unknown>, key: string, allowed: readonly string[]): { skip: true } | { value: string | null } | { error: string } {
  const raw = b[key];
  if (raw === undefined) return { skip: true };
  if (raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string' || !allowed.includes(raw.trim())) return { error: `${key} is invalid` };
  return { value: raw.trim() };
}

function readText(b: Record<string, unknown>, key: string, max: number): { skip: true } | { value: string | null } | { error: string } {
  const raw = b[key];
  if (raw === undefined) return { skip: true };
  if (raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: `${key} is invalid` };
  const v = raw.trim();
  if (v.length > max) return { error: `${key} is too long` };
  return { value: v === '' ? null : v };
}

function readDate(b: Record<string, unknown>, key: string): { skip: true } | { value: string | null } | { error: string } {
  const raw = b[key];
  if (raw === undefined) return { skip: true };
  if (raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string' || !isDateOnly(raw)) return { error: `${key} is invalid` };
  return { value: raw };
}

function readMetadata(b: Record<string, unknown>, key: string): { skip: true } | { value: Record<string, unknown> | null } | { error: string } {
  const raw = b[key];
  if (raw === undefined) return { skip: true };
  if (raw === null) return { value: null };
  const err = metadataError(raw, key);
  return err ? { error: err } : { value: raw as Record<string, unknown> };
}

type Field<V> = { skip: true } | { value: V } | { error: string };

function apply<T>(changes: Partial<T>, key: keyof T, r: Field<unknown>): string | null {
  if ('error' in r) return r.error;
  if ('value' in r) (changes as Record<string, unknown>)[key as string] = r.value;
  return null;
}

// ── Tax Configuration ──────────────────────────────────────────────────────────

export interface TaxConfiguration {
  tax_regime: string | null;
  tax_status: string | null;
  tax_calculation_method: string | null;
  additional_tax_identification: string | null;
  configuration_metadata: Record<string, unknown> | null;
}

export const EMPTY_TAX_CONFIGURATION: TaxConfiguration = {
  tax_regime: null,
  tax_status: null,
  tax_calculation_method: null,
  additional_tax_identification: null,
  configuration_metadata: null,
};

/**
 * Judges a `PUT` body against the stored configuration and the gym's fiscal country.
 * A field the body does not mention keeps its value; `null`/`''` clears it. The
 * resulting regime must be one the country offers, so a regime stored under a
 * previous country is refused on the next save rather than kept silently.
 */
export function parseTaxConfigurationInput(body: unknown, stored: TaxConfiguration, country: string | null): Parse<TaxConfiguration> {
  const b = (body ?? {}) as Record<string, unknown>;
  const changes: Partial<TaxConfiguration> = {};
  const errors = [
    apply(changes, 'tax_regime', readText(b, 'tax_regime', 50)),
    apply(changes, 'tax_status', readEnum(b, 'tax_status', TAX_STATUSES)),
    apply(changes, 'tax_calculation_method', readEnum(b, 'tax_calculation_method', TAX_CALCULATION_METHODS)),
    apply(changes, 'additional_tax_identification', readText(b, 'additional_tax_identification', 255)),
    apply(changes, 'configuration_metadata', readMetadata(b, 'configuration_metadata')),
  ].filter(Boolean);
  if (errors.length > 0) return { ok: false, error: errors[0] as string };
  const next = { ...stored, ...changes };
  if (next.tax_regime != null && !taxRegimesFor(country).includes(next.tax_regime)) {
    return { ok: false, error: 'tax_regime is invalid for the gym country' };
  }
  return { ok: true, changes };
}

// ── Electronic Invoicing integrations ──────────────────────────────────────────

export interface ComplianceIntegration {
  country_code: string;
  provider: string;
  integration_type: string;
  enabled: boolean;
  authorization_status: string;
  authorization_date: string | null;
  authorization_reference: string | null;
  activation_date: string | null;
  configuration_metadata: Record<string, unknown> | null;
}

function parseMutableIntegration(b: Record<string, unknown>): Parse<ComplianceIntegration> {
  const changes: Partial<ComplianceIntegration> = {};
  const errors = [
    apply(changes, 'authorization_status', readEnum(b, 'authorization_status', AUTHORIZATION_STATUSES)),
    apply(changes, 'authorization_date', readDate(b, 'authorization_date')),
    apply(changes, 'authorization_reference', readText(b, 'authorization_reference', 255)),
    apply(changes, 'activation_date', readDate(b, 'activation_date')),
    apply(changes, 'configuration_metadata', readMetadata(b, 'configuration_metadata')),
  ].filter(Boolean);
  if (errors.length > 0) return { ok: false, error: errors[0] as string };
  if (changes.authorization_status === null) return { ok: false, error: 'authorization_status is required' };
  return { ok: true, changes };
}

/**
 * A new integration: `provider` and `integration_type` are required, `country_code`
 * defaults to the gym's fiscal country, and the provider must serve that country
 * and offer that type. `enabled` is accepted here; afterwards it moves only through
 * the enable / disable routes.
 */
export function parseNewIntegrationInput(body: unknown, gymCountry: string | null): { ok: true; value: ComplianceIntegration } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawCountry = b.country_code ?? gymCountry;
  if (typeof rawCountry !== 'string' || rawCountry.trim() === '') return { ok: false, error: 'country_code is required' };
  const country = rawCountry.trim().toUpperCase();
  if (!(TAX_COUNTRIES as readonly string[]).includes(country)) return { ok: false, error: 'country_code is invalid' };
  if (typeof b.provider !== 'string' || b.provider.trim() === '') return { ok: false, error: 'provider is required' };
  const provider = b.provider.trim();
  if (!providersFor(country).includes(provider)) return { ok: false, error: 'provider is invalid for country_code' };
  if (typeof b.integration_type !== 'string' || b.integration_type.trim() === '') return { ok: false, error: 'integration_type is required' };
  const type = b.integration_type.trim();
  if (!integrationTypesFor(provider).includes(type)) return { ok: false, error: 'integration_type is invalid for provider' };
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled is invalid' };
  const rest = parseMutableIntegration(b);
  if (!rest.ok) return rest;
  return {
    ok: true,
    value: {
      country_code: country,
      provider,
      integration_type: type,
      enabled: b.enabled === true,
      authorization_status: rest.changes.authorization_status ?? 'not_started',
      authorization_date: rest.changes.authorization_date ?? null,
      authorization_reference: rest.changes.authorization_reference ?? null,
      activation_date: rest.changes.activation_date ?? null,
      configuration_metadata: rest.changes.configuration_metadata ?? null,
    },
  };
}

/**
 * A `PUT` of an existing integration: only the authorization fields and the
 * metadata move. Naming a different provider, type or country is a 400 rather than
 * a silent re-identification — that is a new integration.
 */
export function parseIntegrationUpdateInput(body: unknown, stored: ComplianceIntegration): Parse<ComplianceIntegration> {
  const b = (body ?? {}) as Record<string, unknown>;
  for (const key of ['provider', 'integration_type', 'country_code'] as const) {
    if (b[key] !== undefined && b[key] !== stored[key]) return { ok: false, error: `${key} cannot be changed` };
  }
  if (b.enabled !== undefined) return { ok: false, error: 'enabled is changed through enable / disable' };
  return parseMutableIntegration(b);
}

/** Everything the editors offer, so the browser keeps no list of its own. */
export function taxConfigurationOptions(): {
  tax_regimes: Record<string, string[]>;
  tax_statuses: string[];
  tax_calculation_methods: string[];
  providers: Record<string, string[]>;
  integration_types: Record<string, string[]>;
  authorization_statuses: string[];
} {
  const tax_regimes: Record<string, string[]> = {};
  const providers: Record<string, string[]> = {};
  for (const c of TAX_COUNTRIES) {
    tax_regimes[c] = taxRegimesFor(c);
    providers[c] = providersFor(c);
  }
  const integration_types: Record<string, string[]> = {};
  for (const p of COMPLIANCE_PROVIDERS) integration_types[p.key] = integrationTypesFor(p.key);
  return {
    tax_regimes,
    tax_statuses: [...TAX_STATUSES],
    tax_calculation_methods: [...TAX_CALCULATION_METHODS],
    providers,
    integration_types,
    authorization_statuses: [...AUTHORIZATION_STATUSES],
  };
}
