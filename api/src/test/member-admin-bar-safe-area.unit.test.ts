import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1294 — on an iPhone the superadmin bar (the "Impersonate" button) sat under the
// status bar (clock, Wi-Fi) and could not be tapped: only TopBar had the safe-area
// inset (#1073). The top bar of the screen owns the inset, and exactly one does.
const C = join(__dirname, '..', '..', '..', 'apps', 'member', 'src', 'components');
const src = (f: string) => readFileSync(join(C, f), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('#1294 the top bar of the screen carries the safe-area inset', () => {
  it('AdminBar and ImpersonationBanner pad the top by the inset', () => {
    for (const f of ['AdminBar.tsx', 'ImpersonationBanner.tsx']) {
      expect(src(f), f).toContain("withSafeArea(");
      expect(src(f), f).toMatch(/paddingTop: withSafeArea\(\d+, 'top'\)/);
    }
  });

  it('TopBar skips the top inset for a superadmin, who has a bar above it', () => {
    const topBar = src('TopBar.tsx');
    expect(topBar).toContain('isSuperadmin');
    expect(topBar).toMatch(/paddingTop: isSuperadmin \? 10 : withSafeArea\(10, 'top'\)/);
  });
});
