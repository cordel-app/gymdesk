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
//
// #1152 added three value types (a font size in pixels and the two alignment
// enums) and the one shape for a setting the Admin theme has no counterpart
// for: `source: null` plus the `default` it resolves to while nothing
// overrides it. The alignment variables carry the CSS property value rather
// than the stored word, so `memberChrome.ts` reads them with no mapping.
import { DEFAULT_TOKENS, isHexColor, type ThemeTokens } from './themeTokens';

export type MembersAppSettingType = 'color' | 'font' | 'length' | 'pixels' | 'font-size' | 'align-v' | 'align-h' | CardEffectType;

export const MEMBERS_APP_FONT_SIZE = { min: 8, max: 48 } as const;
export const MEMBERS_APP_VERTICAL_ALIGNMENTS = ['top', 'center', 'bottom'];
export const MEMBERS_APP_HORIZONTAL_ALIGNMENTS = ['left', 'center', 'right'];

/**
 * #1321 stage 1 — the Section Card's three enum settings. Each is a closed set:
 * a value is one the Members App can paint or a 400, never a coercion. Shape and
 * Shadow write the CSS value itself (`cardEffectCssValue()`), so
 * `memberChrome.ts` maps nothing; Border edges write the keyword plus four
 * 0/1 flags (`cardEdgeFlags()`) that scale the border width per edge.
 */
export const MEMBERS_APP_CARD_SHAPES = ['rounded', 'square', 'none'];
export const MEMBERS_APP_CARD_BORDER_EDGES = ['all', 'none', 'top', 'bottom', 'left', 'right'];
export const MEMBERS_APP_CARD_SHADOWS = ['none', 'soft', 'medium', 'strong'];

export type CardEffectType = 'card-shape' | 'card-edges' | 'card-shadow' | 'card-glow' | 'card-style';

export const MEMBERS_APP_CARD_OPTIONS: Record<CardEffectType, string[]> = {
  'card-shape': MEMBERS_APP_CARD_SHAPES,
  'card-edges': MEMBERS_APP_CARD_BORDER_EDGES,
  'card-shadow': MEMBERS_APP_CARD_SHADOWS,
  'card-glow': ['none', 'subtle', 'strong'],
  'card-style': ['clean', 'outlined', 'glass'],
};

const CARD_SHAPE_CSS: Record<string, string> = { rounded: '12px', square: '4px', none: '0px' };
const CARD_SHADOW_CSS: Record<string, string> = {
  none: 'none',
  soft: '0 1px 3px rgba(0,0,0,0.05)',
  medium: '0 4px 12px rgba(0,0,0,0.12)',
  strong: '0 8px 24px rgba(0,0,0,0.2)',
};


/** #1321 stage 2 — the glow word and the Visual Style word, closed sets like the other three. */
export const MEMBERS_APP_CARD_GLOWS = ['none', 'subtle', 'strong'];
export const MEMBERS_APP_CARD_STYLES = ['clean', 'outlined', 'glass'];

/**
 * A Visual Style is a bundle of *defaults*: it supplies a value only for a
 * setting the Theme has not overridden, so it can never overwrite an explicit
 * choice. `clean` supplies nothing — it is today's card.
 */
export const CARD_STYLE_DEFAULTS: Record<string, Record<string, string>> = {
  clean: {},
  outlined: { sectionCardsShadow: 'none', sectionCardsBorderWidth: '2px' },
  glass: { sectionCardsShadow: 'medium', sectionCardsGlow: 'subtle' },
};

const CARD_GLOW_CSS: Record<string, string> = {
  none: '',
  subtle: '0 0 8px 1px',
  strong: '0 0 18px 3px',
};

/**
 * The card's whole `box-shadow`: the drop shadow and the glow in one list.
 * `none` is not valid inside a list, so each part is dropped when it is off.
 */
export function cardBoxShadow(shadowCss: string, glow: string, glowColor: string): string {
  const parts: string[] = [];
  if (shadowCss && shadowCss !== 'none') parts.push(shadowCss);
  const g = CARD_GLOW_CSS[glow];
  if (g) parts.push(`${g} color-mix(in srgb, ${glowColor} 60%, transparent)`);
  return parts.length ? parts.join(', ') : 'none';
}

/** The CSS a stored shape, edge or shadow word becomes; `null` for a word outside its set. */
export function cardEffectCssValue(type: CardEffectType, value: unknown): string | null {
  if (typeof value !== 'string' || !MEMBERS_APP_CARD_OPTIONS[type].includes(value)) return null;
  if (type === 'card-shape') return CARD_SHAPE_CSS[value];
  if (type === 'card-shadow') return CARD_SHADOW_CSS[value];
  return value; // edges, glow and style are words; their CSS is composed by cardBoxShadow()
}

