import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HEADER_BG, HEADER_TEXT, headerOptionStyle } from '../components/headerChrome';

// Regression test for #808 — the language dropdown's colours.
//
// The picker is a native <select>. Its closed trigger inherits the header's
// text colour, but the popup the browser opens for it is painted outside the
// header element and takes the UA's defaults, so the options came out white on
// white for every themed gym. The fix is that each <option> carries the
// header's own pair (`--gd-header-bg` / `--gd-header-text`, the same chain
// `TopHeader` paints the band with), declared once in `headerChrome.ts`.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like activity-colour-column.test.ts (#676) — this pins the
// structure down by scanning the component sources.

const COMPONENTS = join(__dirname, '..', 'components');
const pickerSrc = readFileSync(join(COMPONENTS, 'LanguagePicker.tsx'), 'utf-8');
const headerSrc = readFileSync(join(COMPONENTS, 'TopHeader.tsx'), 'utf-8');

describe('Language picker: the dropdown is an extension of the header (#808)', () => {
  it('gives every option the shared header chrome', () => {
    const option = pickerSrc.match(/<option[\s\S]*?>/)?.[0] ?? '';
    expect(option, 'the <option> could not be located').not.toBe('');
    expect(option).toContain('style={headerOptionStyle}');
    expect(pickerSrc).toMatch(/import \{ headerOptionStyle \} from '\.\/headerChrome'/);
  });

  it('paints the options with the header\'s own background and text tokens', () => {
    expect(headerOptionStyle.background).toBe(HEADER_BG);
    expect(headerOptionStyle.color).toBe(HEADER_TEXT);
    // The exact pair TopHeader paints the band with, fallbacks included.
    expect(headerSrc).toContain(`background: '${HEADER_BG}'`);
    expect(headerSrc).toContain(`color: '${HEADER_TEXT}'`);
  });

  it('hardcodes no separate colour scheme for the options', () => {
    // Nothing white, light or UA-default may be restated on the option itself.
    const options = [...pickerSrc.matchAll(/<option[\s\S]*?>/g)].map((m) => m[0]).join('\n');
    expect(options).not.toMatch(/#fff|#FFF|white|rgba?\(/);
    expect(options).not.toMatch(/background(Color)?:\s*'(?!var\()/);
  });

  it('leaves the trigger and the rest of the header untouched (§6)', () => {
    // The closed control keeps the appearance it had before the fix.
    expect(pickerSrc).toContain("background: 'rgba(255,255,255,0.15)'");
    expect(pickerSrc).toContain("border: '1px solid rgba(255,255,255,0.3)'");
    expect(pickerSrc).toContain("color: 'inherit'");
    // The three languages, and the routing behaviour, are unchanged.
    expect(pickerSrc).toMatch(/\{ code: 'es', label: 'Español' \}/);
    expect(pickerSrc).toMatch(/\{ code: 'ca', label: 'Català' \}/);
    expect(pickerSrc).toMatch(/\{ code: 'en', label: 'English' \}/);
    expect(pickerSrc).toContain('router.push(`/${newLocale}${pathWithoutLocale}`)');
  });
});
