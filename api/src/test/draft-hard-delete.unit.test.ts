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
    expect(block).toContain('gym_id = ?');
  });

  it('only deletes a locked Draft row and answers 409 otherwise', () => {
    expect(block).toContain('FOR UPDATE');
    expect(block).toContain('ASSIGNMENT_CREATION_STATUS');
    expect(block).toContain('DELETE FROM user_memberships');
    expect(block).toContain('409');
  });
});
