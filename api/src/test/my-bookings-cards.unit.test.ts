import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #1880 — source assertions for the My Bookings card (the Members App has no UI test runner in CI).
const root = join(__dirname, '../../../apps/member/src');
const page = readFileSync(join(root, 'app/[locale]/schedule/page.tsx'), 'utf8');

describe('My Bookings cards (#1880)', () => {
  it('reuses the Calendar icons and the shared image preview', () => {
    expect(page).toContain("from '@/components/ActivityMetaIcon'");
    expect(page).toContain("from '@/components/ImagePreview'");
    for (const icon of ["'center'", "'space'", "'trainer'"]) expect(page).toContain(icon);
  });
  it('filters through the existing schedule query parameters', () => {
    for (const p of ['activity_type_id', 'center_id', 'trainer_membership_id']) expect(page).toContain(p);
  });
  it('shows the professional service indicator as an icon with an accessible label only', () => {
    expect(page).toMatch(/s\.professional_service &&/);
    expect(page).toContain('professional_service_required');
  });
  it('has the new keys in every locale', () => {
    for (const l of ['en', 'es', 'ca']) {
      const ms = JSON.parse(readFileSync(join(root, `../locales/base/${l}.json`), 'utf8')).member_schedule;
      for (const k of ['filter_activity', 'filter_center', 'filter_trainer', 'professional_service_required', 'image_alt']) {
        expect(ms[k], `${l}.${k}`).toBeTruthy();
      }
    }
  });
});
