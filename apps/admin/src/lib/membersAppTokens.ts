// #833 — the Members App's own visual settings, and where each one inherits
// from when the Theme does not override it.
//
// The Theme editor is shared by Base Themes and Custom Themes, so this one
// declaration gives both screens the same settings, the same inheritance
// sources and the same UI (§15). It is the only place the mapping in §8 is
// written down: the editor, the resolution helpers below and the Members App's
// own `applyTokens()` all read it rather than restating a source of their own.
//
// Two properties are the rule, not the implementation:
//
//  * **An inherited setting is not stored** (§13, §19). `tokens.membersApp`
//    holds overrides only — a key that is absent means "inherited", and
//    `restore inherited value` removes the key rather than writing the Admin
//    value into it. That is what keeps inheritance dynamic: an Admin setting
//    edited later moves every Members App setting still inherited from it,
//    and never one that was overridden.
//  * **Inheritance is per setting** (§12, §18). Every entry resolves on its
//    own, so overriding Header Color cannot implicitly override Header Text.
//
// #1152 amended the first rule for the settings the Admin theme has nothing
// honest for a Section Card's text to inherit from — its size and its two
// positions, which no Admin surface has: such a setting declares `source:
// null` and a `default`, is stored when overridden and absent otherwise
// exactly like the rest, and resolves to the default rather than to an Admin
// value. The editor says "Default value" for it where it says "inherited from
// …" for the others. Reuse of an Admin setting is still the first answer; a
// sourceless setting is the second and needs the reason spelled beside it.
//
// Mirrored (keys, types, sources, CSS variables) in
// apps/member/src/lib/membersAppTokens.ts, which resolves the effective values
// when the Members App renders, and in api/src/domain/membersAppTokens.ts,
// which validates what may be written. A test asserts the three agree.
import {
  DEFAULT_ADVANCED,
  DEFAULT_TOKENS,
  FONT_STACKS,
  isHexColor,
  type ThemeTokens,
} from '@/lib/themeTokens';

/**
 * What kind of value a Members App setting holds — and therefore which control
 * edits it. `font-size` is an integer of CSS pixels inside
 * `MEMBERS_APP_FONT_SIZE`; `align-v` / `align-h` are the two alignment enums
 * (#1152 §3), kept as two types rather than one so a horizontal value can never
 * be stored on the vertical axis.
 */
export type MembersAppSettingType = 'color' | 'font' | 'length' | 'pixels' | 'font-size' | 'align-v' | 'align-h' | CardEffectType;

/** The bounds of a `font-size` setting, in CSS pixels. Mirrors the API validator. */
export const MEMBERS_APP_FONT_SIZE = { min: 8, max: 48 } as const;

export type MembersAppVerticalAlignment = 'top' | 'center' | 'bottom';
export type MembersAppHorizontalAlignment = 'left' | 'center' | 'right';
/** The stored values of an `align-v` setting, in the order the editor offers them. */
export const MEMBERS_APP_VERTICAL_ALIGNMENTS: MembersAppVerticalAlignment[] = ['top', 'center', 'bottom'];
/** The stored values of an `align-h` setting, in the order the editor offers them. */
export const MEMBERS_APP_HORIZONTAL_ALIGNMENTS: MembersAppHorizontalAlignment[] = ['left', 'center', 'right'];

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

export type CardEffectType = 'card-shape' | 'card-edges' | 'card-shadow' | 'card-glow' | 'card-style' | 'card-touch';

