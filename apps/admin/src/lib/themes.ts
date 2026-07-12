/**
 * Per-gym chrome themes. Kept in sync with:
 *   - api/src/api/gyms.ts THEME_KEYS
 *   - api/src/infra/migrations/030_gym_theme.js
 *
 * Adding a preset needs an update in all three plus the CHECK constraint.
 * The keys are stored as-is in gyms.theme_key.
 */
export const THEMES = {
  indigo:  { brand: '#6c63ff', chrome: '#1a1a2e', accent: '#4c46bf' },
  emerald: { brand: '#1e9e6a', chrome: '#123024', accent: '#0f7d54' },
  crimson: { brand: '#c94559', chrome: '#2b1220', accent: '#a03445' },
  amber:   { brand: '#c7811a', chrome: '#2b1e0f', accent: '#a26910' },
} as const;

export type ThemeKey = keyof typeof THEMES;
export const THEME_KEYS = Object.keys(THEMES) as ThemeKey[];
export const DEFAULT_THEME: ThemeKey = 'indigo';

/** Type guard for values coming off the wire (backend returns string). */
export function isThemeKey(k: unknown): k is ThemeKey {
  return typeof k === 'string' && k in THEMES;
}
