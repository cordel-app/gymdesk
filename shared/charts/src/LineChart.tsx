'use client';

import { type CSSProperties, useCallback } from 'react';
import { EChartCanvas } from './EChartCanvas';
import { type ChartTheme } from './chartTheme';
import { type LineChartInput, lineChartOption } from './lineChartOption';
import { type ChartPoint, type ChartSeries, segmentPoints } from './series';

/**
 * #1037 stage 4 — **LineChart**, the layer's first chart type.
 *
 * It is the whole of what a page needs to draw a line: the data, an optional
 * reference line and whether it fills. Everything else — the colours, the
 * tooltip, the axes, the smoothing, the interaction, the canvas's lifetime — is
 * the layer's, so neither app renders an ECharts option of its own and a chart
 * added later cannot look different for having been written later.
 *
 * `points` is the shorthand a single-series chart takes; `series` is the
 * explicit form, and a point carrying a `group` becomes §23's segmented line
 * through `segmentPoints()` — the caller never builds the segments itself.
 *
 * An **area** chart is this component with `area`, because that is what an area
 * chart is; a bar or a scatter chart is a module beside `lineChartOption.ts`
 * plus a component of this shape (`README.md`).
 */
export function LineChart({
  points, series, height, ariaLabel, reference, area, zoom = true,
  xAxisType, axisLabelFormatter, style,
}: {
  /** One series' points. Ignored when `series` is given. */
  points?: ChartPoint[];
  series?: ChartSeries[];
  height?: number;
  ariaLabel?: string;
  reference?: LineChartInput['reference'];
  area?: boolean;
  /** Pinch and drag. On by default — a reading history outgrows its box. */
  zoom?: boolean;
  xAxisType?: LineChartInput['xAxisType'];
  axisLabelFormatter?: (value: number) => string;
  style?: CSSProperties;
}) {
  const resolved: ChartSeries[] = series ?? segmentPoints(points ?? []);

  const build = useCallback(
    (theme: ChartTheme) => lineChartOption(
      { series: resolved, reference, area, zoom, xAxisType, axisLabelFormatter },
      theme,
    ),
    // The series are rebuilt on every render by the caller's own memoisation, so
    // the option is keyed on their content rather than on their identity.
    [JSON.stringify(resolved), reference?.value, reference?.label, area, zoom, xAxisType, axisLabelFormatter],
  );

  return <EChartCanvas build={build} height={height} ariaLabel={ariaLabel} style={style} />;
}
