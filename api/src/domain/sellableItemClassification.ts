// #550: shared classification of a Sellable Item (`gym_charges`) into the
// three Promotion benefit sections (migration 155). This is the single
// source of truth the ticket asks for — Promotions must not re-derive this
// from a name or a second mapping, and the API is the one place it's
// computed (not duplicated in the frontend, per CLAUDE.md).
//
// Rules (per #550's agreed classification):
//   - type === 'sessions'                          -> 'session'
//   - type !== 'sessions' and frequency recurring   -> 'periodical'
//   - type !== 'sessions' and frequency not recurring (including none, e.g.
//     'once'/'per_session'/null) -> 'oneoff'

export type SellableItemBenefitCategory = 'session' | 'oneoff' | 'periodical';

const RECURRING_FREQUENCIES = new Set(['four_weeks', 'week', 'month', 'year']);

export function isRecurringFrequency(billingFrequency: string | null | undefined): boolean {
  return !!billingFrequency && RECURRING_FREQUENCIES.has(billingFrequency);
}

export function classifySellableItem(item: {
  type: string;
  billing_frequency: string | null;
}): SellableItemBenefitCategory {
  if (item.type === 'sessions') return 'session';
  return isRecurringFrequency(item.billing_frequency) ? 'periodical' : 'oneoff';
}

/** Table (migration 155) that holds Promotion benefits for a given category. */
export function benefitTableForCategory(category: SellableItemBenefitCategory): string {
  switch (category) {
    case 'session': return 'promotion_session';
    case 'oneoff': return 'promotion_oneoff';
    case 'periodical': return 'promotion_periodical';
  }
}

/**
 * Table (migration 173) that holds Membership Plan benefits for a given
 * category — #635 stage 1 gives a Plan the same three sections a Promotion has,
 * classified by the same `classifySellableItem()` above so an item can never
 * land in a different section depending on which entity it is attached to.
 */
export function planBenefitTableForCategory(category: SellableItemBenefitCategory): string {
  switch (category) {
    case 'session': return 'membership_plan_session';
    case 'oneoff': return 'membership_plan_oneoff';
    case 'periodical': return 'membership_plan_periodical';
  }
}
