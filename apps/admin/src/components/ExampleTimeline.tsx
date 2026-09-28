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

export interface ExampleTimelineRow {
  key: string | number;
  /** `1`, or `6+` for a trailing open-ended period — the caller's wording. */
  period: string;
  dates: string;
  status: string;
  billing: string;
  tone: ExampleTimelineTone;
}

export interface ExampleTimelineLabels {
  period: string;
  dates: string;
  status: string;
  billing: string;
}

const TONE_BACKGROUND: Record<ExampleTimelineTone, string> = {
  free: '#f0fdf4',
  benefit: '#fefce8',
  regular: '#f9fafb',
};

const TONE_BILLING_COLOUR: Record<ExampleTimelineTone, string> = {
  free: '#166534',
  benefit: '#854d0e',
  regular: '#666',
};

const thSt: CSSProperties = {
  textAlign: 'left', padding: '6px 8px', color: '#888', fontWeight: 600,
  borderBottom: '1px solid #eee', fontSize: 12,
};
const tdSt: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f5f5f5', fontSize: 13 };

export function ExampleTimeline({
  rows, labels, footnotes,
}: {
  rows: ExampleTimelineRow[];
  labels: ExampleTimelineLabels;
  /** The explanatory lines below the table — each page's own wording. */
  footnotes?: ReactNode;
}) {
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={thSt}>{labels.period}</th>
              <th style={thSt}>{labels.dates}</th>
              <th style={thSt}>{labels.status}</th>
              <th style={thSt}>{labels.billing}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} style={{ background: TONE_BACKGROUND[row.tone] }}>
                <td style={tdSt}>{row.period}</td>
                <td style={tdSt}>{row.dates}</td>
                <td style={{ ...tdSt, fontWeight: 500 }}>{row.status}</td>
                <td style={{ ...tdSt, color: TONE_BILLING_COLOUR[row.tone] }}>{row.billing}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footnotes}
    </>
  );
}
