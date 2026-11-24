/**
 * #3311 — the Member card's **Payments History and Forecast**, as chart input.
 *
 * Pure and JSX-free. The API decides which point is a payment, a scheduled
 * Billing Event or a forecast (`domain/paymentsTimeline.ts`); this module only
 * turns that answer into the three series the chart draws, the month ticks,
 * the Today marker and the points a selected date shows. It computes no
 * amount, status or date of its own.
 */

import type { ChartSeries } from '@gymdesk/charts';
import type { GymFormatSettings } from '@/lib/gymFormat';

export type TimelinePointKind = 'payment' | 'scheduled' | 'forecast';

export interface TimelineLine { label: string; quantity: number; amount: number }

export interface TimelinePoint {
  kind: TimelinePointKind;
  date: string;
  amount: number;
  status: string | null;
  billing_event_id: number | null;
  name: string | null;
  event_type: string | null;
  lines: TimelineLine[];
}

export interface PaymentsTimeline { today: string; points: TimelinePoint[] }

/** The three series, in legend order. A forecast is dashed: it is a projection, not a record. */
export const TIMELINE_KINDS: readonly TimelinePointKind[] = ['payment', 'scheduled', 'forecast'];

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
 * One series per kind, each point carrying its already formatted labels. A kind
 * with no points is still a series (empty), so the legend always names all three
 * and a reader can tell "nothing scheduled" from "not shown".
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
  return TIMELINE_KINDS.map((kind, index) => ({
    id: `payments-timeline-${kind}`,
    name: labels.kind(kind),
    colorIndex: index,
    dashed: kind === 'forecast',
    points: timeline.points.filter((p) => p.kind === kind).map((p) => ({
      x: dateToX(p.date),
      y: p.amount,
      label: labels.date(p.date),
      valueLabel: labels.money(p.amount),
      detailLines: [labels.status(p), ...p.lines.map((l) => `${l.label} × ${l.quantity}: ${labels.money(l.amount)}`)],
    })),
  }));
}

/** The points drawn at one x — what the detail card under the chart lists. */
export function pointsAtX(timeline: PaymentsTimeline, x: number | null): TimelinePoint[] {
  if (x == null) return [];
  return timeline.points.filter((p) => dateToX(p.date) === x);
}

/** The ledger statuses the chart has a label for; anything else reads as unknown. */
export const TIMELINE_STATUSES = [
  'paid', 'pending', 'failed', 'scheduled', 'waived', 'cancelled', 'refunded', 'partially_refunded', 'expired_24h', 'unknown',
] as const;

export function knownStatusKey(point: TimelinePoint): string {
  if (point.kind === 'forecast') return 'timeline_kind_forecast';
  const s = point.status ?? 'unknown';
  return `timeline_status_${(TIMELINE_STATUSES as readonly string[]).includes(s) ? s : 'unknown'}`;
}
