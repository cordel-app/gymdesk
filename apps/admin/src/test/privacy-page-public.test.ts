import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { privacyContentFor } from '../app/[locale]/privacy/privacyContent';

// The privacy policy is the URL on the Google OAuth consent screen. Google only
// lets an External app stay published while that URL is reachable, so the page
// must never sit behind Clerk's auth.protect(), and it renders without the
// signed-in app chrome. No component-test infra here, so the wiring is pinned
// by scanning the sources (same approach as theme-logo-r2.test.ts).

const ADMIN_SRC = join(__dirname, '..');
const middleware = readFileSync(join(ADMIN_SRC, 'middleware.ts'), 'utf8');
const appShell = readFileSync(join(ADMIN_SRC, 'components', 'AppShell.tsx'), 'utf8');

describe('public privacy policy page', () => {
  it('is a public route with and without a locale prefix', () => {
    expect(middleware).toContain("'/:locale/privacy'");
    expect(middleware).toContain("'/privacy'");
  });

  it('renders without the app chrome', () => {
    expect(appShell).toMatch(/isPublicPage\s*=\s*\/\^\\\/\[a-z\]\{2\}\\\/privacy\$\//);
    expect(appShell).toMatch(/if \(isAuthPage \|\| isPublicPage/);
  });

  it('has content for every app locale and falls back to English', () => {
    for (const locale of ['en', 'es', 'ca']) {
      const content = privacyContentFor(locale);
      expect(content.title).not.toBe('');
      expect(content.sections.length).toBeGreaterThan(0);
    }
    expect(privacyContentFor('fr')).toBe(privacyContentFor('en'));
    expect(privacyContentFor('es')).not.toBe(privacyContentFor('en'));
  });
});
