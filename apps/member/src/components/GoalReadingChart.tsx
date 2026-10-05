'use client';

import { type CSSProperties, useMemo } from 'react';
import { LineChart } from '@gymdesk/charts';
import { memberTheme } from '@/lib/memberChrome';
import {
  type GoalReading, readingAxisLabel, readingChartPoints,
} from '@/lib/memberGoals';

/**
 * #1037 §12–§17 / §23–§24 — the **progress chart** of one goal card in the
 * Members App: every reading over time, smooth, with a visible point per
 * measurement, the target as a reference line and one colour per
 * initial-reading period.
 *
 * It draws nothing itself. `@gymdesk/charts`' `LineChart` owns the engine, the
 * colours (resolved from this app's own Theme variables), the tooltip and the
 * canvas's lifetime, and this file is the adapter: the rows become points in
 * `lib/memberGoals.ts`, the labels are written in the member's own locale, and
 * the strings arrive already translated from the page (the rule the header and
 * the history beside it already follow).
 *
 * Two of its answers are the rule rather than the implementation.
 *
 * * **With nothing measured there is no chart.** An empty canvas with a target
 *   line says less than the history's own "no readings recorded yet", so the
 *   section is **absent** rather than empty — the same answer #981 gives for a
 *   missing trainer.
 * * **It spells no colour and no size** beyond the box the canvas fills: the
 *   series, axes and tooltip are the Theme's through the charting layer, and the
 *   label is `memberChrome.ts`'s (#983).
 */
export function GoalReadingChart({ readings, unit, target, locale, labels }: {
  readings: GoalReading[];
  unit: string | null;
  /** The assignment's own target — §13's reference line. `null` draws none. */
  target: number | null;
  locale: string;
  labels: {
    title: string;
    /** The canvas's accessible name: a canvas has none of its own. */
    ariaLabel: string;
    /** Already interpolated, e.g. `Target 70 kg`. */
    target: string | null;
  };
}) {
  const points = useMemo(
    () => readingChartPoints(readings, unit, locale),
    [readings, unit, locale],
  );

  if (points.length === 0) return null;

  return (
    <div style={styles.wrap}>
      <span style={styles.title}>{labels.title}</span>
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

const styles: Record<string, CSSProperties> = {
  wrap:  { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 },
  title: {
    fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
    color: memberTheme.textSecondary,
  },
};
