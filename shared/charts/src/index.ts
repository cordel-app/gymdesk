/**
 * `@gymdesk/charts` — Cordel's shared charting layer (#1037 stage 4).
 *
 * ```text
 * Admin app  ─┐
 *             ├─▶  @gymdesk/charts  ─▶  Apache ECharts
 * Members app ─┘
 * ```
 *
 * The two apps share no other frontend module, deliberately — but a chart is
 * not a screen: it is an engine plus a visual contract, and two of those would
 * be two visual languages for the same data. So this package owns ECharts, the
 * option every chart type is drawn from, the mapping from the apps' own Theme
 * variables onto the canvas, and the canvas's lifetime; each app owns only the
 * adapter that turns its rows into points, with its own locale and its own
 * labels.
 *
 * Nothing here resolves a locale key, formats a date, names an endpoint or knows
 * what an entity is — a point arrives with its labels already written.
 */

export { EChartCanvas } from './EChartCanvas';
export { LineChart } from './LineChart';
export {
  CHART_SERIES_ROLES, CHART_THEME_ROLES, type ChartTheme, type CssVariableReader,
  cssVariableReader, defaultChartTheme, resolveChartTheme, seriesColor,
} from './chartTheme';
export {
  type ChartOption, type LineChartInput, type ReferenceLine, lineChartOption, tooltipHtml,
} from './lineChartOption';
export { type ChartPoint, type ChartSeries, segmentPoints } from './series';
export { type EChartsInstance, type EChartsModule, loadECharts } from './echartsRuntime';
