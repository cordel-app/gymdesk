import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2677 — on the Assigned Plan card, the open section editor's Save/Cancel is
// rendered at the end of that section (after its fields and hint, before the
// next section), never once at the foot of the whole configuration block.
// apps/admin has no component-test infra, so the wiring is pinned by scanning
// the source, comments stripped.

const SRC = readFileSync(
  join(__dirname, '..', 'components', 'assignedPlan', 'AssignedPlanConfiguration.tsx'), 'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\s*\}/g, '{}');

function sectionBody(label: string, next: string): string {
  const start = SRC.indexOf(label);
  const end = SRC.indexOf(next, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('Assigned Plan section Save/Cancel placement (#2677)', () => {
  it('closes Billing & Duration with its own pair, before Membership Fee Benefit', () => {
    const body = sectionBody("t('section_billing_duration')", "t('section_membership_fee_benefit')");
    const pair = body.indexOf('sectionActions(saveDuration)');
    expect(pair).toBeGreaterThan(body.indexOf("t('snapshot_edit_hint')"));
    expect(pair).toBeLessThan(body.indexOf('</CardSection>'));
  });

  it('closes Membership Fee Benefit with its own pair, before the benefit sections', () => {
    const body = sectionBody("t('section_membership_fee_benefit')", 'BENEFIT_SECTIONS.map(');
    const pair = body.indexOf('sectionActions(saveFeeBenefit)');
    expect(pair).toBeGreaterThan(body.indexOf("t('personal_fee_benefit_hint')"));
    expect(pair).toBeLessThan(body.indexOf('</CardSection>'));
  });

  it('closes each Product benefit section with its own pair', () => {
    const body = sectionBody('BENEFIT_SECTIONS.map(', "t('section_plan_promotions')");
    const pair = body.indexOf('sectionActions(() => saveBenefits(endpoint))');
    expect(pair).toBeGreaterThan(body.indexOf('<ProductBenefitEditor'));
    expect(pair).toBeLessThan(body.indexOf('<ProductBenefitView'));
  });

  it('renders no pair after the last section', () => {
    const tail = SRC.slice(SRC.indexOf("t('section_plan_promotions')"));
    expect(tail).not.toContain('<SaveCancel');
    expect(tail).not.toContain('sectionActions(');
  });
});
