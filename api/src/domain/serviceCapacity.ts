/**
 * #1984 stage 1 — the capacity of one Professional Service offered on an
 * occurrence, and what its occupancy means. Pure: the SQL half is
 * `api/src/api/service-capacity.ts`.
 *
 * The effective capacity is the occurrence's override, else the Activity Type's
 * default for that service, else the event's own capacity (today's behaviour,
 * which is what every existing service keeps until someone configures one).
 * Occupancy is the `booked` rows that name the service: a booking counts once,
 * toward exactly one service, and never toward another's.
 */

export type ServiceOccupancyStatus = 'available' | 'incomplete' | 'full';

export interface ServiceCapacityInputs {
  override: number | null | undefined;
  activityDefault: number | null | undefined;
  eventCapacity: number;
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export function effectiveServiceCapacity({ override, activityDefault, eventCapacity }: ServiceCapacityInputs): number {
  if (positive(override)) return override;
  if (positive(activityDefault)) return activityDefault;
  return eventCapacity;
}

/**
 * Available: nobody booked it. Incomplete: some places taken, not all. Full: all.
 * A one-place service is therefore never incomplete.
 */
export function serviceOccupancyStatus(occupied: number, capacity: number): ServiceOccupancyStatus {
  if (occupied >= capacity) return 'full';
  return occupied > 0 ? 'incomplete' : 'available';
}

export function isServiceFull(occupied: number, capacity: number): boolean {
  return occupied >= capacity;
}

export interface ServiceCapacityView {
  id: number;
  name: string;
  capacity: number;
  occupied: number;
  remaining: number;
  status: ServiceOccupancyStatus;
  /** True when the occurrence overrides the Activity Type's value. */
  capacity_overridden: boolean;
}

export function serviceCapacityView(
  service: { id: number; name: string },
  inputs: ServiceCapacityInputs,
  occupied: number,
): ServiceCapacityView {
  const capacity = effectiveServiceCapacity(inputs);
  return {
    id: Number(service.id),
    name: service.name,
    capacity,
    occupied,
    remaining: Math.max(0, capacity - occupied),
    status: serviceOccupancyStatus(occupied, capacity),
    capacity_overridden: positive(inputs.override),
  };
}

export type CapacityMapResult =
  | { ok: true; capacities: Map<number, number | null> }
  | { ok: false; error: string };

/**
 * Judges a request's `{ "<service id>": n | null }` map. `null` is "follow the
 * default again"; anything else that is not a positive integer is a 400, never a
 * coercion (a capacity of 0 would silently close a service).
 */
export function parseServiceCapacitiesInput(raw: unknown, field = 'service_capacities'): CapacityMapResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${field} must be an object of service id to capacity` };
  }
  const capacities = new Map<number, number | null>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: `${field} keys must be positive integers` };
    if (value === null || value === '') { capacities.set(id, null); continue; }
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!positive(n)) return { ok: false, error: `${field} values must be positive integers or null` };
    capacities.set(id, n);
  }
  return { ok: true, capacities };
}
