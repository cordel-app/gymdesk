export interface ThemeTokenTypography {
  fontFamily: string;
  color: string;
}

export interface ThemeTokens {
  v: number;
  typography: {
    h1: ThemeTokenTypography;
    h2: ThemeTokenTypography;
    h3: ThemeTokenTypography;
    body: ThemeTokenTypography;
    small: ThemeTokenTypography;
  };
  colors: {
    // Application
    pageBackground: string;
    textColor: string; // "Primary Text Color" in the editor
    secondaryTextColor: string;
    mutedTextColor: string;
    sectionHeadingTextColor: string;
    cardBackground: string;
    cardBorder: string;
    separatorColor: string;
    inputBorderColor: string;
    inputBackgroundColor: string;
    // Header
    headerBackground: string;
    headerText: string;
    headerSeparatorColor: string;
    headerSeparatorHeight: number;
    // Sidebar
    sidebarBackground: string;
    sidebarText: string;
    sidebarSelectedItemBackground: string;
    sidebarSelectedItemText: string;
    sidebarHoverBackground: string;
    // Navigation
    dropdownBackground: string;
    dropdownText: string;
    dropdownHoverBackground: string;
    // Buttons
    primaryButton: string;
    primaryButtonText: string;
    secondaryButton: string;
    secondaryButtonText: string;
    // Status
    statusSuccess: string;
    statusWarning: string;
    statusError: string;
    statusInfo: string;
    // Links
    linkColor: string;
    linkHoverColor: string;
    // Calendar (#559 stages 1 & 3) — only the surfaces the admin Calendar
    // (FullCalendar: timeGridDay / timeGridWeek / dayGridMonth) actually
    // renders today. Deliberately absent: a now-indicator token, since
    // `nowIndicator` isn't enabled; and an empty-state color, since
    // dayGrid/timeGrid have no empty state.
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
    // Event colors (#559 stage 3). One background for every event: the booking
    // status is carried by the pill badge inside the event instead (#541 /
    // lib/calendarEventColors.ts), so it is still status — and only status —
    // that gives an event its color.
    calendarEventBackground: string;
    calendarEventBorder: string;
    calendarEventText: string;
    calendarNavButtonBackground: string;
    calendarNavButtonText: string;
  };
  advanced?: Record<string, string | number | boolean | null>;
}

export interface AdvancedAttribute {
  key: string;
  labelKey: string;
  group: string;
  type: 'text' | 'color' | 'select' | 'boolean';
  options?: string[];
}

