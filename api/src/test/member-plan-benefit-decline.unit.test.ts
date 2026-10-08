import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// #1184 stage 3b — the Members App and the bulk-assign modal send the same
// `declined_benefits` the API already enforces (stage 3).
const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('#1184 stage 3b — decline checkboxes', () => {
  it('GET /me/membership-plans reports each plan\'s benefits', () => {
    const src = read('api/src/api/me-membership-plans.ts');
    expect(src).toContain('loadNamedPlanBenefitLines');
    expect(src).toContain('benefits: benefitsByPlan.get');
  });

  it('the Members App sends only unticked optional lines', () => {
    const lib = read('apps/member/src/lib/memberPlanCatalogue.ts');
    expect(lib).toContain('!b.mandatory && declinedKeys.has');
    const page = read('apps/member/src/app/[locale]/membership/page.tsx');
    expect(page).toContain('declined_benefits: declinedBenefitsPayload(');
  });

  it('the Plans page bulk assign sends declined_benefits through the shared helper', () => {
    const src = read('apps/admin/src/app/[locale]/plans/AssignPlanModal.tsx');
    expect(src).toContain('declined_benefits: declinedPayload(');
  });

  it('locale keys exist in en/es/ca', () => {
    for (const l of ['en', 'es', 'ca']) {
      const m = JSON.parse(read(`apps/member/locales/base/${l}.json`)).membership;
      for (const k of ['plan_benefits_heading', 'plan_benefit_mandatory', 'plan_benefit_optional']) {
        expect(m[k]).toBeTruthy();
      }
    }
  });
});
