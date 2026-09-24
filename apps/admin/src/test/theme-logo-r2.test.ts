import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #713 — a Custom Theme logo is stored in the gym's Cloudflare R2 folder, and
// every header loads it from there (`theme.logo_url`), falling back to the API
// route for a logo that is still a blob. The header's two rendering states are
// unchanged and still driven by `logo_contains_gym_name`.
//
// This repo has no component-test infra for apps/admin or apps/member (see
// docs/architecture.md's TL;DR), so — like theme-header-metadata.test.ts (#712)
// and theme-editor-unification.test.ts (#678) — this pins the behaviour down by
// scanning the sources. Member Web is read from here because both headers must
// resolve the logo the same way; the alternative is two tests that can't see
// each other drift (`calendar-theme-css.test.ts` reads across the same way).

const ADMIN_SRC = join(__dirname, '..');
const MEMBER_SRC = join(ADMIN_SRC, '..', '..', 'member', 'src');

const TOP_HEADER = join(ADMIN_SRC, 'components', 'TopHeader.tsx');
const TOP_BAR = join(MEMBER_SRC, 'components', 'TopBar.tsx');
const GYM_CONTEXT = join(ADMIN_SRC, 'context', 'GymContext.tsx');
const APP_CONTEXT = join(MEMBER_SRC, 'context', 'AppContext.tsx');
const CUSTOM_THEMES_PAGE = join(ADMIN_SRC, 'app', '[locale]', 'themes', 'page.tsx');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const headers = [
  { name: 'Admin TopHeader', src: read(TOP_HEADER), nameExpr: 'activeGym?.name' },
  { name: 'Member Web TopBar', src: read(TOP_BAR), nameExpr: 'gymName' },
];

describe('theme logo resolution (#713)', () => {
  it.each(headers)('$name prefers the R2 logo URL over the API route', ({ src }) => {
    // `logo_url` first, the blob-serving API route only as the fallback.
    expect(src).toMatch(/logoSrc\s*=\s*theme\?\.logo_url\s*\?\?/);
    expect(src).toContain('/api/proxy/themes/${theme.id}/logo');
    expect(src).toContain('theme.logo_updated_at');
  });

  it.each([
    { name: 'admin GymContext', path: GYM_CONTEXT },
    { name: 'member AppContext', path: APP_CONTEXT },
  ])('$name types logo_url on the theme it hands the header', ({ path }) => {
    expect(read(path)).toContain('logo_url: string | null;');
  });

  it('the Custom Themes page previews the R2 logo, with the API route as fallback', () => {
    const page = read(CUSTOM_THEMES_PAGE);
    expect(page).toContain('logo_url: string | null;');
    // The one place the page builds a logo src, used by the row thumbnail and
    // the Branding preview alike.
    expect(page).toMatch(/function logoUrl\(theme: Theme\) \{\s*return theme\.logo_url\s*\?\?/);
  });

  it('no header reads the logo bytes or the object key directly', () => {
    for (const { src } of headers) {
      expect(src).not.toContain('logo_bytes');
      expect(src).not.toContain('logo_object_key');
    }
  });
});

// The two states #488 defined, which #713 must leave intact: the flag decides
// whether the gym name renders next to the logo, and a gym with no logo still
// shows its name.
describe('header rendering states (logo_contains_gym_name, #488 + #713)', () => {
  it.each(headers)('$name renders the logo only when logo_contains_gym_name is true', ({ src, nameExpr }) => {
    expect(src).toMatch(/\{logoSrc && \(/);
    // The gym name is suppressed for a logo that already contains it — and
    // rendered whenever there is no logo at all.
    expect(src).toContain('(!logoSrc || !theme?.logo_contains_gym_name)');
    expect(src).toContain(nameExpr);
  });
});
