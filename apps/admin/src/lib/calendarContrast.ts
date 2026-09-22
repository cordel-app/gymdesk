import {
  CALENDAR_COLOR_VARS,
  DEFAULT_ADVANCED,
  DEFAULT_TOKENS,
  isHexColor,
  type ThemeTokens,
} from '@/lib/themeTokens';

/**
 * #559 stage 4 — the contrast half of the ticket's accessibility requirement
 * ("Ensure configured colors remain readable and provide sufficient contrast
 * against their backgrounds").
 *
 * The Calendar section lets an admin pick a foreground and the surface behind
 * it independently, so nothing stops a combination that can't be read. This
 * module states which calendar tokens are actually rendered on top of which
 * (`CALENDAR_CONTRAST_PAIRS`) and scores each pair with the WCAG 2.1 contrast
 * formula, so the theme editors can report it back while the admin is picking
 * colors (`components/ThemeTokensEditor.tsx`).
 *
 * The report is advisory, never a save blocker: a theme is the customer's own
 * branding, and `validateTokens()` on the API side stays a pure format check.
 */

/** WCAG 2.1 §1.4.3 (AA) — body text against its background. */
export const AA_TEXT_RATIO = 4.5;
/** WCAG 2.1 §1.4.11 (AA) — a UI component's boundary against what's behind it. */
export const AA_NON_TEXT_RATIO = 3;

export interface CalendarContrastPair {
  /** Stable id — used as the React key and in test failure messages. */
  id: string;
  /** Token key of the thing drawn on top (a calendar color or `advanced` entry). */
  fg: string;
  /** Token key of the surface it is drawn on. */
  bg: string;
  minRatio: number;
}

/**
 * Every calendar combination the eye actually has to separate, as the
 * stylesheet paints them (`components/CalendarThemeStyles.tsx`).
 *
 * Deliberately absent: `calendarGridBorder` and `calendarDisabledSlotBackground`
 * against the surface. Both are decorative boundaries rather than "graphical
 * objects needed to understand the content" — every cell's meaning is carried
 * by the date and event text inside it — and FullCalendar's own defaults sit at
 * 1.4:1 and 1.1:1, so scoring them would mean reporting the stock calendar (and
 * every calendar that keeps a conventional hairline grid) as a failure.
 */
export const CALENDAR_CONTRAST_PAIRS: CalendarContrastPair[] = [
  { id: 'header_text',        fg: 'calendarHeaderText',      bg: 'calendarHeaderBackground',        minRatio: AA_TEXT_RATIO },
  { id: 'day_text',           fg: 'calendarDayText',         bg: 'calendarSurfaceBackground',       minRatio: AA_TEXT_RATIO },
  { id: 'muted_day_text',     fg: 'calendarMutedDayText',    bg: 'calendarSurfaceBackground',       minRatio: AA_TEXT_RATIO },
  { id: 'day_text_today',     fg: 'calendarDayText',         bg: 'calendarTodayBackground',         minRatio: AA_TEXT_RATIO },
  { id: 'day_text_weekend',   fg: 'calendarDayText',         bg: 'calendarWeekendBackground',       minRatio: AA_TEXT_RATIO },
  { id: 'day_text_selection', fg: 'calendarDayText',         bg: 'calendarSelectionBackground',     minRatio: AA_TEXT_RATIO },
  { id: 'time_axis_text',     fg: 'calendarTimeAxisText',    bg: 'calendarTimeAxisBackground',      minRatio: AA_TEXT_RATIO },
  { id: 'event_text',         fg: 'calendarEventText',       bg: 'calendarEventBackground',         minRatio: AA_TEXT_RATIO },
  { id: 'event_text_hover',   fg: 'calendarEventText',       bg: 'calendarEventHoverBackground',    minRatio: AA_TEXT_RATIO },
  { id: 'nav_btn_text',       fg: 'calendarNavButtonText',   bg: 'calendarNavButtonBackground',     minRatio: AA_TEXT_RATIO },
  { id: 'nav_btn_text_hover', fg: 'calendarNavButtonText',   bg: 'calendarNavButtonHoverBackground', minRatio: AA_TEXT_RATIO },
  // The event box against the grid behind it — a UI component boundary, so the
  // lower 3:1 bar. Without it an event painted the surface color would vanish.
  { id: 'event_surface',      fg: 'calendarEventBackground', bg: 'calendarSurfaceBackground',       minRatio: AA_NON_TEXT_RATIO },
];

/** WCAG 2.1 relative luminance of an `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
  const channel = (byte: number) => {
    const c = byte / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` colors — 1 (identical) to 21 (black/white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The color a calendar token actually resolves to — the same order
 * `applyTokens()` uses, so the report scores what the calendar will paint:
 * the configured value when it is a usable color, the default otherwise
 * (missing on a pre-#559 theme, or invalid).
 */
export function resolveCalendarColor(tokens: ThemeTokens, key: string): string {
  const isColorToken = key in CALENDAR_COLOR_VARS;
  const raw = isColorToken
    ? (tokens.colors as Record<string, unknown>)[key]
    : (tokens.advanced ?? {})[key];
  if (isHexColor(raw)) return raw;
  return String(isColorToken
    ? (DEFAULT_TOKENS.colors as Record<string, unknown>)[key]
    : DEFAULT_ADVANCED[key]);
}

export interface CalendarContrastResult {
  pair: CalendarContrastPair;
  fgColor: string;
  bgColor: string;
  /** Rounded to 2 decimals — the same number the editor shows. */
  ratio: number;
  passes: boolean;
}

/** Scores every pair in `CALENDAR_CONTRAST_PAIRS` against a theme's tokens. */
export function checkCalendarContrast(tokens: ThemeTokens): CalendarContrastResult[] {
  return CALENDAR_CONTRAST_PAIRS.map((pair) => {
    const fgColor = resolveCalendarColor(tokens, pair.fg);
    const bgColor = resolveCalendarColor(tokens, pair.bg);
    const ratio = Math.round(contrastRatio(fgColor, bgColor) * 100) / 100;
    return { pair, fgColor, bgColor, ratio, passes: ratio >= pair.minRatio };
  });
}
