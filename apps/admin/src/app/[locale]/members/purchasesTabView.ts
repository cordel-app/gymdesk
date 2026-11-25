/**
 * #3273 — the Member card's **Purchases** tab: what `GET /payments/purchases?member_id=` answers,
 * and the few presentation decisions the tab makes about it. Pure (no React, no `t()`), so the
 * decisions are assertable directly. Nothing here decides a payment state: the event status and
 * the payment status are the API's (`deriveBillingEventStatus()`, `domain/purchasePayment.ts`).
 */

export interface PurchaseMemberRef { id: number; name: string | null }

export interface PurchasePlanLine {
  kind: 'session' | 'oneoff' | 'periodical';
  product_id: number | null;
  name: string | null;
  product_type: string | null;
  quantity: number;
  beneficiary: PurchaseMemberRef | null;
}

export interface PurchasePlan {
  plan_snapshot_id: number;
  membership_plan_id: number | null;
  name: string | null;
  status: string;
  starts_at: string | null;
  beneficiaries: PurchaseMemberRef[];
  products: PurchasePlanLine[];
}

export interface PurchaseProduct {
  kind: 'recurring' | 'oneoff' | 'session';
  line_id: number | null;
  product_id: number | null;
  name: string | null;
  product_type: string | null;
  billing_frequency: string | null;
  quantity: number;
  status: string | null;
  beneficiary: PurchaseMemberRef | null;
}

export interface PurchaseBillingEvent {
  id: number;
  name: string | null;
  event_type: string;
  amount: string | null;
  status: string;
  created_at: string;
  attempt_id: number | null;
  payment_method_name: string | null;
  payment_method_code: string | null;
  method: string | null;
  payment_status: string | null;
  paid_at: string | null;
  attempt_count: number;
}

export interface MemberPurchase {
  id: number;
  /** #3270: the creation instant the purchase is named after. */
  name: string | null;
  status: string;
  created_at: string;
  created_by: string | null;
  /** #3355 stage 2: the purchase row's last change, and who made it. */
  modified_at: string | null;
  modified_by: string | null;
  /** #3355 stage 2: the API's `purchaseTotalAmount()`; null (read `—`) with no Billing Event. */
  total_amount: string | null;
  /** #3278: the application the purchase was initiated through; null when unknown. */
  channel: string | null;
  owner: PurchaseMemberRef;
  plans: PurchasePlan[];
  products: PurchaseProduct[];
  billing_events: PurchaseBillingEvent[];
}

/**
 * Whom the item is for, said only where it differs from the buyer: a person reads "for <name>"
 * beside an item somebody else bought for them (#3273 §2), and nothing beside their own.
 */
export function beneficiaryNameIfOther(
  beneficiary: PurchaseMemberRef | null | undefined, owner: PurchaseMemberRef,
): string | null {
  if (!beneficiary || beneficiary.id === owner.id) return null;
  return beneficiary.name ?? `#${beneficiary.id}`;
}

/** The plan's beneficiaries other than the buyer, as names. */
export function otherBeneficiaryNames(plan: Pick<PurchasePlan, 'beneficiaries'>, owner: PurchaseMemberRef): string[] {
  return plan.beneficiaries
    .map((b) => beneficiaryNameIfOther(b, owner))
    .filter((n): n is string => n !== null);
}

/** The Billing Events page opened on this exact event (the purchase's own `purchase_id` link). */
export function purchaseEventPath(locale: string, eventId: number): string {
  return `/${locale}/payments/billing-events?id=${Number(eventId)}`;
}

/** The Products page's type label key, when the stored type is one it names. */
const PRODUCT_TYPES = ['fee', 'service', 'sessions', 'merchandise', 'other'];
export function productTypeLabelKey(type: string | null | undefined): string | null {
  return type && PRODUCT_TYPES.includes(type) ? `products.type_${type}` : null;
}

/** Whether the purchase has anything to show in its expanded body. */
export function purchaseIsEmpty(p: Pick<MemberPurchase, 'plans' | 'products'>): boolean {
  return p.plans.length === 0 && p.products.length === 0;
}

/**
 * #3278 — the locale key of a purchase's Channel value (`admin_app` → Admin App, `members_app` →
 * Members App), or null for an unknown or absent channel, which reads as the neutral `—`.
 */
export function purchaseChannelLabelKey(channel: string | null | undefined): string | null {
  if (channel === 'admin_app') return 'members.purchases_channel_admin_app';
  if (channel === 'members_app') return 'members.purchases_channel_members_app';
  return null;
}

/**
 * #3355 stage 2 — the name a purchase row is identified by: its stored canonical name verbatim
 * (#3288), else its creation instant for a row written before the name existed.
 */
export function purchaseDisplayName(p: Pick<MemberPurchase, 'name' | 'created_at'>): string {
  return p.name ?? p.created_at;
}

/** #3355 stage 2 — the Total Amount as a number to format, or null for `—`. */
export function purchaseTotalValue(p: Pick<MemberPurchase, 'total_amount'>): number | null {
  if (p.total_amount == null) return null;
  const n = Number(p.total_amount);
  return Number.isFinite(n) ? n : null;
}
