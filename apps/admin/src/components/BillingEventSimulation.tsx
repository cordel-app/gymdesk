'use client';

// A **Billing Event Simulation**: one collapsible card per billing date, each
// listing every line that falls on it.
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
// #955 turned the vertically stacked list into **billing-period cards**: the
// header carries the date, how many lines fall on it and that date's total, and
// the lines themselves appear underneath when the card is open, in the Example
// Timeline's own table language — its cells, its row density and its three tones
// (`TIMELINE_TONE_*`), imported rather than restated, because the ticket's rule
// is "do not introduce a separate visual language for Billing Event Simulation"
// and "do not introduce new colors specifically for this component". The total
// moved into that header, so there is no Total row under the lines any more.
//
// It formats, it never recomputes: which events exist, which date each falls on,
// which benefit applies, what it costs and whether tax is included are all
// decided by `api/src/domain/billingEventSimulation.ts` and the adapters over
// the shared Billing Simulation engine (CLAUDE.md: no business logic duplicated
// in the frontend, and #817 — no tax arithmetic in a page). Expanding a card
// shows what is already loaded; it fetches nothing and changes nothing.
// Read-only by nature: the server computes it on every read, persists nothing
// and charges nothing.

import React, { useState } from 'react';

import {
  TIMELINE_TONE_BACKGROUND,
  TIMELINE_TONE_TEXT,
  timelineTdStyle,
  timelineThStyle,
} from './ExampleTimeline';
import { innerCardStyle, secondaryBtnSmall } from './formChrome';
import {
  BillingEventSimulationBenefit,
  BillingEventSimulationData,
  BillingEventSimulationDate,
  BillingEventSimulationLine,
  allExpandedPeriods,
  everyPeriodExpanded,
  initialExpandedPeriods,
  simulationLineTone,
  simulationPriceLabelKey,
} from '@/lib/billingEventSimulation';

type Simulation = BillingEventSimulationData;
type Translate = (key: string, values?: Record<string, string | number>) => string;

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
  t: Translate;
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
function priceLabel(line: BillingEventSimulationLine, t: Translate): string {
  if (line.benefits.length === 0) return t('simulation_price_regular');
  return line.benefits
    .map((b) => t(simulationPriceLabelKey(b), {
      value: b.value ?? 0,
      amount: fmtMoney(b.value ?? 0),
    }))
    .join(' · ');
}

/** The Status cell: the treatment, the Pre-paid count, and what it would have cost. */
function statusCell(line: BillingEventSimulationLine, t: Translate): React.ReactNode {
  return (
    <>
      {priceLabel(line, t)}
      {/* #946 — a Pre-paid Duration is collected in one charge on the first of
          its periods, so the line says how many periods that amount covers
          rather than leaving a ×3 against the Plan's monthly price unexplained. */}
      {line.prepaid_periods != null && (
        <span> · {t('simulation_prepaid_periods', { count: line.prepaid_periods })}</span>
      )}
      {/* A discounted or waived line still shows what it would otherwise have
          cost, which is what makes the benefit legible. */}
      {line.actual_charge !== line.regular_price && (
        <span> · {t('simulation_regular_was', { amount: fmtMoney(line.regular_price) })}</span>
      )}
    </>
  );
}

/**
 * The lines of one billing period, in the Example Timeline's table language.
 * The date is printed on the first row only — every line in the group falls on
 * the same date, and repeating it four times is the noise the cards exist to
 * remove.
 */
