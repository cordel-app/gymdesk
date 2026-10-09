import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1300 — AppContext's load effect must not blank the Members App on a re-run.
// In the API suite for #1009's reason: CI runs `npm test` in `api/` only.

const src = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'member', 'src', 'context', 'AppContext.tsx'), 'utf-8')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('#1300 AppContext load lifecycle', () => {
  it('waits for Clerk to load instead of treating "not loaded" as signed out', () => {
    expect(src).toMatch(/isLoaded\s*\}\s*=\s*useAuth\(\)/);
    expect(src).toMatch(/if \(!isLoaded\) return;/);
    expect(src.indexOf('if (!isLoaded) return;')).toBeLessThan(src.indexOf('if (!isSignedIn || !user)'));
  });

  it('resets state only when the identity or an explicit reload changed', () => {
    expect(src).toMatch(/loadedFor\.current === loadKey/);
    expect(src).toMatch(/if \(!background\) \{\s*setLoading\(true\);/);
  });
});