export const DEFAULT_ADVANCED: Record<string, string | number | boolean> = {
  // Overlays
  modalBackground: '#f5f5f5',
  // Layout & Density
  contentMaxWidth: '1280px',
  pageHorizontalPadding: '24px',
  pageVerticalSpacing: '32px',
  sectionSpacing: '24px',
  componentSpacingScale: '1',
  uiDensity: 'comfortable',
  // Shape & Borders
  globalBorderRadius: '8px',
  cardBorderRadius: '8px',
  buttonBorderRadius: '6px',
  inputBorderRadius: '6px',
  modalBorderRadius: '12px',
  dropdownBorderRadius: '6px',
  defaultBorderWidth: '1px',
  // Shadows
  cardShadow: 'small',
  modalShadow: 'medium',
  dropdownShadow: 'small',
  popoverShadow: 'small',
  // Component Colors — Buttons
  primaryBtnHoverBg: '#5a52d5',
  primaryBtnActiveBg: '#4a42c0',
  secondaryBtnHoverBg: '#f0f0f0',
  disabledBtnBg: '#e5e7eb',
  disabledBtnText: '#9ca3af',
  // Component Colors — Forms
  inputFocusBorderColor: '#6c63ff',
  inputErrorBorderColor: '#dc2626',
  inputDisabledBg: '#f9fafb',
  // Feedback
  successBg: '#f0fdf4',
  warningBg: '#fffbeb',
  errorBg: '#fef2f2',
  infoBg: '#eff6ff',
  // Navigation — Sidebar
  sidebarWidth: '240px',
  sidebarItemHeight: '40px',
  sidebarItemSpacing: '2px',
  selectedItemRadius: '6px',
  // Navigation — Header
  headerHeight: '56px',
  headerSpacing: '16px',
  // Tables
  tableRowHeight: '48px',
  tableHeaderHeight: '40px',
  cellPadding: '12px',
  rowHoverBg: '#f9fafb',
  selectedRowBg: '#eff6ff',
  // Buttons
  buttonHeight: '36px',
  buttonHorizontalPadding: '16px',
  buttonFontWeight: '500',
  buttonTextTransform: 'none',
  // Forms
  inputHeight: '36px',
  inputHorizontalPadding: '12px',
  inputLabelSpacing: '6px',
  inputBorderWidth: '1px',
  focusRingWidth: '2px',
  // Animations
  animationsEnabled: true,
  transitionSpeed: 'normal',
  // Calendar (#559 stages 1 & 3) — defaults mirror FullCalendar's own built-in
  // values so an unconfigured theme keeps today's exact calendar appearance.
  // The exception is the event hover background (#559 stage 3): FullCalendar
  // has no event hover style of its own, so the default is the same purple the
  // events themselves default to, one step darker.
  calendarEventBorderRadius: '3px',
  calendarEventSelectedOverlay: '#000000',
  calendarEventHoverBackground: '#5a52d5',
  calendarSlotHeight: '1.5em',
  calendarNavButtonHoverBackground: '#1e2b37',
  calendarNavButtonBorderRadius: '4px',
};

