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
}

/** `Occupied / Total`, e.g. `1 / 2`. */
export function serviceOccupancyLabel(row: Pick<ServiceCapacityRow, 'occupied' | 'capacity'>): string {
  return `${row.occupied} / ${row.capacity}`;
}

/**
 * #2499 — a Professional Service's capacity is its own configuration (`max_capacity`,
 * `min_participants`), shown beside its name wherever it is offered and never
 * entered again on an Activity or an event. Which locale key and values the label
 * takes is decided here (a value that is not configured is left out, never
 * defaulted); the page resolves the key.
 */
export interface ServiceCapacityConfig {
  max_capacity?: number | null;
  min_participants?: number | null;
}

export function serviceCapacityRange(
  svc: ServiceCapacityConfig,
): { key: 'service_capacity_range' | 'service_capacity_max_only' | 'service_capacity_min_only'; min?: number; max?: number } | null {
  const max = svc.max_capacity != null ? Number(svc.max_capacity) : null;
  const min = svc.min_participants != null ? Number(svc.min_participants) : null;
  if (max !== null && min !== null) return { key: 'service_capacity_range', min, max };
  if (max !== null) return { key: 'service_capacity_max_only', max };
  if (min !== null) return { key: 'service_capacity_min_only', min };
  return null;
}

/** `Training Duo (min 2 - max 2)`; the bare name when no capacity is configured. */
export function serviceNameWithCapacity(
  name: string, svc: ServiceCapacityConfig,
  t: (key: 'service_capacity_range' | 'service_capacity_max_only' | 'service_capacity_min_only', values: { min?: number; max?: number }) => string,
): string {
  const range = serviceCapacityRange(svc);
  return range ? `${name} (${t(range.key, { min: range.min, max: range.max })})` : name;
}
