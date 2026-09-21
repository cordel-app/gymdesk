// Default token values and CSS variable wiring kept in sync with
// apps/admin/src/lib/themeTokens.ts (source of truth for the shape of
// `tokens` persisted on `themes.tokens`). Member Web only reads/applies
// tokens — it never edits them — so this file omits the admin-only
// draft/live-preview helpers (`tokensEqual`, `getLiveTokens`).
export interface ThemeTokens {
  v: number;
  typography: {
    h1: { fontFamily: string; color: string };
    h2: { fontFamily: string; color: string };
    h3: { fontFamily: string; color: string };
    body: { fontFamily: string; color: string };
    small: { fontFamily: string; color: string };
  };
  colors: {
    pageBackground: string;
    textColor: string;
    secondaryTextColor: string;
    mutedTextColor: string;
    sectionHeadingTextColor: string;
    cardBackground: string;
    cardBorder: string;
    separatorColor: string;
    inputBorderColor: string;
    inputBackgroundColor: string;
    headerBackground: string;
    headerText: string;
    headerSeparatorColor: string;
    headerSeparatorHeight: number;
    sidebarBackground: string;
    sidebarText: string;
    sidebarSelectedItemBackground: string;
    sidebarSelectedItemText: string;
    sidebarHoverBackground: string;
    dropdownBackground: string;
    dropdownText: string;
    dropdownHoverBackground: string;
    primaryButton: string;
    primaryButtonText: string;
    secondaryButton: string;
    secondaryButtonText: string;
    statusSuccess: string;
    statusWarning: string;
    statusError: string;
    statusInfo: string;
    linkColor: string;
    linkHoverColor: string;
    // Calendar (#559). Member Web renders the same FullCalendar views as
    // Admin off the same theme, so it reads the same tokens; they are only
    // ever edited in the Admin theme editors.
    calendarBackground: string;
    calendarSurfaceBackground: string;
    calendarHeaderBackground: string;
    calendarHeaderText: string;
    calendarDayText: string;
    calendarMutedDayText: string;
    calendarTodayBackground: string;
    calendarSelectionBackground: string;
    calendarGridBorder: string;
    calendarTimeAxisBackground: string;
    calendarTimeAxisText: string;
    calendarWeekendBackground: string;
    calendarDisabledSlotBackground: string;
    calendarEventText: string;
    calendarNavButtonBackground: string;
    calendarNavButtonText: string;
  };
  advanced?: Record<string, string | number | boolean | null>;
}

// Mirrors apps/admin/src/lib/themeTokens.ts — the calendar `advanced` defaults
// Admin's editor writes, needed here so an unconfigured theme still resolves
// every --gd-calendar-* variable.
export const DEFAULT_CALENDAR_ADVANCED: Record<string, string> = {
  calendarEventBorderRadius:        '3px',
  calendarEventSelectedOverlay:     '#000000',
  calendarSlotHeight:               '1.5em',
  calendarNavButtonHoverBackground: '#1e2b37',
  calendarNavButtonBorderRadius:    '4px',
};

export const CALENDAR_COLOR_VARS: Record<string, string> = {
  calendarBackground:             '--gd-calendar-bg',
  calendarSurfaceBackground:      '--gd-calendar-surface-bg',
  calendarHeaderBackground:       '--gd-calendar-header-bg',
  calendarHeaderText:             '--gd-calendar-header-text',
  calendarDayText:                '--gd-calendar-day-text',
  calendarMutedDayText:           '--gd-calendar-muted-day-text',
  calendarTodayBackground:        '--gd-calendar-today-bg',
  calendarSelectionBackground:    '--gd-calendar-selection-bg',
  calendarGridBorder:             '--gd-calendar-grid-border',
  calendarTimeAxisBackground:     '--gd-calendar-time-axis-bg',
  calendarTimeAxisText:           '--gd-calendar-time-axis-text',
  calendarWeekendBackground:      '--gd-calendar-weekend-bg',
  calendarDisabledSlotBackground: '--gd-calendar-disabled-slot-bg',
  calendarEventText:              '--gd-calendar-event-text',
  calendarNavButtonBackground:    '--gd-calendar-nav-btn-bg',
  calendarNavButtonText:          '--gd-calendar-nav-btn-text',
};

