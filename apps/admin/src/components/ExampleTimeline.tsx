'use client';

import type { CSSProperties, ReactNode } from 'react';

/**
 * #818 — the Example timeline table, shared by the Promotion card and the
 * Membership Plan card.
 *
 * The ticket's rule is "do not introduce a second simulation design
 * specifically for Membership Plans", so the table itself lives here once and
 * both pages hand it rows. It is presentational only and deliberately knows
 * nothing about promotions, plans, benefits or prices: which period is Free /
 * Pre-paid / Pay / Bonus / regular, what it charges and how that reads are
 * decided server-side and translated by the owning page, exactly as #806 keeps
 * the shared Exercise editor free of endpoints and permissions.
 *
 * The three tones are the ones the Promotion timeline has had since #486: green
 * for a period that charges nothing, grey for the regular ones, amber for the
 * promotional/plan-duration ones in between.
 */

export type ExampleTimelineTone = 'free' | 'benefit' | 'regular';

/**
 * #1130 stage 2 — the Cycle cell of a row: the iteration's number on its first
 * row, and whether the thin line beside it stops here so the next iteration's
 * does not touch it. Decided by `exampleTimelineRowCycles()`
 * (`lib/exampleTimeline.ts`) from the cycle the engine reports, never here: a
 * table that counted its own iterations would group rows the nightly run bills
 * differently.
 */
export interface ExampleTimelineRowCycleCell {
  label: string | null;
  endsSegment: boolean;
}

export interface ExampleTimelineRow {
  key: string | number;
  /** `1`, or `6+` for a trailing open-ended period — the caller's wording. */
  period: string;
  dates: string;
  status: string;
  billing: string;
  tone: ExampleTimelineTone;
  /**
   * The row's iteration, or `null` for a row outside the configured stretch.
   * Rows carrying one give the table its Cycle column; a caller that passes
   * none (a Promotion's timeline, which has no such cycle) gets the four
   * columns it always had.
   */
  cycle?: ExampleTimelineRowCycleCell | null;
}

export interface ExampleTimelineLabels {
  /** Only read when the rows carry a cycle. */
  cycle?: string;
  period: string;
  dates: string;
  status: string;
  billing: string;
}

/**
 * The three tones, and the table's own cells, are **exported** since #955: the
 * Billing Event Simulation's detail table is the same visual language ("do not
 * introduce a separate visual language for Billing Event Simulation", "do not
 * introduce new colors specifically for this component"), so it renders from
 * these objects rather than from a second copy of the numbers. They stay here
 * because this is the table that defined them.
 */
export const TIMELINE_TONE_BACKGROUND: Record<ExampleTimelineTone, string> = {
  free: '#f0fdf4',
  benefit: '#fefce8',
  regular: '#f9fafb',
};

/** The colour the *amount* of a row in that tone reads in. */
export const TIMELINE_TONE_TEXT: Record<ExampleTimelineTone, string> = {
  free: '#166534',
  benefit: '#854d0e',
  regular: '#666',
};

/** A header cell of a timeline-language table. */
export const timelineThStyle: CSSProperties = {
  textAlign: 'left', padding: '6px 8px', color: '#888', fontWeight: 600,
  borderBottom: '1px solid #eee', fontSize: 12,
};
/** A body cell of one — the row density every such table shares. */
export const timelineTdStyle: CSSProperties = {
  padding: '6px 8px', borderBottom: '1px solid #f5f5f5', fontSize: 13,
};

/**
 * #1130 stage 2 — the cycle grouping's own two values, exported for the same
 * reason the tones are: the Billing Event Simulation groups the same two
 * iterations over its existing cards, and a second hex there would be a second
 * visual language for one story. Both are deliberately lighter than any cell
 * of the table, because the ticket's rule is that the cycle marker must not
 * compete with Period, Dates, Status or Billing.
 */
export const TIMELINE_CYCLE_LINE = '#e5e7eb';
export const TIMELINE_CYCLE_TEXT = '#b0b0b0';

/** The Cycle cell: the number, and the thin line that runs alongside its rows. */
function CycleCell({ cell }: { cell: ExampleTimelineRowCycleCell | null | undefined }) {
  return (
    <td style={{ ...timelineTdStyle, position: 'relative', width: 46, paddingRight: 14, verticalAlign: 'top' }}>
      {cell?.label != null && (
        <span style={{ color: TIMELINE_CYCLE_TEXT, fontSize: 11, fontWeight: 600 }}>{cell.label}</span>
      )}
      {cell && (
        <span
          aria-hidden
          style={{
            position: 'absolute', top: 0, right: 8, width: 1,
            // The gap at the foot of an iteration's last row is what keeps the
            // two lines from touching, with no horizontal divider.
            bottom: cell.endsSegment ? 7 : 0,
            background: TIMELINE_CYCLE_LINE,
          }}
        />
      )}
    </td>
  );
}

export function ExampleTimeline({
  rows, labels, cycleNote, footnotes,
}: {
  rows: ExampleTimelineRow[];
  labels: ExampleTimelineLabels;
  /**
   * #1130 stage 2 — the marker under the last row: whether the cycle starts
   * again, already worded (and glyphed) by the card, because which sentence a
   * cycle takes is `exampleTimelineCycleNote()`'s answer and not this table's.
   */
  cycleNote?: ReactNode;
  /** The explanatory lines below the table — each page's own wording. */
  footnotes?: ReactNode;
}) {
  // The Cycle column exists for the rows that have one. A caller whose rows
  // carry no cycle renders the four columns unchanged.
  const showCycle = rows.some((row) => row.cycle);
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {showCycle && (
                <th style={{ ...timelineThStyle, color: TIMELINE_CYCLE_TEXT, fontWeight: 500 }}>{labels.cycle}</th>
              )}
              <th style={timelineThStyle}>{labels.period}</th>
              <th style={timelineThStyle}>{labels.dates}</th>
              <th style={timelineThStyle}>{labels.status}</th>
              <th style={timelineThStyle}>{labels.billing}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} style={{ background: TIMELINE_TONE_BACKGROUND[row.tone] }}>
                {showCycle && <CycleCell cell={row.cycle} />}
                <td style={timelineTdStyle}>{row.period}</td>
                <td style={timelineTdStyle}>{row.dates}</td>
                <td style={{ ...timelineTdStyle, fontWeight: 500 }}>{row.status}</td>
                <td style={{ ...timelineTdStyle, color: TIMELINE_TONE_TEXT[row.tone] }}>{row.billing}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showCycle && cycleNote != null && (
        <p style={{ margin: '6px 0 0', paddingLeft: 8, fontSize: 11, color: TIMELINE_CYCLE_TEXT }}>{cycleNote}</p>
      )}
      {footnotes}
    </>
  );
}
