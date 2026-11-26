/**
 * #3311 — the Member card's **Payments History and Forecast**, as chart input.
 *
 * Pure and JSX-free. The API decides which point is a payment, a scheduled
 * Billing Event, a forecast or a no-charge cycle (`domain/paymentsTimeline.ts`);
 * this module only turns that answer into the three series the chart draws, the
 * month ticks, the Today marker and the points a selected date shows. It computes
 * no amount, status or date of its own.
 *
 * #3311 stage 4 — the chart is **one continuous line** in one theme colour: every
 * payment, scheduled Billing Event, forecast and no-charge cycle is a point on it,
 * in date order. What tells the kinds apart is the point's own marker and its
 * status in the tooltip and the detail card — never a separate series, a colour of
 * its own or a legend. (This supersedes #3311 stage 2's legend and #3446's three
 * series.)
 */

import type { ChartPointSymbol, ChartSeries } from '@gymdesk/charts';
import type { GymFormatSettings } from '@/lib/gymFormat';

export type TimelinePointKind = 'payment' | 'scheduled' | 'forecast' | 'no_charge';

export interface TimelineLine { label: string; quantity: number; amount: number }

export interface TimelinePoint {
  kind: TimelinePointKind;
  date: string;
  amount: number;
  status: string | null;
  billing_event_id: number | null;
  /** #3435: a failed or pending payment, which the chart marks with a `!` (the API decides it). */
  alert?: 'failed' | 'pending' | null;
  name: string | null;
  event_type: string | null;
  lines: TimelineLine[];
}

export interface PaymentsTimeline { today: string; points: TimelinePoint[] }

/**
 * #3311 stage 4 — the marker a kind is drawn with on the one line: a record is a
 * filled circle, a scheduled charge a filled diamond, a projection an outline.
 */
export const TIMELINE_POINT_SYMBOLS: Record<TimelinePointKind, ChartPointSymbol> = {
  payment: 'circle',
  scheduled: 'diamond',
  forecast: 'emptyCircle',
  no_charge: 'emptyDiamond',
};

/** About a month: the smallest gap between two x ticks, so the axis reads by month. */
export const MONTH_TICK_MS = 28 * 24 * 60 * 60 * 1000;

export function dateToX(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

/** `MM/YYYY`, or `YYYY-MM` for a gym on ISO dates — a month tick on the x axis. */
export function monthTickLabel(x: number, s: Pick<GymFormatSettings, 'date_format'>): string {
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return '';
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return s.date_format === 'YYYY-MM-DD' ? `${year}-${month}` : `${month}/${year}`;
}

/**
 * #3311 stage 4 — the one series the chart draws: every point, in date order (the
 * API's order breaks a tie), each with its kind's marker and its already formatted
 * labels. The series has no name, so no legend is drawn.
 */
export function timelineSeries(
  timeline: PaymentsTimeline,
  labels: {
    kind: (kind: TimelinePointKind) => string;
    date: (date: string) => string;
    money: (amount: number) => string;
    status: (point: TimelinePoint) => string;
  },
): ChartSeries[] {
  const ordered = timeline.points
    .map((p, index) => ({ p, index }))
    .sort((a, b) => dateToX(a.p.date) - dateToX(b.p.date) || a.index - b.index)
    .map(({ p }) => p);
  return [{
    id: 'payments-timeline',
    colorIndex: 0,
    points: ordered.map((p) => ({
      x: dateToX(p.date),
      y: p.amount,
      label: labels.date(p.date),
      valueLabel: labels.money(p.amount),
      alert: p.alert != null,
      symbol: TIMELINE_POINT_SYMBOLS[p.kind],
      detailLines: [
        `${labels.kind(p.kind)} · ${labels.status(p)}`,
        ...p.lines.map((l) => `${l.label} × ${l.quantity}: ${labels.money(l.amount)}`),
      ],
    })),
  }];
}

/** The points drawn at one x — what the detail card under the chart lists. */
export function pointsAtX(timeline: PaymentsTimeline, x: number | null): TimelinePoint[] {
  if (x == null) return [];
  return timeline.points.filter((p) => dateToX(p.date) === x);
}

/** The ledger statuses the chart has a label for; anything else reads as unknown. */
export const TIMELINE_STATUSES = [
  'paid', 'pending', 'failed', 'scheduled', 'forecasted', 'no_charge', 'waived', 'cancelled', 'refunded',
  'partially_refunded', 'expired_24h', 'unknown',
] as const;

export function knownStatusKey(point: TimelinePoint): string {
  if (point.kind === 'forecast') return 'timeline_status_forecasted';
  if (point.kind === 'no_charge') return 'timeline_status_no_charge';
  const s = point.status ?? 'unknown';
  return `timeline_status_${(TIMELINE_STATUSES as readonly string[]).includes(s) ? s : 'unknown'}`;
}