function BillingEventTable({
  group, t, formatDate,
}: {
  group: BillingEventSimulationDate;
  t: Translate;
  formatDate: (date: string) => string;
}) {
  return (
    <div style={periodTableWrap}>
      <table style={tableStyle}>
        {/* #1106 — one fixed grid for every card: the widths are declared here,
            never measured from a card's own content. */}
        <colgroup>
          <col style={{ width: COL_WIDTHS.date }} />
          <col />
          <col style={{ width: COL_WIDTHS.status }} />
          <col style={{ width: COL_WIDTHS.amount }} />
        </colgroup>
        <thead>
          <tr>
            <th style={timelineThStyle}>{t('simulation_col_date')}</th>
            <th style={timelineThStyle}>{t('simulation_col_event')}</th>
            <th style={timelineThStyle}>{t('simulation_col_status')}</th>
            <th style={{ ...timelineThStyle, textAlign: 'right' }}>{t('simulation_col_amount')}</th>
          </tr>
        </thead>
        <tbody>
          {group.lines.map((line, i) => {
            const tone = simulationLineTone(line);
            return (
              <tr
                key={`${line.product_id ?? 'fee'}-${i}`}
                style={{ background: TIMELINE_TONE_BACKGROUND[tone] }}
              >
                <td style={timelineTdStyle}>{i === 0 ? formatDate(group.date) : ''}</td>
                <td style={{ ...timelineTdStyle, fontWeight: 500 }}>
                  {line.label}
                  {/* #832/#894 — a Mandatory item is part of every Plan, and the
                      line says so rather than looking like an optional extra. */}
                  {line.mandatory && (
                    <span style={{ color: '#888', fontWeight: 400 }}> ({t('simulation_mandatory')})</span>
                  )}
                  {line.quantity > 1 && (
                    <span style={{ color: '#888', fontWeight: 400 }}> ×{line.quantity}</span>
                  )}
                </td>
                <td style={timelineTdStyle}>{statusCell(line, t)}</td>
                <td style={{ ...timelineTdStyle, textAlign: 'right', color: TIMELINE_TONE_TEXT[tone] }}>
                  {fmtMoney(line.actual_charge)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One billing period. The whole header is the expand/collapse control, so the
 * summary itself is clickable and keyboard-operable (`<button>` + `aria-expanded`,
 * the shape the list rows use); the chevron beside the date is decorative.
 */
function BillingPeriodCard({
  group, expanded, onToggle, t, formatDate,
}: {
  group: BillingEventSimulationDate;
  expanded: boolean;
  onToggle: () => void;
  t: Translate;
  formatDate: (date: string) => string;
}) {
  return (
    <div style={periodCard}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} style={periodHeader}>
        <span aria-hidden="true" style={chevron}>{expanded ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 600 }}>{formatDate(group.date)}</span>
        <span style={periodSummary}>
          <span style={{ color: '#888' }}>
            {t('simulation_items_count', { count: group.lines.length })}
          </span>
          <span style={{ fontWeight: 600 }}>
            {t('simulation_total')} {fmtMoney(group.total)}
          </span>
        </span>
      </button>
      {expanded && <BillingEventTable group={group} t={t} formatDate={formatDate} />}
    </div>
  );
}

export function BillingEventSimulation({ simulation, t, formatDate }: Props) {
  const dates = simulation?.dates ?? [];
  const signature = dates.map((group) => group.date).join('|');

  // Which cards are open, keyed by the group's own date, so an individual card
  // keeps its state while the global control rewrites every entry at once.
  //
  // The Promotion card loads its projection after the card opens and saving a
  // Benefit section replaces it, so the state is re-seeded whenever the set of
  // billing dates itself changes — carried beside the state rather than in an
  // effect, so an unrelated re-render cannot close a card the viewer has just
  // opened and a new projection never renders once against the old state.
  const [open, setOpen] = useState(() => ({ signature, expanded: initialExpandedPeriods(dates) }));
  if (open.signature !== signature) {
    setOpen({ signature, expanded: initialExpandedPeriods(dates) });
  }
  const expanded = open.signature === signature ? open.expanded : initialExpandedPeriods(dates);
  const setExpanded = (next: Record<string, boolean>) => setOpen({ signature, expanded: next });

  // The server's `reason` is one of two known conditions (no billing frequency,
  // nothing priced to bill), so it is said in the viewer's language rather than
  // relayed in English — the same choice the Example Timeline makes.
  if (!simulation?.available) {
    return <p style={hint}>{t('simulation_unavailable')}</p>;
  }

  const allOpen = everyPeriodExpanded(dates, expanded);
  // A single period is still individually collapsible, but "expand all" has no
  // meaning over one card, so the global control is not rendered for it.
  const showGlobalToggle = dates.length > 1;

  return (
    <div>
      {(simulation.anchor_date || simulation.tax_included || showGlobalToggle) && (
        <div style={toolbar}>
          <p style={{ margin: 0, fontSize: 12, color: '#666' }}>
            {simulation.anchor_date && t('simulation_example_note', { date: formatDate(simulation.anchor_date) })}
            {simulation.anchor_date && simulation.tax_included && ' · '}
            {/* Said once for the whole section: every amount below it, in a
                header total and in a line alike, is the server's VAT-inclusive
                figure (#817 — the page does no tax arithmetic). */}
            {simulation.tax_included && t('tax_included_suffix')}
          </p>
          {showGlobalToggle && (
            <button
              type="button"
              style={secondaryBtnSmall}
              onClick={() => setExpanded(allExpandedPeriods(dates, !allOpen))}
            >
              {allOpen ? t('simulation_collapse_all') : t('simulation_expand_all')}
            </button>
          )}
        </div>
      )}

      {dates.map((group) => (
        <BillingPeriodCard
          key={group.date}
          group={group}
          expanded={expanded[group.date] === true}
          onToggle={() => setExpanded({ ...expanded, [group.date]: !expanded[group.date] })}
          t={t}
          formatDate={formatDate}
        />
      ))}

      <p style={footnote}>{t('simulation_disclaimer')}</p>
      {simulation.truncated && <p style={footnote}>{t('simulation_truncated')}</p>}
    </div>
  );
}

const COL_WIDTHS = { date: 120, status: 300, amount: 90 } as const;
const tableStyle: React.CSSProperties = {
  width: '100%', minWidth: 640, tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 13,
};
const hint: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
const toolbar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  flexWrap: 'wrap', gap: 8, marginBottom: 8,
};
/** The card a billing period sits in — the shared one, with its own padding on the parts. */
const periodCard: React.CSSProperties = { ...innerCardStyle, padding: 0, overflow: 'hidden' };
const periodHeader: React.CSSProperties = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
  width: '100%', padding: '8px 12px', background: 'none', border: 'none',
  textAlign: 'left', cursor: 'pointer', fontSize: 13, color: 'inherit',
};
/** The open card's table: a hairline under the header, and the cells' own 8px inset lined up with it. */
const periodTableWrap: React.CSSProperties = {
  overflowX: 'auto', padding: '0 4px 4px',
  borderTop: '1px solid var(--gd-card-border, #e8e8ed)',
};
/** The summary half: it drops under the date when the card is too narrow for one line. */
const periodSummary: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto',
};
const chevron: React.CSSProperties = { color: '#888', fontSize: 11, width: 10 };
const footnote: React.CSSProperties = {
  color: '#aaa', fontSize: 11, fontStyle: 'italic', margin: '4px 0 0',
};
