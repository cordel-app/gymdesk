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
}

/** What the tooltip renders for one hovered point. Exported so it is assertable. */
export function tooltipHtml(point: { label?: string; valueLabel?: string }): string {
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

/** The option object, loose on purpose: ECharts' own types are the canvas's. */
export type ChartOption = Record<string, unknown>;

export function lineChartOption(input: LineChartInput, theme: ChartTheme): ChartOption {
  const axisType = input.xAxisType ?? 'time';

  const series = input.series.map((entry, index) => {
    const color = seriesColor(theme, entry.colorIndex ?? index);
    const bridges = entry.bridgeCount ?? 0;
    return {
      id: entry.id,
      name: entry.name,
      type: 'line',
      // §14 — smooth, and monotone so the curve invents no reading.
      smooth: true,
      smoothMonotone: 'x',
      showSymbol: true,
      symbol: 'circle',
      symbolSize: SYMBOL_SIZE,
      lineStyle: { width: LINE_WIDTH, color },
      itemStyle: { color, borderColor: theme.surface, borderWidth: 1 },
      areaStyle: input.area ? { color, opacity: 0.12 } : undefined,
      emphasis: { scale: 1.4, focus: 'none' },
      data: entry.points.map((point, pointIndex) => ({
        value: [point.x, point.y],
        label: point.label,
        valueLabel: point.valueLabel,
        // A bridge carries no symbol, so it cannot be hovered and cannot
        // report a measurement the member already read on the previous period.
        symbolSize: pointIndex < bridges ? 0 : SYMBOL_SIZE,
      })),
      markLine: index === 0 && input.reference
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

  return {
    // ECharts' own palette is replaced rather than merged: the first entry is
    // what a series with no colour of its own would take.
    color: theme.series,
    backgroundColor: 'transparent',
    animation: true,
    textStyle: { color: theme.text },
    grid: { left: 8, right: 14, top: 18, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'item',
      // A tap is a click: the same tooltip serves desktop, tablet and phone (§16).
      triggerOn: 'mousemove|click',
      confine: true,
      backgroundColor: theme.surface,
      borderColor: theme.surfaceBorder,
      textStyle: { color: theme.text, fontSize: 12 },
      formatter: (params: unknown) => {
        const data = (params as { data?: { label?: string; valueLabel?: string } }).data;
        return data ? tooltipHtml(data) : '';
      },
    },
    xAxis: {
      type: axisType,
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
    yAxis: {
      type: 'value',
      // Readings sit in a narrow band (80 → 75 kg), so a zero-based axis would
      // flatten the whole history into one line.
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: theme.textMuted, fontSize: 11 },
      splitLine: { lineStyle: { color: theme.axisLine, type: 'solid' } },
    },
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
    series,
  };
}
