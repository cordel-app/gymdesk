// #2587 — the Professional Service a member picks inline when booking.
//
// Pure: no React, no `t()`. The accepted list is the event's own
// (`professional_services` on /me/schedule, #2500) and the balance is the
// member's own wallet (`GET /me/professional-services`, #1779), the very read
// the booking gate uses, so nothing here keeps an accounting of its own. The
// server still validates and spends (#1985); this only decides what is offered.

export interface AcceptedService { id: number; name: string }
/**
 * #2605 stage 3: `available` is remaining minus the units the member's future
 * bookings already hold, the figure the gate refuses on; a reader older than
 * the field falls back to `remaining`.
 */
export interface ServiceBalance { professional_service_id: number; remaining: number; available?: number; booked?: number }

export interface ServiceChoice {
  id: number;
  name: string;
  /** Sessions available; `null` when the wallet could not be read. */
  balance: number | null;
  /** #2848: units the member's future bookings hold on it; `null` when unknown. */
  booked: number | null;
  /** A balance of zero cannot be selected. An unknown balance is left to the server. */
  disabled: boolean;
}

export function serviceChoices(accepted: AcceptedService[] | null | undefined, balances: ServiceBalance[] | null): ServiceChoice[] {
  if (!accepted || accepted.length === 0) return [];
  const byId = new Map((balances ?? []).map((b) => [Number(b.professional_service_id), b]));
  return accepted.map((s) => {
    const row = byId.get(s.id);
    const balance = balances ? (row ? Number(row.available ?? row.remaining) : 0) : null;
    const booked = balances ? (row?.booked != null ? Number(row.booked) : 0) : null;
    return { id: s.id, name: s.name, balance, booked, disabled: balance !== null && balance <= 0 };
  });
}

/** The one service to preselect: exactly one is selectable, else none. */
export function defaultChoice(choices: ServiceChoice[]): number | null {
  const open = choices.filter((c) => !c.disabled);
  return open.length === 1 ? open[0].id : null;
}

/**
 * #2605 §3: every accepted service is known and none has a unit left to book
 * (all of the member's entitlement is already booked). The screen says so and
 * offers no Book; the server would refuse with `no_available_balance` anyway.
 */
export function noAvailableBalance(choices: ServiceChoice[]): boolean {
  return choices.length > 0 && choices.every((c) => c.balance !== null && c.disabled);
}

/**
 * #2848 §2: the action an available event offers. `buy` exactly when
 * {@link noAvailableBalance} holds (every accepted service is known and none
 * has a unit to book): the member is sent to the Add Product catalogue
 * narrowed to these services instead of being offered a Book the server
 * would refuse. Anything else — no service, an unknown wallet, one service
 * with a unit left — keeps the existing Book.
 */
export type BookingAction = 'book' | 'buy';
export function bookingAction(choices: ServiceChoice[]): BookingAction {
  return noAvailableBalance(choices) ? 'buy' : 'book';
}

/** The services a Buy narrows the catalogue to: every service the event accepts. */
export function buyServiceIds(choices: ServiceChoice[]): number[] {
  return choices.map((c) => c.id);
}

/**
 * #2848: which explanation stands beside Buy. `all_booked` when the member
 * holds units but their bookings already reserve them (#2605's wording, which
 * also says a cancellation frees one); `none_left` when there is nothing to
 * reserve at all. The locale key is the page's.
 */
export function zeroBalanceReason(choices: ServiceChoice[]): 'all_booked' | 'none_left' {
  return choices.some((c) => (c.booked ?? 0) > 0) ? 'all_booked' : 'none_left';
}

/** Whether a booking must wait for a selection: some service is selectable and none is chosen. */
export function selectionMissing(choices: ServiceChoice[], chosen: number | null): boolean {
  if (choices.length === 0) return false;
  if (!choices.some((c) => !c.disabled)) return false; // nothing to pick: the server explains why
  return chosen == null || !choices.some((c) => c.id === chosen && !c.disabled);
}

/** The service a booking used, from the accepted list; `null` when unknown. */
export function bookedService<T extends { id: number }>(accepted: T[] | null | undefined, bookedId: number | null | undefined): T | null {
  if (bookedId == null) return null;
  return (accepted ?? []).find((s) => s.id === bookedId) ?? null;
}
