// #1367 — Home dashboard: date navigation, task ordering/visibility, destinations,
// nav entry and locale coverage.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { navigationGroups, filterNavGroups } from '@/config/navigationGroups';
import { shiftDate, taskHref, orderedTasks, memberHref, TASK_ORDER, TASK_ACTION_KEY } from '@/lib/homeDashboard';

const LOCALES = ['en', 'es', 'ca'].map((l) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${l}.json`), 'utf-8')));

describe('date navigation', () => {
  it('moves by whole days across month and year ends', () => {
    expect(shiftDate('2026-10-11', 1)).toBe('2026-10-12');
    expect(shiftDate('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2026-03-29', 1)).toBe('2026-03-30');
  });
});

describe('tasks', () => {
  it('are listed A–F and zero-count ones are hidden', () => {
    const out = orderedTasks([
      { key: 'payments_with_issues', count: 1 },
      { key: 'events_without_trainer', count: 0 },
      { key: 'events_without_space', count: 3 },
    ]);
    expect(out.map((t) => t.key)).toEqual(['events_without_space', 'payments_with_issues']);
    expect(orderedTasks([])).toEqual([]);
  });
  it('lead to the existing management screens', () => {
    expect(taskHref('welcome_new_members', 'en')).toBe('/en/members?welcomed=false');
    expect(taskHref('payments_with_issues', 'es')).toBe('/es/payments/billing-events?status=failed');
    expect(taskHref('events_without_space', 'ca')).toBe('/ca/calendar');
    expect(memberHref(7, 'en')).toBe('/en/members?member=7&tab=products_services');
  });
});

describe('navigation', () => {
  it('Home is the first sidebar entry for every role and flags do not hide it', () => {
    expect(navigationGroups[0].id).toBe('home');
    expect(navigationGroups[0].items[0].href).toBe('/{{locale}}/home');
    for (const role of ['admin', 'front_desk', 'accountant', 'trainer_performance', 'nutritionist'] as const) {
      expect(filterNavGroups(navigationGroups, role, {})[0].id).toBe('home');
    }
  });
});

describe('locales', () => {
  it('cover the nav entry, the Welcomed field and every task/key in en, es and ca', () => {
    const enHome = Object.keys(LOCALES[0].home).sort();
    for (const l of LOCALES) {
      expect(l.nav.home).toBeTruthy();
      expect(l.nav.groups.home).toBeTruthy();
      expect(Object.keys(l.home).sort()).toEqual(enHome);
      for (const k of TASK_ORDER) expect(l.home[`task_${k}`], k).toBeTruthy();
      for (const a of Object.values(TASK_ACTION_KEY)) expect(l.home[a]).toBeTruthy();
      for (const k of ['label_welcomed', 'welcomed_yes', 'welcomed_no', 'filter_welcomed', 'all_welcomed']) expect(l.members[k], k).toBeTruthy();
    }
    expect(LOCALES[1].nav.home).toBe('Inicio');
    expect(LOCALES[2].nav.home).toBe('Inici');
  });
});
