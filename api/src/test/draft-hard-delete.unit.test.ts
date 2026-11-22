import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #1240: Cancel on a Draft is a hard delete, guarded to status 'draft'.
const src = readFileSync(join(__dirname, '../api/user-memberships.ts'), 'utf8');

describe('DELETE /user-memberships/:id/draft (#1240)', () => {
  const start = src.indexOf("userMembershipsRouter.delete('/:id/draft'");
  const block = src.slice(start, src.indexOf('userMembershipsRouter.delete(\'/:id\'', start));

  it('exists, is write-gated and tenant-scoped', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("requireModuleWrite('PAYMENTS')");
    expect(block).toContain('lockAssignmentRecord(tx, gymId'); // tenant-scoped through the anchor lock
  });

  it('only deletes a locked Draft row and answers 409 otherwise', () => {
    expect(block).toContain('lockAssignmentRecord('); // #2125 M6b-51d-2: the lock is the anchor snapshot's
    expect(block).toContain('ASSIGNMENT_CREATION_STATUS');
    expect(block).toContain('deleteDraftAssignments(tx, gymId'); // #2125 M6b-51d-3: the writer deletes `in_cart` rows only
    expect(block).toContain('409');
  });
});
