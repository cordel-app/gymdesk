/**
 * #3300: the Billing Event Details modal shows exactly the Product Details
 * modal's fields, in its order and sections, filled with the event's values.
 * This is the one place that maps an event onto that field set; a field with
 * no Billing Event counterpart reads `—`, as Product Details reads an unset one.
 *
 * Pure (no React, no `t()`): the caller hands in the status label and the
 * formatters, so the mapping can be asserted directly.
 */

export const DETAILS_EMPTY = '—';

/** The Product Details field set, in its order. Sections as the reference draws them. */
export const PRODUCT_DETAILS_FIELDS = {
  general: ['name', 'type', 'description'] as const,
  generalGrid: ['units', 'status', 'enrollment_status', 'mandatory'] as const,
  billing: ['price', 'frequency', 'validity_days', 'tax_rate'] as const,
  audit: ['created_at', 'created_by', 'modified_at', 'modified_by', 'deleted_at', 'deleted_by'] as const,
};

export type DetailsFieldKey =
  | (typeof PRODUCT_DETAILS_FIELDS.general)[number]
  | (typeof PRODUCT_DETAILS_FIELDS.generalGrid)[number]
  | (typeof PRODUCT_DETAILS_FIELDS.billing)[number]
  | (typeof PRODUCT_DETAILS_FIELDS.audit)[number];

export interface BillingEventDetailsSource {
  name?: string | null;
  plan_name: string | null;
  event_type: string;
  amount: string | null;
  currency: string | null;
  notes: string | null;
  created_at: string | null;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
}

export interface BillingEventDetailsView {
  values: Record<DetailsFieldKey, string>;
  /** Product Details' Notes section, shown only when there are notes. */
  notes: string | null;
}

function orEmpty(v: string | null | undefined): string {
  return v != null && String(v).trim() !== '' ? String(v) : DETAILS_EMPTY;
}

export function billingEventDetailsView(
  ev: BillingEventDetailsSource,
  opts: {
    statusLabel: string;
    formatAmount: (amount: string | null) => string;
    formatDateTime: (iso: string | null) => string;
    /** The list's own fallback when an event has no audit actor (the system wrote it). */
    systemActor: string;
  },
): BillingEventDetailsView {
  const price = ev.amount == null
    ? DETAILS_EMPTY
    : `${opts.formatAmount(ev.amount)} ${ev.currency ?? ''}`.trim();
  return {
    values: {
      name: orEmpty(ev.name ?? ev.plan_name),
      type: orEmpty(ev.event_type),
      description: DETAILS_EMPTY,
      units: DETAILS_EMPTY,
      status: orEmpty(opts.statusLabel),
      enrollment_status: DETAILS_EMPTY,
      mandatory: DETAILS_EMPTY,
      price,
      frequency: DETAILS_EMPTY,
      validity_days: DETAILS_EMPTY,
      tax_rate: DETAILS_EMPTY,
      created_at: ev.created_at ? opts.formatDateTime(ev.created_at) : DETAILS_EMPTY,
      created_by: ev.created_by ?? opts.systemActor,
      modified_at: ev.modified_at ? opts.formatDateTime(ev.modified_at) : DETAILS_EMPTY,
      modified_by: orEmpty(ev.modified_by),
      // A Billing Event is never deleted (#2480 cancels it), as Product Details reads these for a live row.
      deleted_at: DETAILS_EMPTY,
      deleted_by: DETAILS_EMPTY,
    },
    notes: ev.notes != null && ev.notes.trim() !== '' ? ev.notes : null,
  };
}