export const MEMBERS_APP_CARD_OPTIONS: Record<CardEffectType, string[]> = {
  'card-shape': MEMBERS_APP_CARD_SHAPES,
  'card-edges': MEMBERS_APP_CARD_BORDER_EDGES,
  'card-shadow': MEMBERS_APP_CARD_SHADOWS,
  'card-glow': ['none', 'subtle', 'strong'],
  'card-style': ['clean', 'outlined', 'glass'],
  'card-touch': ['none', 'press', 'ripple', 'highlight', 'lift'],
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
/**
 * #1321 stage 3 — what each Touch Effect looks like while the card is pressed,
 * mirroring the stylesheet in apps/member/src/lib/cardTouch.ts (a test asserts
 * the two agree). The editor's preview draws the pressed state from it.
 */
export const CARD_TOUCH_PRESSED: Record<string, { transform?: string; filter?: string; ripple?: boolean }> = {
  none: {},
  press: { transform: 'scale(0.97)' },
  ripple: { ripple: true },
  highlight: { filter: 'brightness(1.08)' },
  lift: { transform: 'translateY(-2px)', filter: 'drop-shadow(0 6px 8px rgba(0,0,0,0.2))' },
};

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

/**
 * The Admin setting a Members App setting inherits from. `labelKey` is the
 * label the Admin editor already gives that setting, so the
 * "(inherited from …)" line names the real source rather than a paraphrase
 * (§9, and the acceptance criterion that the displayed name identifies it).
 */
export type MembersAppSource =
  | { kind: 'color'; key: keyof ThemeTokens['colors']; labelKey: string }
  | { kind: 'advanced'; key: string; labelKey: string }
  // A typography level carries a colour and a font family, and since #1152
  // either half may be a source — `field` says which, so the same level
  // answers both a Title's Color and its Font Family.
  | { kind: 'typography'; level: 'h1' | 'h2' | 'h3' | 'body'; field: 'color' | 'fontFamily'; labelKey: string };

interface MembersAppSettingBase {
  /** The key inside `tokens.membersApp` an override is stored under. */
  key: string;
  /** Which of the five Members App sections renders it. */
  section: MembersAppSection;
  labelKey: string;
  type: MembersAppSettingType;
  /**
   * The CSS variable the Members App paints this setting with. Where the
   * concept already has a variable (the page background, the calendar
   * surfaces, the title colours and fonts), the effective value is written
   * into that same variable, so nothing downstream needs a second rule; the
   * settings with no existing variable get a `--gd-members-*` one of their own.
   */
  cssVar: string;
}

/**
 * A setting either inherits from an Admin setting (`source`) or, since #1152,
 * declares `source: null` with the `default` it resolves to while nothing
 * overrides it — the one shape for a value the Admin theme genuinely has no
 * counterpart for. The union makes a sourceless setting with no default, or a
 * sourced one carrying a default nothing reads, a type error.
 */
export type MembersAppSetting =
  | (MembersAppSettingBase & { source: MembersAppSource; default?: undefined })
  | (MembersAppSettingBase & { source: null; default: string | number });

export type MembersAppSection =
  | 'group_members_header'
  | 'group_members_background'
  | 'group_members_section_cards'
  | 'group_members_text'
  | 'group_members_buttons'
  | 'group_members_calendar'
  | 'group_members_inputs';

/** Section order in the editor (§1). */
export const MEMBERS_APP_SECTIONS: MembersAppSection[] = [
  'group_members_header',
  'group_members_background',
  'group_members_section_cards',
  'group_members_text',
  'group_members_buttons',
  'group_members_calendar',
  'group_members_inputs',
];

// §8's mapping, in the order the ticket lists it. Every source below is an
// Admin setting that already exists, except the two the ticket asked for
// explicitly (§2 Header Text Font, §4 Card Border Width) — both added to
// ADVANCED_ATTRIBUTES beside the settings they belong to, and both wired to a
// CSS variable the Admin app itself reads, so neither is an editable setting
// that changes nothing.
//
// `Application Surface` and `Input Background` (§7) are the two §14 flagged as
// possibly missing. Both already exist: the Admin application's modal surface
// is `advanced.modalBackground` ("Modal Background") and its input background
// is `colors.inputBackgroundColor` ("Input Background Color"), so they are
// reused rather than duplicated, per §7 and §14.
export const MEMBERS_APP_SETTINGS: MembersAppSetting[] = [
  // ── Header (Members App) ──────────────────────────────────────────────────
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
    // The Admin setting is spelled "Separator Height (px)" and is the same
    // semantic setting, so §2 reuses it rather than adding a second one.
    key: 'headerSeparatorWidth',
    section: 'group_members_header',
    labelKey: 'label_members_header_sep_width',
    type: 'pixels',
    source: { kind: 'color', key: 'headerSeparatorHeight', labelKey: 'label_header_sep_height' },
    cssVar: '--gd-header-sep-height',
  },
  // ── Background (Members App) ──────────────────────────────────────────────
  {
    key: 'backgroundColor',
    section: 'group_members_background',
    labelKey: 'label_members_background_color',
    type: 'color',
    source: { kind: 'color', key: 'pageBackground', labelKey: 'label_page_bg' },
    cssVar: '--gd-app-bg',
  },
  // ── Section Cards (Members App) ───────────────────────────────────────────
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
    // Border *width*, not radius (§4) — `cardBorderRadius` is a separate
    // attribute and keeps its own meaning.
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
    // #1321 stage 3 — Touch Effect. Inherits from nothing (default none) and is
    // never supplied by a Visual Style: how a card feels when pressed is
    // independent of how it looks. It applies to interactive cards only.
    key: 'sectionCardsTouchEffect',
    section: 'group_members_section_cards',
    labelKey: 'label_members_card_touch',
    type: 'card-touch',
    source: null,
    default: 'none',
    cssVar: '--gd-members-card-touch',
  },
  // #1152 §3 — the text inside a Section Card. Colour and font family have an
  // honest Admin source (the primary text colour and the body font, which is
  // what a tile's label rendered in before the ticket); size and the two
  // positions have none — the Admin app has no Section Cards and no setting a
  // text's position could inherit from — so they declare the default that is
  // today's rendering (13px, centred both ways) and inherit from nothing.
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
  // ── Typography (Members App) ──────────────────────────────────────────────
  // #1152 §1/§2 — the section reads *Typography (Members App)* and each Title
  // carries its Font Family beside its Color, both halves of the same
  // typography level. The font overrides write into the level's own
  // `--gd-font-h*` variable exactly as the colours write into `--gd-color-h*`,
  // so a heading reading it gets the Members App value where the Theme
  // overrides it and the Admin value where it does not.
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
  // ── Calendar (Members App) ────────────────────────────────────────────────
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
    // The time column stays a separate surface from the calendar background
    // (§6), which is why it has its own pair rather than reading the one above.
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
    // §7 — the event window is a surface layered *above* the calendar, so it
    // inherits from the Admin application's own surface setting and never from
    // Calendar Background.
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
    // #1213 — the text-input fill. Writes `--gd-input-bg`, the very variable
    // `memberTheme.inputBackground` (and so every `inputStyle` consumer) reads,
    // so no input component spells a colour of its own.
    key: 'inputBackgroundColor',
    section: 'group_members_inputs',
    labelKey: 'label_members_input_bg',
    type: 'color',
    source: { kind: 'color', key: 'inputBackgroundColor', labelKey: 'label_input_background_color' },
    cssVar: '--gd-input-bg',
  },
];

