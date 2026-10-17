// #1367: Home dashboard — the pure rules (date windows, role access, task visibility).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  dayWindow, weekWindow, parseDashboardDate, completedWeekWindows, attendanceKpis, homeAccess, visibleTasks, groupPendingPaymentMembers, resolveTimeZone,
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

describe('groupPendingPaymentMembers (#1466)', () => {
  it('counts a member once, sums their amounts and leads with the most overdue', () => {
    const g = groupPendingPaymentMembers([
      { member_id: 2, amount: '10.10', created_at: '2026-10-05T10:00:00Z' },
      { member_id: 1, amount: 20, created_at: '2026-10-01T10:00:00Z' },
      { member_id: 2, amount: 5.2, created_at: '2026-09-20T10:00:00Z' },
      { member_id: null, amount: 99, created_at: '2026-09-01T10:00:00Z' },
    ]);
    expect(g.map((x) => x.member_id)).toEqual([2, 1]);
    expect(g[0].outstanding_amount).toBe(15.3);
    expect(g[0].oldest_at).toBe('2026-09-20T10:00:00.000Z');
  });
});

describe('completedWeekWindows (#1754)', () => {
  it('is the four complete Monday–Sunday gym-local weeks before this one, oldest first', () => {
    // 2026-10-14 is a Wednesday; this week starts Mon 2026-10-12.
    const w = completedWeekWindows('2026-10-14', 'Europe/Madrid', 4);
    expect(w).toHaveLength(4);
    expect(w[3]).toEqual({ from: '2026-10-04 22:00:00', to: '2026-10-11 22:00:00' });
    expect(w[0].from).toBe('2026-09-13 22:00:00');
    expect(w[0].to).toBe(w[1].from);
  });
  it('treats a Monday as the start of the current week', () => {
    const w = completedWeekWindows('2026-10-12', 'UTC', 1);
    expect(w[0]).toEqual({ from: '2026-10-05 00:00:00', to: '2026-10-12 00:00:00' });
  });
});

describe('attendanceKpis (#1754)', () => {
  const weeks = completedWeekWindows('2026-10-14', 'UTC', 4);
  const inWeek = (i: number) => weeks[i].from;
  it('needs an attendance in every week and averages over active members', () => {
    const att = [
      ...[0, 1, 2, 3].map((i) => ({ member_id: 1, at: inWeek(i) })),
      ...[0, 1, 2].map((i) => ({ member_id: 2, at: inWeek(i) })),
      { member_id: 2, at: inWeek(0) },
      { member_id: 3, at: '2000-01-01 00:00:00' },
    ];
    const k = attendanceKpis(att, weeks, 10);
    expect(k.top_trainers).toBe(1);
    expect(k.average_classes_per_member_per_week).toBe(0.20); // 8 / 10 / 4
  });
  it('handles no data and no members without dividing by zero', () => {
    expect(attendanceKpis([], weeks, 0)).toEqual({ top_trainers: 0, average_classes_per_member_per_week: 0, weeks: 4 });
  });
});
