// #1537 — the recurring Products section's decisions, as pure functions.
//
// Nothing here prices, charges or decides lifecycle: the version, its status,
// the diff and the amount due are the server's (`/product-sets`). This only
// says which status chip, which controls and which confirmation wording a state
// of that answer gets, so each is assertable without a component harness.

import type { ProductSetSummary } from './membershipConfiguration';

export type RecurringChip = 'active' | 'draft';

export interface RecurringState {
  /** The status chip — only Active or Draft are ever shown (§2). */
  chip: RecurringChip | null;
  /** A Pending Payment version reads as a Draft with a "payment pending" hint. */
  paymentPending: boolean;
  /** Lines and the commit are editable: a Draft that has not expired. */
  editing: boolean;
  /** `Edit` starts a Draft from the Active version. */
  canStartEdit: boolean;
  /** Save & Pay is offered (a Draft, or a pending one to resume). */
  canSaveAndPay: boolean;
  /** Cancel is offered; the server still refuses it when the payment state forbids. */
  canCancel: boolean;
  expired: boolean;
}

export function recurringState(current: ProductSetSummary | null, canWrite: boolean): RecurringState {
  const none: RecurringState = {
    chip: null, paymentPending: false, editing: false, canStartEdit: false,
    canSaveAndPay: false, canCancel: false, expired: false,
  };
  if (!current) return none;
  if (current.status === 'active') {
    return { ...none, chip: 'active', canStartEdit: canWrite };
  }
  if (current.status === 'draft') {
    const expired = !!current.expired;
    return {
      ...none, chip: 'draft', expired,
      editing: canWrite && !expired, canSaveAndPay: canWrite && !expired, canCancel: canWrite,
    };
  }
  if (current.status === 'pending_payment') {
    return { ...none, chip: 'draft', paymentPending: true, canSaveAndPay: canWrite, canCancel: canWrite };
  }
  return none;
}

export interface ReviewLike {
  amount_due: number | null;
  payment_required: boolean;
  error: string | null;
}

/** The confirmation action: the exact amount when payment is due, plain Confirm when not, nothing when unreliable. */
export function confirmAction(review: ReviewLike | null): { key: 'review_confirm_pay' | 'review_confirm'; amount: number | null } | null {
  if (!review || review.error || review.amount_due == null) return null;
  return review.payment_required && review.amount_due > 0
    ? { key: 'review_confirm_pay', amount: review.amount_due }
    : { key: 'review_confirm', amount: null };
}

export type ChangeLike =
  | { kind: 'added' | 'removed'; line: { name: string; quantity: number } }
  | { kind: 'quantity_changed' | 'price_changed'; line: { name: string }; from: number; to: number }
  | { kind: 'plan_changed'; from: string | null; to: string | null }
  | { kind: 'fee_changed'; from: number | null; to: number | null }
  | { kind: 'promotion_added' | 'promotion_removed'; name: string };

/** The `members` locale key of a change, with its interpolation values (the page resolves `t()`). */
export function changeMessage(c: ChangeLike): { key: string; values: Record<string, string | number> } {
  switch (c.kind) {
    case 'added': return { key: 'review_change_added', values: { name: c.line.name, quantity: c.line.quantity } };
    case 'removed': return { key: 'review_change_removed', values: { name: c.line.name, quantity: c.line.quantity } };
    case 'quantity_changed': return { key: 'review_change_quantity', values: { name: c.line.name, from: c.from, to: c.to } };
    case 'price_changed': return { key: 'review_change_price', values: { name: c.line.name, from: c.from.toFixed(2), to: c.to.toFixed(2) } };
    case 'plan_changed': return { key: 'review_change_plan', values: { from: c.from ?? '—', to: c.to ?? '—' } };
    case 'fee_changed': return { key: 'review_change_fee', values: { from: c.from?.toFixed(2) ?? '—', to: c.to?.toFixed(2) ?? '—' } };
    case 'promotion_added': return { key: 'review_change_promotion_added', values: { name: c.name } };
    case 'promotion_removed': return { key: 'review_change_promotion_removed', values: { name: c.name } };
  }
}

/** A recurring line of the configuration `GET /product-sets/:id` freezes, as the section edits it. */
export interface EditableLine {
  /** The Additional Periodic Service row id, `null` for a Membership Plan benefit (read-only here). */
  serviceId: number | null;
  key: string;
  name: string;
  quantity: number;
  unitPrice: number;
  billingFrequency: string | null;
}

export function editableLines(config: {
  planBenefits?: Array<{ productId: number; name: string; category: string; quantity: number; unitPrice: number; billingFrequency: string | null }>;
  services?: Array<{ id: number; productId: number; name: string; quantity: number; unitPrice: number; billingFrequency: string | null; endsOn: string | null }>;
} | null | undefined): EditableLine[] {
  const out: EditableLine[] = [];
  for (const b of config?.planBenefits ?? []) {
    if (b.category !== 'periodical') continue;
    out.push({ serviceId: null, key: `benefit-${b.productId}`, name: b.name, quantity: b.quantity, unitPrice: b.unitPrice, billingFrequency: b.billingFrequency });
  }
  for (const s of config?.services ?? []) {
    if (s.endsOn != null) continue;
    out.push({ serviceId: s.id, key: `service-${s.id}`, name: s.name, quantity: s.quantity, unitPrice: s.unitPrice, billingFrequency: s.billingFrequency });
  }
  return out;
}
