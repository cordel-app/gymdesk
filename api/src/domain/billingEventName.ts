// #2940 — the one place a Billing Event's name is decided.
//
// Pure: the writers (`ensureInitialEvent()`, `materialiseScheduledEvents()`, the
// one-time purchase paths) read the facts and store what this answers in
// `billing_events.name`, once, when the event is created. Nothing here prices,
// schedules or reads the database.

/** Month names as the ticket spells them (`Gym-Name - January`). */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export const INITIAL_ENGAGEMENT_NAME = 'Initial Engagement';

/** The column's width (`VARCHAR(255)`); a longer name is cut, never refused. */
const MAX_NAME_LENGTH = 255;

const clip = (s: string) => (s.length > MAX_NAME_LENGTH ? s.slice(0, MAX_NAME_LENGTH) : s);

/** `YYYY-MM-DD` (or a longer ISO string) → its parts, read as a calendar date. */
function dateParts(date: string): { y: string; m: number; d: string } {
  const [y, m, d] = date.slice(0, 10).split('-');
  return { y, m: Number(m), d };
}

/** `dd/mm/yyyy`, the ticket's spelling, whatever the gym's display format. */
export function ddmmyyyy(date: string): string {
  const { y, m, d } = dateParts(date);
  return `${d}/${String(m).padStart(2, '0')}/${y}`;
}

export function monthName(date: string): string {
  return MONTHS[dateParts(date).m - 1] ?? '';
}

const prefixed = (gymName: string, rest: string) => clip(gymName.trim() ? `${gymName.trim()} - ${rest}` : rest);

/**
 * A recurring obligation (§2, §3). A monthly cadence billed on the 1st reads
 * `Gym - Month`; every other recurring charge (4 weeks, or a monthly schedule
 * anchored on another day) carries its billing date: `Gym - Month (dd/mm/yyyy)`.
 * The month is the billing date's.
 */
export function recurringEventName(input: {
  gymName: string;
  billingDate: string;
  cadence: { interval: number; unit: string } | null;
}): string {
  const { gymName, billingDate, cadence } = input;
  const month = monthName(billingDate);
  const monthlyOnFirst = cadence?.unit === 'month' && cadence.interval === 1 && dateParts(billingDate).d === '01';
  return prefixed(gymName, monthlyOnFirst ? month : `${month} (${ddmmyyyy(billingDate)})`);
}

/** What one purchase newly adds (§4, §5: never what the member already holds). */
export interface PurchaseItems {
  plans: string[];
  products: string[];
}

/**
 * A ProductSet purchase or a one-time purchase (§4): one product → its name,
 * one plan → its name, anything else → `Compra dd/mm/yyyy` on the purchase date.
 */
export function purchaseEventName(input: { gymName: string; purchaseDate: string; items: PurchaseItems }): string {
  const { gymName, purchaseDate, items } = input;
  const count = items.plans.length + items.products.length;
  if (count === 1) return prefixed(gymName, (items.plans[0] ?? items.products[0]).trim());
  return prefixed(gymName, `Compra ${ddmmyyyy(purchaseDate)}`);
}

/**
 * The initial event of a ProductSet version (§1, §4, §5). The member's first
 * configuration with a plan, and any version that modifies a plan they already
 * hold, is `Initial Engagement` (§1 takes precedence); otherwise the version is a
 * purchase named from what it adds. A version that adds nothing nameable (a
 * quantity change on a held Product) is a modification too.
 */
export function initialEventName(input: {
  gymName: string;
  purchaseDate: string;
  /** The version has no predecessor and carries a Membership Plan. */
  firstEngagement: boolean;
  /** The version edits, replaces or removes a plan its predecessor carried. */
  modifiesPlan: boolean;
  added: PurchaseItems;
}): string {
  if (input.firstEngagement || input.modifiesPlan) return INITIAL_ENGAGEMENT_NAME;
  if (input.added.plans.length + input.added.products.length === 0) return INITIAL_ENGAGEMENT_NAME;
  return purchaseEventName({ gymName: input.gymName, purchaseDate: input.purchaseDate, items: input.added });
}

/**
 * #3045 — the name a *simulated* Billing Event carries: the existing naming
 * rules, not a second convention. A date the projection marks as the initial
 * payment is `Initial Engagement`; every other date is a recurring obligation,
 * named by `recurringEventName()`. A simulation date does not carry its
 * schedule's cadence, so it is read off the dates themselves: a date exactly 28
 * days from a neighbouring one belongs to a 4-weekly schedule, anything else to
 * a monthly one (the plan's two offered cadences, #820).
 */
export function simulatedEventNames(
  dates: { date: string; kind?: string | null }[],
  gymName: string,
): (string | null)[] {
  const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
  return dates.map((group, i) => {
    if (group.kind === 'initial_payment') return INITIAL_ENGAGEMENT_NAME;
    const near = [dates[i - 1], dates[i + 1]].filter((n) => n && n.kind !== 'initial_payment') as { date: string }[];
    const fourWeekly = near.some((n) => Math.abs(day(n.date) - day(group.date)) === 28);
    return recurringEventName({
      gymName,
      billingDate: group.date,
      cadence: { interval: fourWeekly ? 4 : 1, unit: fourWeekly ? 'week' : 'month' },
    });
  });
}
