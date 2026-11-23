import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #3245 — the Home's "No upcoming bookings" icon is the app's single-colour line icon, never an emoji
// (source assertions: the Members App has no UI test runner in CI).
const root = join(__dirname, '../../../apps/member/src');
const page = readFileSync(join(root, 'app/[locale]/page.tsx'), 'utf8');
const icons = readFileSync(join(root, 'components/ActivityMetaIcon.tsx'), 'utf8');

describe('Home no-upcoming-bookings icon (#3245)', () => {
  const emptyState = page.slice(page.indexOf('styles.emptyBookingRow'), page.indexOf("t('home.book_now')"));

  it('draws the shared calendar line icon and no emoji', () => {
    expect(emptyState).toContain('<ActivityMetaIcon name="calendar"');
    expect(emptyState).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(icons).toMatch(/calendar: \(/);
    expect(icons).toContain('stroke="currentColor"');
  });

  it('takes its one colour from the Members App theme', () => {
    expect(page).toMatch(/emptyBookingIcon:\s*\{[^}]*color: memberTheme\.textMuted/);
  });
});
