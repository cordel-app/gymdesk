// #1191 — Primary / Linked is derived, never stored, and decided in one place.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSIGNMENT_RELATIONSHIPS,
  MEMBER_MEMBERSHIP_SQL,
  assignmentRelationship,
} from '../domain/assignmentRelationship';

describe('assignmentRelationship()', () => {
  it('is primary for the owner', () => {
    expect(assignmentRelationship(5, 5)).toBe('primary');
  });
  it('is linked for any other covered Member', () => {
    expect(assignmentRelationship(6, 5)).toBe('linked');
  });
  it('compares ids numerically, so "5" and 5 are the same Member', () => {
    expect(assignmentRelationship('5', 5)).toBe('primary');
    expect(assignmentRelationship(5, '5')).toBe('primary');
  });
  it('declares exactly the two values', () => {
    expect([...ASSIGNMENT_RELATIONSHIPS]).toEqual(['primary', 'linked']);
  });
});

describe('MEMBER_MEMBERSHIP_SQL', () => {
  it('binds the Member twice and reads the owner column and the covered-member table', () => {
    expect(MEMBER_MEMBERSHIP_SQL.match(/\?/g)).toHaveLength(2);
    expect(MEMBER_MEMBERSHIP_SQL).toContain('um.member_id = ?');
    expect(MEMBER_MEMBERSHIP_SQL).toContain('user_membership_members');
  });
});

describe('#1191 wiring', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('the list filter and the configuration read share the one fragment', () => {
    expect(read('api/user-memberships.ts')).toContain('MEMBER_MEMBERSHIP_SQL');
    expect(read('api/member-membership-configuration.ts')).toContain('MEMBER_MEMBERSHIP_SQL');
  });

  it('adds no stored linked column', () => {
    const migrations = join(__dirname, '..', 'infra', 'migrations');
    // No migration may introduce a `linked` / `assignment_relationship` column.
    // It looks for a column definition, not the word: migration 239 (#1234) says
    // a Member "linked their Clerk account" in a comment and is not a violation.
    const linkedColumn = /assignment_relationship|add\s+column\s+`?\w*linked\w*`?|\.(?:string|boolean|integer|tinyint|specificType)\(\s*['"]\w*linked\w*['"]/i;
    for (const f of readdirSync(migrations) as string[]) {
      if (!/^(23[8-9]|2[4-9]\d)_/.test(f)) continue;
      expect(readFileSync(join(migrations, f), 'utf8')).not.toMatch(linkedColumn);
    }
  });
});
