import { describe, expect, it } from 'vitest';
import { incompleteServiceRows } from '../domain/incompleteClasses';
import { serviceCapacityView } from '../domain/serviceCapacity';

const view = (id: number, name: string, cap: number, occ: number) =>
  serviceCapacityView({ id, name }, { override: null, activityDefault: cap, eventCapacity: 10 }, occ);

describe('incompleteServiceRows', () => {
  it('lists only services with some, not all, places taken', () => {
    const views = new Map([[1, [view(10, 'PT', 1, 1), view(11, 'Duo', 2, 1), view(12, 'Trio', 3, 0), view(13, 'Pair', 2, 2)]]]);
    const rows = incompleteServiceRows(
      [{ id: 1, name: 'Training', starts_at: '2026-11-01T10:00:00.000Z' }],
      views,
      [{ event_id: 1, service_id: 11, name: 'Ana' }, { event_id: 1, service_id: 10, name: 'Bo' }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service_id: 11, occupied: 1, capacity: 2, remaining: 1, participants: ['Ana'] });
  });
});
