/**
 * #2849 — which Professional Services an **Admin** calendar event box lists,
 * one per line, in place of the event's `booked/capacity` count.
 *
 * An occurrence that offers Professional Services is booked per service
 * (#1984 stage 2a: a booking counts toward the one service it names), so the
 * event-level `0/10` says little and the services themselves are what the box
 * shows. This module only decides *which names* to show; it changes no
 * capacity, booking or availability figure.
 *
 *   • The source is the API's own effective list: `services` (the per-service
 *     capacity views `GET /class-sessions` attaches), else
 *     `eligible_professional_services` (#980 stage 3, the effective list both
 *     routers report). Nothing is re-derived from an Activity Type here.
 *   • A blank name is dropped, and a service named twice is listed once.
 *   • An empty answer means "no services": the caller keeps the event's
 *     capacity exactly as before (§3).
 *
 * Pure — no JSX, no `t()` (a service name is data), assertable in
 * `apps/admin/src/test/calendar-event-services.test.ts`.
 */

interface NamedService { id?: number | string | null; name?: string | null }

export interface CalendarEventServicesSource {
  services?: NamedService[] | null;
  eligible_professional_services?: NamedService[] | null;
}

function names(list: NamedService[] | null | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const name = typeof s?.name === 'string' ? s.name.trim() : '';
    if (!name) continue;
    const key = s?.id != null ? `id:${s.id}` : `name:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** The Professional Service names an event box lists, in the API's order; `[]` when it offers none. */
export function calendarEventServiceNames(e: CalendarEventServicesSource | null | undefined): string[] {
  if (!e) return [];
  const fromViews = names(e.services);
  return fromViews.length > 0 ? fromViews : names(e.eligible_professional_services);
}
