'use client';

import React, { useMemo } from 'react';
import { LineChart } from '@gymdesk/charts';
import { cardSectionLabelStyle, innerCardStyle } from '@/components/formChrome';
import {
  GoalReadingRow, readingAxisLabel, readingChartPoints,
} from './goalReadings';

/**
 * #1037 §12–§17 / §23–§24 — an Assigned Personal Goal's **progress chart**.
 *
 * One component for both screens that administer an assignment (#806), exactly
 * as `GoalReadingHeader` and `GoalReadingHistory` are: the gym-wide Assigned
 * Personal Goals section draws it in the expanded row, the Member card's
 * PERSONAL GOALS section inside each goal's card, and the Members App has its
 * own adapter over the **same** charting layer, so the three surfaces cannot
 * draw one member's history three ways.
 *
 * It draws nothing itself. `@gymdesk/charts`' `LineChart` owns ECharts, the
 * colours (resolved from this app's own Theme variables — §23's "do not
 * hard-code colors"), the smoothing, the tooltip and the canvas's lifetime; this
 * file turns rows into points and places the section.
 *
 * Two of its answers are the rule rather than the implementation.
 *
 * * **With nothing measured there is no chart** — the section is absent rather
 *   than an empty canvas under a target line, because the reading history beside
 *   it already says "no readings recorded yet".
 * * **It declares no look of its own**: the card is `formChrome`'s `innerCardStyle`
 *   and the label its `cardSectionLabelStyle`, the two the reading history
 *   already wears (#929), so the two sections of one card cannot drift apart.
 *
 * It resolves no locale key: every string arrives from the page's own resolver
 * (#901).
 */
export function GoalReadingChart({ readings, unit, target, locale, labels }: {
  readings: GoalReadingRow[];
  unit: string | null;
  /** The assignment's own target — §13's reference line. `null` draws none. */
  target: number | null;
  locale: string;
  labels: {
    title: string;
    /** The canvas's accessible name: a canvas has none of its own. */
    ariaLabel: string;
    /** Already interpolated, e.g. `Target 70 kg`. `null` labels the line not at all. */
    target: string | null;
  };
}) {
  const points = useMemo(
    () => readingChartPoints(readings, unit, locale),
    [readings, unit, locale],
  );

  if (points.length === 0) return null;

  return (
    <div style={innerCardStyle}>
      <span style={cardSectionLabelStyle}>{labels.title}</span>
      <LineChart
        points={points}
        height={200}
        ariaLabel={labels.ariaLabel}
        axisLabelFormatter={(value) => readingAxisLabel(value, locale)}
        reference={target === null ? null : { value: target, label: labels.target ?? undefined }}
      />
    </div>
  );
}
