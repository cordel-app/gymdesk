'use client';

import { ThemeAdvancedSection } from '@/components/ThemeAdvancedSection';
import { DEFAULT_TOKENS, FONT_STACKS, type ThemeTokens } from '@/lib/themeTokens';

// Shared by the Custom Themes (`[locale]/themes`) and Base Themes
// (`[locale]/system/themes`) editors (#492) — both edit the same
// `ThemeTokens` shape and previously duplicated this rendering byte-for-byte.
export const COLOR_GROUPS: { groupKey: string; fields: { key: keyof ThemeTokens['colors']; labelKey: string }[] }[] = [
  {
    groupKey: 'group_application',
    fields: [
      { key: 'pageBackground', labelKey: 'label_page_bg' },
    ],
  },
  {
    groupKey: 'group_cards',
    fields: [
      { key: 'cardBackground', labelKey: 'label_card_bg' },
      { key: 'cardBorder', labelKey: 'label_card_border' },
    ],
  },
  {
    groupKey: 'group_text',
    fields: [
      { key: 'textColor', labelKey: 'label_text_color' },
      { key: 'secondaryTextColor', labelKey: 'label_secondary_text_color' },
      { key: 'mutedTextColor', labelKey: 'label_muted_text_color' },
      { key: 'sectionHeadingTextColor', labelKey: 'label_section_heading_text_color' },
    ],
  },
  {
    groupKey: 'group_separators',
    fields: [
      { key: 'separatorColor', labelKey: 'label_separator_color' },
    ],
  },
  {
    groupKey: 'group_inputs',
    fields: [
      { key: 'inputBackgroundColor', labelKey: 'label_input_background_color' },
      { key: 'inputBorderColor', labelKey: 'label_input_border_color' },
    ],
  },
  {
    groupKey: 'group_header',
    fields: [
      { key: 'headerBackground', labelKey: 'label_header_bg' },
      { key: 'headerText', labelKey: 'label_header_text' },
      { key: 'headerSeparatorColor', labelKey: 'label_header_sep_color' },
    ],
  },
  {
    groupKey: 'group_sidebar',
    fields: [
      { key: 'sidebarBackground', labelKey: 'label_sidebar_bg' },
      { key: 'sidebarText', labelKey: 'label_sidebar_text' },
      { key: 'sidebarSelectedItemBackground', labelKey: 'label_sidebar_sel_bg' },
      { key: 'sidebarSelectedItemText', labelKey: 'label_sidebar_sel_text' },
      { key: 'sidebarHoverBackground', labelKey: 'label_sidebar_hover_bg' },
    ],
  },
  {
    groupKey: 'group_navigation',
    fields: [
      { key: 'dropdownBackground', labelKey: 'label_dropdown_bg' },
      { key: 'dropdownText', labelKey: 'label_dropdown_text' },
      { key: 'dropdownHoverBackground', labelKey: 'label_dropdown_hover_bg' },
    ],
  },
  {
    groupKey: 'group_buttons',
    fields: [
      { key: 'primaryButton', labelKey: 'label_primary_btn' },
      { key: 'primaryButtonText', labelKey: 'label_primary_btn_text' },
      { key: 'secondaryButton', labelKey: 'label_secondary_btn' },
      { key: 'secondaryButtonText', labelKey: 'label_secondary_btn_text' },
    ],
  },
  {
    groupKey: 'group_status',
    fields: [
      { key: 'statusSuccess', labelKey: 'label_status_success' },
      { key: 'statusWarning', labelKey: 'label_status_warning' },
      { key: 'statusError', labelKey: 'label_status_error' },
      { key: 'statusInfo', labelKey: 'label_status_info' },
    ],
  },
  {
    groupKey: 'group_links',
    fields: [
      { key: 'linkColor', labelKey: 'label_link_color' },
      { key: 'linkHoverColor', labelKey: 'label_link_hover_color' },
    ],
  },
  {
    // No dedicated colors of its own — holds only the table-density attributes
    // formerly under the standalone "Advanced" section (#489 stage 2).
    groupKey: 'group_tables',
    fields: [],
  },
  {
    // #559 stage 1. Rendered identically in Base Themes and Custom Themes —
    // both editors map over COLOR_GROUPS through ThemeColorsEditor, so this
    // one entry gives both screens the section. Per the #559 clarification,
    // the Base/Custom relationship itself is unchanged: cloning a Base Theme
    // copies these values along with every other token, exactly as today.
    // Stage 1 persists and validates these tokens; stage 2 wires them to
    // --gd-calendar-* CSS variables, so saving one has no visual effect yet.
    groupKey: 'group_calendar',
    fields: [
      { key: 'calendarBackground', labelKey: 'label_calendar_bg' },
      { key: 'calendarSurfaceBackground', labelKey: 'label_calendar_surface_bg' },
      { key: 'calendarHeaderBackground', labelKey: 'label_calendar_header_bg' },
      { key: 'calendarHeaderText', labelKey: 'label_calendar_header_text' },
      { key: 'calendarDayText', labelKey: 'label_calendar_day_text' },
      { key: 'calendarMutedDayText', labelKey: 'label_calendar_muted_day_text' },
      { key: 'calendarTodayBackground', labelKey: 'label_calendar_today_bg' },
      { key: 'calendarSelectionBackground', labelKey: 'label_calendar_selection_bg' },
      { key: 'calendarGridBorder', labelKey: 'label_calendar_grid_border' },
      { key: 'calendarTimeAxisBackground', labelKey: 'label_calendar_time_axis_bg' },
      { key: 'calendarTimeAxisText', labelKey: 'label_calendar_time_axis_text' },
      { key: 'calendarWeekendBackground', labelKey: 'label_calendar_weekend_bg' },
      { key: 'calendarDisabledSlotBackground', labelKey: 'label_calendar_disabled_slot_bg' },
      { key: 'calendarEventText', labelKey: 'label_calendar_event_text' },
      { key: 'calendarNavButtonBackground', labelKey: 'label_calendar_nav_btn_bg' },
      { key: 'calendarNavButtonText', labelKey: 'label_calendar_nav_btn_text' },
    ],
  },
];