export const MEMBERS_APP_SETTING_KEYS = MEMBERS_APP_SETTINGS.map((s) => s.key);

export function membersAppSettingsFor(section: MembersAppSection): MembersAppSetting[] {
  return MEMBERS_APP_SETTINGS.filter((s) => s.section === section);
}

/** The overrides a Theme carries. Absent for every Theme that overrides nothing. */
export function membersAppOverrides(tokens: ThemeTokens): Record<string, string | number | null> {
  return (tokens.membersApp ?? {}) as Record<string, string | number | null>;
}

/**
 * Whether this setting is overridden on this Theme. `null` reads as inherited,
 * the same way `ThemeAdvancedSection` treats a cleared `advanced` entry, so a
 * row written with an explicit null is not mistaken for a custom value.
 */
export function isMembersAppOverridden(tokens: ThemeTokens, key: string): boolean {
  const v = membersAppOverrides(tokens)[key];
  return v !== null && v !== undefined;
}

/** The current value of the Admin setting a Members App setting inherits from. */
export function adminSourceValue(tokens: ThemeTokens, source: MembersAppSource): string | number {
  if (source.kind === 'color') {
    const colors = (tokens.colors ?? {}) as Record<string, string | number | undefined>;
    return colors[source.key as string] ?? (DEFAULT_TOKENS.colors as Record<string, string | number>)[source.key as string];
  }
  if (source.kind === 'advanced') {
    const raw = (tokens.advanced ?? {})[source.key];
    return (raw !== null && raw !== undefined ? raw : DEFAULT_ADVANCED[source.key]) as string | number;
  }
  return tokens.typography?.[source.level]?.[source.field] ?? DEFAULT_TOKENS.typography[source.level][source.field];
}