// Per #489 stage 2 (remainder): these attributes no longer live under a
// standalone "Advanced" section. Each `group` below is one of the same
// section keys COLOR_GROUPS uses in the theme editor pages, so the editor
// renders a component's colors and its fine-grained attributes together.
export const ADVANCED_ATTRIBUTES: AdvancedAttribute[] = [
  // Application (global / not specific to one component)
  { key: 'modalBackground',         labelKey: 'adv_modal_bg',                group: 'group_application',     type: 'color' },
  { key: 'modalBorderRadius',       labelKey: 'adv_modal_radius',            group: 'group_application',     type: 'text' },
  { key: 'modalShadow',             labelKey: 'adv_modal_shadow',            group: 'group_application',     type: 'select', options: ['none', 'small', 'medium', 'large'] },
  { key: 'popoverShadow',           labelKey: 'adv_popover_shadow',          group: 'group_application',     type: 'select', options: ['none', 'small', 'medium', 'large'] },
  { key: 'uiDensity',               labelKey: 'adv_ui_density',              group: 'group_application',     type: 'select', options: ['compact', 'comfortable', 'spacious'] },
  { key: 'contentMaxWidth',         labelKey: 'adv_content_max_width',       group: 'group_application',     type: 'text' },
  { key: 'pageHorizontalPadding',   labelKey: 'adv_page_h_padding',          group: 'group_application',     type: 'text' },
  { key: 'pageVerticalSpacing',     labelKey: 'adv_page_v_spacing',          group: 'group_application',     type: 'text' },
  { key: 'sectionSpacing',          labelKey: 'adv_section_spacing',         group: 'group_application',     type: 'text' },
  { key: 'componentSpacingScale',   labelKey: 'adv_component_spacing',       group: 'group_application',     type: 'text' },
  { key: 'globalBorderRadius',      labelKey: 'adv_global_radius',           group: 'group_application',     type: 'text' },
  { key: 'defaultBorderWidth',      labelKey: 'adv_default_border_width',    group: 'group_application',     type: 'text' },
  { key: 'animationsEnabled',       labelKey: 'adv_animations_enabled',      group: 'group_application',     type: 'boolean' },
  { key: 'transitionSpeed',         labelKey: 'adv_transition_speed',        group: 'group_application',     type: 'select', options: ['fast', 'normal', 'slow'] },
  // Cards
  { key: 'cardBorderRadius',        labelKey: 'adv_card_radius',             group: 'group_cards',           type: 'text' },
  { key: 'cardShadow',              labelKey: 'adv_card_shadow',             group: 'group_cards',           type: 'select', options: ['none', 'small', 'medium', 'large'] },
  // Inputs
  { key: 'inputBorderRadius',       labelKey: 'adv_input_radius',            group: 'group_inputs',          type: 'text' },
  { key: 'inputFocusBorderColor',   labelKey: 'adv_input_focus_border',      group: 'group_inputs',          type: 'color' },
  { key: 'inputErrorBorderColor',   labelKey: 'adv_input_error_border',      group: 'group_inputs',          type: 'color' },
  { key: 'inputDisabledBg',         labelKey: 'adv_input_disabled_bg',       group: 'group_inputs',          type: 'color' },
  { key: 'inputHeight',             labelKey: 'adv_input_height',            group: 'group_inputs',          type: 'text' },
  { key: 'inputHorizontalPadding',  labelKey: 'adv_input_h_padding',         group: 'group_inputs',          type: 'text' },
  { key: 'inputLabelSpacing',       labelKey: 'adv_input_label_spacing',     group: 'group_inputs',          type: 'text' },
  { key: 'inputBorderWidth',        labelKey: 'adv_input_border_width',      group: 'group_inputs',          type: 'text' },
  { key: 'focusRingWidth',          labelKey: 'adv_focus_ring_width',        group: 'group_inputs',          type: 'text' },
  // Header
  { key: 'headerHeight',            labelKey: 'adv_header_height',           group: 'group_header',          type: 'text' },
  { key: 'headerSpacing',           labelKey: 'adv_header_spacing',          group: 'group_header',          type: 'text' },
  // Sidebar
  { key: 'sidebarWidth',            labelKey: 'adv_sidebar_width',           group: 'group_sidebar',         type: 'text' },
  { key: 'sidebarItemHeight',       labelKey: 'adv_sidebar_item_height',     group: 'group_sidebar',         type: 'text' },
  { key: 'sidebarItemSpacing',      labelKey: 'adv_sidebar_item_spacing',    group: 'group_sidebar',         type: 'text' },
  { key: 'selectedItemRadius',      labelKey: 'adv_selected_item_radius',    group: 'group_sidebar',         type: 'text' },
  // Navigation (dropdowns)
  { key: 'dropdownBorderRadius',    labelKey: 'adv_dropdown_radius',         group: 'group_navigation',      type: 'text' },
  { key: 'dropdownShadow',          labelKey: 'adv_dropdown_shadow',         group: 'group_navigation',      type: 'select', options: ['none', 'small', 'medium', 'large'] },
  // Buttons
  { key: 'buttonBorderRadius',      labelKey: 'adv_btn_radius',              group: 'group_buttons',         type: 'text' },
  { key: 'primaryBtnHoverBg',       labelKey: 'adv_primary_btn_hover_bg',    group: 'group_buttons',         type: 'color' },
  { key: 'primaryBtnActiveBg',      labelKey: 'adv_primary_btn_active_bg',   group: 'group_buttons',         type: 'color' },
  { key: 'secondaryBtnHoverBg',     labelKey: 'adv_secondary_btn_hover_bg',  group: 'group_buttons',         type: 'color' },
  { key: 'disabledBtnBg',           labelKey: 'adv_disabled_btn_bg',         group: 'group_buttons',         type: 'color' },
  { key: 'disabledBtnText',         labelKey: 'adv_disabled_btn_text',       group: 'group_buttons',         type: 'color' },
  { key: 'buttonHeight',            labelKey: 'adv_button_height',           group: 'group_buttons',         type: 'text' },
  { key: 'buttonHorizontalPadding', labelKey: 'adv_button_h_padding',        group: 'group_buttons',         type: 'text' },
  { key: 'buttonFontWeight',        labelKey: 'adv_button_font_weight',      group: 'group_buttons',         type: 'text' },
  { key: 'buttonTextTransform',     labelKey: 'adv_button_text_transform',   group: 'group_buttons',         type: 'select', options: ['none', 'uppercase', 'capitalize'] },
  // Status / feedback
  { key: 'successBg',               labelKey: 'adv_success_bg',              group: 'group_status',          type: 'color' },
  { key: 'warningBg',               labelKey: 'adv_warning_bg',              group: 'group_status',          type: 'color' },
  { key: 'errorBg',                 labelKey: 'adv_error_bg',                group: 'group_status',          type: 'color' },
  { key: 'infoBg',                  labelKey: 'adv_info_bg',                 group: 'group_status',          type: 'color' },
  // Tables
  { key: 'tableRowHeight',          labelKey: 'adv_table_row_height',        group: 'group_tables',          type: 'text' },
  { key: 'tableHeaderHeight',       labelKey: 'adv_table_header_height',     group: 'group_tables',          type: 'text' },
  { key: 'cellPadding',             labelKey: 'adv_cell_padding',            group: 'group_tables',          type: 'text' },
  { key: 'rowHoverBg',              labelKey: 'adv_row_hover_bg',            group: 'group_tables',          type: 'color' },
  { key: 'selectedRowBg',           labelKey: 'adv_selected_row_bg',         group: 'group_tables',          type: 'color' },
  // Calendar (#559 stages 1 & 3)
  { key: 'calendarEventBorderRadius',      labelKey: 'adv_calendar_event_radius',          group: 'group_calendar', type: 'text' },
  { key: 'calendarEventSelectedOverlay',   labelKey: 'adv_calendar_event_selected_overlay', group: 'group_calendar', type: 'color' },
  { key: 'calendarEventHoverBackground',   labelKey: 'adv_calendar_event_hover_bg',        group: 'group_calendar', type: 'color' },
  { key: 'calendarSlotHeight',             labelKey: 'adv_calendar_slot_height',           group: 'group_calendar', type: 'text' },
  { key: 'calendarNavButtonHoverBackground', labelKey: 'adv_calendar_nav_btn_hover_bg',    group: 'group_calendar', type: 'color' },
  { key: 'calendarNavButtonBorderRadius',  labelKey: 'adv_calendar_nav_btn_radius',        group: 'group_calendar', type: 'text' },
];

