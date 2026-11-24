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

// ── #3288: the server's date-time spelling ──────────────────────────────────
//
// The API writes one gym-formatted date-time into a stored string (a Purchase's
// canonical name), so it needs the same spelling the two apps' `gymFormat.ts`
// produce (`23/11/2026 11:56`, `11/23/2026 11:56 AM`, `2026-11-23 11:56`): the
// instant in the gym's IANA zone, its date format, its 24h/12h clock. An
// unusable zone falls back to the default rather than throwing.

type FormatSettings = Pick<GymLocalization, 'time_zone' | 'date_format' | 'time_format'>;

function dateTimeParts(value: Date, timeZone: string, hour12: boolean): Record<string, string> {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_GYM_LOCALIZATION.time_zone;
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: hour12 ? 'h12' : 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(value)) out[p.type] = p.value;
  return out;
}

/** `value` as the gym writes a date and time, e.g. `23/11/2026 11:56`. */
export function formatGymDateTime(value: Date, s: FormatSettings = DEFAULT_GYM_LOCALIZATION): string {
  const hour12 = s.time_format === '12h';
  const p = dateTimeParts(value, s.time_zone, hour12);
  const date = s.date_format === 'MM/DD/YYYY' ? `${p.month}/${p.day}/${p.year}`
    : s.date_format === 'YYYY-MM-DD' ? `${p.year}-${p.month}-${p.day}`
      : `${p.day}/${p.month}/${p.year}`;
  const time = hour12
    ? `${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toUpperCase()}`.trim()
    : `${p.hour}:${p.minute}`;
  return `${date} ${time}`;
}
