// Unit tests for api/src/domain/themeTokens.ts — pure functions, no DB/HTTP.
import { describe, expect, it } from 'vitest';
import { defaultTokens, validateTokens } from '../domain/themeTokens';

describe('defaultTokens()', () => {
  it('returns tokens that pass validateTokens()', () => {
    expect(validateTokens(defaultTokens())).toBeNull();
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
