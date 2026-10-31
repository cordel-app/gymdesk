import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2200 — Members → Training Plan: the Inactive group is read-only (no Edit
// button), the Active group keeps it. Structural scan, as the repo has no
// component-test infra for apps/admin.
const src = readFileSync(join(__dirname, '..', 'app', '[locale]', 'members', 'MemberExpandedRow.tsx'), 'utf8');

describe('#2200 inactive training plan assignments', () => {
  const start = src.indexOf('trainingInactiveOpen && inactivePlans.map(');
  const inactiveBlock = src.slice(start, src.indexOf('))}', start));
  const activeStart = src.indexOf('activePlans.map(');
  const activeBlock = src.slice(activeStart, src.indexOf('))}', activeStart));

  it('offers no Edit handler on inactive assignments', () => {
    expect(start).toBeGreaterThan(-1);
    expect(inactiveBlock).not.toContain('onEdit=');
  });

  it('still offers Edit on active assignments', () => {
    expect(activeStart).toBeGreaterThan(-1);
    expect(activeBlock).toContain('onEdit=');
  });
});
