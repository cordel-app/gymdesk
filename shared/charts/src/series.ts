/**
 * #1037 stage 4 — what a chart is given, and the one grouping rule it applies.
 *
 * A point carries its own already-formatted labels (`label`, `valueLabel`), so
 * **nothing in this layer calls `t()` or formats a date**: a tooltip prints what
 * the page handed it, which is how the chart stays locale-agnostic while the
 * dates and units a member reads stay the page's own (the rule
 * `apps/member/src/lib/calendarEventDisplay.ts` follows for a status line).
 */

export interface ChartPoint {
  /** Milliseconds since the epoch on a time axis, a number on a value axis. */
  x: number;
  /** `null` is a gap — a point with no measurement, never plotted as 0. */
  y: number | null;
  /**
   * Which group this point belongs to, for `segmentPoints()`. 0-based, and
   * ascending along the axis — #1037's initial-reading period (§38) is the
   * first consumer, but the layer knows nothing about goals.
   */
  group?: number;
  /** The tooltip's first line — a formatted date, say. */
  label?: string;
  /** The tooltip's second line — the value with its unit, say. */
  valueLabel?: string;
}

export interface ChartSeries {
  /** Stable across renders, so ECharts can diff rather than redraw. */
  id: string;
  /** Shown in a legend where one is rendered; never required. */
  name?: string;
  points: ChartPoint[];
  /**
   * Which palette entry this series takes. Defaults to its position, and is set
   * explicitly by `segmentPoints()` so a *group*'s colour follows the group
   * rather than the order its segment happens to be in.
   */
  colorIndex?: number;
  /**
   * Points that exist only to join this series to the previous one, by `x`.
   * They are drawn by the line and carry no symbol and no tooltip, because a
   * bridge is not a measurement (§14's "do not create fake readings" is why they
   * are the *previous* segment's real point rather than an interpolated one).
   */
  bridgeCount?: number;
}

/**
 * Consecutive points sharing a `group` become one series, in axis order.
 *
 * §23/§24's segmented line is this function: the chart gets one series per
 * initial-reading period and the option builder gives each its own palette
 * entry. Two properties are the rule rather than the implementation.
 *
 * * **The line stays continuous.** Each segment after the first repeats the
 *   previous segment's last point as a bridge, so the curve does not break at a
 *   period boundary — the boundary is a colour change, not a gap. The repeated
 *   point draws no symbol and raises no tooltip, so one reading is never
 *   reported twice.
 * * **The colour follows the group**, not the segment's position, so a chart
 *   whose groups are `0, 2` (a period with no readings of its own) does not
 *   silently re-use period 0's colour for period 2.
 */
export function segmentPoints(points: ChartPoint[], idPrefix = 'segment'): ChartSeries[] {
  const series: ChartSeries[] = [];
  for (const point of points) {
    const group = point.group ?? 0;
    const current = series[series.length - 1];
    if (current && current.colorIndex === group) {
      current.points.push(point);
      continue;
    }
    const bridge = current && current.points.length > 0
      ? [{ ...current.points[current.points.length - 1] }]
      : [];
    series.push({
      id: `${idPrefix}-${series.length}`,
      colorIndex: group,
      bridgeCount: bridge.length,
      points: [...bridge, point],
    });
  }
  return series;
}
