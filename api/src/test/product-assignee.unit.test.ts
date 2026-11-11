// #2609 stage 1 — the pure rule for who an Individual Product assignment is for.
import { describe, expect, it } from 'vitest';
import { assignedMemberSql, parseAssignedMemberInput, resolveAssignee } from '../domain/productAssignee';

describe('parseAssignedMemberInput', () => {
  it('distinguishes absent, cleared, a member and garbage', () => {
    expect(parseAssignedMemberInput(undefined)).toEqual({ kind: 'absent' });
    expect(parseAssignedMemberInput(null)).toEqual({ kind: 'none' });
    expect(parseAssignedMemberInput('')).toEqual({ kind: 'none' });
    expect(parseAssignedMemberInput(7)).toEqual({ kind: 'member', memberId: 7 });
    expect(parseAssignedMemberInput('7')).toEqual({ kind: 'member', memberId: 7 });
    expect(parseAssignedMemberInput(0)).toEqual({ kind: 'invalid' });
    expect(parseAssignedMemberInput('x')).toEqual({ kind: 'invalid' });
    expect(parseAssignedMemberInput(1.5)).toEqual({ kind: 'invalid' });
  });
});

describe('resolveAssignee', () => {
  const family = [10, 11, 12];

  it('defaults an individual Product to the purchaser', () => {
    expect(resolveAssignee({ requested: { kind: 'absent' }, purchaserId: 10, familyMemberIds: family, sharingType: 'individual' }))
      .toEqual({ ok: true, assignedMemberId: 10 });
    expect(resolveAssignee({ requested: { kind: 'none' }, purchaserId: 5, familyMemberIds: [], sharingType: 'individual' }))
      .toEqual({ ok: true, assignedMemberId: 5 });
    // A row with no sharing type (the Product is gone) is read as individual.
    expect(resolveAssignee({ requested: { kind: 'absent' }, purchaserId: 5, familyMemberIds: [], sharingType: null }))
      .toEqual({ ok: true, assignedMemberId: 5 });
  });

  it('accepts the purchaser or a member of their family, and refuses an outsider', () => {
    expect(resolveAssignee({ requested: { kind: 'member', memberId: 12 }, purchaserId: 10, familyMemberIds: family, sharingType: 'individual' }))
      .toEqual({ ok: true, assignedMemberId: 12 });
    expect(resolveAssignee({ requested: { kind: 'member', memberId: 10 }, purchaserId: 10, familyMemberIds: [], sharingType: 'individual' }))
      .toEqual({ ok: true, assignedMemberId: 10 });
    expect(resolveAssignee({ requested: { kind: 'member', memberId: 99 }, purchaserId: 10, familyMemberIds: family, sharingType: 'individual' }))
      .toEqual({ ok: false, error: 'assignee_not_in_family' });
    expect(resolveAssignee({ requested: { kind: 'member', memberId: 11 }, purchaserId: 10, familyMemberIds: [], sharingType: 'individual' }))
      .toEqual({ ok: false, error: 'assignee_not_in_family' });
    expect(resolveAssignee({ requested: { kind: 'invalid' }, purchaserId: 10, familyMemberIds: family, sharingType: 'individual' }))
      .toEqual({ ok: false, error: 'assignee_invalid' });
  });

  it('stores nothing for a shared Product and refuses naming someone else for it', () => {
    expect(resolveAssignee({ requested: { kind: 'absent' }, purchaserId: 10, familyMemberIds: family, sharingType: 'shared' }))
      .toEqual({ ok: true, assignedMemberId: null });
    expect(resolveAssignee({ requested: { kind: 'member', memberId: 10 }, purchaserId: 10, familyMemberIds: family, sharingType: 'shared' }))
      .toEqual({ ok: true, assignedMemberId: null });
    expect(resolveAssignee({ requested: { kind: 'member', memberId: 11 }, purchaserId: 10, familyMemberIds: family, sharingType: 'shared' }))
      .toEqual({ ok: false, error: 'assignee_not_allowed' });
  });

  it('reads a legacy row and a shared Product as the purchaser, with no products join', () => {
    expect(assignedMemberSql('mp', 'mp.member_id')).toBe('COALESCE(mp.assigned_member_id, mp.member_id)');
  });
});
