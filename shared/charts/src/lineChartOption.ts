/**
 * #1037 stage 4 — the ECharts option a line chart is drawn from, as a pure
 * function of its data and its resolved theme.
 *
 * Every chart type the layer grows gets a module of this shape: an input
 * interface, a builder, and no DOM. `EChartCanvas` then does nothing but hand
 * the result to ECharts, which is what keeps *what a chart looks like*
 * assertable in a unit test while *how it is mounted* is one component for all
 * of them (`shared/charts/README.md` says how to add one).
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * * **No colour is spelled here.** Every one comes from the `ChartTheme` it is
 *   handed (§23/§40), and ECharts' own palette is overridden rather than
 *   extended — an option that left `color` unset would paint the library's
 *   default blue over a gym's Theme.
 * * **The curve never overshoots a reading.** `smooth` plus
 *   `smoothMonotone: 'x'` is §14 read literally: the line is smooth, and it
 *   cannot bulge past the highest or below the lowest measurement, which a plain
 *   cubic spline does — and a bulge *is* a reading the member never recorded.
 * * **A point is bigger than the line** (§15): the symbol is 8px against a 2px
 *   stroke, and a bridge point (a segment's repeat of its predecessor's last
 *   reading) is given `symbolSize: 0`, so the join is drawn without reporting
 *   one measurement twice.
 * * **The tooltip prints what the page formatted** (§16): `label` and
 *   `valueLabel` come off the point, so no date and no unit is composed in this
 *   layer, and it triggers on click as well as hover so a tap works on a phone.
 */

import { type ChartSeries } from './series';
import { type ChartTheme, seriesColor } from './chartTheme';

export interface ReferenceLine {
  value: number;
  /** Already formatted and translated — e.g. `Target 70 kg`. */
  label?: string;
}

export interface LineChartInput {
  series: ChartSeries[];
  /** `time` spaces points by when they happened; `value` by their number. */
  xAxisType?: 'time' | 'value';
  /** A horizontal reference — #1037's target (§13's "show the target"). */
  reference?: ReferenceLine | null;
  /** Fills under the line. An area chart is a line chart with this set. */
  area?: boolean;
  /** §16's interaction half: pinch and drag on touch, wheel-free on desktop. */
  zoom?: boolean;
  /** Formats an axis tick. The page's, so the dates stay localized. */
  axisLabelFormatter?: (value: number) => string;
  /** The x of the point a page has selected; it is drawn larger so the selection reads on the chart. */
  selectedX?: number | null;
  /**
   * A compact legend of hand-named entries (#2224). A reference line is not a series, so a
   * chart that wants it identified declares the entries itself: `primary` takes the first
   * palette colour, `reference` the reference line's muted dashed style.
   */
  legend?: { name: string; kind: 'primary' | 'reference' }[];
  /**
   * A vertical marker at one x — #3311's *Today*, which separates what happened
   * from what is scheduled or forecast. Its label is the page's, already translated.
   */
  xMarker?: { value: number; label?: string } | null;
  /** The smallest gap between two x-axis ticks — a month-labelled time axis passes ~a month. */
  xMinInterval?: number;
  /**
   * Where the legend sits (#3311 stage 2). `top` (the default) above the plot; `bottom`
   * under the x-axis, so a labelled `xMarker` has the space above the plot to itself.
   */
  legendPosition?: 'top' | 'bottom';
}

/** What the tooltip renders for one hovered point. Exported so it is assertable. */
export function tooltipHtml(point: { heading?: string; label?: string; valueLabel?: string; detailLines?: string[] }): string {
  const details = (point.detailLines ?? []).filter((line) => !!line);
  if (point.heading) {
    // #3499 — heading (bold, uppercase), the date, the lines, the total (bold).
    const parts = [
      `<strong style="text-transform:uppercase">${escapeHtml(point.heading)}</strong>`,
      ...(point.label ? [`<span>${escapeHtml(point.label)}</span>`] : []),
      ...details.map((line) => `<span>${escapeHtml(line)}</span>`),
      ...(point.valueLabel ? [`<strong>${escapeHtml(point.valueLabel)}</strong>`] : []),
    ];
    return parts.join('<br/>');
  }
  if (details.length > 0) {
    const head = point.label ? `<strong>${escapeHtml(point.label)}</strong><br/>` : '';
    const total = point.valueLabel ? `<br/><strong>${escapeHtml(point.valueLabel)}</strong>` : '';
    return `${head}${details.map(escapeHtml).join('<br/>')}${total}`;
  }
  const lines = [point.label, point.valueLabel].filter((line): line is string => !!line);
  if (lines.length === 0) return '';
  const [first, ...rest] = lines;
  return rest.length === 0
    ? `<span>${escapeHtml(first)}</span>`
    : `<span>${escapeHtml(first)}</span><br/><strong>${rest.map(escapeHtml).join(' ')}</strong>`;
}

