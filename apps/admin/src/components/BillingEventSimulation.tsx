'use client';

// A **Billing Event Simulation**: one group per billing date, listing every line
// that falls on it.
//
// #915 built this for the Membership Plan card — what a member enrolling today
// would be billed and when, before the Plan is assigned to anybody. #922 asks
// the Promotion card for the same thing over the items a Promotion affects, and
// asks for it to *look* the same, so this is one component rendered by both
// cards (CLAUDE.md: a read-only section two different cards present the same way
// is one component). It holds no entity knowledge: the labels come from the
// page's own namespace, exactly as `ExampleTimeline` and
// `BillingDurationSummary` take theirs.
//
// It formats, it never recomputes: which events exist, which date each falls on,
// which benefit applies, what it costs and whether tax is included are all
// decided by `api/src/domain/billingEventSimulation.ts` and the two adapters
// over the shared Billing Simulation engine (CLAUDE.md: no business logic
// duplicated in the frontend, and #817 — no tax arithmetic in a page).
// Read-only by nature: the server computes it on every read, persists nothing
// and charges nothing.

import React from 'react';

import {
  BillingEventSimulationBenefit,
  BillingEventSimulationData,
  BillingEventSimulationLine,
  simulationPriceLabelKey,
} from '@/lib/billingEventSimulation';

type Simulation = BillingEventSimulationData;

export type {
  BillingEventSimulationBenefit,
  BillingEventSimulationData,
  BillingEventSimulationDate,
  BillingEventSimulationLine,
} from '@/lib/billingEventSimulation';
export { simulationPriceLabelKey } from '@/lib/billingEventSimulation';

interface Props {
  simulation: Simulation | null | undefined;
  /** The page's own translator, so the labels stay the page's (#901's rule for shared UI). */
  t: (key: string, values?: Record<string, string | number>) => string;
  /** Formats a `YYYY-MM-DD` in the viewer's locale — the page's own helper. */
  formatDate: (date: string) => string;
}

function fmtMoney(amount: number): string {
  return `€${amount.toFixed(2)}`;
}

/**
 * What the line's price *is*: "Regular price", "Waived", or the discount that
 * was applied. A line usually carries one benefit, but two can apply to the
 * same occurrence (two Promotions covering one period), so every one of them is
 * named rather than dropped.
 */
function priceLabel(line: BillingEventSimulationLine, t: Props['t']): string {
  if (line.benefits.length === 0) return t('simulation_price_regular');
  return line.benefits
    .map((b) => t(simulationPriceLabelKey(b), {
      value: b.value ?? 0,
      amount: fmtMoney(b.value ?? 0),
    }))
    .join(' · ');
}

export function BillingEventSimulation({ simulation, t, formatDate }: Props) {
  // The server's `reason` is one of two known conditions (no billing frequency,
  // nothing priced to bill), so it is said in the viewer's language rather than
  // relayed in English — the same choice the Example Timeline makes.
  if (!simulation?.available) {
    return <p style={hint}>{t('simulation_unavailable')}</p>;
  }

  return (
    <div>
      {simulation.anchor_date && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#666' }}>
          {t('simulation_example_note', { date: formatDate(simulation.anchor_date) })}
        </p>
      )}

      {simulation.dates.map((group) => (
        <div key={group.date} style={card}>
          <div style={groupHeader}>
            <span>{formatDate(group.date)}</span>
            <span>{fmtMoney(group.total)}</span>
          </div>
          {group.lines.map((line, i) => (
            <div key={`${line.gym_charge_id ?? 'fee'}-${i}`} style={lineRow}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13 }}>
                  {line.label}
                  {/* #832/#894 — a Mandatory item is part of every Plan, and the
                      line says so rather than looking like an optional extra. */}
                  {line.mandatory && (
                    <span style={{ color: '#888' }}> ({t('simulation_mandatory')})</span>
                  )}
                  {line.quantity > 1 && <span style={{ color: '#888' }}> ×{line.quantity}</span>}
                </div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  {priceLabel(line, t)}
                  {/* A discounted or waived line still shows what it would
                      otherwise have cost, which is what makes the benefit legible. */}
                  {line.actual_charge !== line.regular_price && (
                    <span> · {t('simulation_regular_was', { amount: fmtMoney(line.regular_price) })}</span>
                  )}
                </div>
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                {fmtMoney(line.actual_charge)}
              </span>
            </div>
          ))}
          <div style={totalRow}>
            <span>{t('simulation_total')}</span>
            <span>
              {fmtMoney(group.total)}
              {simulation.tax_included && (
                <span style={{ fontWeight: 400, color: '#888' }}> · {t('tax_included_suffix')}</span>
              )}
            </span>
          </div>
        </div>
      ))}

      <p style={footnote}>{t('simulation_disclaimer')}</p>
      {simulation.truncated && <p style={footnote}>{t('simulation_truncated')}</p>}
    </div>
  );
}

const hint: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
const card: React.CSSProperties = {
  background: '#fff', border: '1px solid #e8e8ed', borderRadius: 6,
  padding: '8px 12px', marginBottom: 8,
};
const groupHeader: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 8,
  fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4,
};
const lineRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  gap: 12, padding: '4px 0', borderTop: '1px solid #f4f4f6',
};
const totalRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 8,
  fontSize: 13, fontWeight: 700, borderTop: '1px solid #e8e8ed',
  paddingTop: 6, marginTop: 4,
};
const footnote: React.CSSProperties = {
  color: '#aaa', fontSize: 11, fontStyle: 'italic', margin: '4px 0 0',
};
