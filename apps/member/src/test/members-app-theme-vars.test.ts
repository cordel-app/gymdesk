import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_MEMBERS_APP_SOURCE_ADVANCED,
  MEMBERS_APP_SETTINGS,
  alignmentCssValue,
  cardBoxShadow,
  cardEffectCssValue,
  cardEdgeFlags,
  applyMembersAppTokens,
  effectiveMembersAppValue,
  inheritedMembersAppValue,
  membersAppCssVars,
} from '../lib/membersAppTokens';
import { DEFAULT_TOKENS, applyTokens, type ThemeTokens } from '../lib/themeTokens';

// #833 — the Members App renders with its own theme settings, each following
// the Admin setting it inherits from unless the active Theme overrides it.
//
// The declaration is Admin's (apps/admin/src/lib/membersAppTokens.ts, which
// holds §8's mapping); this file's copy is a mirror, so the first block below
// fails if the two drift — the convention lib/themeTokens.ts has followed since
// #489 stage 4.

const ADMIN_LIB = join(__dirname, '..', '..', '..', 'admin', 'src', 'lib');

function stubDocument(): Record<string, string> {
  const written: Record<string, string> = {};
  (globalThis as any).document = {
    documentElement: {
      style: { setProperty: (name: string, value: string) => { written[name] = value; } },
    },
  };
  return written;
}

describe('Members App theme settings: mirror of the Admin declaration (#833)', () => {
  const adminSrc = readFileSync(join(ADMIN_LIB, 'membersAppTokens.ts'), 'utf-8');
  const adminThemeTokens = readFileSync(join(ADMIN_LIB, 'themeTokens.ts'), 'utf-8');

  it('declares the same settings, sources and CSS variables Admin does', () => {
    for (const setting of MEMBERS_APP_SETTINGS) {
      const { key, cssVar, type, source } = setting;
      expect(adminSrc, `Admin has no ${key}`).toContain(`key: '${key}'`);
      expect(adminSrc, `Admin does not map ${key} to ${cssVar}`).toContain(`cssVar: '${cssVar}'`);
      expect(adminSrc, `Admin has no ${type} setting`).toContain(`type: '${type}'`);
      if (source === null) {
        const dflt = typeof setting.default === 'string' ? `'${setting.default}'` : String(setting.default);
        expect(adminSrc, `Admin declares another default for ${key}`)
          .toMatch(new RegExp(`key: '${key}',[\\s\\S]*?source: null,\\s*default: ${dflt},`));
      } else if (source.kind !== 'typography') {
        expect(adminSrc).toContain(`key: '${source.key}', labelKey: '${source.labelKey}'`);
      } else {
        expect(adminSrc).toContain(`level: '${source.level}', field: '${source.field}', labelKey: '${source.labelKey}'`);
      }
    }
    // And nothing Admin declares is missing here: the count has to match, or a
    // setting configurable in the editor would never be painted.
    const adminKeys = adminSrc.match(/^    key: '(\w+)',$/gm) ?? [];
    expect(adminKeys.length).toBe(MEMBERS_APP_SETTINGS.length);
  });

  it('keeps the advanced-source defaults in step with Admin’s DEFAULT_ADVANCED', () => {
    for (const [key, value] of Object.entries(DEFAULT_MEMBERS_APP_SOURCE_ADVANCED)) {
      expect(adminThemeTokens, `Admin's default for ${key} is not ${value}`).toContain(`${key}: '${value}'`);
    }
  });
});

