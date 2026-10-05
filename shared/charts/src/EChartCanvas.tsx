'use client';

import { type CSSProperties, useCallback, useEffect, useRef } from 'react';
import { type ChartTheme, cssVariableReader, resolveChartTheme } from './chartTheme';
import { type ChartOption } from './lineChartOption';
import { type EChartsInstance, loadECharts } from './echartsRuntime';

/**
 * #1037 stage 4 — the one component that mounts an ECharts canvas.
 *
 * Every chart type in the layer renders through it: a chart component decides
 * *what* to draw (its own pure option builder) and this decides *how it lives on
 * a page* — when ECharts is loaded, when the option is re-applied, what happens
 * when the box or the Theme changes, and when the instance is disposed. A second
 * mounting component is what would let one chart leak an instance while another
 * does not.
 *
 * Three of its answers are the rule rather than the implementation.
 *
 * * **The theme is resolved from the element the chart sits in**, not from a
 *   prop, so a Center's own Theme (written on a subtree) reaches the canvas and
 *   no page has to pass colours down.
 * * **It re-reads the Theme when the Theme is written.** `ThemeProvider` applies
 *   its tokens in an effect, which may land *after* this one, so a chart painted
 *   from the fallbacks would keep them for ever. The observer on the root's
 *   `style` attribute is what makes a Theme arriving late repaint the chart
 *   (#983's rule that a value a page cannot move must come from the Theme is
 *   only true if the Theme actually reaches it).
 * * **It is disposed.** ECharts holds a canvas, a resize listener and its own
 *   animation frames; an instance left behind by an unmounted card is a leak
 *   that grows with every goal a member expands.
 */
export function EChartCanvas({ build, height = 220, ariaLabel, style }: {
  /**
   * The option, from the resolved theme. Memoize it (`useCallback`) — it is the
   * dependency that decides when the chart is re-drawn.
   */
  build: (theme: ChartTheme) => ChartOption;
  height?: number;
  /** The chart's accessible name: a canvas has none of its own. */
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const buildRef = useRef(build);
  buildRef.current = build;

  const apply = useCallback(() => {
    const chart = chartRef.current;
    const box = boxRef.current;
    if (!chart || !box) return;
    const theme = resolveChartTheme(cssVariableReader(box));
    // `notMerge` — a redraw after a period was added must not leave the series
    // the previous option declared on the canvas.
    chart.setOption(buildRef.current(theme), { notMerge: true });
  }, []);

  useEffect(() => {
    let disposed = false;
    const box = boxRef.current;
    if (!box) return;

    loadECharts().then((echarts) => {
      if (disposed || !boxRef.current) return;
      chartRef.current = echarts.init(boxRef.current, undefined, { renderer: 'canvas' });
      apply();
    }).catch(() => {
      // A chart that cannot be loaded leaves the card it sits in exactly as it
      // was: the header's figures and the reading history are the record, and a
      // failed canvas is not worth an error banner over correct numbers.
    });

    return () => {
      disposed = true;
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [apply]);

  // The data changed (a reading was added) — redraw from the current theme.
  useEffect(() => { apply(); }, [build, apply]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const observer = new MutationObserver(() => apply());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, [apply]);

  return (
    <div
      ref={boxRef}
      role="img"
      aria-label={ariaLabel}
      style={{ width: '100%', height, ...style }}
    />
  );
}