export const TYPO_LEVELS = ['h1', 'h2', 'h3', 'body', 'small'] as const;

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6,
  border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff',
};

interface EditorProps {
  tokens: ThemeTokens;
  onChange: (next: ThemeTokens) => void;
  namespace: 'gym_themes' | 'themes';
  // Typed loosely — callers pass their namespaced `useTranslations()` result,
  // which is typed to a specific key union that dynamic group/label keys
  // (COLOR_GROUPS, ADVANCED_ATTRIBUTES) don't statically satisfy.
  t: (key: any) => string;
  readOnly?: boolean;
}

// Colors groups + inline Advanced attributes for each group (draft-only —
// the caller decides when/whether `onChange` triggers a live preview or a
// persistence call; this component never calls either directly).
export function ThemeColorsEditor({ tokens, onChange, namespace, t, readOnly }: EditorProps) {
  const advanced = tokens.advanced ?? {};
  return (
    <div>
      {COLOR_GROUPS.map(({ groupKey, fields }) => (
        <div key={groupKey} style={{ marginBottom: 20 }}>
          <p style={{ margin: '0 0 10px', fontSize: 11, fontWeight: 700, color: 'var(--gd-section-heading-text, #888888)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t(groupKey)}</p>
          {fields.map(({ key, labelKey }) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{t(labelKey)}</span>
              <input
                type="color"
                disabled={readOnly}
                // Themes persisted before a token was introduced have no value
                // for it (the Calendar group in #559, the Text/Separator/Input
                // groups in #489). Fall back to the default so the picker stays
                // a controlled input showing the color actually in effect,
                // rather than rendering blank — matches applyTokens()'s own
                // `?? DEFAULT_TOKENS.colors.x` fallbacks.
                value={(tokens.colors[key] ?? DEFAULT_TOKENS.colors[key]) as string}
                onChange={(e) => onChange({ ...tokens, colors: { ...tokens.colors, [key]: e.target.value } })}
                style={{ width: 48, height: 36, border: '1px solid #ccc', borderRadius: 4, cursor: readOnly ? 'default' : 'pointer', padding: 2 }}
              />
            </div>
          ))}
          {groupKey === 'group_header' && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{t('label_header_sep_height')}</span>
              <input
                type="number"
                min={0}
                max={20}
                disabled={readOnly}
                value={tokens.colors.headerSeparatorHeight}
                onChange={(e) => onChange({ ...tokens, colors: { ...tokens.colors, headerSeparatorHeight: Number(e.target.value) } })}
                style={{ width: 80, padding: '6px 10px', border: '1px solid #ccc', borderRadius: 4, fontSize: 14 }}
              />
            </div>
          )}
          {!readOnly && (
            <ThemeAdvancedSection
              group={groupKey}
              advanced={advanced}
              onChange={(next) => onChange({ ...tokens, advanced: next })}
              namespace={namespace}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function ThemeTypographyEditor({ tokens, onChange, t }: Omit<EditorProps, 'namespace' | 'readOnly'>) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px', gap: '8px 12px', alignItems: 'center' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_level')}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_font')}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_color')}</span>
      {TYPO_LEVELS.map((lv) => {
        const typo = tokens.typography[lv];
        return (
          <>
            <span key={`${lv}-label`} style={{ fontSize: 13 }}>{lv}</span>
            <select
              key={`${lv}-font`}
              value={typo.fontFamily}
              onChange={(e) => onChange({ ...tokens, typography: { ...tokens.typography, [lv]: { ...typo, fontFamily: e.target.value } } })}
              style={selectStyle}
            >
              {FONT_STACKS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <input
              key={`${lv}-color`}
              type="color"
              value={typo.color}
              onChange={(e) => onChange({ ...tokens, typography: { ...tokens.typography, [lv]: { ...typo, color: e.target.value } } })}
              style={{ width: 48, height: 36, border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer', padding: 2 }}
            />
          </>
        );
      })}
    </div>
  );
}
