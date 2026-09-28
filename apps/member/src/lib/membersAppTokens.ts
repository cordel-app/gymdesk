// #833 — the Members App's own visual settings, as this app resolves them.
//
// Mirror of apps/admin/src/lib/membersAppTokens.ts, which is the source of
// truth for the mapping (§8) and the only place it is decided; Member Web
// never edits a Theme, so this copy holds the resolution and nothing else. A
// test (test/members-app-theme-vars.test.ts) fails if the two drift on a key,
// a type, a source or a CSS variable.
//
// The rule both copies implement: an override in `tokens.membersApp` wins,
// otherwise the setting follows the current value of its Admin source (§18).
// Inheritance is therefore dynamic — an Admin setting edited later moves every
// Members App setting still inherited from it, because nothing was copied into
// the Theme when it was created (§13).
import { DEFAULT_TOKENS, isHexColor, type ThemeTokens } from './themeTokens';

export type MembersAppSettingType = 'color' | 'font' | 'length' | 'pixels';

export type MembersAppSource =
  | { kind: 'color'; key: string; labelKey: string }
  | { kind: 'advanced'; key: string; labelKey: string }
  | { kind: 'typography'; level: 'h1' | 'h2' | 'h3'; labelKey: string };

export interface MembersAppSetting {
  key: string;
  section: string;
  labelKey: string;
  type: MembersAppSettingType;
  source: MembersAppSource;
  cssVar: string;
}

// The `advanced` defaults the three Admin sources above need, mirroring
// apps/admin/src/lib/themeTokens.ts's DEFAULT_ADVANCED. Member Web has no copy
// of the full attribute map (it never renders the editor), so only the entries
// a Members App setting inherits from live here.
export const DEFAULT_MEMBERS_APP_SOURCE_ADVANCED: Record<string, string> = {
  headerTextFont: 'system-ui, -apple-system, sans-serif',
  cardBorderWidth: '1px',
  modalBackground: '#f5f5f5',
};

export const FONT_STACK_VALUES = [
  'system-ui, -apple-system, sans-serif',
  'Georgia, "Times New Roman", serif',
  '"Courier New", Courier, monospace',
  'Arial, Helvetica, sans-serif',
  '"Trebuchet MS", sans-serif',
];

export const MEMBERS_APP_SETTINGS: MembersAppSetting[] = [
  {
    key: 'headerColor',
    section: 'group_members_header',
    labelKey: 'label_members_header_color',
    type: 'color',
    source: { kind: 'color', key: 'headerBackground', labelKey: 'label_header_bg' },
    cssVar: '--gd-members-header-bg',
  },
  {
    key: 'headerTextColor',
    section: 'group_members_header',
    labelKey: 'label_members_header_text_color',
    type: 'color',
    source: { kind: 'color', key: 'headerText', labelKey: 'label_header_text' },
    cssVar: '--gd-members-header-text',
  },
  {
    key: 'headerTextFont',
    section: 'group_members_header',
    labelKey: 'label_members_header_text_font',
    type: 'font',
    source: { kind: 'advanced', key: 'headerTextFont', labelKey: 'adv_header_text_font' },
    cssVar: '--gd-members-header-font',
  },
  {
    key: 'headerSeparatorColor',
    section: 'group_members_header',
    labelKey: 'label_members_header_sep_color',
    type: 'color',
    source: { kind: 'color', key: 'headerSeparatorColor', labelKey: 'label_header_sep_color' },
    cssVar: '--gd-header-sep-color',
  },
  {
    key: 'headerSeparatorWidth',
    section: 'group_members_header',
    labelKey: 'label_members_header_sep_width',
    type: 'pixels',
    source: { kind: 'color', key: 'headerSeparatorHeight', labelKey: 'label_header_sep_height' },
    cssVar: '--gd-header-sep-height',
  },
  {
    key: 'backgroundColor',
    section: 'group_members_background',
    labelKey: 'label_members_background_color',
    type: 'color',
    source: { kind: 'color', key: 'pageBackground', labelKey: 'label_page_bg' },
    cssVar: '--gd-app-bg',
  },
  {
    key: 'sectionCardsBorderColor',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_border_color',
    type: 'color',
    source: { kind: 'color', key: 'cardBorder', labelKey: 'label_card_border' },
    cssVar: '--gd-members-card-border',
  },
  {
    key: 'sectionCardsBorderWidth',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_border_width',
    type: 'length',
    source: { kind: 'advanced', key: 'cardBorderWidth', labelKey: 'adv_card_border_width' },
    cssVar: '--gd-members-card-border-width',
  },
  {
    key: 'title1Color',
    section: 'group_members_text',
    labelKey: 'label_members_title1_color',
    type: 'color',
    source: { kind: 'typography', level: 'h1', labelKey: 'source_typography_h1' },
    cssVar: '--gd-color-h1',
  },
  {
    key: 'title2Color',
    section: 'group_members_text',
    labelKey: 'label_members_title2_color',
    type: 'color',
    source: { kind: 'typography', level: 'h2', labelKey: 'source_typography_h2' },
    cssVar: '--gd-color-h2',
  },
  {
    key: 'title3Color',
    section: 'group_members_text',
    labelKey: 'label_members_title3_color',
    type: 'color',
    source: { kind: 'typography', level: 'h3', labelKey: 'source_typography_h3' },
    cssVar: '--gd-color-h3',
  },
  {
    key: 'calendarBackgroundColor',
    section: 'group_members_calendar',
    labelKey: 'label_members_calendar_bg',
    type: 'color',
    source: { kind: 'color', key: 'calendarBackground', labelKey: 'label_calendar_bg' },
    cssVar: '--gd-calendar-bg',
  },
  {
    key: 'calendarHeaderColor',
    section: 'group_members_calendar',
    labelKey: 'label_members_calendar_header_color',
    type: 'color',
    source: { kind: 'color', key: 'calendarHeaderBackground', labelKey: 'label_calendar_header_bg' },
    cssVar: '--gd-calendar-header-bg',
  },
  {
    key: 'calendarButtonsColor',
    section: 'group_members_calendar',
    labelKey: 'label_members_calendar_buttons_color',
    type: 'color',
    source: { kind: 'color', key: 'calendarNavButtonBackground', labelKey: 'label_calendar_nav_btn_bg' },
    cssVar: '--gd-calendar-nav-btn-bg',
  },
  {
    key: 'calendarTimeColumnBackgroundColor',
    section: 'group_members_calendar',
    labelKey: 'label_members_calendar_time_col_bg',
    type: 'color',
    source: { kind: 'color', key: 'calendarTimeAxisBackground', labelKey: 'label_calendar_time_axis_bg' },
    cssVar: '--gd-calendar-time-axis-bg',
  },
  {
    key: 'calendarTimeColumnTextColor',
    section: 'group_members_calendar',
    labelKey: 'label_members_calendar_time_col_text',
    type: 'color',
    source: { kind: 'color', key: 'calendarTimeAxisText', labelKey: 'label_calendar_time_axis_text' },
    cssVar: '--gd-calendar-time-axis-text',
  },
  {
    key: 'calendarModalBackgroundColor',
    section: 'group_members_calendar',
    labelKey: 'label_members_calendar_modal_bg',
    type: 'color',
    source: { kind: 'advanced', key: 'modalBackground', labelKey: 'adv_modal_bg' },
    cssVar: '--gd-members-calendar-modal-bg',
  },
  {
    key: 'calendarModalInputBackgroundColor',
    section: 'group_members_calendar',
    labelKey: 'label_members_calendar_modal_input_bg',
    type: 'color',
    source: { kind: 'color', key: 'inputBackgroundColor', labelKey: 'label_input_background_color' },
    cssVar: '--gd-members-calendar-modal-input-bg',
  },
];

