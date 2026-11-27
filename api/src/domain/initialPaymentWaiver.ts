/**
 * #3284 stage 2 — the per-line Initial Payment waive, decided in one place.
 *
 * Staff may waive one line of a cart's Initial Payment (the commit charge `initialCharge()` builds)
 * and revert it. The waiver is a one-time manual adjustment of this checkout's initial charge only:
 * it is applied to the charge lines after the engine priced them, so the engine, the plan and
 * Promotion configuration, every recurring obligation and every forecast are untouched.
 *
 * Three things are decided here:
 *  - a line's stable identity (`initialPaymentLineKeys()`), from what the line *is* (the plan
 *    assignment and member a fee or included Product is for, a recurring line's `line_ref`, a
 *    one-time purchase's id), never its row index, name or price; two lines that would carry the
 *    same identity are told apart by their order of occurrence;
 *  - whether a line may be waived (`waiveRefusal()`): any line that charges something (#3440);
 *  - how a Membership Fee's prorated stretch and prepayment become two lines (`splitPrepaidMembershipFees()`);
 *  - what a waived line becomes (`applyInitialPaymentWaivers()`): amount and net 0, every original
 *    reason kept, plus one `manual_adjustment` reason coded `initial_payment_waive`.
 *
 * Pure.
 */

import { roundCents, type BillingEventLineRow, type LineReason } from './billingEventLines';

export const INITIAL_PAYMENT_WAIVE_CODE = 'initial_payment_waive';

/** The reason a waived line carries beside its original ones (never a Promotion field). */
export const INITIAL_PAYMENT_WAIVE_REASON: LineReason = {
  type: 'manual_adjustment', source: 'personal', code: INITIAL_PAYMENT_WAIVE_CODE,
  action: 'waive', value: null, name: null,
};

/** What identifies a charge line before its occurrence index is appended. */
export interface LineIdentity {
  kind: 'membership_fee' | 'product' | 'service' | 'adjustment';
  /** The plan assignment the engine line belongs to (`SimulationLine.user_membership_id`); 0 for none. */
  assignmentId?: number | null;
  productId?: number | null;
  assignedMemberId?: number | null;
  /** A recurring Product line's identity across versions (#1865). */
  lineRef?: number | null;
  /** A one-time purchase's id. */
  purchaseId?: number | null;
}

function baseKey(i: LineIdentity): string {
  if (i.purchaseId != null) return `purchase:${i.purchaseId}`;
  if (i.lineRef != null) return `ref:${i.lineRef}`;
  const member = i.assignedMemberId ?? 0;
  if (i.kind === 'membership_fee') return `fee:${i.assignmentId ?? 0}:${member}`;
  return `item:${i.assignmentId ?? 0}:${i.productId ?? 0}:${member}`;
}

/**
 * One key per line, in order. A base identity seen again gets `#2`, `#3`, … so two lines of the
 * same Product for the same member (a Product the plan includes and a stretch due before the plan's
 * start) stay distinct and keep their key across reads of the same cart.
 */
