// #1367: Home dashboard — the pure rules (date windows, role access, task visibility).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  dayWindow, weekWindow, parseDashboardDate, homeAccess, visibleTasks, resolveTimeZone,
} from '../domain/homeDashboard';

describe('parseDashboardDate', () => {
  it('accepts a real date and refuses everything else', () => {
    expect(parseDashboardDate('2026-10-11')).toBe('2026-10-11');
    expect(parseDashboardDate('2026-02-31')).toBeNull();
    expect(parseDashboardDate('11/10/2026')).toBeNull();
    expect(parseDashboardDate(undefined)).toBeNull();
  });
});

describe('dayWindow', () => {
  it('is the gym-local day as UTC instants', () => {
    // Madrid is UTC+2 in October (DST).
    expect(dayWindow('2026-10-11', 'Europe/Madrid')).toEqual({ from: '2026-10-10 22:00:00', to: '2026-10-11 22:00:00' });
  });
  it('is 25 hours long on the day DST ends', () => {
    const w = dayWindow('2026-10-25', 'Europe/Madrid');
    expect(w).toEqual({ from: '2026-10-24 22:00:00', to: '2026-10-25 23:00:00' });
  });
});

describe('weekWindow', () => {
  it('starts on the gym first day of week (Monday = 1)', () => {
    // 2026-10-11 is a Sunday → the week started Monday 2026-10-05.
    expect(weekWindow('2026-10-11', 'UTC', 1)).toEqual({ from: '2026-10-05 00:00:00', to: '2026-10-12 00:00:00' });
  });
  it('honours a Sunday start', () => {
    expect(weekWindow('2026-10-11', 'UTC', 0)).toEqual({ from: '2026-10-11 00:00:00', to: '2026-10-18 00:00:00' });
  });
});

describe('resolveTimeZone', () => {
  it('falls back to the product default for an unknown zone', () => {
    expect(resolveTimeZone('Not/AZone')).toBe('Europe/Madrid');
    expect(resolveTimeZone('Europe/London')).toBe('Europe/London');
  });
});

describe('homeAccess', () => {
  it('follows the module matrix', () => {
    expect(homeAccess('admin', false)).toEqual({ members: true, classes: true, payments: true });
    expect(homeAccess('accountant', false)).toEqual({ members: false, classes: false, payments: true });
    expect(homeAccess('trainer_performance', false).payments).toBe(false);
    expect(homeAccess('front_desk', false).members).toBe(true);
    expect(homeAccess('nutritionist', true)).toEqual({ members: true, classes: true, payments: true });
  });
});

describe('visibleTasks', () => {
  it('hides zero-count tasks', () => {
    const t = visibleTasks([
      { key: 'events_without_space', count: 0 },
      { key: 'events_without_trainer', count: 2 },
    ]);
    expect(t.map((x) => x.key)).toEqual(['events_without_trainer']);
  });
});

describe('route wiring', () => {
  const app = readFileSync(join(__dirname, '..', 'app.ts'), 'utf-8');
  const router = readFileSync(join(__dirname, '..', 'api', 'home-dashboard.ts'), 'utf-8');
  it('is mounted behind auth and tenant context', () => {
    expect(app).toMatch(/app\.use\('\/dashboard', requireAuth\(\), tenantContext, homeDashboardRouter\)/);
  });
  it('scopes every query by gym and gates sections through homeAccess', () => {
    expect(router).toContain('homeAccess(role, isSuperadmin)');
    expect(router).not.toMatch(/LIMIT \?/);
  });
});
