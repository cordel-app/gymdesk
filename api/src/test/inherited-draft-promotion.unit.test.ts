import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

describe('Promotions only on lines added in the Draft (#1863)', () => {
  it('marks every row the clone copies as inherited', () => {
    const src = read('../api/product-set-bridge.ts');
    // A plan snapshot copied by `copyPlanSnapshotToVersion()` records its source (#2125 M5a), which is
    // what `planSnapshotInheritedSql()` reads it as inherited by.
    expect(read('../api/plan-snapshot-add.ts')).toMatch(/ps\.status, s\.id, s\.starts_at/);
    expect(read('../api/plan-snapshot-lines.ts')).toMatch(/copied_from_plan_snapshot_id IS NOT NULL/);
    // The clone links the predecessor's recurring lines (#2126 stage 5c-2c-2); a copy (the merge, or a
    // writer owning a shared line) is written inherited (its snapshot; the legacy line is no longer
    // written since #2126 stage 5d-5). Since #2126 stage 6a the copy records its source snapshot instead of a flag.
    expect(src).toMatch(/linkRecurringLines\(/);
    const writer = read('../api/recurring-line-writer.ts');
    expect(writer).not.toMatch(/INSERT INTO member_products_recurrent_snapshot/);
    expect(writer).toMatch(/ps\.status, \?, COALESCE\(\?, p\.name\)/);
    expect(read('../api/recurring-line-sharing.ts')).toMatch(/copied_from_periodical_snapshot_id IS NOT NULL/);
  });

  it('refuses a Plan Promotion on an inherited plan in the one writer', () => {
    const src = read('../api/membership-promotions.ts');
    expect(src).toContain("planSnapshotInheritedSql('s', 'psj.product_set_id')");
    expect(src).toMatch(/inherited from the previous version/);
  });

  it('adds the column with a safe default so existing rows stay eligible', () => {
    const mig = read('../infra/migrations/305_inherited_draft_lines.js');
    expect(mig).toMatch(/is_inherited TINYINT\(1\) NOT NULL DEFAULT 0/);
  });
});