/**
 * What a setting resolves to while nothing overrides it: the current value of
 * its Admin source, or — for a setting that inherits from nothing (#1152) —
 * its declared default.
 */
export function inheritedMembersAppValue(tokens: ThemeTokens, setting: MembersAppSetting): string | number {
  return setting.source ? adminSourceValue(tokens, setting.source) : setting.default;
}

/**
 * §18 — the value the Members App actually renders with: the Theme's own
 * override when there is one, the inherited value otherwise. Evaluated
 * independently per setting, so nothing here reads another setting's state.
 */
export function effectiveMembersAppValue(tokens: ThemeTokens, setting: MembersAppSetting): string | number {
  const override = membersAppOverrides(tokens)[setting.key];
  if (override !== null && override !== undefined) return override;
  // #1321 stage 2 — a Visual Style fills only what nothing overrides.
  if (setting.key !== 'sectionCardsVisualStyle') {
    const styleOverride = ((tokens as any).membersApp ?? {})['sectionCardsVisualStyle'];
    const styleDefault = CARD_STYLE_DEFAULTS[typeof styleOverride === 'string' ? styleOverride : 'clean']?.[setting.key];
    if (styleDefault !== undefined) return styleDefault;
  }
  return inheritedMembersAppValue(tokens, setting);
}

/** §10 — editing a setting overrides that setting and nothing else. */
export function withMembersAppOverride(
  tokens: ThemeTokens,
  key: string,
  value: string | number,
): ThemeTokens {
  return { ...tokens, membersApp: { ...membersAppOverrides(tokens), [key]: value } };
}

/**
 * §11 / §19 — restoring inheritance *removes* the override rather than
 * writing the Admin value into it, and a Theme left with no overrides at all
 * carries no `membersApp` map, so "inherited" never reaches the database as a
 * stored value.
 */
export function withMembersAppInherited(tokens: ThemeTokens, key: string): ThemeTokens {
  const next = { ...membersAppOverrides(tokens) };
  delete next[key];
  if (Object.keys(next).length === 0) {
    const { membersApp: _dropped, ...rest } = tokens;
    return rest as ThemeTokens;
  }
  return { ...tokens, membersApp: next };
}

const FONT_STACK_VALUES = FONT_STACKS.map((f) => f.value);

/**
 * The CSS a stored alignment becomes (#1152 §4). The Members App's Section
 * Card is a column flex box, so a vertical position is its `justify-content`
 * and a horizontal one its `text-align` — the variable carries the property
 * value rather than the stored word, so `memberChrome.ts` reads it with no
 * mapping of its own. An unknown value answers `null`, and the caller falls
 * back to the default for `membersAppVarValue()`'s reason.
 */
export function alignmentCssValue(type: 'align-v' | 'align-h', value: unknown): string | null {
  if (type === 'align-v') {
    if (value === 'top') return 'flex-start';
    if (value === 'center') return 'center';
    if (value === 'bottom') return 'flex-end';
    return null;
  }
  return typeof value === 'string' && (MEMBERS_APP_HORIZONTAL_ALIGNMENTS as string[]).includes(value) ? value : null;
}

/** Whether a stored value is a `font-size` the Members App may paint. */
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
 * unusable (a colour that is not a hex triplet, a font outside the allowed
 * stacks, a blank length, a size or an alignment outside its set) falls back
 * to the inherited value rather than reaching the variable: a custom property
 * holding `""` or `"blue-ish"` makes the declaration that reads it invalid at
 * computed-value time, so the stylesheet's own `var()` literal is *not* what
 * takes over — same reasoning as `calendarVarValue()`.
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
    case 'card-touch':
      return cardEffectCssValue(setting.type, value) ?? cardEffectCssValue(setting.type, inherited) ?? '';
    case 'length':
    default:
      return cssLength(typeof value === 'string' && value.trim() !== '' ? value.trim() : String(inherited));
  }
}

/** Every Members App CSS variable, resolved. Consumed by the Members App. */
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
