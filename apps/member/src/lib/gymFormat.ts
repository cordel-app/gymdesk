// #1246 stage 1 — the one place the admin formats a date, time, date-time or
// amount from the active gym's Time & Localization settings. Pure: it takes the
// settings as an argument and reads no environment. The Members App has its own
// copy (`apps/admin/src/lib/gymFormat.ts`) — keep them identical; the apps share no module.

export interface GymFormatSettings {
  time_zone: string;
  first_day_of_week: number;
  currency: string;
  date_format: string;
  time_format: string;
  number_format: string;
}

export const DEFAULT_GYM_FORMAT: GymFormatSettings = {
  time_zone: 'Europe/Madrid',
  first_day_of_week: 1,
  currency: 'EUR',
  date_format: 'DD/MM/YYYY',
  time_format: '24h',
  number_format: 'comma_decimal',
};

function parts(value: Date | string, timeZone: string, hour12: boolean) {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: hour12 ? 'h12' : 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d)) out[p.type] = p.value;
  return out;
}

export function formatGymDate(value: Date | string, s: GymFormatSettings = DEFAULT_GYM_FORMAT): string {
  const p = parts(value, s.time_zone, false);
  if (!p) return '—';
  if (s.date_format === 'MM/DD/YYYY') return `${p.month}/${p.day}/${p.year}`;
  if (s.date_format === 'YYYY-MM-DD') return `${p.year}-${p.month}-${p.day}`;
  return `${p.day}/${p.month}/${p.year}`;
}

export function formatGymTime(value: Date | string, s: GymFormatSettings = DEFAULT_GYM_FORMAT): string {
  const p = parts(value, s.time_zone, s.time_format === '12h');
  if (!p) return '—';
  return s.time_format === '12h'
    ? `${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toUpperCase()}`.trim()
    : `${p.hour}:${p.minute}`;
}

export function formatGymDateTime(value: Date | string, s: GymFormatSettings = DEFAULT_GYM_FORMAT): string {
  const date = formatGymDate(value, s);
  return date === '—' ? date : `${date} ${formatGymTime(value, s)}`;
}

export function formatGymAmount(amount: number, s: GymFormatSettings = DEFAULT_GYM_FORMAT): string {
  if (!Number.isFinite(amount)) return '—';
  const fixed = Math.abs(amount).toFixed(2);
  const [int, dec] = fixed.split('.');
  const [group, decimal] = s.number_format === 'dot_decimal' ? [',', '.'] : ['.', ','];
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const symbol = s.currency === 'EUR' ? '€' : s.currency;
  return `${amount < 0 ? '-' : ''}${grouped}${decimal}${dec} ${symbol}`;
}