/**
 * The tooltip is HTML, and a value that reached it is a member's own unit
 * string or a gym's own goal name — data, never markup. Escaped here rather
 * than at each caller, so no page can forget.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LINE_WIDTH = 2;
const SYMBOL_SIZE = 8;
const SELECTED_SYMBOL_SIZE = 14;
/** #3311 stage 2 — room above the plot for a labelled `xMarker`, so the label clears the data. */
const MARKER_LABEL_SPACE = 22;
const LEGEND_SPACE = 26;

const ALERT_SIZE = 14;

/**
 * #3435 — a point's alert mark: a small solid disc in the series' own colour with
 * a `!` in the surface colour, sitting just above the point so it never covers it.
 * Silent text, so a tap still reaches the point and its tooltip.
 */
export function alertLabel(color: string, theme: ChartTheme): Record<string, unknown> {
  return {
    show: true,
    position: 'top',
    distance: 4,
    formatter: '!',
    color: theme.surface,
    backgroundColor: color,
    fontSize: 10,
    fontWeight: 'bold',
    width: ALERT_SIZE,
    height: ALERT_SIZE,
    lineHeight: ALERT_SIZE,
    align: 'center',
    verticalAlign: 'middle',
    borderRadius: ALERT_SIZE / 2,
  };
}

/** The option object, loose on purpose: ECharts' own types are the canvas's. */
export type ChartOption = Record<string, unknown>;

