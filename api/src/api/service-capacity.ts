/**
 * #1984 stage 1 — the SQL half of `domain/serviceCapacity.ts`: which Professional
 * Services an occurrence offers, each one's effective capacity and how many
 * `booked` rows name it. The decision (override → Activity Type default → event
 * capacity, and what the occupancy means) is the domain module's.
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
    `SELECT ceeps.calendar_event_id AS event_id, ps.id, ps.name, NULL AS activity_default
       FROM calendar_event_eligible_professional_services ceeps
       JOIN professional_services ps ON ps.id = ceeps.professional_service_id AND ps.deleted_at IS NULL
      WHERE ceeps.gym_id = ? AND ceeps.calendar_event_id IN (${ph})`,
    [gymId, ...eventIds],
  );
  const { rows: inherited } = await q.query(
    `SELECT ce.id AS event_id, ps.id, ps.name, ateps.capacity AS activity_default
       FROM calendar_events ce
       JOIN activity_type_eligible_professional_services ateps
         ON ateps.activity_type_id = ce.activity_type_id AND ateps.gym_id = ce.gym_id
       JOIN professional_services ps ON ps.id = ateps.professional_service_id AND ps.deleted_at IS NULL
      WHERE ce.gym_id = ? AND ce.id IN (${ph})`,
    [gymId, ...eventIds],
  );
  // The Activity Type's default also applies to a service an occurrence lists itself.
  const { rows: defaults } = await q.query(
    `SELECT ce.id AS event_id, ateps.professional_service_id AS service_id, ateps.capacity
       FROM calendar_events ce
       JOIN activity_type_eligible_professional_services ateps
         ON ateps.activity_type_id = ce.activity_type_id AND ateps.gym_id = ce.gym_id
      WHERE ce.gym_id = ? AND ce.id IN (${ph})`,
    [gymId, ...eventIds],
  );
  const { rows: overrides } = await q.query(
    `SELECT calendar_event_id AS event_id, professional_service_id AS service_id, capacity
       FROM calendar_event_service_capacity
      WHERE gym_id = ? AND calendar_event_id IN (${ph})`,
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
  const defaultOf = new Map(defaults.map((r: any) => [key(r.event_id, r.service_id), r.capacity == null ? null : Number(r.capacity)]));
  const overrideOf = new Map(overrides.map((r: any) => [key(r.event_id, r.service_id), Number(r.capacity)]));
  const occupiedOf = new Map(counts.map((r: any) => [key(r.event_id, r.service_id), Number(r.n)]));

  for (const ev of events as any[]) {
    const source = (ev.own_list ? own : inherited).filter((r: any) => Number(r.event_id) === Number(ev.id));
    const views = source
      .map((s: any) => {
        const k = key(ev.id, s.id);
        return serviceCapacityView(
          { id: s.id, name: s.name },
          { override: overrideOf.get(k) ?? null, activityDefault: defaultOf.get(k) ?? null, eventCapacity: Number(ev.event_capacity) },
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
 * bookings of the same service. A service the occurrence does not list (a staff
 * override of the gate) has the event's own capacity, as before.
 */
export async function loadServiceOccupancy(
  q: Queryable, gymId: string, eventId: number, serviceId: number, eventCapacity: number,
): Promise<{ capacity: number; occupied: number }> {
  const { rows: ov } = await q.query(
    'SELECT capacity FROM calendar_event_service_capacity WHERE gym_id = ? AND calendar_event_id = ? AND professional_service_id = ?',
    [gymId, eventId, serviceId],
  );
  const { rows: df } = await q.query(
    `SELECT ateps.capacity FROM calendar_events ce
       JOIN activity_type_eligible_professional_services ateps
         ON ateps.activity_type_id = ce.activity_type_id AND ateps.gym_id = ce.gym_id
      WHERE ce.id = ? AND ce.gym_id = ? AND ateps.professional_service_id = ?`,
    [eventId, gymId, serviceId],
  );
  const { rows: cnt } = await q.query(
    `SELECT COUNT(*) AS n FROM calendar_event_bookings
      WHERE gym_id = ? AND calendar_event_id = ? AND professional_service_id = ? AND status = 'booked'`,
    [gymId, eventId, serviceId],
  );
  const capacity = effectiveServiceCapacity({
    override: ov[0] ? Number(ov[0].capacity) : null,
    activityDefault: df[0]?.capacity == null ? null : Number(df[0].capacity),
    eventCapacity,
  });
  return { capacity, occupied: Number(cnt[0].n) };
}

/** Replace-all of an occurrence's overrides, inside the caller's transaction. `null` removes one. */
export async function writeServiceCapacityOverrides(
  tx: Queryable, gymId: string, eventId: number | string, capacities: Map<number, number | null>,
): Promise<void> {
  for (const [serviceId, capacity] of capacities) {
    if (capacity === null) {
      await tx.query(
        'DELETE FROM calendar_event_service_capacity WHERE gym_id = ? AND calendar_event_id = ? AND professional_service_id = ?',
        [gymId, eventId, serviceId],
      );
    } else {
      await tx.query(
        `INSERT INTO calendar_event_service_capacity (gym_id, calendar_event_id, professional_service_id, capacity)
         VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE capacity = VALUES(capacity)`,
        [gymId, eventId, serviceId, capacity],
      );
    }
  }
}