/** Which edges carry the border (1) and which do not (0), for a stored edges word. */
export function cardEdgeFlags(value: unknown): { top: 0 | 1; right: 0 | 1; bottom: 0 | 1; left: 0 | 1 } {
  const v = typeof value === 'string' && MEMBERS_APP_CARD_BORDER_EDGES.includes(value) ? value : 'all';
  const on = (edge: string): 0 | 1 => (v === 'all' || v === edge ? 1 : 0);
  return { top: on('top'), right: on('right'), bottom: on('bottom'), left: on('left') };
}

export type MembersAppSource =
  | { kind: 'color'; key: string; labelKey: string }
  | { kind: 'advanced'; key: string; labelKey: string }
  | { kind: 'typography'; level: 'h1' | 'h2' | 'h3' | 'body'; field: 'color' | 'fontFamily'; labelKey: string };

interface MembersAppSettingBase {
  key: string;
  section: string;
  labelKey: string;
  type: MembersAppSettingType;
  cssVar: string;
}

export type MembersAppSetting =
  | (MembersAppSettingBase & { source: MembersAppSource; default?: undefined })
  | (MembersAppSettingBase & { source: null; default: string | number });

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
    key: 'sectionCardsBackgroundColor',
    section: 'group_members_background',
    labelKey: 'label_members_card_bg_color',
    type: 'color',
    source: { kind: 'color', key: 'cardBackground', labelKey: 'label_card_bg' },
    cssVar: '--gd-card-bg',
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
    // #1321 stage 1 — the Section Card's shape, border edges and shadow. The
    // Admin theme has no counterpart for any of them (its `cardBorderRadius` is
    // a pixel attribute for the Admin's own cards), so each declares `source:
    // null` and the default that is today's rendering (12px corners, a border on
    // every edge, a soft shadow). Border edges say *where* the border is drawn;
    // its colour and width stay the two settings above, so position and
    // appearance remain separate concepts.
    key: 'sectionCardsShape',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_shape',
    type: 'card-shape',
    source: null,
    default: 'rounded',
    cssVar: '--gd-members-card-radius',
  },
  {
    key: 'sectionCardsBorderEdges',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_border_edges',
    type: 'card-edges',
    source: null,
    default: 'all',
    cssVar: '--gd-members-card-edges',
  },
  {
    key: 'sectionCardsShadow',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_shadow',
    type: 'card-shadow',
    source: null,
    default: 'soft',
    cssVar: '--gd-members-card-shadow',
  },
  {
    // #1321 stage 2 — Glow, its colour and the Visual Style. Glow inherits from
    // nothing (default none); its colour inherits the primary button colour so a
    // glow follows the brand until someone picks one. The Visual Style supplies
    // defaults only for settings the Theme has not overridden.
    key: 'sectionCardsGlow',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_glow',
    type: 'card-glow',
    source: null,
    default: 'none',
    cssVar: '--gd-members-card-glow',
  },
  {
    key: 'sectionCardsGlowColor',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_glow_color',
    type: 'color',
    source: { kind: 'color', key: 'primaryButton', labelKey: 'label_primary_btn' },
    cssVar: '--gd-members-card-glow-color',
  },
  {
    key: 'sectionCardsVisualStyle',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_style',
    type: 'card-style',
    source: null,
    default: 'clean',
    cssVar: '--gd-members-card-style',
  },
  {
    key: 'sectionCardsTextColor',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_text_color',
    type: 'color',
    source: { kind: 'color', key: 'textColor', labelKey: 'label_text_color' },
    cssVar: '--gd-members-card-text',
  },
  {
    key: 'sectionCardsTextSize',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_text_size',
    type: 'font-size',
    source: null,
    default: 13,
    cssVar: '--gd-members-card-text-size',
  },
  {
    key: 'sectionCardsTextFont',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_text_font',
    type: 'font',
    source: { kind: 'typography', level: 'body', field: 'fontFamily', labelKey: 'source_typography_body_font' },
    cssVar: '--gd-members-card-text-font',
  },
  {
    key: 'sectionCardsTextVertical',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_text_vertical',
    type: 'align-v',
    source: null,
    default: 'center',
    cssVar: '--gd-members-card-text-vertical',
  },
  {
    key: 'sectionCardsTextHorizontal',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_text_horizontal',
    type: 'align-h',
    source: null,
    default: 'center',
    cssVar: '--gd-members-card-text-horizontal',
  },
  {
    key: 'title1Color',
    section: 'group_members_text',
    labelKey: 'label_members_title1_color',
    type: 'color',
    source: { kind: 'typography', level: 'h1', field: 'color', labelKey: 'source_typography_h1' },
    cssVar: '--gd-color-h1',
  },
  {
    key: 'title1Font',
    section: 'group_members_text',
    labelKey: 'label_members_title1_font',
    type: 'font',
    source: { kind: 'typography', level: 'h1', field: 'fontFamily', labelKey: 'source_typography_h1_font' },
    cssVar: '--gd-font-h1',
  },
  {
    key: 'title2Color',
    section: 'group_members_text',
    labelKey: 'label_members_title2_color',
    type: 'color',
    source: { kind: 'typography', level: 'h2', field: 'color', labelKey: 'source_typography_h2' },
    cssVar: '--gd-color-h2',
  },
  {
    key: 'title2Font',
    section: 'group_members_text',
    labelKey: 'label_members_title2_font',
    type: 'font',
    source: { kind: 'typography', level: 'h2', field: 'fontFamily', labelKey: 'source_typography_h2_font' },
    cssVar: '--gd-font-h2',
  },
  {
    key: 'title3Color',
    section: 'group_members_text',
    labelKey: 'label_members_title3_color',
    type: 'color',
    source: { kind: 'typography', level: 'h3', field: 'color', labelKey: 'source_typography_h3' },
    cssVar: '--gd-color-h3',
  },
  {
    key: 'title3Font',
    section: 'group_members_text',
    labelKey: 'label_members_title3_font',
    type: 'font',
    source: { kind: 'typography', level: 'h3', field: 'fontFamily', labelKey: 'source_typography_h3_font' },
    cssVar: '--gd-font-h3',
  },
  {
    key: 'text1Color',
    section: 'group_members_text',
    labelKey: 'label_members_text1_color',
    type: 'color',
    source: { kind: 'color', key: 'textColor', labelKey: 'label_text_color' },
    cssVar: '--gd-text',
  },
  {
    key: 'text2Color',
    section: 'group_members_text',
    labelKey: 'label_members_text2_color',
    type: 'color',
    source: { kind: 'color', key: 'secondaryTextColor', labelKey: 'label_secondary_text_color' },
    cssVar: '--gd-text-secondary',
  },
  {
    key: 'text3Color',
    section: 'group_members_text',
    labelKey: 'label_members_text3_color',
    type: 'color',
    source: { kind: 'color', key: 'mutedTextColor', labelKey: 'label_muted_text_color' },
    cssVar: '--gd-text-muted',
  },
  // ── Buttons (Members App) ─────────────────────────────────────────────────
  // #1212 — both write the same variables the Members App's `memberTheme`
  // already reads for its primary and secondary buttons, so nothing downstream
  // needs a rule of its own.
  {
    key: 'primaryButtonColor',
    section: 'group_members_buttons',
    labelKey: 'label_members_primary_button_color',
    type: 'color',
    source: { kind: 'color', key: 'primaryButton', labelKey: 'label_primary_btn' },
    cssVar: '--gd-primary-btn',
  },
  {
    key: 'secondaryButtonColor',
    section: 'group_members_buttons',
    labelKey: 'label_members_secondary_button_color',
    type: 'color',
    source: { kind: 'color', key: 'secondaryButton', labelKey: 'label_secondary_btn' },
    cssVar: '--gd-secondary-btn',
  },
  {
    key: 'primaryButtonTextColor',
    section: 'group_members_buttons',
    labelKey: 'label_members_primary_button_text_color',
    type: 'color',
    source: { kind: 'color', key: 'primaryButtonText', labelKey: 'label_primary_btn_text' },
    cssVar: '--gd-primary-btn-text',
  },
  {
    key: 'secondaryButtonTextColor',
    section: 'group_members_buttons',
    labelKey: 'label_members_secondary_button_text_color',
    type: 'color',
    source: { kind: 'color', key: 'secondaryButtonText', labelKey: 'label_secondary_btn_text' },
    cssVar: '--gd-secondary-btn-text',
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
    key: 'calendarActiveAreaColor',
    section: 'group_members_calendar',
    labelKey: 'label_members_calendar_active_area_bg',
    type: 'color',
    source: { kind: 'color', key: 'calendarActiveAreaBackground', labelKey: 'label_calendar_active_area_bg' },
    cssVar: '--gd-calendar-active-area-bg',
  },
  {
    key: 'calendarInactiveAreaColor',
    section: 'group_members_calendar',
    labelKey: 'label_members_calendar_inactive_area_bg',
    type: 'color',
    source: { kind: 'color', key: 'calendarDisabledSlotBackground', labelKey: 'label_calendar_disabled_slot_bg' },
    cssVar: '--gd-calendar-disabled-slot-bg',
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
  {
    key: 'inputBackgroundColor',
    section: 'group_members_inputs',
    labelKey: 'label_members_input_bg',
    type: 'color',
    source: { kind: 'color', key: 'inputBackgroundColor', labelKey: 'label_input_background_color' },
    cssVar: '--gd-input-bg',
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
  return tokens.typography?.[source.level]?.[source.field] ?? DEFAULT_TOKENS.typography[source.level][source.field];
}

/** The Admin source's current value, or the declared default for a setting that inherits from nothing (#1152). */
export function inheritedMembersAppValue(tokens: ThemeTokens, setting: MembersAppSetting): string | number {
  return setting.source ? adminSourceValue(tokens, setting.source) : setting.default;
}

export function effectiveMembersAppValue(tokens: ThemeTokens, setting: MembersAppSetting): string | number {
  const override = (tokens.membersApp ?? {})[setting.key];
  if (override !== null && override !== undefined) return override;
  // #1321 stage 2 — a Visual Style fills only what nothing overrides.
  if (setting.key !== 'sectionCardsVisualStyle') {
    const styleOverride = ((tokens as any).membersApp ?? {})['sectionCardsVisualStyle'];
    const styleDefault = CARD_STYLE_DEFAULTS[typeof styleOverride === 'string' ? styleOverride : 'clean']?.[setting.key];
    if (styleDefault !== undefined) return styleDefault;
  }
  return inheritedMembersAppValue(tokens, setting);
}

/**
 * The CSS a stored alignment becomes (#1152 §4): a Section Card is a column
 * flex box, so a vertical position is its `justify-content` and a horizontal
 * one its `text-align`. An unknown value answers `null`.
 */
export function alignmentCssValue(type: 'align-v' | 'align-h', value: unknown): string | null {
  if (type === 'align-v') {
    if (value === 'top') return 'flex-start';
    if (value === 'center') return 'center';
    if (value === 'bottom') return 'flex-end';
    return null;
  }
  return typeof value === 'string' && MEMBERS_APP_HORIZONTAL_ALIGNMENTS.includes(value) ? value : null;
}

export function isMembersAppFontSize(value: unknown): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n >= MEMBERS_APP_FONT_SIZE.min && n <= MEMBERS_APP_FONT_SIZE.max;
}

