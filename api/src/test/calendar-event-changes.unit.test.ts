// #980 stage 1 — the audit diff behind `PUT /class-sessions/:id` (§11).
//
// The route is a partial write, so "what the request sent" and "what changed
// about the occurrence" are two different sets. These are the comparison rules
// the one place deciding it has to get right: a value is unchanged when it is
// the same value, whatever type the driver handed it back as, and an unchanged
// edit writes no audit row at all.

import { describe, expect, it } from 'vitest';
import { diffAuditedFields, SESSION_AUDITED_FIELDS } from '../domain/calendarEventChanges';

describe('diffAuditedFields (#980 §11)', () => {
  it('reports only the fields that changed, previous → new', () => {
    const before = { trainer_membership_id: 7, space_id: 3, capacity: 4 };
    const after  = { trainer_membership_id: 9, space_id: 3, capacity: 4 };

    expect(diffAuditedFields(before, after)).toEqual({
      previous: { trainer_membership_id: 7 },
      next: { trainer_membership_id: 9 },
    });
  });

  it('answers null when nothing in the field list moved', () => {
    const row = { trainer_membership_id: 7, space_id: 3, capacity: null };
    expect(diffAuditedFields(row, { ...row })).toBeNull();
  });

  it('ignores a field outside the list, however much it changed', () => {
    // `modified_by_membership_id` moves on every write — if it counted, every
    // edit would write an audit row, including one that changed nothing.
    const before = { trainer_membership_id: 7, modified_by_membership_id: 1 };
    const after  = { trainer_membership_id: 7, modified_by_membership_id: 2 };
    expect(diffAuditedFields(before, after)).toBeNull();
  });

  it('does not read a type difference as a change', () => {
    // mysql2 gives an INT back as a number and the same value can arrive as a
    // string from a different read; a phantom change here is an audit row
    // claiming a capacity was edited when it was not.
    expect(diffAuditedFields({ capacity: 4 }, { capacity: '4' })).toBeNull();
  });

  it('compares DATETIME columns by instant, not by object identity', () => {
    const starts = new Date('2026-10-05T17:00:00Z');
    expect(diffAuditedFields(
      { starts_at: starts },
      { starts_at: new Date('2026-10-05T17:00:00Z') },
    )).toBeNull();

    const moved = diffAuditedFields(
      { starts_at: starts },
      { starts_at: new Date('2026-10-05T18:00:00Z') },
    );
    expect(moved?.next.starts_at).toEqual(new Date('2026-10-05T18:00:00Z'));
  });

  it('treats an absent key as unset rather than as a change to NULL', () => {
    expect(diffAuditedFields({ space_id: null }, {})).toBeNull();
    expect(diffAuditedFields({}, { space_id: null })).toBeNull();
  });

  it('records clearing a field, and reports NULL rather than undefined', () => {
    const cleared = diffAuditedFields({ trainer_membership_id: 7 }, { trainer_membership_id: null });
    expect(cleared).toEqual({
      previous: { trainer_membership_id: 7 },
      next: { trainer_membership_id: null },
    });
  });

  it('reports values as stored, so the audit log can resolve the FK name', () => {
    // `space_id` is enriched to `{ id, name }` by the audit registry — a
    // stringified id would lose the name a gym actually reads.
    const changes = diffAuditedFields({ space_id: 3 }, { space_id: 5 });
    expect(changes?.previous.space_id).toBe(3);
    expect(changes?.next.space_id).toBe(5);
  });

  it('covers every column the session PUT can write', () => {
    // A field added to the route and not to this list changes silently.
    expect([...SESSION_AUDITED_FIELDS]).toEqual([
      'activity_type_id',
      'trainer_membership_id',
      'space_id',
      'starts_at',
      'ends_at',
      'capacity',
      'allows_shared_booking',
      'professional_service_id',
    ]);
  });
});
