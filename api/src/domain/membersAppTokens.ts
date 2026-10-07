// #833 — what may be written into `themes.tokens.membersApp`.
//
// The map holds the Members App's **overrides only**: a key that is absent
// means the setting follows the current value of its Admin source, and
// restoring inheritance removes the key rather than storing the Admin value
// (§13, §19). Nothing here resolves an inherited value — that is the reading
// side's job (apps/*/src/lib/membersAppTokens.ts) — this decides only whether a
// write is well-formed.
//
// The key list and each key's type mirror
// apps/admin/src/lib/membersAppTokens.ts, which declares the mapping in §8; a
// test asserts the two agree, so a setting added there cannot be silently
// rejected here.
//
// #1152 added three value types a Section Card's text needs and the Admin
// theme has no counterpart for: a font size in pixels and the two alignment
// enums. Each is a closed answer — an integer inside `MEMBERS_APP_FONT_SIZE`'s
// bounds, one of the three vertical or the three horizontal positions — so a
// value is either one the Members App can paint or a 400, never a coercion.
import { FONT_STACKS, HEX_RE } from './themeTokenFormats';

export type MembersAppSettingType =
  | 'color'
  | 'font'
  | 'length'
  | 'pixels'
  | 'font-size'
  | 'align-v'
  | 'align-h';

/** The bounds of a `font-size` setting, in CSS pixels. */
export const MEMBERS_APP_FONT_SIZE = { min: 8, max: 48 } as const;

/** The three vertical positions a Section Card's text may take (#1152 §3). */
export const MEMBERS_APP_VERTICAL_ALIGNMENTS = ['top', 'center', 'bottom'] as const;
/** The three horizontal positions a Section Card's text may take (#1152 §3). */
export const MEMBERS_APP_HORIZONTAL_ALIGNMENTS = ['left', 'center', 'right'] as const;

export const MEMBERS_APP_SETTING_TYPES: Record<string, MembersAppSettingType> = {
  headerColor:                       'color',
  headerTextColor:                   'color',
  headerTextFont:                    'font',
  headerSeparatorColor:              'color',
  headerSeparatorWidth:              'pixels',
  backgroundColor:                   'color',
  sectionCardsBackgroundColor:       'color',
  sectionCardsBorderColor:           'color',
  sectionCardsBorderWidth:           'length',
  sectionCardsTextColor:             'color',
  sectionCardsTextSize:              'font-size',
  sectionCardsTextFont:              'font',
  sectionCardsTextVertical:          'align-v',
  sectionCardsTextHorizontal:        'align-h',
  title1Color:                       'color',
  title1Font:                        'font',
  title2Color:                       'color',
  title2Font:                        'font',
  title3Color:                       'color',
  title3Font:                        'font',
  text1Color:                        'color',
  text2Color:                        'color',
  text3Color:                        'color',
  calendarBackgroundColor:           'color',
  calendarHeaderColor:               'color',
  calendarButtonsColor:              'color',
  calendarTimeColumnBackgroundColor: 'color',
  calendarTimeColumnTextColor:       'color',
  calendarModalBackgroundColor:      'color',
  calendarModalInputBackgroundColor: 'color',
};

export const MEMBERS_APP_SETTING_KEYS = Object.keys(MEMBERS_APP_SETTING_TYPES);

/**
 * `null` is accepted and means the same as an absent key — inherited. The
 * editor removes a restored key outright, but a client that clears one by
 * writing `null` must not be rejected, and the reading side treats the two the
 * same way `advanced` has always treated a cleared attribute.
 */
export function validateMembersApp(membersApp: any): string | null {
  if (membersApp === undefined || membersApp === null) return null;
  if (typeof membersApp !== 'object' || Array.isArray(membersApp)) {
    return 'membersApp must be an object of Members App setting overrides';
  }
  for (const [key, value] of Object.entries(membersApp as Record<string, unknown>)) {
    const type = MEMBERS_APP_SETTING_TYPES[key];
    if (!type) return `membersApp.${key} is not a Members App setting`;
    if (value === null || value === undefined) continue;
    if (type === 'color') {
      if (typeof value !== 'string' || !HEX_RE.test(value)) {
        return `membersApp.${key} must be a hex color like #rrggbb`;
      }
    } else if (type === 'font') {
      if (typeof value !== 'string' || !FONT_STACKS.includes(value)) {
        return `membersApp.${key} must be one of the allowed font stacks`;
      }
    } else if (type === 'pixels') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 20) {
        return `membersApp.${key} must be an integer 0–20`;
      }
    } else if (type === 'font-size') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < MEMBERS_APP_FONT_SIZE.min || n > MEMBERS_APP_FONT_SIZE.max) {
        return `membersApp.${key} must be an integer ${MEMBERS_APP_FONT_SIZE.min}–${MEMBERS_APP_FONT_SIZE.max}`;
      }
    } else if (type === 'align-v') {
      if (typeof value !== 'string' || !(MEMBERS_APP_VERTICAL_ALIGNMENTS as readonly string[]).includes(value)) {
        return `membersApp.${key} must be one of ${MEMBERS_APP_VERTICAL_ALIGNMENTS.join(', ')}`;
      }
    } else if (type === 'align-h') {
      if (typeof value !== 'string' || !(MEMBERS_APP_HORIZONTAL_ALIGNMENTS as readonly string[]).includes(value)) {
        return `membersApp.${key} must be one of ${MEMBERS_APP_HORIZONTAL_ALIGNMENTS.join(', ')}`;
      }
    } else if (typeof value !== 'string' || value.trim() === '') {
      return `membersApp.${key} must be a non-empty CSS length`;
    }
  }
  return null;
}
