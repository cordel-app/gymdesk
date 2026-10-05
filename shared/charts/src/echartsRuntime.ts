/**
 * #1037 stage 4 — where ECharts itself is loaded, and the only file in the
 * repository that imports it.
 *
 * Two properties are the rule rather than the implementation, and both are the
 * reason this is a module of its own rather than three lines in the component.
 *
 * * **The import is dynamic.** A client component is still evaluated during SSR
 *   in the App Router, and ECharts at module scope would be loaded on the server
 *   and in every browser that never renders a chart. `await import()` inside an
 *   effect keeps it off the server entirely and out of the initial bundle —
 *   `apps/member/src/lib/nativePlugins.ts` (#1073) is the same rule for the same
 *   reason.
 * * **Only what is drawn is registered.** `echarts/core` plus the chart and
 *   component modules a chart actually uses, never the `echarts` barrel, which
 *   pulls in every chart type the library has. A new chart type adds its entry
 *   here (see `README.md`), which is also the one place that cost is visible.
 */

export type EChartsModule = typeof import('echarts/core');
export type EChartsInstance = ReturnType<EChartsModule['init']>;

let loader: Promise<EChartsModule> | null = null;

/** Loads and registers ECharts once per browser session. */
export function loadECharts(): Promise<EChartsModule> {
  if (!loader) {
    loader = (async () => {
      const [core, charts, components, renderers] = await Promise.all([
        import('echarts/core'),
        import('echarts/charts'),
        import('echarts/components'),
        import('echarts/renderers'),
      ]);
      core.use([
        charts.LineChart,
        components.GridComponent,
        components.TooltipComponent,
        components.MarkLineComponent,
        components.DataZoomInsideComponent,
        renderers.CanvasRenderer,
      ]);
      return core;
    })();
  }
  return loader;
}
