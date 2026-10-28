/**
 * #1984 stage 3 — Home's "Incomplete classes": which services of upcoming
 * sessions hold some bookings but not all their places. Pure; the SQL is in
 * `api/src/api/home-dashboard.ts`. The status itself is `serviceCapacity.ts`'s
 * (`incomplete` = some places taken, not all), so a one-place service never
 * appears and Home cannot disagree with the Calendar.
 */
import type { ServiceCapacityView } from './serviceCapacity';

export interface IncompleteServiceRow {
  event_id: number;
  event_name: string;
  starts_at: string;
  service_id: number;
  service_name: string;
  occupied: number;
  capacity: number;
  remaining: number;
  participants: string[];
}

export function incompleteServiceRows(
  events: { id: number; name: string; starts_at: string }[],
  views: Map<number, ServiceCapacityView[]>,
  people: { event_id: number; service_id: number; name: string }[],
): IncompleteServiceRow[] {
  const out: IncompleteServiceRow[] = [];
  for (const ev of events) {
    for (const v of views.get(ev.id) ?? []) {
      if (v.status !== 'incomplete') continue;
      out.push({
        event_id: ev.id,
        event_name: ev.name,
        starts_at: ev.starts_at,
        service_id: v.id,
        service_name: v.name,
        occupied: v.occupied,
        capacity: v.capacity,
        remaining: v.remaining,
        participants: people.filter((p) => p.event_id === ev.id && p.service_id === v.id).map((p) => p.name),
      });
    }
  }
  return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.event_id - b.event_id || a.service_id - b.service_id);
}
