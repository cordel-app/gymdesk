/**
 * #1984 stage 1 — the capacity of one Professional Service offered on an
 * occurrence, and what its occupancy means. Pure: the SQL half is
 * `api/src/api/service-capacity.ts`.
 *
 * The effective capacity is the Professional Service's own `max_capacity`
 * (#2499: the service is the single source of truth, nothing on an Activity or
 * an occurrence overrides it), capped by the event's own capacity, which stays
 * the ceiling; a service with no maximum takes the event's capacity.
 * Occupancy is the `booked` rows that name the service: a booking counts once,
 * toward exactly one service, and never toward another's.
 */

export type ServiceOccupancyStatus = 'available' | 'incomplete' | 'full';

export interface ServiceCapacityInputs {
  serviceMax: number | null | undefined;
  eventCapacity: number;
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export function effectiveServiceCapacity({ serviceMax, eventCapacity }: ServiceCapacityInputs): number {
  if (positive(serviceMax)) return Math.min(serviceMax, eventCapacity);
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
  };
}
