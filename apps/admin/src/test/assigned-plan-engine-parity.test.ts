import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2093 stage 4 — the Plans card and the Assigned Plan card save benefit
// sections through the one engine, so the two editors cannot drift. Source scan: apps/admin has no
// component-test infra.
const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

const PLANS = read('app', '[locale]', 'plans', 'page.tsx');
const ASSIGNED = read('components', 'assignedPlan', 'AssignedPlanConfiguration.tsx');

describe('Plans and Assigned Plan editors share one engine (#2093)', () => {
  it.each([
    ['Plans page', PLANS],
    ['Assigned Plan card', ASSIGNED],
  ])('%s saves benefit sections through saveBenefitSection', (_n, src) => {
    expect(src).toMatch(/saveBenefitSection\(/);
  });

  it('the Assigned Plan Billing & Duration save validates before the first request', () => {
    expect(ASSIGNED).toMatch(/durationFormError\(/);
  });
});