describe('Members App theme settings: resolution (#833)', () => {
  let written: Record<string, string>;

  beforeEach(() => { written = stubDocument(); });
  afterEach(() => { delete (globalThis as any).document; });

  it('inherits every setting from its Admin source on a Theme that overrides nothing', () => {
    applyMembersAppTokens(DEFAULT_TOKENS);
    for (const setting of MEMBERS_APP_SETTINGS) {
      const inherited = inheritedMembersAppValue(DEFAULT_TOKENS, setting);
      const expected =
        setting.type === 'pixels' || setting.type === 'font-size' ? `${inherited}px`
        : setting.type === 'align-v' || setting.type === 'align-h' ? alignmentCssValue(setting.type, inherited)
        : setting.type === 'card-shape' || setting.type === 'card-edges' || setting.type === 'card-shadow' || setting.type === 'card-glow' || setting.type === 'card-style' ? cardEffectCssValue(setting.type, inherited)
        : String(inherited);
      expect(written[setting.cssVar], `${setting.key} does not follow its Admin source`).toBe(expected);
    }
  });

  it('follows the Admin value as it is today, not a snapshot', () => {
    const edited = {
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, headerBackground: '#eeeeee', pageBackground: '#fafafa' },
    } as ThemeTokens;
    applyMembersAppTokens(edited);
    expect(written['--gd-members-header-bg']).toBe('#eeeeee');
    expect(written['--gd-app-bg']).toBe('#fafafa');
  });

  it('paints an overridden setting with the override and leaves the rest inherited', () => {
    const themed = {
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, headerBackground: '#eeeeee' },
      membersApp: { headerColor: '#000000' },
    } as ThemeTokens;
    applyMembersAppTokens(themed);
    expect(written['--gd-members-header-bg']).toBe('#000000');
    expect(written['--gd-members-header-text']).toBe(DEFAULT_TOKENS.colors.headerText);
  });

  it('wins over the Theme variable it shares a name with', () => {
    // The page background, the calendar surfaces and the title colours are
    // painted through the same variables Admin's own tokens use, so the
    // Members App value has to be written last.
    const themed = {
      ...DEFAULT_TOKENS,
      membersApp: { backgroundColor: '#010203', calendarBackgroundColor: '#040506', title1Color: '#070809' },
    } as ThemeTokens;
    applyTokens(themed);
    applyMembersAppTokens(themed);
    expect(written['--gd-app-bg']).toBe('#010203');
    expect(written['--gd-calendar-bg']).toBe('#040506');
    expect(written['--gd-color-h1']).toBe('#070809');
  });

  it('keeps the time column and the event window off the calendar background', () => {
    const themed = {
      ...DEFAULT_TOKENS,
      membersApp: {
        calendarBackgroundColor: '#111111',
        calendarTimeColumnBackgroundColor: '#222222',
        calendarModalBackgroundColor: '#333333',
        calendarModalInputBackgroundColor: '#444444',
      },
    } as ThemeTokens;
    applyMembersAppTokens(themed);
    expect(written['--gd-calendar-bg']).toBe('#111111');
    expect(written['--gd-calendar-time-axis-bg']).toBe('#222222');
    expect(written['--gd-members-calendar-modal-bg']).toBe('#333333');
    expect(written['--gd-members-calendar-modal-input-bg']).toBe('#444444');
  });

  it('resolves a Theme saved before this ticket', () => {
    const legacy = { ...DEFAULT_TOKENS } as ThemeTokens;
    delete (legacy as any).advanced;
    delete (legacy as any).membersApp;
    applyMembersAppTokens(legacy);
    expect(written['--gd-members-header-font']).toBe(DEFAULT_MEMBERS_APP_SOURCE_ADVANCED.headerTextFont);
    expect(written['--gd-members-card-border-width']).toBe(DEFAULT_MEMBERS_APP_SOURCE_ADVANCED.cardBorderWidth);
    expect(written['--gd-members-calendar-modal-bg']).toBe(DEFAULT_MEMBERS_APP_SOURCE_ADVANCED.modalBackground);
  });

  it('falls back to the inherited value for an unusable stored one', () => {
    const broken = {
      ...DEFAULT_TOKENS,
      membersApp: { headerColor: '', headerTextFont: 'Papyrus', sectionCardsBorderWidth: '  ', headerSeparatorWidth: -1 },
    } as unknown as ThemeTokens;
    const vars = membersAppCssVars(broken);
    expect(vars['--gd-members-header-bg']).toBe(DEFAULT_TOKENS.colors.headerBackground);
    expect(vars['--gd-members-header-font']).toBe(DEFAULT_MEMBERS_APP_SOURCE_ADVANCED.headerTextFont);
    expect(vars['--gd-members-card-border-width']).toBe(DEFAULT_MEMBERS_APP_SOURCE_ADVANCED.cardBorderWidth);
    expect(vars['--gd-header-sep-height']).toBe(`${DEFAULT_TOKENS.colors.headerSeparatorHeight}px`);
  });

  it('treats an explicit null as inherited', () => {
    const nulled = { ...DEFAULT_TOKENS, membersApp: { headerColor: null } } as ThemeTokens;
    const header = MEMBERS_APP_SETTINGS.find((s) => s.key === 'headerColor')!;
    expect(effectiveMembersAppValue(nulled, header)).toBe(DEFAULT_TOKENS.colors.headerBackground);
  });

  it('paints a Title font over the Theme variable it shares a name with (#1152 §2)', () => {
    const themed = {
      ...DEFAULT_TOKENS,
      membersApp: { title1Font: 'Georgia, "Times New Roman", serif' },
    } as ThemeTokens;
    applyTokens(themed);
    applyMembersAppTokens(themed);
    expect(written['--gd-font-h1']).toBe('Georgia, "Times New Roman", serif');
    expect(written['--gd-font-h2']).toBe(DEFAULT_TOKENS.typography.h2.fontFamily);
  });

  it('paints the Section Card text from its five settings, defaults included (#1152 §3)', () => {
    applyMembersAppTokens(DEFAULT_TOKENS);
    expect(written['--gd-members-card-text']).toBe(DEFAULT_TOKENS.colors.textColor);
    expect(written['--gd-members-card-text-size']).toBe('13px');
    expect(written['--gd-members-card-text-font']).toBe(DEFAULT_TOKENS.typography.body.fontFamily);
    expect(written['--gd-members-card-text-vertical']).toBe('center');
    expect(written['--gd-members-card-text-horizontal']).toBe('center');
    const themed = {
      ...DEFAULT_TOKENS,
      membersApp: {
        sectionCardsTextColor: '#ffffff',
        sectionCardsTextSize: 20,
        sectionCardsTextFont: 'Arial, Helvetica, sans-serif',
        sectionCardsTextVertical: 'top',
        sectionCardsTextHorizontal: 'right',
      },
    } as ThemeTokens;
    applyMembersAppTokens(themed);
    expect(written['--gd-members-card-text']).toBe('#ffffff');
    expect(written['--gd-members-card-text-size']).toBe('20px');
    expect(written['--gd-members-card-text-font']).toBe('Arial, Helvetica, sans-serif');
    expect(written['--gd-members-card-text-vertical']).toBe('flex-start');
    expect(written['--gd-members-card-text-horizontal']).toBe('right');
  });
});

