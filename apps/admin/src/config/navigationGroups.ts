import { AppRole, AppModule, canAccessModule } from './permissions';

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
  /** Stable dot-separated feature key — if flags[featureKey] is false, entire group is hidden. */
  featureKey?: string;
  /** Module-based access gate: show when the user's role canAccessModule(module). */
  module?: AppModule;
  /** Explicit role gate — only used for superadmin-only groups. */
  requiredRole?: 'superadmin';
  items: NavItem[];
}

export const navigationGroups: NavGroup[] = [
  {
    id: 'membership',
    labelKey: 'nav.groups.membership',
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
        children: [
          {
            href: '/{{locale}}/members/deleted',
            labelKey: 'nav.members_deleted',
          },
        ],
      },
    ],
  },
  {
    id: 'calendar',
    labelKey: 'nav.groups.calendar',
    featureKey: 'calendar',
    module: 'CALENDAR',
    items: [
      {
        href: '/{{locale}}/calendar',
        labelKey: 'nav.calendar',
        featureKey: 'calendar.calendar',
      },
    ],
  },
  {
    id: 'organization',
    labelKey: 'nav.groups.organization',
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
        href: '/{{locale}}/class-packages',
        labelKey: 'nav.class_packages',
        featureKey: 'organization.class_packages',
      },
    ],
  },
  {
    id: 'training',
    labelKey: 'nav.groups.training',
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
    id: 'nutrition',
    labelKey: 'nav.groups.nutrition',
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
    ],
  },
  {
    id: 'payments',
    labelKey: 'nav.groups.payments',
    featureKey: 'payments',
    module: 'PAYMENTS',
    items: [
      {
        href: '/{{locale}}/payments/transactions',
        labelKey: 'nav.transactions',
        featureKey: 'payments.transactions',
      },
    ],
  },
  {
    id: 'financials',
    labelKey: 'nav.groups.financials',
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
        href: '/{{locale}}/financials/gym-charges',
        labelKey: 'nav.gym_charges',
        featureKey: 'financials.gym_charges',
      },
      {
        href: '/{{locale}}/financials/payment-providers',
        labelKey: 'nav.payment_providers',
        featureKey: 'financials.payment_providers',
      },
    ],
  },
  {
    id: 'system',
    labelKey: 'nav.groups.system',
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
        href: '/{{locale}}/recycle-bin',
        labelKey: 'nav.recycle_bin',
        featureKey: 'system.recycle_bin',
      },
    ],
  },
  {
    id: 'cordel',
    labelKey: 'nav.groups.cordel',
    requiredRole: 'superadmin',
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
        href: '/{{locale}}/cordel/audit',
        labelKey: 'nav.audit',
      },
      {
        href: '/{{locale}}/cordel/feature-flags',
        labelKey: 'nav.feature_flags',
        separatorAbove: true,
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
