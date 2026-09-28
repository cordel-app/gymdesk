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

/** What kind of value a Members App setting holds — and therefore which control edits it. */
export type MembersAppSettingType = 'color' | 'font' | 'length' | 'pixels';

/**
 * The Admin setting a Members App setting inherits from. `labelKey` is the
 * label the Admin editor already gives that setting, so the
 * "(inherited from …)" line names the real source rather than a paraphrase
 * (§9, and the acceptance criterion that the displayed name identifies it).
 */
export type MembersAppSource =
  | { kind: 'color'; key: keyof ThemeTokens['colors']; labelKey: string }
  | { kind: 'advanced'; key: string; labelKey: string }
  | { kind: 'typography'; level: 'h1' | 'h2' | 'h3'; labelKey: string };

export interface MembersAppSetting {
  /** The key inside `tokens.membersApp` an override is stored under. */
  key: string;
  /** Which of the five Members App sections renders it. */
  section: MembersAppSection;
  labelKey: string;
  type: MembersAppSettingType;
  source: MembersAppSource;
  /**
   * The CSS variable the Members App paints this setting with. Where the
   * concept already has a variable (the page background, the calendar
   * surfaces, the title colours), the effective value is written into that
   * same variable, so nothing downstream needs a second rule; the settings
   * with no existing variable get a `--gd-members-*` one of their own.
   */
  cssVar: string;
}

export type MembersAppSection =
  | 'group_members_header'
  | 'group_members_background'
  | 'group_members_section_cards'
  | 'group_members_text'
  | 'group_members_calendar';

/** Section order in the editor (§1). */
export const MEMBERS_APP_SECTIONS: MembersAppSection[] = [
  'group_members_header',
  'group_members_background',
  'group_members_section_cards',
  'group_members_text',
  'group_members_calendar',
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
  // ── Text (Members App) ────────────────────────────────────────────────────
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
  // ── Calendar (Members App) ────────────────────────────────────────────────
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
  return tokens.typography?.[source.level]?.color ?? DEFAULT_TOKENS.typography[source.level].color;
}

/**
 * §18 — the value the Members App actually renders with: the Theme's own
 * override when there is one, the current Admin value otherwise. Evaluated
 * independently per setting, so nothing here reads another setting's state.
 */
export function effectiveMembersAppValue(tokens: ThemeTokens, setting: MembersAppSetting): string | number {
  const override = membersAppOverrides(tokens)[setting.key];
  if (override !== null && override !== undefined) return override;
  return adminSourceValue(tokens, setting.source);
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
 * The value to write for one Members App CSS variable. A stored value that is
 * unusable (a colour that is not a hex triplet, a font outside the allowed
 * stacks, a blank length) falls back to the inherited Admin value rather than
 * reaching the variable: a custom property holding `""` or `"blue-ish"` makes
 * the declaration that reads it invalid at computed-value time, so the
 * stylesheet's own `var()` literal is *not* what takes over — same reasoning
 * as `calendarVarValue()`.
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

/** Every Members App CSS variable, resolved. Consumed by the Members App. */
export function membersAppCssVars(tokens: ThemeTokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const setting of MEMBERS_APP_SETTINGS) out[setting.cssVar] = membersAppVarValue(tokens, setting);
  return out;
}