describe('Members App theme settings: where they are painted (#833, #983)', () => {
  // Comments in these files name the variables they replaced, so the scans run
  // on comment-free code.
  const read = (...parts: string[]) =>
    readFileSync(join(__dirname, '..', ...parts), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  // #983 — the variables are read in one place now (`lib/memberChrome.ts`, the
  // rule `listChrome.ts`/`formChrome.ts` are for the Admin app), and the
  // surfaces spread the objects it exports. So "is this setting painted?" is a
  // question about that module, and "does this surface follow the theme?" is a
  // question about which object it spreads.
  const chrome = read('lib', 'memberChrome.ts');

  it('applies them once the Theme’s own variables are written', () => {
    const provider = read('components', 'ThemeProvider.tsx');
    expect(provider).toContain('applyMembersAppTokens(tokens)');
    expect(provider.indexOf('applyTokens(tokens)')).toBeLessThan(provider.indexOf('applyMembersAppTokens(tokens)'));
  });

  it('paints the header from the Members App header settings, not the sidebar', () => {
    expect(chrome).toContain('var(--gd-members-header-bg');
    expect(chrome).toContain('var(--gd-members-header-text');
    expect(chrome).toContain('var(--gd-members-header-font');
    expect(chrome).toContain('var(--gd-header-sep-height');
    expect(chrome).toContain('var(--gd-header-sep-color');
    const topBar = read('components', 'TopBar.tsx');
    expect(topBar).toContain('memberTheme.headerBackground');
    expect(topBar).toContain('memberTheme.headerText');
    expect(topBar).toContain('memberTheme.headerFont');
    expect(topBar).toContain('memberTheme.headerSeparatorWidth');
    expect(topBar).toContain('memberTheme.headerSeparatorColor');
    expect(topBar, 'the header still borrows the sidebar colour').not.toContain('--gd-sidebar-bg');
  });

  it('borders every Section Card from one declaration', () => {
    expect(chrome).toContain('var(--gd-members-card-border,');
    expect(chrome).toContain('var(--gd-members-card-border-width, 1px)');
    // The tiles get it from the component every navigation card renders
    // through; the content cards of the sections it does not wrap get it from
    // `sectionCardStyle`. Neither restates the rule.
    const card = read('components', 'MembersSectionCard.tsx');
    expect(card).toContain('...sectionCardBorder');
    for (const page of [
      ['app', '[locale]', 'page.tsx'],
      ['app', '[locale]', 'membership', 'page.tsx'],
      ['app', '[locale]', 'training', 'page.tsx'],
      ['app', '[locale]', 'schedule', 'page.tsx'],
      ['app', '[locale]', 'nutrition', 'page.tsx'],
    ]) {
      const src = read(...page);
      expect(src, `${page.join('/')} does not use the shared Section Card surface`).toContain('sectionCardStyle');
      expect(src, `${page.join('/')} restates the Section Card border`).not.toContain('--gd-members-card-border');
    }
  });

  it('paints the titles from the Title 1/2/3 settings', () => {
    expect(chrome).toContain('var(--gd-color-h1,');
    expect(chrome).toContain('var(--gd-color-h2,');
    expect(chrome).toContain('var(--gd-color-h3,');
    // …and every screen with a heading takes its colour from there, rather
    // than from a literal of its own (§4).
    for (const page of [
      ['app', '[locale]', 'page.tsx'],
      ['app', '[locale]', 'membership', 'page.tsx'],
      ['app', '[locale]', 'nutrition', 'page.tsx'],
      ['app', '[locale]', 'packages', 'page.tsx'],
      ['app', '[locale]', 'profile', 'page.tsx'],
      ['app', '[locale]', 'schedule', 'page.tsx'],
      ['app', '[locale]', 'training', 'page.tsx'],
      ['app', '[locale]', 'notifications', 'page.tsx'],
    ]) {
      expect(read(...page), `${page.join('/')} does not use a Title setting`).toContain('memberTheme.title1');
    }
  });

  it('paints a heading in its Title font and a Section Card’s text in its five settings (#1152)', () => {
    for (const n of [1, 2, 3]) {
      expect(chrome).toContain(`var(--gd-font-h${n},`);
      expect(chrome).toContain(`title${n}Font:`);
    }
    for (const v of ['text', 'text-size', 'text-font', 'text-vertical', 'text-horizontal']) {
      expect(chrome).toContain(`var(--gd-members-card-${v},`);
    }
    expect(chrome).toContain('export const sectionCardText');
    const card = read('components', 'MembersSectionCard.tsx');
    // Under the caller's style, so a card that spells one of the five keeps it.
    expect(card).toContain('style: { ...sectionCardText, ...style, ');
    // …and the navigation tile spells none of them.
    const home = read('app', '[locale]', 'page.tsx');
    const tile = home.match(/tile:\s*\{[^}]*\}/)![0];
    const label = home.match(/tileLabel:\s*\{[^}]*\}/)![0];
    expect(tile + label).not.toMatch(/\bcolor:|fontSize|fontFamily|textAlign|justifyContent|alignItems/);
    // Every heading reads the pair.
    expect(home).toContain('color: memberTheme.title1, fontFamily: memberTheme.title1Font');
  });

  it('leaves no setting unpainted', () => {
    // Every Members App setting has to reach a surface: a setting the editor
    // persists but nothing reads is a setting that changes nothing (the #677
    // defect). The variables the FullCalendar sheet owns count through it.
    const sources = [chrome, read('components', 'CalendarThemeStyles.tsx')].join('\n');
    for (const { key, cssVar } of MEMBERS_APP_SETTINGS) {
      expect(sources, `${key} writes ${cssVar}, which nothing reads`).toContain(`var(${cssVar}`);
    }
  });

  it('paints the page background and the calendar surfaces where they belong', () => {
    // The background setting shares `--gd-app-bg` with the Admin page
    // background, so the body and the two full-height screens read it through
    // the one `pageBackground` value.
    expect(chrome).toContain("pageBackground: 'var(--gd-app-bg");
    expect(read('app', '[locale]', 'layout.tsx')).toContain('memberTheme.pageBackground');
    expect(chrome).toContain('var(--gd-members-calendar-modal-bg');
    expect(chrome).toContain('var(--gd-members-calendar-modal-input-bg');
    expect(chrome).toContain('var(--gd-calendar-nav-btn-bg');
    const calendar = read('app', '[locale]', 'calendar', 'page.tsx');
    expect(calendar).toContain('memberTheme.calendarModalBackground');
    expect(calendar).toContain('memberTheme.calendarModalInputBackground');
    // #983 §5/§7 — the filter bar's own buttons used to borrow the Admin
    // sidebar's selected colour, which no Members App setting can move.
    expect(calendar, 'the calendar still borrows the sidebar colour').not.toContain('--gd-sidebar-bg');
    expect(calendar).toContain('memberTheme.calendarButton');
  });

  it('resolves the background scrim from the Members App setting, not the Admin one', () => {
    // §6 — a Theme that overrides the Members App background must tint its
    // artwork with that colour; reading `colors.pageBackground` directly is
    // what made an overridden background invisible behind a photograph.
    const background = read('components', 'MembersBackground.tsx');
    expect(background).toContain('membersAppVarValue');
    expect(background).not.toContain('colors?.pageBackground');
  });
});

