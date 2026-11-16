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
  /**
   * A balance of zero cannot be booked. Since #2848 stage 2 it stays
   * selectable: choosing it turns the action into Buy for that service. An
   * unknown balance is left to the server.
   */
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
 * The chosen service when it is one of the event's and has no unit to book
 * (#2848 stage 2); `null` otherwise. Choosing a zero-balance service is how a
 * member asks to buy its sessions while another service is still bookable.
 */
function chosenWithoutBalance(choices: ServiceChoice[], chosen: number | null): ServiceChoice | null {
  if (chosen == null) return null;
  const c = choices.find((x) => x.id === chosen);
  return c && c.balance !== null && c.disabled ? c : null;
}

/**
 * #2848 §2: the action an available event offers. `buy` when
 * {@link noAvailableBalance} holds (every accepted service is known and none
 * has a unit to book) or, since stage 2, when the chosen service is one with
 * no unit to book: the member is sent to the Add Product catalogue instead of
 * being offered a Book the server would refuse. Anything else — no service,
 * an unknown wallet, a chosen service with a unit left, nothing chosen while
 * one is bookable — keeps the existing Book.
 */
export type BookingAction = 'book' | 'buy';
export function bookingAction(choices: ServiceChoice[], chosen: number | null = null): BookingAction {
  return noAvailableBalance(choices) || chosenWithoutBalance(choices, chosen) ? 'buy' : 'book';
}

/**
 * The services a Buy narrows the catalogue to: the chosen zero-balance
 * service alone (stage 2), else every service the event accepts.
 */
export function buyServiceIds(choices: ServiceChoice[], chosen: number | null = null): number[] {
  const c = chosenWithoutBalance(choices, chosen);
  return c ? [c.id] : choices.map((x) => x.id);
}

/**
 * #2848: which explanation stands beside Buy. `all_booked` when the member
 * holds units but their bookings already reserve them (#2605's wording, which
 * also says a cancellation frees one); `none_left` when there is nothing to
 * reserve at all. Asked of the chosen zero-balance service when there is one,
 * else of every service. The locale key is the page's.
 */
export function zeroBalanceReason(choices: ServiceChoice[], chosen: number | null = null): 'all_booked' | 'none_left' {
  const c = chosenWithoutBalance(choices, chosen);
  const scope = c ? [c] : choices;
  return scope.some((x) => (x.booked ?? 0) > 0) ? 'all_booked' : 'none_left';
}

/**
 * Whether a booking must wait for a selection: some service is bookable and
 * no bookable one is chosen. A chosen zero-balance service offers Buy, not
 * Book, so it never satisfies this.
 */
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