// #559 stage 2 — token key → CSS variable name. One list, consumed by
// applyTokens() below, by the FullCalendar override sheet
// (components/CalendarThemeStyles.tsx) and by the tests, so the three can't
// drift apart. Mirrored in apps/member/src/lib/themeTokens.ts.
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
  calendarEventBackground:        '--gd-calendar-event-bg',
  calendarEventBorder:            '--gd-calendar-event-border',
  calendarEventText:              '--gd-calendar-event-text',
  calendarNavButtonBackground:    '--gd-calendar-nav-btn-bg',
  calendarNavButtonText:          '--gd-calendar-nav-btn-text',
};

export const CALENDAR_ADVANCED_VARS: Record<string, string> = {
  calendarEventBorderRadius:        '--gd-calendar-event-radius',
  calendarEventSelectedOverlay:     '--gd-calendar-event-selected-overlay',
  calendarEventHoverBackground:     '--gd-calendar-event-hover-bg',
  calendarSlotHeight:               '--gd-calendar-slot-height',
  calendarNavButtonHoverBackground: '--gd-calendar-nav-btn-hover-bg',
  calendarNavButtonBorderRadius:    '--gd-calendar-nav-btn-radius',
};

// #559 stage 4 — which calendar `advanced` attributes hold a color rather than
// a CSS length. Derived from ADVANCED_ATTRIBUTES so the two can't drift.
export const CALENDAR_ADVANCED_COLOR_KEYS = new Set(
  ADVANCED_ATTRIBUTES.filter((a) => a.group === 'group_calendar' && a.type === 'color').map((a) => a.key),
);

// Mirrors `HEX_RE` in api/src/domain/themeTokens.ts — the format the color
// pickers emit and the API validates on write.
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

