/**
 * #1984 stage 1 — the SQL half of `domain/serviceCapacity.ts`: which Professional
 * Services an occurrence offers, each one's effective capacity and how many
 * `booked` rows name it. The decision (the service's own maximum, capped by the
 * event capacity, and what the occupancy means) is the domain module's (#2499).
 *
 * Which list applies is `loadRequiredServices()`'s rule (#980 stage 3): the
 * occurrence's own rows when `eligible_services_override` is set, else its
 * Activity Type's.
 */
import type { Tx } from '../infra/db';
import { serviceCapacityView, effectiveServiceCapacity, type ServiceCapacityView } from '../domain/serviceCapacity';

interface Queryable { query: Tx['query'] }

const placeholders = (n: number) => Array(n).fill('?').join(', ');

export async function loadServiceCapacityViews(
  q: Queryable, gymId: string, eventIds: number[],
): Promise<Map<number, ServiceCapacityView[]>> {
  const result = new Map<number, ServiceCapacityView[]>();
  if (eventIds.length === 0) return result;
  const ph = placeholders(eventIds.length);

  const { rows: events } = await q.query(
    `SELECT ce.id, ce.eligible_services_override AS own_list,
            COALESCE(ce.capacity, at.max_capacity) AS event_capacity
       FROM calendar_events ce
       JOIN activity_types at ON at.id = ce.activity_type_id
      WHERE ce.gym_id = ? AND ce.id IN (${ph})`,
    [gymId, ...eventIds],
  );
  const { rows: own } = await q.query(
    `SELECT ceeps.calendar_event_id AS event_id, ps.id, ps.name, ps.max_capacity
       FROM calendar_event_eligible_professional_services ceeps
       JOIN professional_services ps ON ps.id = ceeps.professional_service_id AND ps.deleted_at IS NULL
      WHERE ceeps.gym_id = ? AND ceeps.calendar_event_id IN (${ph})`,
    [gymId, ...eventIds],
  );
  const { rows: inherited } = await q.query(
    `SELECT ce.id AS event_id, ps.id, ps.name, ps.max_capacity
       FROM calendar_events ce
       JOIN activity_type_eligible_professional_services ateps
         ON ateps.activity_type_id = ce.activity_type_id AND ateps.gym_id = ce.gym_id
       JOIN professional_services ps ON ps.id = ateps.professional_service_id AND ps.deleted_at IS NULL
      WHERE ce.gym_id = ? AND ce.id IN (${ph})`,
    [gymId, ...eventIds],
  );
  const { rows: counts } = await q.query(
    `SELECT calendar_event_id AS event_id, professional_service_id AS service_id, COUNT(*) AS n
       FROM calendar_event_bookings
      WHERE gym_id = ? AND status = 'booked' AND professional_service_id IS NOT NULL
        AND calendar_event_id IN (${ph})
      GROUP BY calendar_event_id, professional_service_id`,
    [gymId, ...eventIds],
  );

  const key = (e: unknown, s: unknown) => `${Number(e)}:${Number(s)}`;
  const occupiedOf = new Map(counts.map((r: any) => [key(r.event_id, r.service_id), Number(r.n)]));

  for (const ev of events as any[]) {
    const source = (ev.own_list ? own : inherited).filter((r: any) => Number(r.event_id) === Number(ev.id));
    const views = source
      .map((s: any) => {
        const k = key(ev.id, s.id);
        return serviceCapacityView(
          { id: s.id, name: s.name },
          { serviceMax: s.max_capacity == null ? null : Number(s.max_capacity), eventCapacity: Number(ev.event_capacity) },
          occupiedOf.get(k) ?? 0,
        );
      })
      .sort((a: ServiceCapacityView, b: ServiceCapacityView) => a.name.localeCompare(b.name));
    result.set(Number(ev.id), views);
  }
  return result;
}

/**
 * The booking path's question: how many places does this service have on this
 * occurrence and how many are taken. Read inside the transaction that already
 * holds the occurrence row `FOR UPDATE`, which is what serialises concurrent
 * bookings of the same service. A service with no maximum has the event's own capacity.
 */
export async function loadServiceOccupancy(
  q: Queryable, gymId: string, eventId: number, serviceId: number, eventCapacity: number,
): Promise<{ capacity: number; occupied: number }> {
  const { rows: svc } = await q.query(
    'SELECT max_capacity FROM professional_services WHERE id = ? AND deleted_at IS NULL',
    [serviceId],
  );
  const { rows: cnt } = await q.query(
    `SELECT COUNT(*) AS n FROM calendar_event_bookings
      WHERE gym_id = ? AND calendar_event_id = ? AND professional_service_id = ? AND status = 'booked'`,
    [gymId, eventId, serviceId],
  );
  const capacity = effectiveServiceCapacity({
    serviceMax: svc[0]?.max_capacity == null ? null : Number(svc[0].max_capacity),
    eventCapacity,
  });
  return { capacity, occupied: Number(cnt[0].n) };
}

/** #2500 — what a member is shown of one Professional Service an occurrence accepts. */
export interface MemberEventService {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  /** The effective capacity for this occurrence (#1984), never the event's total. */
  capacity: number;
}

/**
 * The Professional Services each occurrence accepts, for the Members App's
 * My Bookings and Calendar. The service list and each capacity are
 * `loadServiceCapacityViews()`'s (no second rule); this only adds what a member
 * sees (description and images) and drops a service the gym has switched off.
 * An occurrence that names no service has an empty list.
 */
export async function loadMemberEventServices(
  q: Queryable, gymId: string, eventIds: number[],
): Promise<Map<number, MemberEventService[]>> {
  const result = new Map<number, MemberEventService[]>();
  if (eventIds.length === 0) return result;
  const views = await loadServiceCapacityViews(q, gymId, eventIds);
  const serviceIds = [...new Set([...views.values()].flat().map((v) => v.id))];
  if (serviceIds.length === 0) return result;
  const { rows } = await q.query(
    `SELECT ps.id, ps.description, ps.image_url, ps.image_thumbnail_url
       FROM professional_services ps
       LEFT JOIN gym_professional_services gps
         ON gps.professional_service_id = ps.id AND gps.gym_id = ?
      WHERE ps.id IN (${placeholders(serviceIds.length)}) AND ps.deleted_at IS NULL
        AND COALESCE(gps.status, 'active') = 'active'`,
    [gymId, ...serviceIds],
  );
  const info = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));
  for (const [eventId, list] of views) {
    const shown = list
      .filter((v) => info.has(v.id))
      .map((v) => {
        const r = info.get(v.id);
        return {
          id: v.id,
          name: v.name,
          description: r.description?.trim() ? r.description : null,
          image_url: r.image_url || null,
          image_thumbnail_url: r.image_thumbnail_url || null,
          capacity: v.capacity,
        };
      });
    if (shown.length) result.set(eventId, shown);
  }
  return result;
}
