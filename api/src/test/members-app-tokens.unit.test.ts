import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBERS_APP_FONT_SIZE,
  MEMBERS_APP_HORIZONTAL_ALIGNMENTS,
  MEMBERS_APP_SETTING_KEYS,
  MEMBERS_APP_SETTING_TYPES,
  MEMBERS_APP_VERTICAL_ALIGNMENTS,
  validateMembersApp,
} from '../domain/membersAppTokens';
import { FONT_STACKS, defaultTokens, validateTokens } from '../domain/themeTokens';

// #833 — what may be written into `themes.tokens.membersApp`. Pure validation,
// no DB and no HTTP: both Theme routers write the blob through
// `validateTokens()`, so this is the whole of the server-side rule.

describe('membersApp overrides: validation (#833)', () => {
  it('accepts a Theme that overrides nothing', () => {
    // The normal case: an inherited setting is not stored, so most Themes carry
    // no `membersApp` map at all (§13, §19).
    expect(validateTokens(defaultTokens())).toBeNull();
    expect(validateMembersApp(undefined)).toBeNull();
    expect(validateMembersApp(null)).toBeNull();
    expect(validateMembersApp({})).toBeNull();
  });

  it('accepts one well-formed override per type', () => {
    expect(validateMembersApp({
      headerColor: '#000000',
      headerTextFont: FONT_STACKS[1],
      headerSeparatorWidth: 4,
      sectionCardsBorderWidth: '2px',
      sectionCardsTextSize: 16,
      sectionCardsTextVertical: 'bottom',
      sectionCardsTextHorizontal: 'left',
      title1Font: FONT_STACKS[2],
    })).toBeNull();
  });

  it('bounds a Section Card text size and refuses anything outside it (#1152 §3)', () => {
    expect(MEMBERS_APP_FONT_SIZE).toEqual({ min: 8, max: 48 });
    for (const bad of [7, 49, 12.5, '16px', 'large']) {
      expect(validateMembersApp({ sectionCardsTextSize: bad }), String(bad))
        .toBe('membersApp.sectionCardsTextSize must be an integer 8–48');
    }
    for (const ok of [8, 13, 48]) {
      expect(validateMembersApp({ sectionCardsTextSize: ok }), String(ok)).toBeNull();
    }
  });

  it('accepts only the three positions on each axis, and never one axis’s word on the other (#1152 §3)', () => {
    expect([...MEMBERS_APP_VERTICAL_ALIGNMENTS]).toEqual(['top', 'center', 'bottom']);
    expect([...MEMBERS_APP_HORIZONTAL_ALIGNMENTS]).toEqual(['left', 'center', 'right']);
    for (const ok of MEMBERS_APP_VERTICAL_ALIGNMENTS) {
      expect(validateMembersApp({ sectionCardsTextVertical: ok }), ok).toBeNull();
    }
    for (const ok of MEMBERS_APP_HORIZONTAL_ALIGNMENTS) {
      expect(validateMembersApp({ sectionCardsTextHorizontal: ok }), ok).toBeNull();
    }
    for (const bad of ['left', 'middle', 'flex-start', 1, '']) {
      expect(validateMembersApp({ sectionCardsTextVertical: bad }), String(bad))
        .toBe('membersApp.sectionCardsTextVertical must be one of top, center, bottom');
    }
    for (const bad of ['top', 'start', 'centre', 0]) {
      expect(validateMembersApp({ sectionCardsTextHorizontal: bad }), String(bad))
        .toBe('membersApp.sectionCardsTextHorizontal must be one of left, center, right');
    }
  });

  it('holds a Title font to the one font catalogue (#1152 §2, §5)', () => {
    for (const key of ['title1Font', 'title2Font', 'title3Font', 'sectionCardsTextFont']) {
      expect(MEMBERS_APP_SETTING_TYPES[key]).toBe('font');
      expect(validateMembersApp({ [key]: FONT_STACKS[3] }), key).toBeNull();
      expect(validateMembersApp({ [key]: 'Comic Sans MS' }), key)
        .toBe(`membersApp.${key} must be one of the allowed font stacks`);
    }
  });

  it('accepts a null as "inherited" rather than rejecting it', () => {
    // The editor removes a restored key outright, but a client that clears one
    // by writing null must not be refused — the reading side treats the two the
    // same way `advanced` has always treated a cleared attribute.
    for (const key of MEMBERS_APP_SETTING_KEYS) {
      expect(validateMembersApp({ [key]: null }), key).toBeNull();
    }
  });

  it('refuses a key that is not a Members App setting', () => {
    expect(validateMembersApp({ headerColour: '#000000' }))
      .toBe('membersApp.headerColour is not a Members App setting');
  });

  it('refuses a colour that is not a hex triplet', () => {
    for (const bad of ['red', '#fff', '', 'rgb(0,0,0)', 12]) {
      expect(validateMembersApp({ headerColor: bad }), String(bad))
        .toBe('membersApp.headerColor must be a hex color like #rrggbb');
    }
  });

  it('refuses a font outside the allowed stacks', () => {
    expect(validateMembersApp({ headerTextFont: 'Comic Sans MS' }))
      .toBe('membersApp.headerTextFont must be one of the allowed font stacks');
    for (const stack of FONT_STACKS) {
      expect(validateMembersApp({ headerTextFont: stack }), stack).toBeNull();
    }
  });

  it('bounds the separator width exactly as the Admin setting is bounded', () => {
    // `colors.headerSeparatorHeight` is an integer 0–20, and the Members App
    // setting inherits from it, so it cannot accept more than its source can.
    for (const bad of [-1, 21, 1.5, 'thick']) {
      expect(validateMembersApp({ headerSeparatorWidth: bad }), String(bad))
        .toBe('membersApp.headerSeparatorWidth must be an integer 0–20');
    }
    for (const ok of [0, 1, 20]) {
      expect(validateMembersApp({ headerSeparatorWidth: ok }), String(ok)).toBeNull();
    }
  });

  it('refuses a blank CSS length', () => {
    for (const bad of ['', '   ', 3]) {
      expect(validateMembersApp({ sectionCardsBorderWidth: bad }), String(bad))
        .toBe('membersApp.sectionCardsBorderWidth must be a non-empty CSS length');
    }
  });

  it('refuses a membersApp that is not a map of settings', () => {
    for (const bad of [[], 'headerColor', 3]) {
      expect(validateMembersApp(bad), String(bad))
        .toBe('membersApp must be an object of Members App setting overrides');
    }
  });

  it('is reached by validateTokens, so both Theme routers apply it', () => {
    const tokens: any = defaultTokens();
    tokens.membersApp = { headerColor: 'not-a-colour' };
    expect(validateTokens(tokens)).toBe('membersApp.headerColor must be a hex color like #rrggbb');
    tokens.membersApp = { headerColor: '#123456' };
    expect(validateTokens(tokens)).toBeNull();
  });

  it('accepts every setting the Admin editor can configure', () => {
    // The key list mirrors apps/admin/src/lib/membersAppTokens.ts, which
    // declares §8's mapping. A setting added there and missed here would be
    // editable in the editor and rejected on save.
    const adminSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'apps', 'admin', 'src', 'lib', 'membersAppTokens.ts'),
      'utf-8',
    );
    const adminKeys = [...adminSrc.matchAll(/^    key: '(\w+)',$/gm)].map((m) => m[1]);
    expect(adminKeys.length).toBeGreaterThan(0);
    expect(adminKeys.sort()).toEqual([...MEMBERS_APP_SETTING_KEYS].sort());
    for (const key of adminKeys) {
      const declared = adminSrc.match(new RegExp(`key: '${key}',[\\s\\S]*?type: '([\\w-]+)',`))?.[1];
      expect(declared, `${key} declares no type`).toBe(MEMBERS_APP_SETTING_TYPES[key]);
    }
  });
  it('#1283: both button text colours inherit the global Buttons tokens and write the variables memberTheme reads', () => {
    for (const [key, source, cssVar] of [
      ['primaryButtonTextColor', 'primaryButtonText', '--gd-primary-btn-text'],
      ['secondaryButtonTextColor', 'secondaryButtonText', '--gd-secondary-btn-text'],
    ]) {
      expect(MEMBERS_APP_SETTING_TYPES[key]).toBe('color');
      for (const app of ['admin', 'member']) {
        const src = readFileSync(
          join(__dirname, '..', '..', '..', 'apps', app, 'src', 'lib', 'membersAppTokens.ts'),
          'utf-8',
        );
        const block = src.match(new RegExp(`key: '${key}',[\\s\\S]*?cssVar: '([^']+)'`));
        expect(block?.[0], `${app} declares ${key}`).toContain(`key: '${source}'`);
        expect(block?.[1]).toBe(cssVar);
      }
    }
    expect(validateMembersApp({ secondaryButtonTextColor: '#123456' })).toBeNull();
  });
});