/**
 * #559 stage 4 — the value to write for one `--gd-calendar-*` variable,
 * falling back to the default when the persisted one is missing *or unusable*.
 *
 * `??` alone only covers missing. An unusable value has to be caught here too:
 * a custom property holding e.g. `""` or `"blue-ish"` is not invalid CSS by
 * itself, so `var(--gd-calendar-event-bg, #6c63ff)` does *not* fall back to
 * its literal — the declaration using it becomes invalid at computed-value
 * time and the property lands on `inherit`/`initial` instead, which is how a
 * single bad token turns a calendar surface transparent. `validateTokens()`
 * rejects a bad calendar *color* on write, but the `advanced` map is not
 * format-checked, and a row written before #559 stage 1 (or edited straight in
 * the DB) never went through that check at all.
 */
export function calendarVarValue(
  key: string,
  raw: unknown,
  fallback: string | number | boolean,
): string {
  if (key in CALENDAR_COLOR_VARS || CALENDAR_ADVANCED_COLOR_KEYS.has(key)) {
    return isHexColor(raw) ? raw : String(fallback);
  }
  // A length (`3px`, `1.5em`). Not parsed further — anything CSS rejects is
  // dropped by the browser and the rule's own `var()` literal takes over.
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : String(fallback);
}

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
    pageBackground:               '#f5f5f5',
    textColor:                    '#111827',
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
    calendarBackground:           '#ffffff',
    calendarSurfaceBackground:    '#ffffff',
    calendarHeaderBackground:     '#ffffff',
    calendarHeaderText:           '#111827',
    calendarDayText:              '#111827',
    calendarMutedDayText:         '#6b7280',
    calendarTodayBackground:      '#fffbe6',
    calendarSelectionBackground:  '#e8f6f9',
    calendarGridBorder:           '#dddddd',
    calendarTimeAxisBackground:   '#ffffff',
    calendarTimeAxisText:         '#6b7280',
    calendarWeekendBackground:    '#ffffff',
    calendarDisabledSlotBackground: '#f7f7f7',
    // #559 stage 3 — the purple every `scheduled` event was painted with
    // before this stage, so the calendar an admin sees on day one is the one
    // they saw before (scheduled is by far the most common status).
    calendarEventBackground:      '#6c63ff',
    calendarEventBorder:          '#6c63ff',
    calendarEventText:            '#ffffff',
    calendarNavButtonBackground:  '#2c3e50',
    calendarNavButtonText:        '#ffffff',
  },
};

