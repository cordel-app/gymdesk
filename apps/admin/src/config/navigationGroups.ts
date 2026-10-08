import { AppRole, AppModule, canAccessModule } from './permissions';
import type { NavIconName } from '@/components/icons/navIconNames';

export interface NavItem {
  href: string;
  labelKey: string;
  /** Stable dot-separated feature key — if flags[featureKey] is false, item is hidden. */
  featureKey?: string;
  requiredRole?: 'superadmin';
  children?: NavItem[];
  /** Draw a divider line above this item (visual grouping within a nav group). */
  separatorAbove?: boolean;
}

export interface NavGroup {
  id: string;
  labelKey: string;
  /**
   * #884: the icon shown beside this first-level entry, drawn by `NAV_ICONS`.
   * Required, so a group added later cannot reach the sidebar without one.
   */
  icon: NavIconName;
  /** Stable dot-separated feature key — if flags[featureKey] is false, entire group is hidden. */
  featureKey?: string;
  /** Module-based access gate: show when the user's role canAccessModule(module). */
  module?: AppModule;
  /** Explicit role gate — only used for superadmin-only groups. */
  requiredRole?: 'superadmin';
  /**
   * #1020: draw a divider above this first-level section, heavier than the
   * hairline `NavItem.separatorAbove` draws inside a section. It is declared
   * here, with the rest of the navigation, so the sidebar never branches on a
   * group's id or label to decide how it looks (#884's rule for the icons).
   * The first visible section never draws one — a leading rule separates a
   * section from nothing.
   */
  separatorAbove?: boolean;
  items: NavItem[];
}

