// #2158 — the six dark Base Themes seeded by migration 351.
import { describe, it, expect } from 'vitest';
import { defaultTokens, validateTokens } from '../domain/themeTokens';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { THEMES, tokensFor } = require('../infra/migrations/351_six_dark_base_themes.js');

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('six dark base themes', () => {
  it('declares the six names with distinct accents', () => {
    expect(THEMES.map((t: any) => t.name)).toEqual(['Midnight', 'Obsidian', 'Forest', 'Ember', 'Solaris', 'Crimson']);
    expect(new Set(THEMES.map((t: any) => t.accent)).size).toBe(6);
  });

  for (const t of THEMES) {
    describe(t.name, () => {
      const tokens = tokensFor(t);
      it('passes the API token validation and defines every colour token', () => {
        expect(validateTokens(tokens)).toBeNull();
        expect(Object.keys(tokens.colors).sort()).toEqual(Object.keys(defaultTokens().colors).sort());
      });
      it('is a dark theme with readable text and buttons', () => {
        expect(luminance(tokens.colors.pageBackground)).toBeLessThan(0.05);
        expect(contrast(tokens.colors.textColor, tokens.colors.pageBackground)).toBeGreaterThanOrEqual(7);
        expect(contrast(tokens.colors.mutedTextColor, tokens.colors.cardBackground)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens.colors.primaryButtonText, tokens.colors.primaryButton)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens.colors.calendarEventText, tokens.colors.calendarEventBackground)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens.colors.linkColor, tokens.colors.cardBackground)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});
