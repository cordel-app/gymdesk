import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { navigationGroups } from '../config/navigationGroups';
import { navGroupContainsActivePath } from '../lib/sidebarCollapse';

const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

describe('#1749 Calendar section tabs', () => {
  const all = navigationGroups.flatMap((g) => g.items);
  it('has no standalone Activities sidebar entry', () => {
    expect(all.some((i) => i.href.endsWith('/activity-types'))).toBe(false);
  });
  it('keeps the Calendar group active on the Activities route', () => {
    const group = navigationGroups.find((g) => g.id === 'calendar')!;
    expect(navGroupContainsActivePath(
      { items: group.items.map((i) => ({ ...i, alsoActiveFor: i.alsoActiveFor?.map((h) => h.replace('{{locale}}', 'en')) })) },
      '/en/activity-types',
    )).toBe(true);
  });
  it('renders the strip on both pages with the matching active tab', () => {
    expect(read('app', '[locale]', 'calendar', 'page.tsx')).toContain('<CalendarSectionTabs active="calendar" />');
    expect(read('app', '[locale]', 'activity-types', 'page.tsx')).toContain('<CalendarSectionTabs active="activities" />');
  });
  it('#1770: Calendar is a direct link and Operating Hours is a tab', () => {
    const group = navigationGroups.find((g) => g.id === 'calendar')!;
    expect(group.directLink).toBe(true);
    expect(group.items).toHaveLength(1);
    expect(group.items[0].alsoActiveFor).toContain('/{{locale}}/calendar/operating-hours');
    expect(read('app', '[locale]', 'calendar', 'operating-hours', 'page.tsx')).toContain('<CalendarSectionTabs active="operating_hours" />');
  });
  it('gates the Activities tab like the retired sidebar entry', () => {
    const src = read('components', 'CalendarSectionTabs.tsx');
    expect(src).toContain("useModuleAccess('ORGANIZATION')");
    expect(src).toContain("flags['organization.activity_types']");
  });
});