describe('Section Cards border width accepts bare pixels (#1216)', () => {
  const widthVar = (value?: string): string => {
    const tokens = { ...DEFAULT_TOKENS, membersApp: value === undefined ? undefined : { sectionCardsBorderWidth: value } } as ThemeTokens;
    return membersAppCssVars(tokens)['--gd-members-card-border-width'];
  };

  it('reads a bare number as pixels', () => {
    expect(widthVar('1')).toBe('1px');
    expect(widthVar('2')).toBe('2px');
    expect(widthVar('0')).toBe('0px');
  });

  it('leaves a value with a unit, and the inherited value, as they were', () => {
    expect(widthVar('1px')).toBe('1px');
    expect(widthVar('0.5px')).toBe('0.5px');
    expect(widthVar()).toBe('1px');
  });
});

describe('Section Card glow and visual style (#1321 stage 2)', () => {
  const themed = (membersApp: Record<string, string>) => ({ ...DEFAULT_TOKENS, membersApp }) as ThemeTokens;

  it('changes nothing by default: no glow, the clean style, the soft shadow alone', () => {
    const vars = membersAppCssVars(DEFAULT_TOKENS);
    expect(vars['--gd-members-card-style']).toBe('clean');
    expect(vars['--gd-members-card-effects']).toBe('0 1px 3px rgba(0,0,0,0.05)');
  });

  it('composes the drop shadow and the glow in one list, dropping a part that is off', () => {
    expect(cardBoxShadow('none', 'none', '#fff')).toBe('none');
    expect(cardBoxShadow('none', 'subtle', '#ff0000')).toBe('0 0 8px 1px color-mix(in srgb, #ff0000 60%, transparent)');
    expect(cardBoxShadow('0 1px 2px #000', 'strong', '#ff0000')).toContain('0 1px 2px #000, 0 0 18px 3px');
  });

  it('lets a style fill only what the theme has not set', () => {
    expect(membersAppCssVars(themed({ sectionCardsVisualStyle: 'outlined' }))['--gd-members-card-shadow']).toBe('none');
    // an explicit shadow outranks the style's default
    const vars = membersAppCssVars(themed({ sectionCardsVisualStyle: 'outlined', sectionCardsShadow: 'strong' }));
    expect(vars['--gd-members-card-shadow']).toBe('0 8px 24px rgba(0,0,0,0.2)');
    expect(vars['--gd-members-card-border-width']).toBe('2px');
    const glass = membersAppCssVars(themed({ sectionCardsVisualStyle: 'glass' }));
    expect(glass['--gd-members-card-effects']).toContain('0 0 8px 1px');
  });

  it('falls back on a glow or style word outside its set', () => {
    const vars = membersAppCssVars(themed({ sectionCardsGlow: 'bogus', sectionCardsVisualStyle: 'bogus' }));
    expect(vars['--gd-members-card-glow']).toBe('none');
    expect(vars['--gd-members-card-style']).toBe('clean');
  });
});

