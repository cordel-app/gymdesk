'use client';

import React from 'react';
import { formFieldLabelStyle, formValueStyle } from '@/components/formChrome';
import {
  GOAL_READING_FIELDS, GoalReadingSummaryFields, formatProgress, formatReadingValue,
} from './goalReadings';

/**
 * #1037 §5–§11 — an Assigned Personal Goal's header, as **structured fields**.
 *
 * ```text
 * GOAL          INITIAL READING   TARGET   LATEST READING   PROGRESS
 * Weight loss   80 kg             70 kg    75 kg            50%
 * ```
 *
 * One component for both screens that administer an assignment (#806), so the
 * five fields, their order and their look are declared once — the gym-wide
 * Assigned Personal Goals section renders it in the expanded row and the Member
 * card's PERSONAL GOALS section at the top of each goal's card.
 *
 * Three of its answers are the rule rather than the implementation.
 *
 * * **It computes nothing.** The three reading figures are the server's
 *   (`initial_reading`, `latest_reading`, `progress_percent`, derived on every
 *   read since stage 2), so the Member card, the gym-wide list and the Members
 *   App cannot report one goal's progress three ways — and a field that cannot
 *   be computed reads `—`, never `0%`.
 * * **It declares no look of its own** (§6): the label is `formChrome`'s own
 *   field label and the value its `formValueStyle`, the two the read-only half of
 *   every card in the app already uses, so a value sits exactly where its input
 *   would (#929). No colour, no type size and no border is spelled here.
 * * **The grid reflows** (§41): `auto-fit` over a minimum column, so five fields
 *   become two columns on a tablet and one on a phone rather than five unreadable
 *   ones — which is also why the fields come from one declaration and not from
 *   five hand-placed cells.
 *
 * It resolves no locale key and decides no permission: `label` is the page's own
 * resolver (#901), and `trailing` is whatever that card puts beside the header —
 * the Status badge on the Member card, nothing on the gym-wide row, which has a
 * Status column of its own.
 */
export function GoalReadingHeader({ goalName, target, unit, summary, label, trailing }: {
  /** Already resolved: a System slug's locale key, else the stored name (#947). */
  goalName: string;
  /** The assignment's own target, already formatted by `formatTarget()`. */
  target: string;
  /** The assignment's unit — the readings are quoted in it (§9/§10). */
  unit: string | null;
  summary: GoalReadingSummaryFields;
  label: (key: string) => string;
  trailing?: React.ReactNode;
}) {
  const values: Record<(typeof GOAL_READING_FIELDS)[number], string> = {
    label_goal: goalName,
    label_initial_reading: formatReadingValue(summary.initial_reading, unit),
    label_target: target,
    label_latest_reading: formatReadingValue(summary.latest_reading, unit),
    label_progress: formatProgress(summary.progress_percent),
  };

  return (
    <div style={rowStyle}>
      <div style={gridStyle}>
        {GOAL_READING_FIELDS.map((key) => (
          <div key={key} style={fieldStyle}>
            <span style={formFieldLabelStyle}>{label(key)}</span>
            <span style={formValueStyle}>{values[key]}</span>
          </div>
        ))}
      </div>
      {trailing}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
  gap: 10, flexWrap: 'wrap',
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  // §41 — the five fields reflow instead of being squeezed into five columns.
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: 12,
  flex: 1,
  minWidth: 0,
};

const fieldStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0,
};
