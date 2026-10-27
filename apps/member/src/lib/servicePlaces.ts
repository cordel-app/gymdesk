// #1984 stage 2b — what the Calendar sheet shows about a Professional Service's
// places and about bringing a linked member. Pure: the numbers and statuses are
// the API's (`services[]` on `GET /me/schedule`, `service` on the booking
// response); nothing here decides an occupancy or who may be added. Locale keys
// and strings are the page's.

export type ServicePlacesStatus = 'available' | 'incomplete' | 'full';

export interface ServicePlaces {
  id: number;
  name: string;
  capacity: number;
  occupied: number;
  remaining: number;
  status: ServicePlacesStatus;
}

export interface LinkedParticipant {
  id: number;
  name: string;
  professional_service_ids: number[];
}

/** `Occupied / Total`, e.g. `1 / 2`. */
export function servicePlacesLabel(s: Pick<ServicePlaces, 'occupied' | 'capacity'>): string {
  return `${s.occupied} / ${s.capacity}`;
}

/** Only a service with more than one place can be shared, so only then is a participant offered. */
export function hasSharedService(services: ServicePlaces[] | undefined): boolean {
  return !!services && services.some((s) => s.capacity > 1 && s.status !== 'full');
}

/** The optional part of the booking body: nothing selected sends nothing. */
export function participantsBody(selected: Iterable<number>): { participant_member_ids?: number[] } {
  const ids = [...selected];
  return ids.length > 0 ? { participant_member_ids: ids } : {};
}

/** Whether the booking just made left its service below capacity (the API's answer). */
export function leftServiceIncomplete(response: unknown): boolean {
  const status = (response as { service?: { status?: unknown } } | null)?.service?.status;
  return status === 'incomplete';
}
