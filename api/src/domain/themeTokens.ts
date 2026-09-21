// Shared by `api/src/api/themes.ts` (superadmin base themes) and
// `api/src/api/gym-themes.ts` (gym-admin customer themes) — both routers
// operate on the same `tokens` JSON shape and previously duplicated this
// validation verbatim.

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const FONT_STACKS = [
  'system-ui, -apple-system, sans-serif',
  'Georgia, "Times New Roman", serif',
  '"Courier New", Courier, monospace',
  'Arial, Helvetica, sans-serif',
  '"Trebuchet MS", sans-serif',
];

export function defaultTokens() {
  return {
    v: 2,
    typography: {
      h1:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' },
      h2:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' },
      h3:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#374151' },
      body:  { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#374151' },
      small: { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#6b7280' },
    },
    colors: {
      pageBackground:               '#f5f5f5',
      textColor:                    '#111827', // "Primary Text Color" in the editor — same field, relabeled per #489 §19 (alias, not a new column)
      secondaryTextColor:           '#374151',
      mutedTextColor:               '#6b7280',
      sectionHeadingTextColor:      '#888888',
      cardBackground:               '#ffffff',
      cardBorder:                   '#e5e7eb',
      separatorColor:               '#e5e7eb',
      inputBorderColor:             '#d1d5db',
      inputBackgroundColor:         '#ffffff',
      headerBackground:             '#1a1a2e',
      headerText:                   '#ffffff',
      headerSeparatorColor:         '#6c63ff',
      headerSeparatorHeight:        2,
      sidebarBackground:            '#1a1a2e',
      sidebarText:                  '#e5e7eb',
      sidebarSelectedItemBackground:'#6c63ff',
      sidebarSelectedItemText:      '#ffffff',
      sidebarHoverBackground:       '#2d2d4a',
      dropdownBackground:           '#ffffff',
      dropdownText:                 '#111827',
      dropdownHoverBackground:      '#f5f5f5',
      primaryButton:                '#6c63ff',
      primaryButtonText:            '#ffffff',
      secondaryButton:              '#ffffff',
      secondaryButtonText:          '#374151',
      statusSuccess:                '#059669',
      statusWarning:                '#d97706',
      statusError:                  '#dc2626',
      statusInfo:                   '#2563eb',
      linkColor:                    '#6c63ff',
      linkHoverColor:               '#5a52d5',
      // Calendar (#559 stages 1 & 3). Values mirror FullCalendar's own
      // built-in defaults so an unconfigured theme keeps today's calendar
      // appearance — except the event colors (stage 3), which default to the
      // purple every `scheduled` event was painted with before.
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
      calendarEventBackground:        '#6c63ff',
      calendarEventBorder:            '#6c63ff',
      calendarEventText:              '#ffffff',
      calendarNavButtonBackground:    '#2c3e50',
      calendarNavButtonText:          '#ffffff',
    },
  };
}

// Kept as a named export so the editor, the validator and the tests all agree
// on exactly which calendar color tokens exist (#559 stages 1 & 3).
export const CALENDAR_COLOR_FIELDS = [
  'calendarBackground', 'calendarSurfaceBackground',
  'calendarHeaderBackground', 'calendarHeaderText',
  'calendarDayText', 'calendarMutedDayText',
  'calendarTodayBackground', 'calendarSelectionBackground',
  'calendarGridBorder',
  'calendarTimeAxisBackground', 'calendarTimeAxisText',
  'calendarWeekendBackground', 'calendarDisabledSlotBackground',
  'calendarEventBackground', 'calendarEventBorder', 'calendarEventText',
  'calendarNavButtonBackground', 'calendarNavButtonText',
];

export function validateTokens(tokens: any): string | null {
  if (!tokens || typeof tokens !== 'object') return 'tokens must be an object';
  const { colors, typography } = tokens;
  if (colors) {
    const hexFields = [
      'pageBackground', 'textColor', 'secondaryTextColor', 'mutedTextColor', 'sectionHeadingTextColor',
      'cardBackground', 'cardBorder', 'separatorColor',
      'inputBorderColor', 'inputBackgroundColor',
      'headerBackground', 'headerText', 'headerSeparatorColor',
      'sidebarBackground', 'sidebarText',
      'sidebarSelectedItemBackground', 'sidebarSelectedItemText', 'sidebarHoverBackground',
      'dropdownBackground', 'dropdownText', 'dropdownHoverBackground',
      'primaryButton', 'primaryButtonText', 'secondaryButton', 'secondaryButtonText',
      'statusSuccess', 'statusWarning', 'statusError', 'statusInfo',
      'linkColor', 'linkHoverColor',
      ...CALENDAR_COLOR_FIELDS,
    ];
    for (const f of hexFields) {
      if (colors[f] !== undefined && !HEX_RE.test(colors[f])) return `colors.${f} must be a hex color like #rrggbb`;
    }
    if (colors.headerSeparatorHeight !== undefined) {
      const h = Number(colors.headerSeparatorHeight);
      if (!Number.isInteger(h) || h < 0 || h > 20) return 'colors.headerSeparatorHeight must be an integer 0–20';
    }
  }
  if (typography) {
    const levels = ['h1','h2','h3','body','small'];
    for (const lv of levels) {
      if (!typography[lv]) continue;
      const { fontFamily, color } = typography[lv];
      if (fontFamily !== undefined && !FONT_STACKS.includes(fontFamily)) return `typography.${lv}.fontFamily must be one of the allowed stacks`;
      if (color !== undefined && !HEX_RE.test(color)) return `typography.${lv}.color must be a hex color`;
    }
  }
  return null;
}
