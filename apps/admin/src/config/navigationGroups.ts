// Navigation group and item configuration for the admin sidebar

export type UserRole = 'staff' | 'admin' | 'superadmin';

export interface NavItem {
  href: string;
  labelKey: string; // Translation key like 'nav.members'
  requiredRole?: UserRole;
  children?: NavItem[];
  /** Draw a divider line above this item (visual grouping within a nav group). */
  separatorAbove?: boolean;
}

export interface NavGroup {
  id: string;
  labelKey: string; // Translation key like 'nav.groups.membership'
  requiredRole?: UserRole;
  items: NavItem[];
}

/**
 * Navigation groups configuration for the admin app
 * Groups are displayed as collapsible sections in the sidebar
 */
export const navigationGroups: NavGroup[] = [
  {
    id: 'membership',
    labelKey: 'nav.groups.membership',
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
    requiredRole: 'admin',
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
    items: [
      {
        href: '/{{locale}}/payments/transactions',
        labelKey: 'nav.transactions',
      },
      {
        href: '/{{locale}}/payments/promotions',
        labelKey: 'nav.promotions',
      },
      {
        href: '/{{locale}}/payments/payment-providers',
        labelKey: 'nav.payment_providers',
      },
    ],
  },
  {
    id: 'financials',
    labelKey: 'nav.groups.financials',
    requiredRole: 'admin',
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
    ],
  },
  {
    id: 'system',
    labelKey: 'nav.groups.system',
    requiredRole: 'admin',
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

/**
 * Check if a user role has access to an item
 */
export function hasAccessToItem(itemRole: UserRole | undefined, userRole: UserRole): boolean {
  if (!itemRole) return true;

  const roleHierarchy: Record<UserRole, number> = {
    staff: 0,
    admin: 1,
    superadmin: 2,
  };

  return roleHierarchy[userRole] >= roleHierarchy[itemRole];
}

/**
 * Filter groups and items based on user role
 */
export function filterNavGroups(groups: NavGroup[], userRole: UserRole): NavGroup[] {
  return groups
    .filter((group) => hasAccessToItem(group.requiredRole, userRole))
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => hasAccessToItem(item.requiredRole, userRole)),
    }))
    .filter((group) => group.items.length > 0);
}
