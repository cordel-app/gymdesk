// #1246 stage 1 — a gym's Time & Localization settings: the one place that
// decides what each may hold and how a request's value is judged.
//
// Pure — no DB, no HTTP. Currency is display-only and EUR is the only accepted
// value for now (the payment provider boundary is untouched). The combined
// "Date & Time Format" is derived from `date_format` + `time_format`, never
// stored, so the two cannot disagree.

export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const;
export const TIME_FORMATS = ['24h', '12h'] as const;
export const NUMBER_FORMATS = ['comma_decimal', 'dot_decimal'] as const;
export const CURRENCIES = ['EUR'] as const;
/** 0 = Sunday … 6 = Saturday (the project's weekday base). */
export const FIRST_DAYS_OF_WEEK = [0, 1, 2, 3, 4, 5, 6] as const;

export interface GymLocalization {
  time_zone: string;
  first_day_of_week: number;
  currency: string;
  date_format: string;
  time_format: string;
  number_format: string;
}

export const DEFAULT_GYM_LOCALIZATION: GymLocalization = {
  time_zone: 'Europe/Madrid',
  first_day_of_week: 1,
  currency: 'EUR',
  date_format: 'DD/MM/YYYY',
  time_format: '24h',
  number_format: 'comma_decimal',
};

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type LocalizationParse =
  | { ok: true; changes: Partial<GymLocalization> }
  | { ok: false; error: string };

/**
 * Absent keeps the stored value; an unknown value is an error, never coerced.
 */
export function parseGymLocalizationInput(body: unknown): LocalizationParse {
  const b = (body ?? {}) as Record<string, unknown>;
  const changes: Partial<GymLocalization> = {};

  const pick = (key: 'currency' | 'date_format' | 'time_format' | 'number_format', allowed: readonly string[]) => {
    if (b[key] === undefined) return null;
    if (typeof b[key] !== 'string' || !allowed.includes(b[key] as string)) return `${key} is invalid`;
    changes[key] = b[key] as string;
    return null;
  };

  if (b.time_zone !== undefined) {
    if (!isValidTimeZone(b.time_zone)) return { ok: false, error: 'time_zone is invalid' };
    changes.time_zone = b.time_zone as string;
  }
  if (b.first_day_of_week !== undefined) {
    const n = b.first_day_of_week;
    if (typeof n !== 'number' || !(FIRST_DAYS_OF_WEEK as readonly number[]).includes(n)) {
      return { ok: false, error: 'first_day_of_week is invalid' };
    }
    changes.first_day_of_week = n;
  }
  for (const [key, allowed] of [
    ['currency', CURRENCIES],
    ['date_format', DATE_FORMATS],
    ['time_format', TIME_FORMATS],
    ['number_format', NUMBER_FORMATS],
  ] as const) {
    const err = pick(key, allowed);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, changes };
}