export const navigationGroups: NavGroup[] = [
  {
    id: 'membership',
    labelKey: 'nav.groups.membership',
    icon: 'users',
    featureKey: 'membership',
    module: 'MEMBERS',
    items: [
      {
        href: '/{{locale}}',
        labelKey: 'nav.dashboard',
      },
      {
        href: '/{{locale}}/members',
        labelKey: 'nav.members',
        featureKey: 'membership.members',
      },
    ],
  },
  {
    id: 'calendar',
    labelKey: 'nav.groups.calendar',
    icon: 'calendar',
    featureKey: 'calendar',
    module: 'CALENDAR',
    items: [
      {
        href: '/{{locale}}/calendar',
        labelKey: 'nav.calendar',
        featureKey: 'calendar.calendar',
      },
      {
        href: '/{{locale}}/calendar/operating-hours',
        labelKey: 'nav.operating_hours',
        featureKey: 'calendar.operating_hours',
        separatorAbove: true,
      },
    ],
  },
  {
    id: 'organization',
    labelKey: 'nav.groups.organization',
    icon: 'building',
    featureKey: 'organization',
    module: 'ORGANIZATION',
    items: [
      {
        href: '/{{locale}}/organization',
        labelKey: 'nav.dashboard',
      },
      {
        href: '/{{locale}}/staff',
        labelKey: 'nav.staff',
        featureKey: 'organization.staff',
      },
      {
        href: '/{{locale}}/centers',
        labelKey: 'nav.centers',
        featureKey: 'organization.centers',
      },
      {
        href: '/{{locale}}/spaces',
        labelKey: 'nav.spaces',
        featureKey: 'organization.spaces',
      },
      {
        href: '/{{locale}}/activity-types',
        labelKey: 'nav.activity_types',
        featureKey: 'organization.activity_types',
      },
      {
        href: '/{{locale}}/professional-services',
        labelKey: 'nav.professional_services',
        featureKey: 'organization.professional_services',
      },
    ],
  },
  {
    id: 'training',
    labelKey: 'nav.groups.training',
    icon: 'dumbbell',
    featureKey: 'training',
    module: 'TRAINING',
    items: [
      {
        href: '/{{locale}}/training',
        labelKey: 'nav.dashboard',
      },
      {
        href: '/{{locale}}/exercises',
        labelKey: 'nav.exercises',
        featureKey: 'training.exercises',
      },
      {
        href: '/{{locale}}/workout-templates',
        labelKey: 'nav.workout_templates',
        featureKey: 'training.workout_templates',
      },
      {
        href: '/{{locale}}/training-plan-templates',
        labelKey: 'nav.training_plan_templates',
        featureKey: 'training.training_plan_templates',
      },
      {
        href: '/{{locale}}/training-plans',
        labelKey: 'nav.training_plans',
        featureKey: 'training.training_plans',
        separatorAbove: true,
      },
    ],
  },
  {
    // #948 §1: the group reads **Nutrition & Goals**. It is a navigation label and
    // nothing else — the id, the module, the feature keys and every existing
    // item's href are deliberately unchanged (§2), and Personal Goals shares the
    // group for navigation only: there is no business relationship between the two
    // domains (§8).
    id: 'nutrition',
    labelKey: 'nav.groups.nutrition',
    icon: 'apple',
    featureKey: 'nutrition',
    module: 'NUTRITION',
    items: [
      {
        href: '/{{locale}}/nutrition',
        labelKey: 'nav.dashboard',
      },
      {
        href: '/{{locale}}/nutrition/nutrition-library',
        labelKey: 'nav.nutrition_library',
        featureKey: 'nutrition.nutrition_library',
      },
      {
        href: '/{{locale}}/nutrition/nutrition-plan-templates',
        labelKey: 'nav.nutrition_plan_templates',
        featureKey: 'nutrition.nutrition_plan_templates',
      },
      {
        href: '/{{locale}}/nutrition/nutrition-plans',
        labelKey: 'nav.nutrition_plans',
        featureKey: 'nutrition.nutrition_plans',
        separatorAbove: true,
      },
      {
        // #948 §3/§9: its own section rather than a tab of the Nutrition Library.
        // The href is **not** under `/nutrition/` — a Personal Goal does not depend
        // on Nutrition and is a different entity (§8) — and its feature key is its
        // own, so hiding the Nutrition Library cannot hide it.
        href: '/{{locale}}/personal-goals',
        labelKey: 'nav.personal_goals',
        featureKey: 'nutrition.personal_goals',
        separatorAbove: true,
      },
      {
        // #948 §4/§9: the goals members actually hold, beside the library that
        // offers them. Same feature key — a gym that hid Personal Goals hid the
        // goals its members hold with them — and the href is outside `/nutrition/`
        // for the reason the catalogue's is (§8).
        href: '/{{locale}}/assigned-personal-goals',
        labelKey: 'nav.assigned_personal_goals',
        featureKey: 'nutrition.personal_goals',
      },
    ],
  },
  {
    id: 'payments',
    labelKey: 'nav.groups.payments',
    icon: 'creditCard',
    featureKey: 'payments',
    module: 'PAYMENTS',
    items: [
      {
        href: '/{{locale}}/payments/dashboard',
        labelKey: 'nav.dashboard',
        featureKey: 'payments.dashboard',
      },
      {
        href: '/{{locale}}/payments/transactions',
        labelKey: 'nav.transactions',
        featureKey: 'payments.transactions',
      },
      {
        href: '/{{locale}}/payments/billing-events',
        labelKey: 'nav.billing_events',
        featureKey: 'payments.billing_events',
      },
    ],
  },
  {
    id: 'financials',
    labelKey: 'nav.groups.financials',
    icon: 'banknote',
    featureKey: 'financials',
    module: 'FINANCIALS',
    items: [
      {
        href: '/{{locale}}/financials',
        labelKey: 'nav.dashboard',
      },
      {
        href: '/{{locale}}/plans',
        labelKey: 'nav.plans',
        featureKey: 'financials.plans',
      },
      {
        href: '/{{locale}}/promotions',
        labelKey: 'nav.promotions',
        featureKey: 'financials.promotions',
      },
      {
        href: '/{{locale}}/financials/products',
        labelKey: 'nav.products',
        featureKey: 'financials.products',
      },
      {
        href: '/{{locale}}/financials/assigned-plans',
        labelKey: 'nav.assigned_plans',
        featureKey: 'financials.assigned_plans',
      },
      {
        href: '/{{locale}}/financials/taxes',
        labelKey: 'nav.taxes',
        featureKey: 'financials.taxes',
      },
      // #636: Payment Providers moved to the Cordel group — they are platform-wide
      // configuration, and a gym only picks one of them. Its `financials.payment_providers`
      // feature flag is dropped by migration 175.
    ],
  },
  {
    id: 'system',
    labelKey: 'nav.groups.system',
    icon: 'sliders',
    featureKey: 'system',
    module: 'SYSTEM',
    items: [
      {
        href: '/{{locale}}/audit',
        labelKey: 'nav.audit',
        featureKey: 'system.audit',
      },
      {
        href: '/{{locale}}/themes',
        labelKey: 'nav.themes',
        featureKey: 'system.themes',
      },
      {
        href: '/{{locale}}/localization',
        labelKey: 'nav.localization',
      },
      {
        href: '/{{locale}}/recycle-bin',
        labelKey: 'nav.recycle_bin',
        featureKey: 'system.recycle_bin',
      },
      // #1052: Website Integration is administered from Cordel → Gyms → [Gym]
      // now — it is the platform's screen, on the card of the gym it belongs to,
      // rather than an item of the gym's own Configuration group.
    ],
  },
  {
    id: 'cordel',
    labelKey: 'nav.groups.cordel',
    icon: 'shield',
    requiredRole: 'superadmin',
    // #1020: the platform's own administration, set apart from the gym's
    // sections above it.
    separatorAbove: true,
    items: [
      {
        href: '/{{locale}}/system/gyms',
        labelKey: 'nav.gyms',
      },
      {
        href: '/{{locale}}/system/themes',
        labelKey: 'nav.base_themes',
      },
      {
        href: '/{{locale}}/system/users',
        labelKey: 'nav.system_users',
      },
      {
        href: '/{{locale}}/system/orphaned-accounts',
        labelKey: 'nav.orphaned_accounts',
      },
      {
        href: '/{{locale}}/cordel/audit',
        labelKey: 'nav.audit',
      },
      {
        href: '/{{locale}}/cordel/payment-providers',
        labelKey: 'nav.payment_providers',
      },
      {
        href: '/{{locale}}/cordel/feature-flags',
        labelKey: 'nav.feature_flags',
        separatorAbove: true,
      },
      {
        // #1077: the published test builds of the mobile apps — platform-wide, so it
        // belongs here and not in any one gym's card.
        href: '/{{locale}}/cordel/mobile-builds',
        labelKey: 'nav.mobile_builds',
      },
      {
        href: '/{{locale}}/cordel/nutrition-library',
        labelKey: 'nav.base_nutrition_library',
        separatorAbove: true,
      },
      {
        href: '/{{locale}}/cordel/nutrition-plan-templates',
        labelKey: 'nav.base_nutrition_plan_templates',
      },
      {
        // #948 §5: Base Personal Goals, the System-level catalogue the gym-level
        // Personal Goals library reads — its own Cordel section, separated from
        // the Base Nutrition pair above because the two are independent system
        // entities (§8).
        href: '/{{locale}}/cordel/personal-goals',
        labelKey: 'nav.base_personal_goals',
        separatorAbove: true,
      },
      {
        href: '/{{locale}}/cordel/exercises',
        labelKey: 'nav.base_exercises',
        separatorAbove: true,
      },
      {
        href: '/{{locale}}/cordel/workout-templates',
        labelKey: 'nav.base_workout_templates',
      },
      {
        href: '/{{locale}}/cordel/training-plan-templates',
        labelKey: 'nav.base_training_plan_templates',
      },
    ],
  },
];

export function filterNavGroups(
  groups: NavGroup[],
  userRole: AppRole | 'superadmin',
  flags: Record<string, boolean> = {},
): NavGroup[] {
  const isSuperadmin = userRole === 'superadmin';

  return groups
    .filter((group) => {
      if (group.requiredRole === 'superadmin') return isSuperadmin;
      if (group.module) {
        if (!isSuperadmin && !canAccessModule(userRole, group.module)) return false;
      }
      if (!isSuperadmin && group.featureKey && flags[group.featureKey] === false) return false;
      return true;
    })
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (item.requiredRole === 'superadmin') return isSuperadmin;
        if (!isSuperadmin && item.featureKey && flags[item.featureKey] === false) return false;
        return true;
      }),
    }))
    .filter((group) => group.items.length > 0);
}