export function lineChartOption(input: LineChartInput, theme: ChartTheme): ChartOption {
  const axisType = input.xAxisType ?? 'time';
  const dualAxis = input.series.some((entry) => entry.axis === 1);
  const customLegend = input.legend && input.legend.length > 0 ? input.legend : null;
  const legendNames = customLegend
    ? customLegend.map((entry) => entry.name)
    : input.series.map((entry) => entry.name).filter((n): n is string => !!n);
  const yAxis = (right: boolean) => ({
    type: 'value',
    // Readings sit in a narrow band (80 → 75 kg), so a zero-based axis would
    // flatten the whole history into one line.
    scale: true,
    position: right ? 'right' : 'left',
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: theme.textMuted, fontSize: 11 },
    // Only the left axis draws grid lines, so two scales never double the grid.
    splitLine: { show: !right, lineStyle: { color: theme.axisLine, type: 'solid' } },
  });

  const series = input.series.map((entry, index) => {
    const color = seriesColor(theme, entry.colorIndex ?? index);
    const bridges = entry.bridgeCount ?? 0;
    return {
      id: entry.id,
      name: entry.name,
      type: 'line',
      yAxisIndex: entry.axis ?? 0,
      // §14 — smooth, and monotone so the curve invents no reading.
      smooth: true,
      smoothMonotone: 'x',
      showSymbol: true,
      symbol: 'circle',
      symbolSize: SYMBOL_SIZE,
      lineStyle: { width: LINE_WIDTH, color, type: entry.dashed ? 'dashed' : 'solid' },
      itemStyle: { color, borderColor: theme.surface, borderWidth: 1 },
      areaStyle: input.area ? { color, opacity: 0.12 } : undefined,
      emphasis: { scale: 1.4, focus: 'none' },
      data: entry.points.map((point, pointIndex) => ({
        value: [point.x, point.y],
        tipLabel: point.label,
        tipHeading: point.heading,
        valueLabel: point.valueLabel,
        detailLines: point.detailLines,
        // A bridge carries no symbol, so it cannot be hovered and cannot
        // report a measurement the member already read on the previous period.
        symbolSize: pointIndex < bridges
          ? 0
          : (input.selectedX != null && point.x === input.selectedX ? SELECTED_SYMBOL_SIZE : SYMBOL_SIZE),
        x: point.x,
        ...(point.symbol ? { symbol: point.symbol } : {}),
        // #2224 — the selected day's informative flag: its date and value, drawn on the point.
        // #3435 — otherwise an alerting point carries its `!` disc above it.
        label: input.selectedX != null && point.x === input.selectedX && pointIndex >= bridges
          ? {
              show: true,
              position: 'top',
              formatter: (point.flagLines && point.flagLines.length > 0 ? point.flagLines : [point.label, point.valueLabel]).filter(Boolean).join('\n'),
              color: theme.text,
              fontSize: 11,
              backgroundColor: theme.surface,
              borderColor: theme.surfaceBorder,
              borderWidth: 1,
              borderRadius: 4,
              padding: [3, 6],
            }
          : point.alert && pointIndex >= bridges
          ? alertLabel(color, theme)
          : undefined,
      })),
      markLine: index === 0 && input.xMarker
        ? {
            silent: true,
            symbol: 'none',
            label: {
              formatter: input.xMarker.label ?? '',
              show: !!input.xMarker.label,
              position: 'end',
              // #3311 stage 2 — lifted off the plot's top edge into the room the grid
              // leaves for it, so it cannot sit on a point or a line.
              distance: 8,
              color: theme.text,
              fontSize: 11,
            },
            // #3500 — dashed, so the marker reads as a boundary rather than as data.
            lineStyle: { color: theme.text, type: 'dashed', width: 1 },
            data: [
              { xAxis: input.xMarker.value },
              ...(input.reference ? [{ yAxis: input.reference.value }] : []),
            ],
          }
        : index === 0 && input.reference
        ? {
            silent: true,
            symbol: 'none',
            label: {
              formatter: input.reference.label ?? '',
              show: !!input.reference.label,
              position: 'insideEndTop',
              color: theme.textMuted,
              fontSize: 11,
            },
            lineStyle: { color: theme.textMuted, type: 'dashed', width: 1 },
            data: [{ yAxis: input.reference.value }],
          }
        : undefined,
    };
  });

  // Legend-only series: no data, they exist so the legend can draw the line style of the
  // element it names (a markLine has no legend entry of its own).
  const legendSeries = (customLegend ?? []).map((entry) => ({
    name: entry.name,
    type: 'line',
    data: [],
    silent: true,
    showSymbol: false,
    itemStyle: { color: entry.kind === 'reference' ? theme.textMuted : seriesColor(theme, 0) },
    lineStyle: entry.kind === 'reference'
      ? { color: theme.textMuted, type: 'dashed', width: 1 }
      : { color: seriesColor(theme, 0), width: LINE_WIDTH },
  }));

  const showLegend = legendNames.length > 1 || !!customLegend;
  const legendAtBottom = showLegend && input.legendPosition === 'bottom';
  const markerLabelSpace = input.xMarker?.label ? MARKER_LABEL_SPACE : 0;
  const gridTop = (showLegend && !legendAtBottom ? 34 : 18) + markerLabelSpace;
  const gridBottom = legendAtBottom ? 6 + LEGEND_SPACE : 6;

  return {
    // ECharts' own palette is replaced rather than merged: the first entry is
    // what a series with no colour of its own would take.
    color: theme.series,
    backgroundColor: 'transparent',
    animation: true,
    textStyle: { color: theme.text },
    // #2198 — a legend only where several named series share the chart.
    legend: showLegend
      ? {
          show: true, ...(legendAtBottom ? { bottom: 0 } : { top: 0 }),
          itemWidth: legendAtBottom ? 24 : 16, itemHeight: 8, itemGap: 12,
          textStyle: { color: theme.textMuted, fontSize: 11 }, data: legendNames,
        }
      : undefined,
    grid: { left: 8, right: 14, top: gridTop, bottom: gridBottom, containLabel: true },
    tooltip: {
      trigger: 'item',
      // A tap is a click: the same tooltip serves desktop, tablet and phone (§16).
      triggerOn: 'mousemove|click',
      confine: true,
      backgroundColor: theme.surface,
      borderColor: theme.surfaceBorder,
      textStyle: { color: theme.text, fontSize: 12 },
      formatter: (params: unknown) => {
        const data = (params as { data?: { tipHeading?: string; tipLabel?: string; valueLabel?: string; detailLines?: string[] } }).data;
        return data
          ? tooltipHtml({ heading: data.tipHeading, label: data.tipLabel, valueLabel: data.valueLabel, detailLines: data.detailLines })
          : '';
      },
    },
    xAxis: {
      type: axisType,
      minInterval: input.xMinInterval,
      axisLine: { lineStyle: { color: theme.axisLine } },
      axisTick: { show: false },
      axisLabel: {
        color: theme.textMuted,
        fontSize: 11,
        hideOverlap: true,
        formatter: input.axisLabelFormatter
          ? (value: number) => input.axisLabelFormatter!(Number(value))
          : undefined,
      },
      splitLine: { show: false },
    },
    yAxis: dualAxis ? [yAxis(false), yAxis(true)] : yAxis(false),
    // ECharts' own interaction rather than a hand-rolled one. The wheel is left
    // to the page: a chart inside a scrolling card that swallowed the wheel
    // would trap the reader on it.
    dataZoom: input.zoom
      ? [{
          type: 'inside',
          zoomOnMouseWheel: false,
          moveOnMouseWheel: false,
          moveOnMouseMove: true,
          preventDefaultMouseMove: false,
        }]
      : undefined,
    series: [...series, ...legendSeries],
  };
}
