import { AppRole, AppModule, canAccessModule } from './permissions';

export interface NavItem {
  href: string;
  labelKey: string;
  requiredRole?: 'superadmin';
  children?: NavItem[];
  /** Draw a divider line above this item (visual grouping within a nav group). */
  separatorAbove?: boolean;
}

export interface NavGroup {
  id: string;
  labelKey: string;
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
    module: 'MEMBERS',
    items: [
      {
        href: '/{{locale}}',
        labelKey: 'nav.dashboard',
      },
      {
        href: '/{{locale}}/members',
        labelKey: 'nav.members',
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
    id: 'organization',
    labelKey: 'nav.groups.organization',
    module: 'ORGANIZATION',
    items: [
      {
        href: '/{{locale}}/organization',
        labelKey: 'nav.dashboard',
      },
      {
        href: '/{{locale}}/staff',
        labelKey: 'nav.staff',
      },
      {
        href: '/{{locale}}/centers',
        labelKey: 'nav.centers',
      },
      {
        href: '/{{locale}}/spaces',
        labelKey: 'nav.spaces',
      },
      {
        href: '/{{locale}}/specialities',
        labelKey: 'nav.specialities',
      },
      {
        href: '/{{locale}}/activity-types',
        labelKey: 'nav.activity_types',
      },
      {
        href: '/{{locale}}/class-packages',
        labelKey: 'nav.class_packages',
      },
      {
        href: '/{{locale}}/events',
        labelKey: 'nav.events',
      },
    ],
  },
  {
    id: 'training',
    labelKey: 'nav.groups.training',
    module: 'TRAINING',
    items: [
      {
        href: '/{{locale}}/training',
        labelKey: 'nav.dashboard',
      },
      {
        href: '/{{locale}}/exercises',
        labelKey: 'nav.exercises',
      },
      {
        href: '/{{locale}}/workout-templates',
        labelKey: 'nav.workout_templates',
      },
      {
        href: '/{{locale}}/training-plan-templates',
        labelKey: 'nav.training_plan_templates',
      },
      {
        href: '/{{locale}}/training-plans',
        labelKey: 'nav.training_plans',
        separatorAbove: true,
      },
    ],
  },
  {
    id: 'nutrition',
    labelKey: 'nav.groups.nutrition',
    module: 'NUTRITION',
    items: [
      {
        href: '/{{locale}}/nutrition',
        labelKey: 'nav.dashboard',
      },
      {
        href: '/{{locale}}/nutrition/meals',
        labelKey: 'nav.meals_catalog',
      },
      {
        href: '/{{locale}}/nutrition/nutrition-plan-templates',
        labelKey: 'nav.nutrition_plan_templates',
      },
    ],
  },
  {
    id: 'payments',
    labelKey: 'nav.groups.payments',
    module: 'PAYMENTS',
    items: [
      {
        href: '/{{locale}}/payments/transactions',
        labelKey: 'nav.transactions',
      },
    ],
  },
  {
    id: 'financials',
    labelKey: 'nav.groups.financials',
    module: 'FINANCIALS',
    items: [
      {
        href: '/{{locale}}/financials',
        labelKey: 'nav.dashboard',
      },
      {
        href: '/{{locale}}/plans',
        labelKey: 'nav.plans',
      },
      {
        href: '/{{locale}}/promotions',
        labelKey: 'nav.promotions',
      },
      {
        href: '/{{locale}}/financials/payment-providers',
        labelKey: 'nav.payment_providers',
      },
    ],
  },
  {
    id: 'system',
    labelKey: 'nav.groups.system',
    module: 'SYSTEM',
    items: [
      {
        href: '/{{locale}}/audit',
        labelKey: 'nav.audit',
      },
      {
        href: '/{{locale}}/themes',
        labelKey: 'nav.themes',
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
    ],
  },
];

export function filterNavGroups(groups: NavGroup[], userRole: AppRole | 'superadmin'): NavGroup[] {
  return groups
    .filter((group) => {
      if (group.requiredRole === 'superadmin') return userRole === 'superadmin';
      if (group.module) {
        if (userRole === 'superadmin') return true;
        return canAccessModule(userRole, group.module);
      }
      return true;
    })
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (item.requiredRole === 'superadmin') return userRole === 'superadmin';
        return true;
      }),
    }))
    .filter((group) => group.items.length > 0);
}