/** A bare number (`1`, `0`, `0.5`) is pixels; a value with a unit is left as typed (#1216). */
function cssLength(value: string): string {
  return /^\d+(\.\d+)?$/.test(value) ? `${value}px` : value;
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
  const inherited = inheritedMembersAppValue(tokens, setting);
  switch (setting.type) {
    case 'color':
      return isHexColor(value) ? value : String(inherited);
    case 'font':
      return typeof value === 'string' && FONT_STACK_VALUES.includes(value) ? value : String(inherited);
    case 'pixels': {
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 && n <= 20 ? `${n}px` : `${Number(inherited) || 0}px`;
    }
    case 'font-size':
      return isMembersAppFontSize(value) ? `${Number(value)}px` : `${Number(inherited)}px`;
    case 'align-v':
    case 'align-h':
      return alignmentCssValue(setting.type, value) ?? alignmentCssValue(setting.type, inherited) ?? 'center';
    case 'card-shape':
    case 'card-edges':
    case 'card-shadow':
      return cardEffectCssValue(setting.type, value) ?? cardEffectCssValue(setting.type, inherited) ?? '';
    case 'card-glow':
    case 'card-style':
      return cardEffectCssValue(setting.type, value) ?? cardEffectCssValue(setting.type, inherited) ?? '';
    case 'length':
    default:
      return cssLength(typeof value === 'string' && value.trim() !== '' ? value.trim() : String(inherited));
  }
}

export function membersAppCssVars(tokens: ThemeTokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const setting of MEMBERS_APP_SETTINGS) {
    out[setting.cssVar] = membersAppVarValue(tokens, setting);
    if (setting.type === 'card-edges') {
      const flags = cardEdgeFlags(out[setting.cssVar]);
      for (const edge of ['top', 'right', 'bottom', 'left'] as const) out[`${setting.cssVar}-${edge}`] = String(flags[edge]);
    }
  }
  out['--gd-members-card-effects'] = cardBoxShadow(
    out['--gd-members-card-shadow'],
    out['--gd-members-card-glow'],
    out['--gd-members-card-glow-color'],
  );
  return out;
}

/**
 * Writes every Members App variable to <html>, after `applyTokens()` has
 * written the Theme's own. The order matters where a setting shares a variable
 * with the Admin concept it inherits from (the page background, the calendar
 * surfaces, the title colours and fonts): the Members App value is the one
 * that must stand, so it is written last.
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
