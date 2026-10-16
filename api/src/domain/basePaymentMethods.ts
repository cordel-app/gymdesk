/**
 * #1663 — the Base Payment Methods catalogue: the pure rules.
 *
 * `status` (enabled for use or not) and `deleted_at` (soft delete) are separate
 * facts. The seed list mirrors migration 284 (a migration is plain JS and cannot
 * import this module); a unit test asserts the two agree.
 */

export const BASE_PAYMENT_METHOD_STATUSES = ['active', 'inactive'] as const;
export type BasePaymentMethodStatus = typeof BASE_PAYMENT_METHOD_STATUSES[number];

/** The product languages a method must be named in. */
export const BASE_PAYMENT_METHOD_LOCALES = ['en', 'es', 'ca'] as const;
export type BasePaymentMethodLocale = typeof BASE_PAYMENT_METHOD_LOCALES[number];

export const MAX_CODE_LENGTH = 50;
export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 500;

export const SEED_BASE_PAYMENT_METHODS: ReadonlyArray<{ code: string; status: BasePaymentMethodStatus }> = [
  { code: 'members_app', status: 'active' },
  { code: 'cash', status: 'active' },
  { code: 'google_pay', status: 'inactive' },
  { code: 'apple_pay', status: 'inactive' },
  { code: 'card', status: 'active' },
  { code: 'paypal', status: 'inactive' },
  { code: 'bizum', status: 'inactive' },
  { code: 'monei', status: 'active' },
];

export type TranslationsInput = Record<string, { name: string; description: string | null }>;

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

export function parseCode(value: unknown): { value: string } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: 'code is required' };
  const code = value.trim();
  if (code.length > MAX_CODE_LENGTH) return { error: `code must be at most ${MAX_CODE_LENGTH} characters` };
  if (!CODE_PATTERN.test(code)) return { error: 'code must be lowercase letters, digits and underscores, starting with a letter' };
  return { value: code };
}

export function parseStatus(value: unknown): { value: BasePaymentMethodStatus } | { error: string } {
  if (typeof value !== 'string' || !(BASE_PAYMENT_METHOD_STATUSES as readonly string[]).includes(value)) {
    return { error: `status must be one of: ${BASE_PAYMENT_METHOD_STATUSES.join(', ')}` };
  }
  return { value: value as BasePaymentMethodStatus };
}

/**
 * Judges the `translations` map of a request. Every supported locale must carry
 * a name; a description is optional (blank = NULL). An unknown locale is a 400,
 * never dropped quietly.
 */
export function parseTranslations(value: unknown): { value: TranslationsInput } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'translations must be an object keyed by locale' };
  }
  const input = value as Record<string, any>;
  for (const key of Object.keys(input)) {
    if (!(BASE_PAYMENT_METHOD_LOCALES as readonly string[]).includes(key)) {
      return { error: `Unsupported locale: ${key}` };
    }
  }
  const out: TranslationsInput = {};
  for (const locale of BASE_PAYMENT_METHOD_LOCALES) {
    const entry = input[locale];
    if (!entry || typeof entry !== 'object') return { error: `translations.${locale}.name is required` };
    if (typeof entry.name !== 'string' || !entry.name.trim()) return { error: `translations.${locale}.name is required` };
    const name = entry.name.trim();
    if (name.length > MAX_NAME_LENGTH) return { error: `translations.${locale}.name must be at most ${MAX_NAME_LENGTH} characters` };
    let description: string | null = null;
    if (entry.description !== null && entry.description !== undefined && entry.description !== '') {
      if (typeof entry.description !== 'string') return { error: `translations.${locale}.description must be a string` };
      description = entry.description.trim() || null;
      if (description && description.length > MAX_DESCRIPTION_LENGTH) {
        return { error: `translations.${locale}.description must be at most ${MAX_DESCRIPTION_LENGTH} characters` };
      }
    }
    out[locale] = { name, description };
  }
  return { value: out };
}
