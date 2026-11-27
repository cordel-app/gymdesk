/**
 * #2886: the Billing Events page's filters, as one state object.
 *
 * The page keeps them in the URL (so a link reopens the same list) and sends
 * them to `GET /payments/billing-events`, which does all the narrowing
 * (`api/src/domain/billingEventListFilters.ts`). This module only maps the
 * state to and from those two query strings; it filters nothing.
 */
export interface BillingEventFilters {
  /** #3510: one Billing Event by id, as typed (`?id=` in the URL). */
  id: string;
  memberId: number | null;
  memberName: string;
  /** #2553: one Assigned Plan's events, shown as a chip. */
  userMembershipId: number | null;
  planName: string;
  product: string;
  processedBy: string;
  paymentMethod: string;
  from: string;
  to: string;
  amountMin: string;
  amountMax: string;
  status: string[];
}

export const EMPTY_BILLING_EVENT_FILTERS: BillingEventFilters = {
  id: '', memberId: null, memberName: '', userMembershipId: null, planName: '',
  product: '', processedBy: '', paymentMethod: '',
  from: '', to: '', amountMin: '', amountMax: '', status: [],
};

interface ParamReader { get(name: string): string | null }

function positiveInt(value: string | null): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A typed amount the API accepts (a finite number), else nothing. */
export function amountParam(value: string): string | null {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed === '') return null;
  return Number.isFinite(Number(trimmed)) ? trimmed : null;
}

/**
 * #3510: what a typed ID filter means. `none` when blank (no narrowing),
 * `valid` with the id to send, `invalid` when it can match no event — the
 * page then shows the empty state instead of asking the API.
 */
export type BillingEventIdFilter =
  | { kind: 'none' }
  | { kind: 'valid'; id: number }
  | { kind: 'invalid' };

export function billingEventIdFilter(value: string): BillingEventIdFilter {
  const trimmed = value.trim().replace(/^#/, '');
  if (trimmed === '') return { kind: 'none' };
  if (!/^\d+$/.test(trimmed)) return { kind: 'invalid' };
  const id = positiveInt(trimmed);
  return id !== null && Number.isSafeInteger(id) ? { kind: 'valid', id } : { kind: 'invalid' };
}

export function filtersFromUrl(params: ParamReader): BillingEventFilters {
  return {
    id: params.get('id') ?? '',
    memberId: positiveInt(params.get('memberId')),
    memberName: params.get('memberName') ?? '',
    userMembershipId: positiveInt(params.get('userMembershipId')),
    planName: params.get('planName') ?? '',
    product: params.get('product') ?? '',
    processedBy: params.get('processedBy') ?? '',
    paymentMethod: params.get('paymentMethod') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    amountMin: params.get('amountMin') ?? '',
    amountMax: params.get('amountMax') ?? '',
    status: (params.get('status') ?? '').split(',').filter(Boolean),
  };
}

/** The page URL's query string (`order` is carried by the page itself). */
export function filtersToUrl(f: BillingEventFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.id.trim()) p.set('id', f.id.trim());
  if (f.memberId) { p.set('memberId', String(f.memberId)); p.set('memberName', f.memberName); }
  if (f.userMembershipId) { p.set('userMembershipId', String(f.userMembershipId)); if (f.planName) p.set('planName', f.planName); }
  if (f.product.trim()) p.set('product', f.product.trim());
  if (f.processedBy) p.set('processedBy', f.processedBy);
  if (f.paymentMethod) p.set('paymentMethod', f.paymentMethod);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.amountMin.trim()) p.set('amountMin', f.amountMin.trim());
  if (f.amountMax.trim()) p.set('amountMax', f.amountMax.trim());
  if (f.status.length > 0) p.set('status', f.status.join(','));
  return p;
}

/** Appends the filters to the API request's query string. */
export function appendApiFilters(p: URLSearchParams, f: BillingEventFilters): void {
  const id = billingEventIdFilter(f.id);
  if (id.kind === 'valid') p.set('id', String(id.id));
  if (f.memberId) p.set('member_id', String(f.memberId));
  if (f.userMembershipId) p.set('user_membership_id', String(f.userMembershipId));
  if (f.product.trim()) p.set('product', f.product.trim());
  if (f.processedBy) p.set('processed_by', f.processedBy);
  if (f.paymentMethod) p.set('payment_method', f.paymentMethod);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  const min = amountParam(f.amountMin);
  const max = amountParam(f.amountMax);
  if (min !== null) p.set('amount_min', min);
  if (max !== null) p.set('amount_max', max);
  for (const s of f.status) p.append('status', s);
}

export function hasActiveFilter(f: BillingEventFilters): boolean {
  return filtersToUrl(f).toString() !== '';
}