export const CALENDAR_ADVANCED_VARS: Record<string, string> = {
  calendarEventBorderRadius:        '--gd-calendar-event-radius',
  calendarEventSelectedOverlay:     '--gd-calendar-event-selected-overlay',
  calendarSlotHeight:               '--gd-calendar-slot-height',
  calendarNavButtonHoverBackground: '--gd-calendar-nav-btn-hover-bg',
  calendarNavButtonBorderRadius:    '--gd-calendar-nav-btn-radius',
};

export const DEFAULT_TOKENS: ThemeTokens = {
  v: 2,
  typography: {
    h1:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' },
    h2:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' },
    h3:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#374151' },
    body:  { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#374151' },
    small: { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#6b7280' },
  },
  colors: {
    pageBackground:                '#f5f5f5',
    textColor:                     '#111827',
    secondaryTextColor:            '#374151',
    mutedTextColor:                '#6b7280',
    sectionHeadingTextColor:       '#888888',
    cardBackground:                '#ffffff',
    cardBorder:                    '#e5e7eb',
    separatorColor:                '#e5e7eb',
    inputBorderColor:              '#d1d5db',
    inputBackgroundColor:          '#ffffff',
    headerBackground:              '#1a1a2e',
    headerText:                    '#ffffff',
    headerSeparatorColor:          '#6c63ff',
    headerSeparatorHeight:         2,
    sidebarBackground:             '#1a1a2e',
    sidebarText:                   '#e5e7eb',
    sidebarSelectedItemBackground: '#6c63ff',
    sidebarSelectedItemText:       '#ffffff',
    sidebarHoverBackground:        '#2d2d4a',
    dropdownBackground:            '#ffffff',
    dropdownText:                  '#111827',
    dropdownHoverBackground:       '#f5f5f5',
    primaryButton:                 '#6c63ff',
    primaryButtonText:             '#ffffff',
    secondaryButton:               '#ffffff',
    secondaryButtonText:           '#374151',
    statusSuccess:                 '#059669',
    statusWarning:                 '#d97706',
    statusError:                   '#dc2626',
    statusInfo:                    '#2563eb',
    linkColor:                     '#6c63ff',
    linkHoverColor:                '#5a52d5',
    calendarBackground:             '#ffffff',
    calendarSurfaceBackground:      '#ffffff',
    calendarHeaderBackground:       '#ffffff',
    calendarHeaderText:             '#111827',
    calendarDayText:                '#111827',
    calendarMutedDayText:           '#6b7280',
    calendarTodayBackground:        '#fffbe6',
    calendarSelectionBackground:    '#e8f6f9',
    calendarGridBorder:             '#dddddd',
    calendarTimeAxisBackground:     '#ffffff',
    calendarTimeAxisText:           '#6b7280',
    calendarWeekendBackground:      '#ffffff',
    calendarDisabledSlotBackground: '#f7f7f7',
    calendarEventText:              '#ffffff',
    calendarNavButtonBackground:    '#2c3e50',
    calendarNavButtonText:          '#ffffff',
  },
};

// Same var set + fallback behavior as apps/admin/src/lib/themeTokens.ts's
// applyTokens(), so Member Web's shared components (which already reference
// these `--gd-*` names, e.g. TopBar, GymSwitcher, calendar) render themed
// values instead of silently falling back to their hardcoded defaults.
export function applyTokens(tokens: ThemeTokens) {
  const el = document.documentElement;
  const c = tokens.colors;
  const ty = tokens.typography;

  // Application
  el.style.setProperty('--gd-app-bg',                c.pageBackground);
  el.style.setProperty('--gd-text',                  c.textColor);
  el.style.setProperty('--gd-text-secondary',        c.secondaryTextColor ?? DEFAULT_TOKENS.colors.secondaryTextColor);
  el.style.setProperty('--gd-text-muted',            c.mutedTextColor ?? DEFAULT_TOKENS.colors.mutedTextColor);
  el.style.setProperty('--gd-section-heading-text',  c.sectionHeadingTextColor ?? DEFAULT_TOKENS.colors.sectionHeadingTextColor);
  el.style.setProperty('--gd-card-bg',               c.cardBackground);
  el.style.setProperty('--gd-card-border',           c.cardBorder);
  el.style.setProperty('--gd-border',                c.separatorColor ?? DEFAULT_TOKENS.colors.separatorColor);
  el.style.setProperty('--gd-input-border',          c.inputBorderColor ?? DEFAULT_TOKENS.colors.inputBorderColor);
  el.style.setProperty('--gd-input-bg',              c.inputBackgroundColor ?? DEFAULT_TOKENS.colors.inputBackgroundColor);
  // Header
  el.style.setProperty('--gd-header-bg',             c.headerBackground);
  el.style.setProperty('--gd-header-text',           c.headerText);
  el.style.setProperty('--gd-header-sep-color',      c.headerSeparatorColor);
  el.style.setProperty('--gd-header-sep-height',     `${c.headerSeparatorHeight}px`);
  // Sidebar
  el.style.setProperty('--gd-sidebar-bg',            c.sidebarBackground);
  el.style.setProperty('--gd-sidebar-text',          c.sidebarText);
  el.style.setProperty('--gd-sidebar-selected-bg',   c.sidebarSelectedItemBackground);
  el.style.setProperty('--gd-sidebar-selected-text', c.sidebarSelectedItemText);
  el.style.setProperty('--gd-sidebar-hover-bg',      c.sidebarHoverBackground);
  // Navigation
  el.style.setProperty('--gd-dropdown-bg',           c.dropdownBackground);
  el.style.setProperty('--gd-dropdown-text',         c.dropdownText);
  el.style.setProperty('--gd-dropdown-hover-bg',     c.dropdownHoverBackground);
  // Buttons
  el.style.setProperty('--gd-primary-btn',           c.primaryButton);
  el.style.setProperty('--gd-primary-btn-text',      c.primaryButtonText);
  el.style.setProperty('--gd-secondary-btn',         c.secondaryButton);
  el.style.setProperty('--gd-secondary-btn-text',    c.secondaryButtonText);
  // Status
  el.style.setProperty('--gd-status-success',        c.statusSuccess);
  el.style.setProperty('--gd-status-warning',        c.statusWarning);
  el.style.setProperty('--gd-status-error',          c.statusError);
  el.style.setProperty('--gd-status-info',           c.statusInfo);
  // Links
  el.style.setProperty('--gd-link',                  c.linkColor);
  el.style.setProperty('--gd-link-hover',            c.linkHoverColor);
  // Calendar (#559 stage 2) — read by components/CalendarThemeStyles.tsx.
  // Themes saved before #559 carry no calendar values, so every key falls back
  // to its default (FullCalendar's own built-in appearance).
  const adv = tokens.advanced ?? {};
  for (const [key, cssVar] of Object.entries(CALENDAR_COLOR_VARS)) {
    const value = (c as Record<string, unknown>)[key] ?? (DEFAULT_TOKENS.colors as Record<string, unknown>)[key];
    el.style.setProperty(cssVar, String(value));
  }
  for (const [key, cssVar] of Object.entries(CALENDAR_ADVANCED_VARS)) {
    el.style.setProperty(cssVar, String(adv[key] ?? DEFAULT_CALENDAR_ADVANCED[key]));
  }

  // Typography
  el.style.setProperty('--gd-font-h1',    ty.h1.fontFamily);
  el.style.setProperty('--gd-color-h1',   ty.h1.color);
  el.style.setProperty('--gd-font-h2',    ty.h2.fontFamily);
  el.style.setProperty('--gd-color-h2',   ty.h2.color);
  el.style.setProperty('--gd-font-h3',    ty.h3.fontFamily);
  el.style.setProperty('--gd-color-h3',   ty.h3.color);
  el.style.setProperty('--gd-font-body',  ty.body.fontFamily);
  el.style.setProperty('--gd-color-body', ty.body.color);
  el.style.setProperty('--gd-font-small', ty.small.fontFamily);
  el.style.setProperty('--gd-color-small',ty.small.color);

  // Legacy aliases — keep during rollout so existing chrome components continue to work.
  el.style.setProperty('--brand',  c.sidebarSelectedItemBackground);
  el.style.setProperty('--chrome', c.headerBackground);
  el.style.setProperty('--accent', c.headerSeparatorColor);
}