describe('Section Card shape, border edges and shadow (#1321 stage 1)', () => {
  it('defaults to today’s card: 12px corners, a border on every edge, a soft shadow', () => {
    const vars = membersAppCssVars(DEFAULT_TOKENS);
    expect(vars['--gd-members-card-radius']).toBe('12px');
    expect(vars['--gd-members-card-shadow']).toBe('0 1px 3px rgba(0,0,0,0.05)');
    for (const edge of ['top', 'right', 'bottom', 'left']) expect(vars[`--gd-members-card-edges-${edge}`]).toBe('1');
  });

  it('maps each option to its CSS and falls back on a word outside the set', () => {
    expect(cardEffectCssValue('card-shape', 'square')).toBe('4px');
    expect(cardEffectCssValue('card-shape', 'none')).toBe('0px');
    expect(cardEffectCssValue('card-shadow', 'none')).toBe('none');
    expect(cardEffectCssValue('card-shadow', 'bogus')).toBeNull();
    const themed = { ...DEFAULT_TOKENS, membersApp: { sectionCardsShape: 'bogus' } } as ThemeTokens;
    expect(membersAppCssVars(themed)['--gd-members-card-radius']).toBe('12px');
  });

  it('turns a single-edge choice into per-edge flags, independent of colour and width', () => {
    expect(cardEdgeFlags('left')).toEqual({ top: 0, right: 0, bottom: 0, left: 1 });
    expect(cardEdgeFlags('none')).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    const themed = { ...DEFAULT_TOKENS, membersApp: { sectionCardsBorderEdges: 'top' } } as ThemeTokens;
    const vars = membersAppCssVars(themed);
    expect(vars['--gd-members-card-edges-top']).toBe('1');
    expect(vars['--gd-members-card-edges-bottom']).toBe('0');
  });
});
