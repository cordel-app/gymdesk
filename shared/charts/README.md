# `@gymdesk/charts`

Cordel's shared charting layer: **Apache ECharts behind one themed abstraction**,
consumed by the Admin app and the Members App (#1037 stage 4).

```text
Admin app  ─┐
            ├─▶  @gymdesk/charts  ─▶  Apache ECharts
Members app ─┘
```

The two apps deliberately share no other frontend module — but a chart is not a
screen. It is an engine plus a visual contract, and two of those would be two
visual languages for the same data, which is what this package exists to
prevent. Future charts reuse it rather than adding a second charting library or
an inline SVG of their own.

## What lives here, and what does not

| Here | The app's |
|---|---|
| ECharts itself, loaded dynamically and registered once (`echartsRuntime.ts`) | which rows become points |
| the option a chart type is drawn from (`lineChartOption.ts`) | every **label**: a formatted date, a value with its unit, a translated caption |
| the colours, resolved from the apps' own Theme variables (`chartTheme.ts`) | which Theme the page is rendered under |
| the canvas's lifetime — mount, resize, Theme change, dispose (`EChartCanvas.tsx`) | where the chart sits on the page |

Nothing in this package resolves a locale key, formats a date, names an endpoint
or knows what an entity is. A point arrives with its labels already written.

## Using it

```tsx
import { LineChart } from '@gymdesk/charts';

<LineChart
  points={points}                       // { x, y, group?, label?, valueLabel? }
  height={200}
  ariaLabel={t('chart_aria_label')}     // a canvas has no accessible name
  reference={{ value: 70, label: t('chart_target', { value: '70 kg' }) }}
  axisLabelFormatter={(at) => format(at, locale)}
/>
```

A point's `group` segments the line: consecutive points sharing a group become
one series with its own palette entry, joined to the previous one by a bridge
point that draws no symbol (#1037 §23/§24 — one colour per initial-reading
period, with the line unbroken).

## Theming

ECharts draws onto a canvas, so it cannot read a CSS variable: every colour has
to be resolved first. `chartTheme.ts` declares each **role** as the variable that
holds it — the same variables `applyTokens()` writes in both apps — and resolves
them off the element the chart sits in, so a Center's own Theme reaches the
canvas. A role's `var()` fallback covers the frames before a Theme has loaded and
nothing else.

**No chart component spells a colour.** `api/src/test/charts-layer.unit.test.ts`
fails the build if one does, if an app imports `echarts` directly, or if the
layer starts resolving locale keys.

## Adding a chart type

1. Write `<type>ChartOption.ts` beside `lineChartOption.ts`: a pure function of
   `(input, theme)`, taking every colour from the theme.
2. Register what it draws in `echartsRuntime.ts` — only what is actually used,
   never the `echarts` barrel, which pulls in every chart the library has. That
   file is also where the bundle cost of a new type is visible.
3. Write `<Type>Chart.tsx`: props in, `EChartCanvas` out. The canvas is never
   mounted a second way.
4. Export both from `src/index.ts` and extend the unit test above.

An **area** chart is `LineChart` with `area`, because that is what an area chart
is. A bar or a scatter chart is the four steps above.

## Why the source is TypeScript and not a build

The package has no build step: `main` is `src/index.ts` and both apps list it in
`transpilePackages`, so Next compiles it with the app that renders it. One fewer
artefact to keep in step, and the apps' own `tsc --noEmit` type-checks it.

Each app's `Dockerfile` therefore copies `shared/charts` into the image and
installs that workspace beside its own.
