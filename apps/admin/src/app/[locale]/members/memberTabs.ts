/**
 * #961 — the Member card's five work areas, declared once.
 *
 * Expanding a Member used to render ten sections as one very long column. The
 * ticket splits them into parallel tabs, and this module is the one place that
 * says **which tabs exist, in what order, and which sections belong to each** —
 * a property of the declaration rather than of the JSX, exactly as
 * `PLAN_SECTION_ORDER` is for the Membership Plan card (#816). Moving a section
 * between tabs is a one-line change here and a failing test, not a review
 * comment.
 *
 * The section keys are the `members.section_*` locale keys the card already
 * rendered, so this is a layout declaration and nothing else: no section
 * changed what it reads, writes or gates on (#961 "Preserve existing
 * functionality").
 *
 * Two of the mappings are a thread's answer rather than this module's:
 *
 * * **Membership Plans is Products & Services', and first in it** — #1051
 *   moved it out of Profile, which is where #961 §1 had put it ("what the
 *   Member *is* rather than what they bought"). The later ticket is explicit
 *   that the Member's assigned plans are managed from Products & Services, so
 *   this declaration is the whole of that move: the section reads, writes and
 *   gates on exactly what it did.
 * * **Everything else was already Products & Services'** — the Billing
 *   Simulation, the Billing Events ledger, the Session Packages and the PT
 *   Class Slots, per #961's `Q2` answer ("All sections in the table to Products
 *   & Services"). They keep the relative order the single column had.
 */

export const MEMBER_TAB_IDS = [
  'profile',
  'products_services',
  'nutrition',
  'personal_goals',
  'training_plan',
] as const;

export type MemberTabId = (typeof MEMBER_TAB_IDS)[number];

/** A `members.section_*` locale key — the heading of one section of the card. */
export type MemberSectionKey =
  | 'section_profile'
  | 'section_account'
  | 'section_membership_plans'
  | 'section_additional_services'
  | 'section_billing_simulation'
  | 'section_pt_slots'
  | 'section_session_packages'
  | 'section_billing_events'
  | 'section_nutrition_plans'
  | 'section_personal_goals'
  | 'section_training_plans';

export interface MemberTab {
  id: MemberTabId;
  /** Resolved in the `members` namespace by the page, never by the tab strip. */
  labelKey: string;
  /** The sections this tab renders, in the order it renders them. */
  sections: readonly MemberSectionKey[];
}

export const MEMBER_TABS: readonly MemberTab[] = [
  {
    id: 'profile',
    labelKey: 'tab_profile',
    sections: ['section_profile', 'section_account'],
  },
  {
    id: 'products_services',
    labelKey: 'tab_products_services',
    sections: [
      'section_membership_plans',
      'section_additional_services',
      'section_billing_simulation',
      'section_pt_slots',
      'section_session_packages',
      'section_billing_events',
    ],
  },
  { id: 'nutrition', labelKey: 'tab_nutrition', sections: ['section_nutrition_plans'] },
  // #948 §4 shipped the assignments this tab shows, so it is never an empty
  // tab for a feature that does not exist yet (the thread's `Q3` answer).
  { id: 'personal_goals', labelKey: 'tab_personal_goals', sections: ['section_personal_goals'] },
  { id: 'training_plan', labelKey: 'tab_training_plan', sections: ['section_training_plans'] },
] as const;

/** The tab a Member opens on, and the one an unusable `?tab=` falls back to. */
export const DEFAULT_MEMBER_TAB: MemberTabId = 'profile';

export function isMemberTabId(value: string | null | undefined): value is MemberTabId {
  return !!value && (MEMBER_TAB_IDS as readonly string[]).includes(value);
}

/** The selected tab for a URL that may carry anything at all in `?tab=`. */
export function memberTabFromParam(value: string | null | undefined): MemberTabId {
  return isMemberTabId(value) ? value : DEFAULT_MEMBER_TAB;
}

export function sectionsForTab(id: MemberTabId): readonly MemberSectionKey[] {
  return MEMBER_TABS.find((tab) => tab.id === id)?.sections ?? [];
}
