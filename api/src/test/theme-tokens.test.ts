// Unit tests for api/src/domain/themeTokens.ts — pure functions, no DB/HTTP.
import { describe, expect, it } from 'vitest';
import { CALENDAR_COLOR_FIELDS, defaultTokens, validateTokens } from '../domain/themeTokens';

describe('defaultTokens()', () => {
  it('returns tokens that pass validateTokens()', () => {
    expect(validateTokens(defaultTokens())).toBeNull();
  });

  it('defines every #559 calendar color token', () => {
    const colors = defaultTokens().colors as Record<string, unknown>;
    for (const field of CALENDAR_COLOR_FIELDS) {
      expect(colors[field], `defaultTokens() is missing colors.${field}`).toBeTypeOf('string');
    }
  });

  it('does not define event background/border tokens — event color stays status-derived (#541)', () => {
    const colors = defaultTokens().colors as Record<string, unknown>;
    expect(colors.calendarEventBackground).toBeUndefined();
    expect(colors.calendarEventBorder).toBeUndefined();
  });
});

describe('validateTokens()', () => {
  it('rejects a non-object', () => {
    expect(validateTokens(null)).toMatch(/must be an object/);
    expect(validateTokens('nope')).toMatch(/must be an object/);
  });

  it('accepts a partial tokens object with only some fields set', () => {
    expect(validateTokens({ colors: { textColor: '#111827' } })).toBeNull();
  });

  it('rejects an invalid hex color', () => {
    const err = validateTokens({ colors: { textColor: 'not-a-color' } });
    expect(err).toBe('colors.textColor must be a hex color like #rrggbb');
  });

  it('validates the #489 stage-2 semantic tokens (secondary/muted text, separator, input border/background)', () => {
    expect(validateTokens({
      colors: {
        secondaryTextColor: '#374151',
        mutedTextColor: '#6b7280',
        separatorColor: '#e5e7eb',
        inputBorderColor: '#d1d5db',
        inputBackgroundColor: '#ffffff',
      },
    })).toBeNull();

    expect(validateTokens({ colors: { secondaryTextColor: 'nope' } })).toBe('colors.secondaryTextColor must be a hex color like #rrggbb');
    expect(validateTokens({ colors: { mutedTextColor: 'nope' } })).toBe('colors.mutedTextColor must be a hex color like #rrggbb');
    expect(validateTokens({ colors: { separatorColor: 'nope' } })).toBe('colors.separatorColor must be a hex color like #rrggbb');
    expect(validateTokens({ colors: { inputBorderColor: 'nope' } })).toBe('colors.inputBorderColor must be a hex color like #rrggbb');
    expect(validateTokens({ colors: { inputBackgroundColor: 'nope' } })).toBe('colors.inputBackgroundColor must be a hex color like #rrggbb');
  });

  it('validates the #558 sectionHeadingTextColor token', () => {
    expect(validateTokens({ colors: { sectionHeadingTextColor: '#888888' } })).toBeNull();
    expect(validateTokens({ colors: { sectionHeadingTextColor: 'nope' } })).toBe('colors.sectionHeadingTextColor must be a hex color like #rrggbb');
  });

  it('validates every #559 calendar color token', () => {
    for (const field of CALENDAR_COLOR_FIELDS) {
      expect(validateTokens({ colors: { [field]: '#123abc' } }), `colors.${field} should accept a valid hex`).toBeNull();
      expect(validateTokens({ colors: { [field]: 'not-a-color' } })).toBe(`colors.${field} must be a hex color like #rrggbb`);
    }
  });

  it('accepts a legacy theme with no calendar tokens at all (backward compatibility)', () => {
    // Themes persisted before #559 have no `calendar*` keys — validation must
    // treat them as absent rather than invalid, so existing themes keep saving.
    expect(validateTokens({ colors: { textColor: '#111827', pageBackground: '#f5f5f5' } })).toBeNull();
  });

  it('rejects headerSeparatorHeight outside 0-20', () => {
    expect(validateTokens({ colors: { headerSeparatorHeight: 21 } })).toMatch(/headerSeparatorHeight/);
    expect(validateTokens({ colors: { headerSeparatorHeight: -1 } })).toMatch(/headerSeparatorHeight/);
    expect(validateTokens({ colors: { headerSeparatorHeight: 5 } })).toBeNull();
  });

  it('rejects a typography font stack not in the allowed list', () => {
    const err = validateTokens({ typography: { h1: { fontFamily: 'Comic Sans' } } });
    expect(err).toBe('typography.h1.fontFamily must be one of the allowed stacks');
  });

  it('rejects an invalid typography color', () => {
    const err = validateTokens({ typography: { body: { color: 'red' } } });
    expect(err).toBe('typography.body.color must be a hex color');
  });
});
