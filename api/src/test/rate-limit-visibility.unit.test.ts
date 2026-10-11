import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// a spent request budget must be visible and must not wipe state.
// In the API suite for #1009's reason: CI runs `npm test` in `api/` only.

const root = join(__dirname, '..', '..', '..', 'apps');
const read = (p: string) => readFileSync(join(root, p), 'utf-8');

describe(' 429 visibility', () => {
  for (const app of ['member', 'admin']) {
    it(`${app}: the proxy forwards the rate-limit headers`, () => {
      const src = read(`${app}/src/app/api/proxy/[...path]/route.ts`);
      expect(src).toContain("'ratelimit'");
      expect(src).toContain("'retry-after'");
      expect(src).toMatch(/headers:\s*responseHeaders\(res\)/);
    });

    it(`${app}: a refused flags poll keeps the flags and getToken cannot relaunch the effect`, () => {
      const src = read(`${app}/src/context/FeatureFlagsContext.tsx`);
      expect(src).toContain('getTokenRef');
      expect(src).toMatch(/\[isLoaded, isSignedIn\]\)/);
      expect(src).toMatch(/if \(!res\.ok\) \{\s*if \(!cancelled && isInitial\) setFlags\(\{\}\);\s*return;/);
      expect(src).toContain('document.hidden');
    });
  }

  it('member: a 429 on the context load is reported and drawn', () => {
    const ctx = read('member/src/context/AppContext.tsx');
    expect(ctx).toMatch(/status === 429\) setRateLimited\(true\)/);
    const ui = read('member/src/components/NativeAppState.tsx');
    expect(ui).toContain('rate_limited_title');
    for (const l of ['en', 'es', 'ca']) {
      const json = JSON.parse(read(`member/locales/base/${l}.json`));
      expect(json.native.rate_limited_title).toBeTruthy();
      expect(json.native.rate_limited_body).toBeTruthy();
    }
  });

  it('a token function is never a hook dependency of a load that asks for a token', () => {
    for (const f of [
      'admin/src/context/CenterContext.tsx',
      'admin/src/context/GymContext.tsx',
      'member/src/components/MemberImpersonationDialog.tsx',
      'member/src/context/FeatureFlagsContext.tsx',
      'admin/src/context/FeatureFlagsContext.tsx',
    ]) {
      const src = read(f);
      expect(src, f).toContain('getTokenRef');
      expect(src, f).not.toMatch(/\[[^\]]*\bgetToken\b[^\]]*\]\)/);
    }
  });

  for (const app of ['member', 'admin']) {
    it(`${app}: an unchanged flags poll keeps the same object`, () => {
      const src = read(`${app}/src/context/FeatureFlagsContext.tsx`);
      expect(src).toContain('function sameFlags(');
      expect(src).toMatch(/setFlags\(\(prev\) => \(sameFlags\(prev, data \?\? \{\}\) \? prev : \(data \?\? \{\}\)\)\)/);
    });
  }
});
