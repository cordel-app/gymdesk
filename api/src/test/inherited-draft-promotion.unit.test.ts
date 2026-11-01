import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

describe('Promotions only on lines added in the Draft (#1863)', () => {
  it('marks every row the clone copies as inherited', () => {
    const src = read('../api/product-set-bridge.ts');
    // The plan snapshots are copied inherited by `copyPlanSnapshotToVersion()` (stage 17).
    expect(read('../api/plan-snapshot-add.ts')).toMatch(/ps\.status, 1, s\.starts_at/);
    expect(src).toMatch(/line_ref, origin, is_inherited\)/);
    expect(src).toMatch(/line_ref, origin, 1\s+FROM member_products_recurrent_snapshot/);
  });

  it('refuses a Plan Promotion on an inherited plan in the one writer', () => {
    const src = read('../api/membership-promotions.ts');
    expect(src).toMatch(/SELECT is_inherited FROM plan_snapshots/);
    expect(src).toMatch(/inherited from the previous version/);
  });

  it('adds the column with a safe default so existing rows stay eligible', () => {
    const mig = read('../infra/migrations/305_inherited_draft_lines.js');
    expect(mig).toMatch(/is_inherited TINYINT\(1\) NOT NULL DEFAULT 0/);
  });
});
