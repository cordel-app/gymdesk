// #1367/#1754 — Home dashboard: quick actions, task ordering/visibility, destinations,
// nav entry and locale coverage.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { navigationGroups, filterNavGroups } from '@/config/navigationGroups';
import { nextHalfHour, quickActionHref, startClassHref, canStartClass, taskHref, orderedTasks, memberHref, TASK_ORDER, TASK_ACTION_KEY } from '@/lib/homeDashboard';

const LOCALES = ['en', 'es', 'ca'].map((l) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${l}.json`), 'utf-8')));

describe('nextHalfHour', () => {
  const at = (h: number, m: number, sec = 0) => new Date(2026, 9, 17, h, m, sec);
  it('picks the next HH:00/HH:30 strictly in the future', () => {
    expect(nextHalfHour(at(10, 10))).toEqual(at(10, 30));
    expect(nextHalfHour(at(10, 30))).toEqual(at(11, 0));
    expect(nextHalfHour(at(10, 45))).toEqual(at(11, 0));
    expect(nextHalfHour(at(10, 0))).toEqual(at(10, 30));
    expect(nextHalfHour(at(10, 30, 5))).toEqual(at(11, 0));
    expect(nextHalfHour(at(10, 29, 59))).toEqual(at(10, 30));
  });
  it('rolls into the next day', () => {
    expect(nextHalfHour(at(23, 45))).toEqual(new Date(2026, 9, 18, 0, 0));
  });
});

describe('quick actions', () => {
  it('lead to the existing screens with the view state they need', () => {
    expect(quickActionHref('add_member', 'en')).toBe('/en/members?add=1');
    expect(quickActionHref('manage_member', 'es')).toBe('/es/members');
    expect(quickActionHref('new_class', 'ca')).toBe('/ca/calendar?new=1');
    expect(quickActionHref('review_payments', 'en')).toBe('/en/payments/billing-events?status=failed');
  });
  it('Start opens that class and only a scheduled one', () => {
    expect(startClassHref(42, 'en')).toBe('/en/calendar?session=42');
    expect(canStartClass('scheduled')).toBe(true);
    for (const s of ['cancelled', 'completed', 'draft']) expect(canStartClass(s)).toBe(false);
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
    // #1453: Home is one page — its header links to it, no submenu.
    expect(navigationGroups[0].directLink).toBe(true);
    expect(navigationGroups[0].items).toHaveLength(1);
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

describe('Home visual refinement (#1367)', () => {
  const page = readFileSync(join(__dirname, '..', 'app', '[locale]', 'home', 'page.tsx'), 'utf-8');
  const parts = readFileSync(join(__dirname, '..', 'components', 'home', 'HomeParts.tsx'), 'utf-8');
  it('shows the Theme motivational sentence in the header, and nothing when unset', () => {
    expect(page).toContain('?.motivationalSentence');
    expect(parts).toContain('data-testid="home-motivation"');
    expect(parts).toMatch(/const quote = sentence\?\.trim\(\);\s*return[\s\S]*\{quote && \(/);
  });
  it('keeps every section and test hook of the functional dashboard', () => {
    for (const id of ['home-pending-payments', 'home-quick-actions', 'home-all-clear', 'home-task-count', 'home-class-', 'home-pending-']) {
      expect(page + parts).toContain(id);
    }
  });
});

// #1877 — Today's classes actions and the swapped Quick actions / pending payments.
describe('Home class actions (#1877)', () => {
  const KEYS = ['class_celebrate', 'class_cancel', 'class_attendees', 'celebrate_title', 'celebrate_complete', 'attendees_title', 'attendees_empty', 'cancel_confirm', 'cancel_reason'];
  it('every locale carries the new copy', () => {
    for (const l of LOCALES) for (const k of KEYS) expect(l.home[k], k).toBeTruthy();
  });
  it('Quick actions now precede the pending payments panel', () => {
    const src = readFileSync(join(__dirname, '..', 'app', '[locale]', 'home', 'page.tsx'), 'utf-8');
    expect(src.indexOf('home-quick-actions')).toBeGreaterThan(-1);
    expect(src.indexOf('home-quick-actions')).toBeLessThan(src.indexOf('home-pending-payments'));
    expect(src.indexOf('home-pending-payments')).toBeGreaterThan(src.indexOf('tasks_title'));
  });
  it('actions are icon buttons with accessible labels', () => {
    const src = readFileSync(join(__dirname, '..', 'app', '[locale]', 'home', 'page.tsx'), 'utf-8');
    for (const k of ['celebrate', 'attendees', 'cancel']) expect(src).toContain(`home-class-${k}-`);
    expect(src).toContain("aria-label={t('class_celebrate')}");
  });
});
