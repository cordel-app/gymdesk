import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CHART_SERIES_ROLES,
  CHART_THEME_ROLES,
  type ChartTheme,
  defaultChartTheme,
  resolveChartTheme,
  seriesColor,
} from '../../../shared/charts/src/chartTheme';
import { lineChartOption, tooltipHtml } from '../../../shared/charts/src/lineChartOption';
import { segmentPoints } from '../../../shared/charts/src/series';

// #1037 stage 4 — `@gymdesk/charts`, the shared charting layer, and the rules
// that keep it the *only* charting implementation in the repository.
//
// This lives in the API suite for #1009's reason, the one that already put
// `members-app-native.unit.test.ts`, `members-app-theme-consumption.unit.test.ts`
// and `mobile-shell-profile.unit.test.ts` here: CI runs `npm test` in `api/`
// only, so a rule that has to hold on every push belongs in this suite even
// when what it covers is another workspace. The modules it imports are pure
// TypeScript with no DOM and no React, which is exactly why the layer is split
// the way it is.

const ROOT = join(__dirname, '..', '..', '..');
const CHARTS = join(ROOT, 'shared', 'charts');

/** A colour spelled in a source file: always a quoted literal, never a `#1037`. */
const QUOTED_COLOR = /['"`]#[0-9a-fA-F]{3,8}['"`]/;

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

/** A reader over a fixed map, as a browser's `getComputedStyle` behaves. */
function reader(values: Record<string, string>) {
  return (variable: string) => values[variable] ?? '';
}

const THEME: ChartTheme = {
  text: '#101010',
  textMuted: '#808080',
  axisLine: '#dddddd',
  surface: '#fefefe',
  surfaceBorder: '#cccccc',
  series: ['#111111', '#222222', '#333333'],
};

describe('the theme a chart is painted with', () => {
  it('resolves every role from the CSS variable that holds it', () => {
    const theme = resolveChartTheme(reader({
      '--gd-text': '#000080',
      '--gd-text-muted': '#555555',
      '--gd-border': '#eeeeee',
      '--gd-card-bg': '#fdfdfd',
      '--gd-card-border': '#dcdcdc',
      '--gd-primary-btn': '#ff00ff',
      '--gd-status-info': '#0000ff',
      '--gd-status-success': '#00ff00',
      '--gd-status-warning': '#ffaa00',
    }));
    expect(theme).toEqual({
      text: '#000080',
      textMuted: '#555555',
      axisLine: '#eeeeee',
      surface: '#fdfdfd',
      surfaceBorder: '#dcdcdc',
      series: ['#ff00ff', '#0000ff', '#00ff00', '#ffaa00'],
    });
  });

  it('falls back when a variable is unset, blank or whitespace', () => {
    // A variable resolving to '' is what `getComputedStyle` answers before
    // `applyTokens()` has run; handing that to ECharts makes it paint its own
    // default, which is the one thing §23/§40 forbid.
    const theme = resolveChartTheme(reader({ '--gd-text': '   ', '--gd-card-bg': '' }));
    expect(theme.text).toBe(CHART_THEME_ROLES.text.fallback);
    expect(theme.surface).toBe(CHART_THEME_ROLES.surface.fallback);
    expect(theme.series).toEqual(CHART_SERIES_ROLES.map((role) => role.fallback));
    expect(theme).toEqual(defaultChartTheme());
  });

  it('trims the value, because a custom property keeps its leading space', () => {
    expect(resolveChartTheme(reader({ '--gd-text': ' #123456 ' })).text).toBe('#123456');
  });

  it('cycles the palette rather than inventing a colour for the fifth period', () => {
    // §24 — any number of initial-reading changes, and a Theme that declares
    // four series colours. The fifth period repeats the first.
    expect(seriesColor(THEME, 0)).toBe('#111111');
    expect(seriesColor(THEME, 3)).toBe('#111111');
    expect(seriesColor(THEME, 4)).toBe('#222222');
    expect(seriesColor({ ...THEME, series: [] }, 1)).toBe(defaultChartTheme().series[1]);
  });

  it('declares no status-error role, so no period is painted as a failure', () => {
    expect(CHART_SERIES_ROLES.map((role) => role.variable)).not.toContain('--gd-status-error');
  });
});

describe('segmenting points into one series per group', () => {
  const points = [
    { x: 1, y: 80, group: 0 },
    { x: 2, y: 78, group: 0 },
    { x: 3, y: 76, group: 1 },
    { x: 4, y: 75, group: 1 },
  ];

  it('keeps one series while the group does not change', () => {
    const series = segmentPoints([{ x: 1, y: 1 }, { x: 2, y: 2 }]);
    expect(series).toHaveLength(1);
    expect(series[0].points).toHaveLength(2);
    expect(series[0].bridgeCount).toBe(0);
  });

  it('starts a new series at a group boundary and bridges it to the previous one', () => {
    const series = segmentPoints(points);
    expect(series).toHaveLength(2);
    expect(series[0].points.map((p) => p.x)).toEqual([1, 2]);
    // §23 — the line is continuous across a boundary: the new segment repeats
    // the previous segment's last *real* reading rather than interpolating one.
    expect(series[1].bridgeCount).toBe(1);
    expect(series[1].points.map((p) => p.x)).toEqual([2, 3, 4]);
    expect(series[1].points[0]).toEqual(points[1]);
  });

  it('colours a series by its group, not by its position', () => {
    const series = segmentPoints([{ x: 1, y: 1, group: 0 }, { x: 2, y: 2, group: 2 }]);
    expect(series.map((s) => s.colorIndex)).toEqual([0, 2]);
  });

  it('answers nothing for no points', () => {
    expect(segmentPoints([])).toEqual([]);
  });
});

describe('the line chart option', () => {
  const option = (overrides = {}) => lineChartOption({
    series: segmentPoints([
      { x: 10, y: 80, group: 0, label: '01 Sep', valueLabel: '80 kg' },
      { x: 20, y: 76, group: 1, label: '22 Sep', valueLabel: '76 kg' },
    ]),
    reference: { value: 70, label: 'Target 70 kg' },
    zoom: true,
    ...overrides,
  }, THEME) as any;

  it('smooths the line monotonically, so the curve invents no reading', () => {
    // §14 — a plain cubic spline overshoots, and an overshoot *is* a value the
    // member never recorded.
    for (const series of option().series) {
      expect(series.smooth).toBe(true);
      expect(series.smoothMonotone).toBe('x');
    }
  });

  it('draws a point bigger than the line, and none for a bridge', () => {
    const [first, second] = option().series;
    expect(first.lineStyle.width).toBeLessThan(first.symbolSize); // §15
    expect(first.data.map((d: any) => d.symbolSize)).toEqual([8]);
    // The bridged point is the previous period's reading, already on screen.
    expect(second.data.map((d: any) => d.symbolSize)).toEqual([0, 8]);
  });

  it('takes every colour from the theme and spells none of its own', () => {
    const hexes = JSON.stringify(option(), (_key, value) => (typeof value === 'function' ? undefined : value))
      .match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    const allowed = new Set([...THEME.series, THEME.text, THEME.textMuted, THEME.axisLine, THEME.surface, THEME.surfaceBorder]);
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) expect(allowed).toContain(hex);
  });

  it('gives each period its own palette entry', () => {
    const [first, second] = option().series;
    expect(first.lineStyle.color).toBe(THEME.series[0]);
    expect(second.lineStyle.color).toBe(THEME.series[1]);
  });

  it('marks the reference line once, dashed, and not at all without one', () => {
    const withRef = option();
    expect(withRef.series[0].markLine.data).toEqual([{ yAxis: 70 }]);
    expect(withRef.series[0].markLine.lineStyle.type).toBe('dashed');
    // One line, not one per period.
    expect(withRef.series[1].markLine).toBeUndefined();
    expect(option({ reference: null }).series[0].markLine).toBeUndefined();
  });

  it('scales the value axis, so a narrow band of readings is readable', () => {
    expect(option().yAxis.scale).toBe(true);
  });

  it('leaves the page its own background and its own wheel', () => {
    expect(option().backgroundColor).toBe('transparent');
    expect(option().dataZoom[0].zoomOnMouseWheel).toBe(false);
    expect(option({ zoom: false }).dataZoom).toBeUndefined();
  });

  it('fills only when asked, which is what an area chart is', () => {
    expect(option().series[0].areaStyle).toBeUndefined();
    expect(option({ area: true }).series[0].areaStyle.color).toBe(THEME.series[0]);
  });

  it('prints the labels the page formatted, and escapes them', () => {
    const formatter = option().tooltip.formatter;
    expect(formatter({ data: { label: '01 Sep', valueLabel: '80 kg' } }))
      .toBe('<span>01 Sep</span><br/><strong>80 kg</strong>');
    expect(formatter({})).toBe('');
    expect(tooltipHtml({ label: '<b>x</b>' })).toBe('<span>&lt;b&gt;x&lt;/b&gt;</span>');
    expect(tooltipHtml({})).toBe('');
  });

  it('formats an axis tick with the caller’s own formatter, never its own', () => {
    const labelled = lineChartOption(
      { series: [], axisLabelFormatter: (value) => `day-${value}` },
      THEME,
    ) as any;
    expect(labelled.xAxis.axisLabel.formatter(7)).toBe('day-7');
    expect((lineChartOption({ series: [] }, THEME) as any).xAxis.axisLabel.formatter).toBeUndefined();
  });

  it('is a time axis unless the caller says otherwise', () => {
    expect(option().xAxis.type).toBe('time');
    expect(option({ xAxisType: 'value' }).xAxis.type).toBe('value');
  });
});

