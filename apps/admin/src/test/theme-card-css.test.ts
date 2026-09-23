import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { COLOR_GROUPS } from '../components/ThemeTokensEditor';
import {
  ADVANCED_ATTRIBUTES,
  CARD_ADVANCED_VARS,
  DEFAULT_ADVANCED,
  DEFAULT_TOKENS,
  applyTokens,
  type ThemeTokens,
} from '../lib/themeTokens';

// #677 — the Cards group's two settings now actually reach the cards:
// "Card Border" is the `cardBorder` color written as --gd-card-border, and
// "Card Border Radius" is the `cardBorderRadius` advanced attribute, which was
// editable and persisted but never written to a CSS variable at all. Both are
// consumed through the one shared `cardSurfaceStyle`, so no card surface may
// restate a border or a radius of its own.

/** Minimal `document` stand-in — these tests run in vitest's node environment. */
function stubDocument(): Record<string, string> {
  const written: Record<string, string> = {};
  (globalThis as any).document = {
    documentElement: {
      style: { setProperty: (name: string, value: string) => { written[name] = value; } },
    },
  };
  return written;
}

describe('Card theme CSS variables (#677)', () => {
  let written: Record<string, string>;

  beforeEach(() => { written = stubDocument(); });
  afterEach(() => { delete (globalThis as any).document; });

  it('maps every editable card attribute to exactly one CSS variable', () => {
    const cardAdvanced = ADVANCED_ATTRIBUTES.filter((a) => a.group === 'group_cards');
    // `cardShadow` is a named preset (none/small/…), not a value a card style
    // can hold directly, so the radius is the only advanced card *variable*.
    expect(cardAdvanced.map((a) => a.key).sort()).toEqual(['cardBorderRadius', 'cardShadow']);
    expect(Object.keys(CARD_ADVANCED_VARS)).toEqual(['cardBorderRadius']);
    const names = Object.values(CARD_ADVANCED_VARS);
    expect(new Set(names).size, 'two attributes share one CSS variable').toBe(names.length);
  });

  it('emits the card border color and radius for a fully configured theme', () => {
    applyTokens(DEFAULT_TOKENS);
    expect(written['--gd-card-border']).toBe(DEFAULT_TOKENS.colors.cardBorder);
    expect(written['--gd-card-radius']).toBe(String(DEFAULT_ADVANCED.cardBorderRadius));
  });

  it('emits the configured values, not the defaults, once they are set', () => {
    const themed = {
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, cardBorder: '#123456' },
      advanced: { cardBorderRadius: '20px' },
    } as ThemeTokens;
    applyTokens(themed);
    expect(written['--gd-card-border']).toBe('#123456');
    expect(written['--gd-card-radius']).toBe('20px');
  });

  it('falls back to the default radius for a theme with no advanced map', () => {
    // A theme saved before the Cards attributes existed, and one whose radius
    // was cleared to an empty string in the editor: both must still paint.
    const legacy = { ...DEFAULT_TOKENS } as ThemeTokens;
    delete (legacy as any).advanced;
    applyTokens(legacy);
    expect(written['--gd-card-radius']).toBe(String(DEFAULT_ADVANCED.cardBorderRadius));

    applyTokens({ ...DEFAULT_TOKENS, advanced: { cardBorderRadius: '  ' } } as ThemeTokens);
    expect(written['--gd-card-radius']).toBe(String(DEFAULT_ADVANCED.cardBorderRadius));
  });

  it('keeps the Cards color group pointing at the card background and border', () => {
    const cardColors = COLOR_GROUPS.find((g) => g.groupKey === 'group_cards')!;
    expect(cardColors.fields.map((f) => f.key)).toEqual(['cardBackground', 'cardBorder']);
  });
});

describe('Shared card surface style (#677)', () => {
  const srcRoot = join(__dirname, '..');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'test' && entry !== 'node_modules') walk(full, out);
      } else if (entry.endsWith('.tsx')) {
        out.push(full);
      }
    }
    return out;
  }

  /** The `{ … }` a declaration at `from` opens, brace-matched so the scan
   *  stops at that style and never runs into the next one. */
  function objectLiteralAt(src: string, from: number): string {
    const open = src.indexOf('{', from);
    if (open === -1) return '';
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    }
    return src.slice(open);
  }

  it('reads the card border and radius from the theme variables', () => {
    const ui = readFileSync(join(srcRoot, 'components/ui.tsx'), 'utf8');
    expect(ui).toContain("var(--gd-card-border,");
    expect(ui).toContain("var(--gd-card-radius,");
    // The CSS fallback is what an unthemed page paints with (no gym resolved
    // yet) — it must match what applyTokens() would have written.
    const radiusFallback = ui.match(/borderRadius: 'var\(--gd-card-radius,\s*([^)]+)\)'/)?.[1]?.trim();
    expect(radiusFallback).toBe(String(DEFAULT_ADVANCED.cardBorderRadius));
  });

  it('leaves no card surface with a hardcoded border or radius of its own', () => {
    // Every card style is `{ ...cardSurfaceStyle, … }`; a card that declares
    // its own borderRadius next to the card background would silently ignore
    // the theme's Card Border Radius, which is the bug this ticket fixed.
    const offenders: string[] = [];
    let declarations = 0;
    for (const file of walk(srcRoot)) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(/const (cardStyle|cardSt)\b/g)) {
        declarations++;
        const body = objectLiteralAt(src, match.index!);
        const where = `${file.replace(srcRoot, 'src')} (${match[1]})`;
        if (!body.includes('cardSurfaceStyle')) {
          offenders.push(`${where}: does not build on cardSurfaceStyle`);
        }
        if (/borderRadius:/.test(body)) {
          offenders.push(`${where}: declares a border radius of its own`);
        }
      }
    }
    expect(declarations, 'no card styles found — has the scan drifted?').toBeGreaterThan(15);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
