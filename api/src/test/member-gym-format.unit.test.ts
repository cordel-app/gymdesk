import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1246 stage 5 — the Members App formats the calendar sheet and the alerts
// page through the gym's Time & Localization settings, read from /me/localization.
const root = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('Members App gym formatting (#1246 stage 5)', () => {
  it.each([
    'apps/member/src/app/[locale]/calendar/page.tsx',
    'apps/member/src/app/[locale]/notifications/page.tsx',
  ])('%s formats through the gym formatter, not toLocaleString', (file) => {
    const src = read(file);
    expect(src).toContain('formatGymDateTime');
    expect(src).not.toMatch(/toLocale(Date|Time)?String/);
  });

  it('the hook reads the member-facing settings route', () => {
    expect(read('apps/member/src/lib/useGymFormatSettings.ts')).toContain("'/me/localization'");
    expect(read('api/src/api/me.ts')).toContain("meRouter.get('/localization'");
  });
});
