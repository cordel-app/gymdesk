import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_PLAN_VIEW_MODE,
  PLAN_VIEW_MODE_STORAGE_KEY,
  parsePlanViewMode,
  readPlanViewMode,
  writePlanViewMode,
} from '../lib/planViewMode';

// #1369 — Cards (default) / List toggle on the Membership Plans page.
describe('plan view mode (#1369)', () => {
  it('defaults to cards and ignores unknown values', () => {
    expect(DEFAULT_PLAN_VIEW_MODE).toBe('cards');
    expect(parsePlanViewMode('grid')).toBe('cards');
    expect(parsePlanViewMode('list')).toBe('list');
  });

  it('round-trips through storage and survives it throwing', () => {
    const data: Record<string, string> = {};
    const storage = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
    writePlanViewMode(storage, 'list');
    expect(data[PLAN_VIEW_MODE_STORAGE_KEY]).toBe('list');
    expect(readPlanViewMode(storage)).toBe('list');
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readPlanViewMode(broken)).toBe('cards');
    expect(() => writePlanViewMode(broken, 'list')).not.toThrow();
  });

  it('the page renders the toggle and the card grid from the same plans', () => {
    const src = readFileSync(join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx'), 'utf8');
    expect(src).toContain('<PlanViewToggle');
    expect(src).toContain("viewMode === 'cards'");
    expect(src).toContain('member_count');
  });

  // #1712 — the card shows the plan's image like an Exercise card, and nothing when there is none.
  it('the plan card renders the shared square image only when the plan has one', () => {
    const card = readFileSync(join(__dirname, '..', 'app', '[locale]', 'plans', 'PlanCard.tsx'), 'utf8');
    expect(card).toContain("from '@/components/CardGrid'");
    expect(card).toMatch(/plan\.imageUrl && \(\s*<CardSquareImage/);
    const page = readFileSync(join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx'), 'utf8');
    expect(page).toContain('imageUrl: plan.image_url ?? null');
  });
});
