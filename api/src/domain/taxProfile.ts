// #2647 stage 1 — a gym's Tax Profile: its fiscal identity as one legal entity.
//
// Pure — no DB, no HTTP. The one place that decides which fiscal countries exist,
// which tax identifier types each country offers, how an identifier is normalised
// and validated, and how a request's values are judged. Country-specific rules are
// entries of `TAX_ID_TYPES_BY_COUNTRY` / `TAX_ID_PATTERNS`, so a country is added
// here and nowhere else (no CHECK on `gyms`, migration 390).
//
// The fiscal fields reuse migration 114's columns: `legal_name`, `cif` (the tax
// identification number, whatever its type) and `fiscal_address` (line 1).

/**
 * The fiscal countries a gym may declare, ISO 3166-1 alpha-2: the EU-27 plus the
 * European non-EU jurisdictions closest to it. A country is labelled in the browser
 * from its code (`Intl.DisplayNames`), so no label lives here.
 */
export const TAX_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'AD', 'CH', 'GB', 'NO',
] as const;
export type TaxCountry = (typeof TAX_COUNTRIES)[number];

/** Generic identifier types every country offers. */
export const GENERIC_TAX_ID_TYPES = ['vat', 'other'] as const;

/** Country-specific identifier types, offered before the generic ones. */
const COUNTRY_TAX_ID_TYPES: Partial<Record<TaxCountry, readonly string[]>> = {
  // Spain: NIF (companies and residents; the former CIF is a NIF) and NIE (foreigners).
  ES: ['nif', 'nie'],
  // Portugal: NIF.
  PT: ['nif'],
  // France: SIREN / SIRET.
  FR: ['siren', 'siret'],
  // Italy: Codice Fiscale / Partita IVA.
  IT: ['codice_fiscale', 'partita_iva'],
};

export function taxIdTypesFor(country: string | null | undefined): string[] {
  const own = country ? COUNTRY_TAX_ID_TYPES[country as TaxCountry] ?? [] : [];
  return [...own, ...GENERIC_TAX_ID_TYPES];
}

/** What a stored identifier of a given type must look like once normalised. */
const TAX_ID_PATTERNS: Record<string, RegExp> = {
  nif: /^[0-9A-Z][0-9]{7}[0-9A-Z]$/, // ES: 8 digits + letter, or a company letter + 7 digits + control
  'PT:nif': /^[0-9]{9}$/,
  nie: /^[XYZ][0-9]{7}[A-Z]$/,
  siren: /^[0-9]{9}$/,
  siret: /^[0-9]{14}$/,
  codice_fiscale: /^[A-Z0-9]{16}$/,
  partita_iva: /^[0-9]{11}$/,
  vat: /^[A-Z]{2}[0-9A-Z]{2,13}$/,
  other: /^[0-9A-Z]{1,20}$/,
};

/** Uppercase, without spaces, dots, dashes or slashes — how `cif` is stored. */
export function normalizeTaxId(value: string): string {
  return value.toUpperCase().replace(/[\s.\-/]/g, '');
}

export function isValidTaxId(country: string | null, type: string | null, value: string): boolean {
  if (value.length === 0 || value.length > 20) return false;
  if (!type) return /^[0-9A-Z]{1,20}$/.test(value);
  const pattern = TAX_ID_PATTERNS[`${country}:${type}`] ?? TAX_ID_PATTERNS[type];
  return pattern ? pattern.test(value) : false;
}

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

export const TAX_PROFILE_FIELDS: readonly (keyof TaxProfile)[] = [
  'legal_name', 'country_code', 'tax_id_type', 'cif', 'fiscal_address', 'fiscal_address_line2',
  'fiscal_postal_code', 'fiscal_city', 'fiscal_region', 'tax_registration_date',
];

/** The fields a saved profile must hold (the issue's "required"). */
export const REQUIRED_TAX_PROFILE_FIELDS: readonly (keyof TaxProfile)[] = ['legal_name', 'country_code', 'cif', 'fiscal_address'];

const MAX_LENGTH: Partial<Record<keyof TaxProfile, number>> = {
  legal_name: 255,
  fiscal_address: 500,
  fiscal_address_line2: 255,
  fiscal_postal_code: 20,
  fiscal_city: 100,
  fiscal_region: 100,
};

export type TaxProfileParse =
  | { ok: true; changes: Partial<TaxProfile> }
  | { ok: false; error: string };

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Judges a `PUT` body against the stored profile. A field the body does not mention
 * keeps its stored value; `null` or `''` clears an optional one; anything else
 * malformed is an error, never a coercion. The *resulting* profile must hold the
 * required fields and a tax id valid for its country and type, so a country change
 * that leaves the stored type or number invalid is refused rather than saved.
 */
export function parseTaxProfileInput(body: unknown, stored: TaxProfile): TaxProfileParse {
  const b = (body ?? {}) as Record<string, unknown>;
  const changes: Partial<TaxProfile> = {};

  for (const key of TAX_PROFILE_FIELDS) {
    const raw = b[key];
    if (raw === undefined) continue;
    if (raw === null || raw === '') {
      changes[key] = null;
      continue;
    }
    if (typeof raw !== 'string') return { ok: false, error: `${key} is invalid` };
    let value = raw.trim();
    if (value === '') {
      changes[key] = null;
      continue;
    }
    if (key === 'country_code') {
      value = value.toUpperCase();
      if (!(TAX_COUNTRIES as readonly string[]).includes(value)) return { ok: false, error: 'country_code is invalid' };
    } else if (key === 'cif') {
      value = normalizeTaxId(value);
    } else if (key === 'tax_registration_date') {
      if (!isDateOnly(value)) return { ok: false, error: 'tax_registration_date is invalid' };
    } else if (key === 'tax_id_type') {
      value = value.toLowerCase();
    }
    const max = MAX_LENGTH[key];
    if (max !== undefined && value.length > max) return { ok: false, error: `${key} is too long` };
    changes[key] = value;
  }

  const next: TaxProfile = { ...stored, ...changes };
  for (const key of REQUIRED_TAX_PROFILE_FIELDS) {
    if (next[key] == null || String(next[key]).trim() === '') return { ok: false, error: `${key} is required` };
  }
  if (next.tax_id_type != null && !taxIdTypesFor(next.country_code).includes(next.tax_id_type)) {
    return { ok: false, error: 'tax_id_type is invalid for country_code' };
  }
  if (!isValidTaxId(next.country_code, next.tax_id_type, normalizeTaxId(String(next.cif)))) {
    return { ok: false, error: 'cif is invalid for tax_id_type' };
  }
  return { ok: true, changes };
}

/** The options the editor offers, so the browser keeps no country list of its own. */
export function taxProfileOptions(): { countries: string[]; tax_id_types: Record<string, string[]> } {
  const tax_id_types: Record<string, string[]> = {};
  for (const c of TAX_COUNTRIES) tax_id_types[c] = taxIdTypesFor(c);
  return { countries: [...TAX_COUNTRIES], tax_id_types };
}
