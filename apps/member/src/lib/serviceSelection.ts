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
  /** A balance of zero cannot be selected. An unknown balance is left to the server. */
  disabled: boolean;
}

export function serviceChoices(accepted: AcceptedService[] | null | undefined, balances: ServiceBalance[] | null): ServiceChoice[] {
  if (!accepted || accepted.length === 0) return [];
  const byId = new Map((balances ?? []).map((b) => [Number(b.professional_service_id), Number(b.available ?? b.remaining)]));
  return accepted.map((s) => {
    const balance = balances ? (byId.get(s.id) ?? 0) : null;
    return { id: s.id, name: s.name, balance, disabled: balance !== null && balance <= 0 };
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
