/**
 * #156: Application-wide RBAC permission matrix.
 *
 * Roles map to modules with a PermissionLevel. Backend middleware uses this
 * to gate reads (requireModuleAccess) and writes (requireModuleWrite).
 * The frontend mirrors this matrix in apps/admin/src/config/permissions.ts
 * to drive sidebar visibility.
 */

export type AppRole =
  | 'admin'
  | 'trainer_performance'
  | 'trainer_perf_nutrition'
  | 'front_desk'
  | 'accountant'
  | 'nutritionist'
  | 'member';

/** All valid staff roles that can be assigned via the Team UI (excludes member). */
export const ASSIGNABLE_ROLES: AppRole[] = [
  'admin',
  'trainer_performance',
  'trainer_perf_nutrition',
  'front_desk',
  'accountant',
  'nutritionist',
];

export type PermissionLevel =
  | 'RW'           // Full read + write
  | 'R'            // Read-only
  | 'R_ASSIGNED'   // Read own assigned records only (assignment filtering deferred)
  | 'RW_ASSIGNED'  // Read+write own assigned records only (assignment filtering deferred)
  | 'R_OWN'        // Read own data via /me/* routes — NOT via admin routes
  | 'NONE';        // No access

export type AppModule =
  | 'MEMBERS'
  | 'ORGANIZATION'
  | 'TRAINING'
  | 'NUTRITION'
  | 'FINANCIALS'
  | 'PAYMENTS'
  | 'SYSTEM'
  | 'CORDEL';

export const PERMISSION_MATRIX: Record<AppModule, Record<AppRole, PermissionLevel>> = {
  MEMBERS: {
    admin:                   'RW',
    trainer_performance:     'R_ASSIGNED',
    trainer_perf_nutrition:  'R_ASSIGNED',
    front_desk:              'RW',
    accountant:              'NONE',
    nutritionist:            'R_ASSIGNED',
    member:                  'R_OWN',
  },
  ORGANIZATION: {
    admin:                   'RW',
    trainer_performance:     'R',
    trainer_perf_nutrition:  'R',
    front_desk:              'R',
    accountant:              'NONE',
    nutritionist:            'R',
    member:                  'NONE',
  },
  TRAINING: {
    admin:                   'RW',
    trainer_performance:     'RW',
    trainer_perf_nutrition:  'RW',
    front_desk:              'R',
    accountant:              'NONE',
    nutritionist:            'R_ASSIGNED',
    member:                  'R_OWN',
  },
  NUTRITION: {
    admin:                   'RW',
    trainer_performance:     'R_ASSIGNED',
    trainer_perf_nutrition:  'RW_ASSIGNED',
    front_desk:              'R',
    accountant:              'NONE',
    nutritionist:            'RW_ASSIGNED',
    member:                  'R_OWN',
  },
  FINANCIALS: {
    admin:                   'RW',
    trainer_performance:     'NONE',
    trainer_perf_nutrition:  'NONE',
    front_desk:              'R',
    accountant:              'R',
    nutritionist:            'NONE',
    member:                  'NONE',
  },
  PAYMENTS: {
    admin:                   'RW',
    trainer_performance:     'NONE',
    trainer_perf_nutrition:  'NONE',
    front_desk:              'RW',
    accountant:              'R',
    nutritionist:            'NONE',
    member:                  'R_OWN',
  },
  SYSTEM: {
    admin:                   'RW',
    trainer_performance:     'NONE',
    trainer_perf_nutrition:  'NONE',
    front_desk:              'NONE',
    accountant:              'NONE',
    nutritionist:            'NONE',
    member:                  'NONE',
  },
  CORDEL: {
    admin:                   'NONE',
    trainer_performance:     'NONE',
    trainer_perf_nutrition:  'NONE',
    front_desk:              'NONE',
    accountant:              'NONE',
    nutritionist:            'NONE',
    member:                  'NONE',
  },
};

export function getPermission(role: AppRole, module: AppModule): PermissionLevel {
  return PERMISSION_MATRIX[module][role];
}

/**
 * Returns true when the role has any access to the module via admin routes.
 * R_OWN is excluded — those users access their data via /me/* not admin routes.
 */
export function canAccess(role: AppRole, module: AppModule): boolean {
  const p = getPermission(role, module);
  return p !== 'NONE' && p !== 'R_OWN';
}

/** Returns true when the role can perform writes on the module. */
export function canWrite(role: AppRole, module: AppModule): boolean {
  const p = getPermission(role, module);
  return p === 'RW' || p === 'RW_ASSIGNED';
}