export const FONT_STACKS: { label: string; value: string }[] = [
  { label: 'System UI',      value: 'system-ui, -apple-system, sans-serif' },
  { label: 'Georgia (Serif)', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono',           value: '"Courier New", Courier, monospace' },
  { label: 'Arial',          value: 'Arial, Helvetica, sans-serif' },
  { label: 'Trebuchet',      value: '"Trebuchet MS", sans-serif' },
];

// Draft/live-preview support for the Theme editors (#492): compares a draft
// against the last-persisted tokens to drive the Save/Cancel dirty state.
export function tokensEqual(a: ThemeTokens, b: ThemeTokens): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The tokens actually painting the current app chrome right now — same
// resolution order as ThemeProvider (center theme > gym theme > defaults).
// Used to restore the real CSS variables when a Theme editor's live preview
// is cancelled or finishes, regardless of which theme was being edited.
export function getLiveTokens(
  activeGymThemeTokens: ThemeTokens | null | undefined,
  centers: { id: number; theme_tokens: Record<string, any> | null }[],
  activeCenterId: number | null,
): ThemeTokens {
  const activeCenter = centers.find((c) => c.id === (activeCenterId ?? (centers.length === 1 ? centers[0].id : null)));
  return ((activeCenter?.theme_tokens ?? activeGymThemeTokens) ?? DEFAULT_TOKENS) as ThemeTokens;
}

export function applyTokens(tokens: ThemeTokens) {
  const el = document.documentElement;
  const c = tokens.colors;
  const ty = tokens.typography;

  // Application
  el.style.setProperty('--gd-app-bg',               c.pageBackground);
  el.style.setProperty('--gd-text',                 c.textColor);
  // Fall back to defaults for themes persisted before #489 stage 2 added these fields.
  el.style.setProperty('--gd-text-secondary',       c.secondaryTextColor ?? DEFAULT_TOKENS.colors.secondaryTextColor);
  el.style.setProperty('--gd-text-muted',           c.mutedTextColor ?? DEFAULT_TOKENS.colors.mutedTextColor);
  el.style.setProperty('--gd-section-heading-text', c.sectionHeadingTextColor ?? DEFAULT_TOKENS.colors.sectionHeadingTextColor);
  el.style.setProperty('--gd-card-bg',              c.cardBackground);
  el.style.setProperty('--gd-card-border',          c.cardBorder);
  el.style.setProperty('--gd-border',               c.separatorColor ?? DEFAULT_TOKENS.colors.separatorColor);
  el.style.setProperty('--gd-input-border',         c.inputBorderColor ?? DEFAULT_TOKENS.colors.inputBorderColor);
  el.style.setProperty('--gd-input-bg',             c.inputBackgroundColor ?? DEFAULT_TOKENS.colors.inputBackgroundColor);
  // Header
  el.style.setProperty('--gd-header-bg',            c.headerBackground);
  el.style.setProperty('--gd-header-text',          c.headerText);
  el.style.setProperty('--gd-header-sep-color',     c.headerSeparatorColor);
  el.style.setProperty('--gd-header-sep-height',    `${c.headerSeparatorHeight}px`);
  // Sidebar
  el.style.setProperty('--gd-sidebar-bg',           c.sidebarBackground);
  el.style.setProperty('--gd-sidebar-text',         c.sidebarText);
  el.style.setProperty('--gd-sidebar-selected-bg',  c.sidebarSelectedItemBackground);
  el.style.setProperty('--gd-sidebar-selected-text',c.sidebarSelectedItemText);
  el.style.setProperty('--gd-sidebar-hover-bg',     c.sidebarHoverBackground);
  // Navigation
  el.style.setProperty('--gd-dropdown-bg',          c.dropdownBackground);
  el.style.setProperty('--gd-dropdown-text',        c.dropdownText);
  el.style.setProperty('--gd-dropdown-hover-bg',    c.dropdownHoverBackground);
  // Buttons
  el.style.setProperty('--gd-primary-btn',          c.primaryButton);
  el.style.setProperty('--gd-primary-btn-text',     c.primaryButtonText);
  el.style.setProperty('--gd-secondary-btn',        c.secondaryButton);
  el.style.setProperty('--gd-secondary-btn-text',   c.secondaryButtonText);
  // Status
  el.style.setProperty('--gd-status-success',       c.statusSuccess);
  el.style.setProperty('--gd-status-warning',       c.statusWarning);
  el.style.setProperty('--gd-status-error',         c.statusError);
  el.style.setProperty('--gd-status-info',          c.statusInfo);
  // Links
  el.style.setProperty('--gd-link',                 c.linkColor);
  el.style.setProperty('--gd-link-hover',           c.linkHoverColor);
  // Calendar (#559 stages 2 & 3) — read by the FullCalendar override sheet in
  // components/CalendarThemeStyles.tsx. Every key falls back to its default,
  // so themes saved before #559 (which carry no calendar values at all) still
  // get the full variable set, holding FullCalendar's own built-in appearance;
  // since #559 stage 4 an unusable persisted value falls back the same way.
  const adv = tokens.advanced ?? {};
  for (const [key, cssVar] of Object.entries(CALENDAR_COLOR_VARS)) {
    const fallback = (DEFAULT_TOKENS.colors as Record<string, string | number>)[key];
    el.style.setProperty(cssVar, calendarVarValue(key, (c as Record<string, unknown>)[key], fallback));
  }
  for (const [key, cssVar] of Object.entries(CALENDAR_ADVANCED_VARS)) {
    el.style.setProperty(cssVar, calendarVarValue(key, adv[key], DEFAULT_ADVANCED[key]));
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
