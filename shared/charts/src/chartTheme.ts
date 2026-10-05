/**
 * #1037 stage 4 — the one place a chart's colours come from.
 *
 * ECharts draws onto a canvas, so it cannot read a CSS variable: every colour
 * it is given has to be a resolved string. That is the whole reason this module
 * exists. It declares each **role** a chart paints with as the theme variable
 * that holds it — the same shape `apps/member/src/lib/memberChrome.ts` (#983)
 * and `apps/admin/src/components/formChrome.ts` (#929) give their own surfaces —
 * and resolves those variables off the live document, so a gym's Theme moves
 * every chart in both apps and no chart component spells a hex.
 *
 * Both apps write the **same** variable names (`themeTokens.ts`'s
 * `applyTokens()` in the admin, `applyTokens()` + `applyMembersAppTokens()` in
 * the Members App), which is why one declaration serves both rather than one per
 * app: a chart asks for "the muted text colour" and the app that rendered it has
 * already decided what that is.
 *
 * Three of its answers are the rule rather than the implementation.
 *
 * * **A `var()` fallback is not a second source of truth.** Each role carries
 *   the value the admin's `DEFAULT_TOKENS` writes, for the frames before a
 *   Theme has loaded and for a deployment that never writes that variable —
 *   exactly what `memberChrome.ts`'s fallbacks are for, and nothing else.
 * * **An unusable stored value falls back** rather than reaching the canvas: a
 *   variable resolving to `''` or whitespace would make ECharts paint its own
 *   default, which is the one thing §23/§40 forbid (`calendarVarValue()`'s
 *   reasoning in the admin, one layer down).
 * * **The series palette is a list of theme roles, not of hues**, and a series
 *   beyond its length **repeats** it. A chart with five initial-reading periods
 *   (§24) reuses the first colour rather than inventing a fifth, because an
 *   invented colour is a colour the Theme cannot move.
 */

/** Every colour role a chart in either app paints with. */
export interface ChartTheme {
  /** Axis labels and the tooltip's own text. */
  text: string;
  /** Secondary type: the axis name and a reference line's label. */
  textMuted: string;
  /** The axis line and the grid's split lines. */
  axisLine: string;
  /** The tooltip's surface — the card background, so it sits on the app's own white. */
  surface: string;
  /** The tooltip's border. */
  surfaceBorder: string;
  /** §23/§24 — one colour per period, cycled. Never empty. */
  series: string[];
}

interface Role {
  /** The CSS custom property both apps write this role into. */
  variable: string;
  /** The value `applyTokens()`'s own defaults write, used until it has run. */
  fallback: string;
}

/**
 * The roles, as the variables that hold them. Changing a chart's colour means
 * changing the Theme setting behind one of these — never this table.
 */
export const CHART_THEME_ROLES: Record<Exclude<keyof ChartTheme, 'series'>, Role> = {
  text:          { variable: '--gd-text',        fallback: '#111827' },
  textMuted:     { variable: '--gd-text-muted',  fallback: '#6b7280' },
  axisLine:      { variable: '--gd-border',      fallback: '#e5e7eb' },
  surface:       { variable: '--gd-card-bg',     fallback: '#ffffff' },
  surfaceBorder: { variable: '--gd-card-border', fallback: '#e5e7eb' },
};

/**
 * The series palette, in order.
 *
 * The primary action colour first — it is the app's own accent and the one a
 * single-series chart should wear — then the three status roles that read as
 * distinctions rather than as verdicts. `--gd-status-error` is deliberately
 * absent: a period of a member's weight history is not a failure, and painting
 * one red would say so.
 */
export const CHART_SERIES_ROLES: Role[] = [
  { variable: '--gd-primary-btn',   fallback: '#6c63ff' },
  { variable: '--gd-status-info',   fallback: '#2563eb' },
  { variable: '--gd-status-success',fallback: '#059669' },
  { variable: '--gd-status-warning',fallback: '#d97706' },
];

/** Reads one CSS custom property. `''` for one that is not set. */
export type CssVariableReader = (variable: string) => string;

/** A value that reached us blank is a value the chart must not be given. */
function usable(value: string | null | undefined, fallback: string): string {
  const text = (value ?? '').trim();
  return text.length > 0 ? text : fallback;
}

/**
 * The resolved theme, from a reader of CSS variables.
 *
 * Pure, and the reader is injectable, so what a chart is painted with is
 * assertable without a browser — the split
 * `api/src/domain/pushDelivery.ts` / `api/src/infra/push.ts` already takes.
 */
export function resolveChartTheme(read: CssVariableReader): ChartTheme {
  return {
    text: usable(read(CHART_THEME_ROLES.text.variable), CHART_THEME_ROLES.text.fallback),
    textMuted: usable(read(CHART_THEME_ROLES.textMuted.variable), CHART_THEME_ROLES.textMuted.fallback),
    axisLine: usable(read(CHART_THEME_ROLES.axisLine.variable), CHART_THEME_ROLES.axisLine.fallback),
    surface: usable(read(CHART_THEME_ROLES.surface.variable), CHART_THEME_ROLES.surface.fallback),
    surfaceBorder: usable(read(CHART_THEME_ROLES.surfaceBorder.variable), CHART_THEME_ROLES.surfaceBorder.fallback),
    series: CHART_SERIES_ROLES.map((role) => usable(read(role.variable), role.fallback)),
  };
}

/**
 * The reader for a real document, scoped to the element the chart sits in so a
 * Center's own Theme (written on a subtree) resolves rather than the gym's.
 *
 * Answers `''` for everything outside a browser, which is what makes the
 * fallbacks the server-rendered value — nothing here touches `document` at
 * module scope.
 */
export function cssVariableReader(element?: Element | null): CssVariableReader {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return () => '';
  }
  const target = element ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!target) return () => '';
  const computed = getComputedStyle(target);
  return (variable) => computed.getPropertyValue(variable);
}

/** The theme a chart takes when nothing has been applied — every role's fallback. */
export function defaultChartTheme(): ChartTheme {
  return resolveChartTheme(() => '');
}

/** §24 — the colour of the *n*th series, cycling rather than inventing one. */
export function seriesColor(theme: ChartTheme, index: number): string {
  const palette = theme.series.length > 0 ? theme.series : defaultChartTheme().series;
  const at = ((index % palette.length) + palette.length) % palette.length;
  return palette[at];
}
