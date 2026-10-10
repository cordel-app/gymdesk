import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #1326 — the Account section's Clerk lines are chips, and an invite / re-invite /
// revoke re-reads the open row's Clerk status instead of leaving it stale.
const root = join(__dirname, '../../../apps/admin/src/app/[locale]/members');
const row = readFileSync(join(root, 'MemberExpandedRow.tsx'), 'utf8');
const page = readFileSync(join(root, 'page.tsx'), 'utf8');

describe('member Account chips (#1326)', () => {
  it('renders the Clerk Status and Invitation values as list chips', () => {
    expect(row).toContain('listNameBadgeAccentStyle : listNameBadgeStyle');
  });
  it('refetches clerk-status when the invitation changes', () => {
    expect(row).toMatch(/accountVersion[\s\S]*clerk-status/);
    expect((page.match(/setAccountVersion\(\(v\) => v \+ 1\)/g) ?? []).length).toBe(3);
    expect(page).toContain('accountVersion={accountVersion}');
  });
});
