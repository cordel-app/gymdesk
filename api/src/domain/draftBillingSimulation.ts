// #1867 stage 2 — the Draft ProductSet's **complete** Billing Event Simulation.
//
// `GET /product-sets/:id/billing-event-simulation` is the single source of the
// projected schedule (the owner's answer on the ticket): the Draft's recurring
// plan and Products come from the engine (`assignmentBillingEventSimulation.ts`)
// and this module adds the two things the engine's forecast cannot know:
//
//   * the **initial payment** — what committing the Draft asks for today
//     (`commitCharge()`, the one function Save & Pay charges from). For a first
//     version it is the engine's own first event, so the group already exists
//     and is only *marked*; for a version replacing a running one it is a delta
//     against the previous version, so it **replaces** the group on that date
//     rather than being added to it. Either way it is counted once.
//   * the member's **one-off purchases still to be paid** (`draft` and
//     `pending_payment` rows): one-offs are paid at purchase, never scheduled,
//     so they land on today's group.
//
// Pure: no reads, nothing persisted, nothing charged.

import {
  BillingEventDate,
  BillingEventLine,
  BillingEventSimulationResult,
} from './billingEventSimulation';
import type { SimulationLine } from './billingSimulation';

export type DraftBillingEventDate = BillingEventDate & {
  /** `initial_payment` marks the date the Draft's commit is paid on. */
  kind: 'initial_payment' | 'scheduled';
};

export type DraftBillingEventSimulationResult = Omit<BillingEventSimulationResult, 'dates'> & {
  dates: DraftBillingEventDate[];
};

export interface PendingOneOff {
  product_id: number | null;
  name: string;
  /** The figure actually charged, VAT-inclusive. */
  amount: number;
  /** The price before a Promotion or direct discount, when it was recorded. */
  list_price: number | null;
}

export interface DraftSimulationInput {
  base: BillingEventSimulationResult;
  /** What committing the Draft asks for, dated `date` (null when it owes nothing). */
  initial: { date: string; lines: BillingEventLine[] } | null;
  oneOffs: PendingOneOff[];
  /** `YYYY-MM-DD` — the date one-offs are paid on. */
  today: string;
}

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const totalOf = (lines: BillingEventLine[]) => cents(lines.reduce((s, l) => s + Number(l.actual_charge), 0));

/** The engine's line, restated in the simulation's wire shape (as `groupBillingEventsByDate()` does). */
export function toBillingEventLine(line: SimulationLine): BillingEventLine {
  return {
    kind: line.kind, label: line.label, product_id: line.product_id, mandatory: false,
    quantity: line.quantity, unit_price: line.unit_price, regular_price: line.regular_price,
    actual_charge: line.actual_charge, prepaid_periods: line.prepaid_periods, proration: line.proration ?? null, benefits: line.benefits,
  };
}

export function oneOffLine(o: PendingOneOff): BillingEventLine {
  const regular = o.list_price != null && o.list_price >= o.amount ? o.list_price : o.amount;
  return {
    kind: 'product', label: o.name, product_id: o.product_id, mandatory: false, quantity: 1,
    unit_price: regular, regular_price: regular, actual_charge: cents(o.amount),
    prepaid_periods: null, benefits: [],
  };
}

export function composeDraftSimulation(input: DraftSimulationInput): DraftBillingEventSimulationResult {
  const groups = new Map<string, DraftBillingEventDate>();
  for (const d of input.base.dates) groups.set(d.date, { ...d, lines: [...d.lines], kind: 'scheduled' });

  if (input.initial && input.initial.lines.length > 0) {
    const existing = groups.get(input.initial.date);
    groups.set(input.initial.date, {
      date: input.initial.date,
      lines: [...input.initial.lines],
      total: totalOf(input.initial.lines),
      cycle: existing?.cycle ?? null,
      kind: 'initial_payment',
    });
  }

  if (input.oneOffs.length > 0) {
    const group = groups.get(input.today)
      ?? { date: input.today, lines: [], total: 0, cycle: null, kind: 'scheduled' as const };
    group.lines = [...group.lines, ...input.oneOffs.map(oneOffLine)];
    group.total = totalOf(group.lines);
    groups.set(input.today, group);
  }

  const dates = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
  const available = input.base.available || dates.length > 0;
  return {
    ...input.base,
    available,
    reason: available ? null : input.base.reason,
    anchor_date: input.base.anchor_date ?? dates[0]?.date ?? null,
    horizon_date: input.base.horizon_date ?? dates[dates.length - 1]?.date ?? null,
    dates,
    total: cents(dates.reduce((s, d) => s + d.total, 0)),
  };
}
