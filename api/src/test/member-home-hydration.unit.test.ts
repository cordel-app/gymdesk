import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// The Home's first client render must take the branch the server rendered: on
// the server Clerk is never loaded, on the client it may be by hydration time,
// and a page that branches on `isLoaded` alone mismatches (React #418/#423/#425
// on every load). In the API suite for #1009's reason: CI runs `npm test` in
// `api/` only.

const src = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'member', 'src', 'app', '[locale]', 'page.tsx'), 'utf-8')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('Home hydration', () => {
  it('gates the auth-dependent branch on a mounted flag', () => {
    expect(src).toMatch(/const \[hydrated, setHydrated\] = useState\(false\);/);
    expect(src).toMatch(/useEffect\(\(\) => \{ setHydrated\(true\); \}, \[\]\);/);
    expect(src).toMatch(/const authKnown = hydrated && isLoaded;/);
  });

  it('never branches on isLoaded directly, and shows no brand while auth is unknown', () => {
    // A bare placeholder first, then the signed-out landing only once Clerk has
    // answered that nobody is signed in.
    expect(src).toMatch(/if \(!authKnown\) \{\s*return <main style=\{styles\.container\}><p style=\{styles\.hint\}>…<\/p><\/main>;/);
    expect(src).toMatch(/if \(!isSignedIn && !appLoading\) \{/);
    expect(src).not.toMatch(/if \(!isLoaded \|\|/);
    expect(src).not.toMatch(/\{!isLoaded \?/);
    expect(src.indexOf('if (!authKnown)')).toBeLessThan(src.indexOf("t('home.title')"));
  });
});
