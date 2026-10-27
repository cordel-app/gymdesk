/**
 * #1984 — presentation of a Professional Service's capacity. The numbers are the
 * API's (`services[]` on a class session, `capacity` on an Activity Type's
 * eligible service); nothing here decides an occupancy or a status.
 */

export interface ServiceCapacityRow {
  id: number;
  name: string;
  capacity: number;
  occupied: number;
  remaining: number;
  status: 'available' | 'incomplete' | 'full';
  capacity_overridden: boolean;
}

/** `Occupied / Total`, e.g. `1 / 2`. */
export function serviceOccupancyLabel(row: Pick<ServiceCapacityRow, 'occupied' | 'capacity'>): string {
  return `${row.occupied} / ${row.capacity}`;
}

/**
 * A capacity input: empty means "follow the event's capacity" (`null`), a
 * positive integer is a capacity and anything else is refused (`undefined`),
 * so the form can name the problem instead of sending a 400.
 */
export function parseCapacityInput(raw: string): number | null | undefined {
  const value = raw.trim();
  if (value === '') return null;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
}

/** The `capacities` body of `PUT /activity-types/:id/eligible-professional-services`. */
export function capacitiesPayload(
  selected: Iterable<number>, inputs: Record<number, string>,
): { capacities: Record<number, number | null> } | { error: number } {
  const capacities: Record<number, number | null> = {};
  for (const id of selected) {
    const parsed = parseCapacityInput(inputs[id] ?? '');
    if (parsed === undefined) return { error: id };
    capacities[id] = parsed;
  }
  return { capacities };
}
