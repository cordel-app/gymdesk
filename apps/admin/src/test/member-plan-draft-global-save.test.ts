import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #1538 stage 2: embedded in the Member card, a plan Draft has no Save / Save & Pay of its own.
const src = readFileSync(join(__dirname, '../components/assignedPlan/AssignedPlanExpandedRow.tsx'), 'utf-8');

describe('#1538 — plan Draft defers to the global Save & Pay when embedded', () => {
  it('gates the menu item and both buttons on the host not being embedded', () => {
    expect(src).toMatch(/canSaveAndPay && !embedded/);
    expect(src).toMatch(/\{!embedded && <button[^>]*onClick=\{\(\) => saveDraft\(\)\}/);
    expect(src).toMatch(/\{!embedded && <button[^>]*\n[^\n]*onClick=\{\(\) => saveAndPay\(\)\}/);
  });
});
