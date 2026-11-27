// #3506 — the month/year x axis every billing chart reads by: the Payments tab's
// Payments History and Forecast (#3311) and both Billing simulations of a
// Membership Plan. One place, so the three charts cannot label a month two ways.

import type { GymFormatSettings } from './gymFormat';

/** About a month: the smallest gap between two x ticks, so the axis reads by month. */
export const MONTH_TICK_MS = 28 * 24 * 60 * 60 * 1000;

/** `MM/YYYY`, or `YYYY-MM` for a gym on ISO dates — a month tick on the x axis. */
export function monthTickLabel(x: number, s: Pick<GymFormatSettings, 'date_format'>): string {
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return '';
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return s.date_format === 'YYYY-MM-DD' ? `${year}-${month}` : `${month}/${year}`;
}
