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
];

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
  },
};

export const FONT_STACKS: { label: string; value: string }[] = [
  { label: 'System UI',      value: 'system-ui, -apple-system, sans-serif' },
  { label: 'Georgia (Serif)', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono',           value: '"Courier New", Courier, monospace' },
  { label: 'Arial',          value: 'Arial, Helvetica, sans-serif' },
  { label: 'Trebuchet',      value: '"Trebuchet MS", sans-serif' },
];

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
