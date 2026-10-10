import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { MEMBERS_APP_SETTING_TYPES } from '../domain/membersAppTokens';

// #1152 — Members App typography and Section Card text settings.
//
// The declaration is the Admin's (`apps/admin/src/lib/membersAppTokens.ts`),
// mirrored for resolution in the Members App and for validation here; each
// app's own suite asserts its half, but CI runs `npm test` in `api/` only, so
// this gate is what fails the build when one of the three drifts, when a
// setting stops reaching a surface, or when a tile spells one of the five
// text properties the card is supposed to own.

const ROOT = join(__dirname, '..', '..', '..');
const ADMIN = join(ROOT, 'apps', 'admin', 'src');
const MEMBER = join(ROOT, 'apps', 'member', 'src');

function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}
const read = (...parts: string[]) => strip(readFileSync(join(...parts), 'utf-8'));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !p.includes('/test/')) out.push(p);
  }
  return out;
}

const NEW_SETTINGS: Record<string, string> = {
  title1Font: 'font',
  title2Font: 'font',
  title3Font: 'font',
  sectionCardsTextColor: 'color',
  sectionCardsTextSize: 'font-size',
  sectionCardsTextFont: 'font',
  sectionCardsTextVertical: 'align-v',
  sectionCardsTextHorizontal: 'align-h',
};

describe('#1152 — the three mirrors agree on the eight new settings', () => {
  const adminSrc = read(ADMIN, 'lib', 'membersAppTokens.ts');
  const memberSrc = read(MEMBER, 'lib', 'membersAppTokens.ts');

  it('declares each with the same type in the Admin, the Members App and the API', () => {
    for (const [key, type] of Object.entries(NEW_SETTINGS)) {
      expect(MEMBERS_APP_SETTING_TYPES[key], `API rejects ${key}`).toBe(type);
      for (const [label, src] of [['Admin', adminSrc], ['Members App', memberSrc]] as const) {
        expect(src, `${label} has no ${key}`).toMatch(new RegExp(`key: '${key}',[\\s\\S]*?type: '${type}',`));
      }
    }
  });

  it('inherits a size or a position from nothing, and a colour or a font from an Admin setting', () => {
    for (const src of [adminSrc, memberSrc]) {
      for (const key of ['sectionCardsTextSize', 'sectionCardsTextVertical', 'sectionCardsTextHorizontal']) {
        expect(src).toMatch(new RegExp(`key: '${key}',[\\s\\S]*?source: null,\\s*default: `));
      }
      expect(src).toContain("key: 'textColor', labelKey: 'label_text_color'");
      expect(src).toContain("level: 'body', field: 'fontFamily', labelKey: 'source_typography_body_font'");
      for (const n of [1, 2, 3]) {
        expect(src).toContain(`level: 'h${n}', field: 'fontFamily', labelKey: 'source_typography_h${n}_font'`);
        expect(src).toMatch(new RegExp(`key: 'title${n}Font',[\\s\\S]*?cssVar: '--gd-font-h${n}',`));
      }
    }
  });

  it('maps a stored position to CSS in both resolvers the same way', () => {
    for (const src of [adminSrc, memberSrc]) {
      expect(src).toContain("if (value === 'top') return 'flex-start';");
      expect(src).toContain("if (value === 'bottom') return 'flex-end';");
      expect(src).toContain('MEMBERS_APP_FONT_SIZE = { min: 8, max: 48 }');
    }
  });
});