export function adminSourceValue(tokens: ThemeTokens, source: MembersAppSource): string | number {
  if (source.kind === 'color') {
    const colors = (tokens.colors ?? {}) as unknown as Record<string, string | number | undefined>;
    return colors[source.key] ?? (DEFAULT_TOKENS.colors as unknown as Record<string, string | number>)[source.key];
  }
  if (source.kind === 'advanced') {
    const raw = (tokens.advanced ?? {})[source.key];
    return (raw !== null && raw !== undefined ? raw : DEFAULT_MEMBERS_APP_SOURCE_ADVANCED[source.key]) as string | number;
  }
  return tokens.typography?.[source.level]?.color ?? DEFAULT_TOKENS.typography[source.level].color;
}

export function effectiveMembersAppValue(tokens: ThemeTokens, setting: MembersAppSetting): string | number {
  const override = (tokens.membersApp ?? {})[setting.key];
  if (override !== null && override !== undefined) return override;
  return adminSourceValue(tokens, setting.source);
}

/**
 * The value to write for one Members App CSS variable. A stored value that is
 * unusable falls back to the inherited Admin value rather than reaching the
 * variable: a custom property holding `""` or `"blue-ish"` makes the
 * declaration reading it invalid at computed-value time, so the stylesheet's
 * own `var()` literal is *not* what takes over — same reasoning as
 * `calendarVarValue()`.
 */
export function membersAppVarValue(tokens: ThemeTokens, setting: MembersAppSetting): string {
  const value = effectiveMembersAppValue(tokens, setting);
  const inherited = adminSourceValue(tokens, setting.source);
  switch (setting.type) {
    case 'color':
      return isHexColor(value) ? value : String(inherited);
    case 'font':
      return typeof value === 'string' && FONT_STACK_VALUES.includes(value) ? value : String(inherited);
    case 'pixels': {
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 && n <= 20 ? `${n}px` : `${Number(inherited) || 0}px`;
    }
    case 'length':
    default:
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : String(inherited);
  }
}

export function membersAppCssVars(tokens: ThemeTokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const setting of MEMBERS_APP_SETTINGS) out[setting.cssVar] = membersAppVarValue(tokens, setting);
  return out;
}

/**
 * Writes every Members App variable to <html>, after `applyTokens()` has
 * written the Theme's own. The order matters where a setting shares a variable
 * with the Admin concept it inherits from (the page background, the calendar
 * surfaces, the title colours): the Members App value is the one that must
 * stand, so it is written last.
 *
 * Only the Members App does this. The Admin app renders no Members App
 * preview (§16), so its `applyTokens()` never writes these.
 */
export function applyMembersAppTokens(tokens: ThemeTokens) {
  const el = document.documentElement;
  for (const [cssVar, value] of Object.entries(membersAppCssVars(tokens))) {
    el.style.setProperty(cssVar, value);
  }
}