export function initialPaymentLineKeys(identities: readonly LineIdentity[]): string[] {
  const seen = new Map<string, number>();
  return identities.map((i) => {
    const base = baseKey(i);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

export type WaiveRefusal = 'line_not_found' | 'already_waived' | 'nothing_to_waive';

/**
 * Why `key` may not be waived on `lines` (the charge as priced, before any waiver), with the keys
 * already waived; `null` when it may. Stage 4 (owner, 25 Nov): a waiver may take the whole Initial
 * Payment to zero. Such a cart is committed by the free activation, which still writes the initial
 * Billing Event with its (waived) lines and a `waive` attempt (`commitWaivedInitialPayment()`), so
 * the waived first period is covered and never charged again as a scheduled obligation.
 *
 * #3440 stage 2 (owner, 26 Nov): every positive line may be waived, a Membership Fee collecting a
 * Pre-paid Duration included — its prepayment is a line of its own (`splitPrepaidMembershipFees()`),
 * and waiving it collects no money for those periods; the periods stay the plan's prepaid ones.
 */
export function waiveRefusal(lines: readonly BillingEventLineRow[], key: string, waived: ReadonlySet<string>): WaiveRefusal | null {
  const line = lines.find((l) => l.line_key === key);
  if (!line) return 'line_not_found';
  if (waived.has(key)) return 'already_waived';
  if (!(Number(line.amount) > 0)) return 'nothing_to_waive';
  return null;
}

/** Whether the line can be offered the Waive action at all (the button's enabled state). */
export function lineWaivable(l: Pick<BillingEventLineRow, 'amount'>): boolean {
  return lineWaiveBlock(l) == null;
}

/** Why a line taken on its own cannot be waived, `null` when it can. */
function lineWaiveBlock(l: Pick<BillingEventLineRow, 'amount'>): 'nothing_to_waive' | null {
  return Number(l.amount) > 0 ? null : 'nothing_to_waive';
}

/** The suffix that tells a Membership Fee's prepayment line apart from its prorated one. */
export const PREPAID_FEE_KEY_SUFFIX = ':prepaid';

/**
 * #3440 stage 2 — a Membership Fee whose first charge is a prorated stretch **and** a Pre-paid
 * Duration (`fee_split`, #2970) becomes two lines, so staff can waive either alone:
 *  - the prorated stretch, keeping the line's key, its dates (`fee_split.prorated`) and its
 *    proration, its regular price prorated by those days;
 *  - the prepayment, keyed `<key>:prepaid`, carrying the prepaid periods and their dates
 *    (`fee_split.prepaid`) and the regular price of those periods.
 * The prepayment's amount is the engine's own lump; the prorated line takes the rest of the
 * charge, so the two always sum to the original line to the cent. Each line's net is taken at the
 * line's own rate, as `withLineTax()` does. A fee with no prepayment, or whose parts are not both
 * positive, is left as one line. Pure; nothing is priced here.
 *
 * Returns the lines and, for each input line, the index of its first output line.
 */
export function splitPrepaidMembershipFees(lines: readonly BillingEventLineRow[]): { lines: BillingEventLineRow[]; index: number[] } {
  const out: BillingEventLineRow[] = [];
  const index: number[] = [];
  for (const l of lines) {
    index.push(out.length);
    const split = l.fee_split;
    const total = roundCents(Number(l.amount));
    const prepaidAmount = split?.prepaid ? roundCents(Number(split.prepaid.amount)) : 0;
    const proratedAmount = roundCents(total - prepaidAmount);
    if (l.kind !== 'membership_fee' || !split?.prorated || !split.prepaid
      || !(prepaidAmount > 0) || !(proratedAmount > 0)) {
      out.push(l);
      continue;
    }
    const periods = Math.max(1, Number(split.prepaid.periods) || 1);
    const regular = Number(l.regular_unit_price);
    const onePeriod = regular / periods;
    const { days, period_days: periodDays } = split.prorated;
    const rate = l.tax_rate_percent != null ? Number(l.tax_rate_percent) : null;
    const net = (amount: number) => (l.amount_excl_tax == null || rate == null ? l.amount_excl_tax : roundCents(amount / (1 + rate / 100)));
    out.push({
      ...l,
      regular_unit_price: periodDays > 0 ? roundCents(onePeriod * days / periodDays) : roundCents(onePeriod),
      amount: proratedAmount,
      amount_excl_tax: net(proratedAmount),
      prepaid_periods: null,
      prepaid_cadence: null,
      fee_split: { prorated: split.prorated, prepaid: null },
    });
    out.push({
      ...l,
      regular_unit_price: roundCents(regular),
      amount: prepaidAmount,
      amount_excl_tax: net(prepaidAmount),
      prorated_days: null,
      period_days: null,
      fee_split: { prorated: null, prepaid: split.prepaid },
      line_key: l.line_key != null ? `${l.line_key}${PREPAID_FEE_KEY_SUFFIX}` : null,
    });
  }
  return { lines: out, index };
}

/**
 * The charge with its waived lines applied: each waived line keeps its quantity, regular price,
 * tax rate and original reasons; its amount and net become 0 and it gains the
 * `initial_payment_waive` reason. A stored waiver whose line no longer exists (the cart changed)
 * applies to nothing, and one on a line that now owes nothing is ignored, so a stale waiver can
 * never under-charge a line it was not given for.
 */
export function applyInitialPaymentWaivers(
  lines: readonly BillingEventLineRow[], waived: ReadonlySet<string>,
): BillingEventLineRow[] {
  // Each disabled Waive carries the reason it is disabled (`waive_refusal`), which the screen words
  // beside the button: a disabled control with no visible reason reads as a button that does nothing.
  return lines.map((l) => {
    const key = l.line_key ?? null;
    const isWaived = key != null && waived.has(key) && lineWaivable(l);
    if (!isWaived) {
      const block = lineWaiveBlock(l);
      return { ...l, waived: false, waivable: block == null, waive_refusal: block };
    }
    return {
      ...l,
      price_before_waive: Number(l.amount),
      amount: 0,
      amount_excl_tax: l.amount_excl_tax != null ? 0 : null,
      reasons: [...(l.reasons ?? []), INITIAL_PAYMENT_WAIVE_REASON],
      waived: true,
      waivable: false,
      waive_refusal: null,
    };
  });
}