describe('#1152 — every new setting reaches a surface', () => {
  const chrome = read(MEMBER, 'lib', 'memberChrome.ts');

  it('reads the eight variables in the one place the Members App spells a visual value', () => {
    for (const n of [1, 2, 3]) expect(chrome).toContain(`title${n}Font: 'var(--gd-font-h${n},`);
    expect(chrome).toContain("cardText: 'var(--gd-members-card-text,");
    expect(chrome).toContain("cardTextSize: 'var(--gd-members-card-text-size, 13px)'");
    expect(chrome).toContain("cardTextFont: 'var(--gd-members-card-text-font,");
    expect(chrome).toContain("cardTextVertical: 'var(--gd-members-card-text-vertical, center)'");
    expect(chrome).toContain("cardTextHorizontal: 'var(--gd-members-card-text-horizontal, center)'");
    expect(chrome).toContain('export const sectionCardText');
  });

  it('paints a Section Card’s text under the caller’s own style, in the one card component', () => {
    const card = read(MEMBER, 'components', 'MembersSectionCard.tsx');
    expect(card).toContain("import { sectionCardBorder, sectionCardShape, sectionCardText } from '@/lib/memberChrome';");
    expect(card).toContain('style: { ...sectionCardText, ...style, ...(background ? { background } : {}), ...sectionCardShape, ...sectionCardBorder }');
  });

  it('keeps the navigation tile free of the five text properties, so the Theme decides them', () => {
    const home = read(MEMBER, 'app', '[locale]', 'page.tsx');
    const tile = home.match(/tile:\s*\{[^}]*\}/)![0];
    const label = home.match(/tileLabel:\s*\{[^}]*\}/)![0];
    expect(tile + label).not.toMatch(/\bcolor:|fontSize|fontFamily|textAlign|justifyContent|alignItems/);
    expect(home).toContain('<span style={styles.tileLabel}>{label}</span>');
    // The dashboard's products card title takes the card's colour and font
    // too; its size and weight are its own, its body being #1116's structure.
    expect(home).not.toContain('productsTitle');
    expect(home).toContain("<span style={styles.tileLabel}>{t('home.products_services')}</span>");
  });

  it('renders every heading in its Title font beside its Title colour', () => {
    const files = walk(MEMBER);
    let headings = 0;
    for (const file of files) {
      const src = strip(readFileSync(file, 'utf-8'));
      for (const m of src.matchAll(/color: memberTheme\.title([123])\b([^,}]*)/g)) {
        headings += 1;
        expect(src, `${file.replace(ROOT, '')} paints a Title colour with no Title font beside it`)
          .toContain(`color: memberTheme.title${m[1]}, fontFamily: memberTheme.title${m[1]}Font`);
      }
    }
    expect(headings).toBeGreaterThan(20);
  });
});

describe('#1152 — the section is renamed, its id is not, and the labels exist in every locale', () => {
  const locales = ['en', 'es', 'ca'].map((c) => [c, JSON.parse(readFileSync(join(ROOT, 'apps', 'admin', 'locales', 'base', `${c}.json`), 'utf-8'))] as const);
  const expected: Record<string, string> = {
    en: 'Typography (Members App)',
    es: 'Tipografía (App de Miembros)',
    ca: 'Tipografia (App de Membres)',
  };

  it('reads Typography (Members App) under the unchanged group_members_text key', () => {
    for (const [code, data] of locales) {
      for (const ns of ['themes', 'gym_themes']) {
        expect(data[ns].group_members_text, `${code}.${ns}`).toBe(expected[code]);
      }
    }
    const adminSrc = read(ADMIN, 'lib', 'membersAppTokens.ts');
    expect(adminSrc).toContain("'group_members_text'");
    expect(adminSrc).not.toContain('group_members_typography');
  });

  it('labels every new setting, every new source and every position in both namespaces', () => {
    const needed = [
      'label_members_title1_font', 'label_members_title2_font', 'label_members_title3_font',
      'label_members_card_text_color', 'label_members_card_text_size', 'label_members_card_text_font',
      'label_members_card_text_vertical', 'label_members_card_text_horizontal',
      'source_typography_h1_font', 'source_typography_h2_font', 'source_typography_h3_font', 'source_typography_body_font',
      'members_default_value', 'members_badge_default', 'members_restore_default',
      'members_align_top', 'members_align_center', 'members_align_bottom', 'members_align_left', 'members_align_right',
    ];
    for (const [code, data] of locales) {
      for (const ns of ['themes', 'gym_themes']) {
        for (const key of needed) {
          expect(typeof data[ns][key], `${code}.${ns}.${key}`).toBe('string');
        }
      }
    }
  });
});
