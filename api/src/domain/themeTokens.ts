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
      textColor:                    '#111827',
      cardBackground:               '#ffffff',
      cardBorder:                   '#e5e7eb',
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
}

export function validateTokens(tokens: any): string | null {
  if (!tokens || typeof tokens !== 'object') return 'tokens must be an object';
  const { colors, typography } = tokens;
  if (colors) {
    const hexFields = [
      'pageBackground', 'textColor', 'cardBackground', 'cardBorder',
      'headerBackground', 'headerText', 'headerSeparatorColor',
      'sidebarBackground', 'sidebarText',
      'sidebarSelectedItemBackground', 'sidebarSelectedItemText', 'sidebarHoverBackground',
      'dropdownBackground', 'dropdownText', 'dropdownHoverBackground',
      'primaryButton', 'primaryButtonText', 'secondaryButton', 'secondaryButtonText',
      'statusSuccess', 'statusWarning', 'statusError', 'statusInfo',
      'linkColor', 'linkHoverColor',
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