describe('the layer is the only charting implementation', () => {
  const APP_DIRS = ['apps/admin/src', 'apps/member/src'];

  function sources(dir: string): string[] {
    const { execSync } = require('child_process');
    return execSync(`find ${join(ROOT, dir)} -type f \\( -name '*.ts' -o -name '*.tsx' \\)`, { encoding: 'utf8' })
      .split('\n').filter(Boolean);
  }

  it('is the only place that imports echarts', () => {
    for (const dir of APP_DIRS) {
      for (const file of sources(dir)) {
        const text = readFileSync(file, 'utf8');
        expect(/from ['"]echarts/.test(text), `${file} imports echarts directly`).toBe(false);
      }
    }
    expect(readFileSync(join(CHARTS, 'src', 'echartsRuntime.ts'), 'utf8')).toContain("import('echarts/core')");
  });

  it('imports echarts dynamically, so it never runs during SSR', () => {
    const runtime = readFileSync(join(CHARTS, 'src', 'echartsRuntime.ts'), 'utf8');
    expect(runtime).not.toMatch(/^import .*from 'echarts/m);
    // The barrel pulls in every chart type the library has.
    expect(runtime).not.toMatch(/import\('echarts'\)/);
  });

  it('is consumed by both apps’ goal charts, which spell no colour', () => {
    for (const file of [
      'apps/admin/src/components/personalGoals/GoalReadingChart.tsx',
      'apps/member/src/components/GoalReadingChart.tsx',
    ]) {
      const text = read(file);
      expect(text, file).toContain("from '@gymdesk/charts'");
      // A colour is always a quoted literal here; a bare `#1037` is a ticket.
      expect(QUOTED_COLOR.test(text), `${file} spells a colour`).toBe(false);
      expect(/\b(rgb|rgba|hsl|hsla)\(/.test(text), `${file} spells a colour`).toBe(false);
    }
  });

  it('resolves no locale key and formats no date inside the layer', () => {
    const { execSync } = require('child_process');
    const files = execSync(`find ${join(CHARTS, 'src')} -type f`, { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(/\bt\(['"]/.test(text), `${file} resolves a locale key`).toBe(false);
      expect(/toLocaleDateString|next-intl/.test(text), `${file} formats a date`).toBe(false);
    }
  });

  it('is wired into the workspace and into both apps', () => {
    const root = JSON.parse(read('package.json'));
    expect(root.workspaces).toContain('shared/charts');
    for (const app of ['admin', 'member']) {
      const pkg = JSON.parse(read('apps', app, 'package.json'));
      expect(pkg.dependencies['@gymdesk/charts'], app).toBeTruthy();
      // The package ships TypeScript source, so Next has to compile it.
      expect(read('apps', app, 'next.config.js'), app).toContain("transpilePackages: ['@gymdesk/charts']");
      // …and the image has to carry it, or the build fails on the VPS and
      // nowhere else.
      const dockerfile = read('apps', app, 'Dockerfile');
      expect(dockerfile, app).toContain('shared/charts/package');
      expect(dockerfile, app).toContain('COPY shared ./shared');
    }
  });
});
