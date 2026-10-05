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

/** All valid staff roles that can be granted to a Staff record (excludes member). */
export const ASSIGNABLE_ROLES: AppRole[] = [
  'admin',
  'trainer_performance',
  'trainer_perf_nutrition',
  'front_desk',
  'accountant',
  'nutritionist',
];

/**
 * #592: a Staff record's HR `profile` (the label the admin picks on the Staff
 * form) determines the RBAC role of the gym_memberships row linked to it.
 * The two lists are 1:1 by design — there is no separate role picker.
 * Mirrored in apps/admin/src/config/permissions.ts for the form hint.
 */
export const PROFILE_ROLE_MAP: Record<string, AppRole> = {
  'Gym Manager': 'admin',
  'Personal Trainer': 'trainer_performance',
  'Personal Trainer & Nutritionist': 'trainer_perf_nutrition',
  'Front Desk': 'front_desk',
  'Accountant': 'accountant',
  'Nutritionist': 'nutritionist',
};

export const STAFF_PROFILES = Object.keys(PROFILE_ROLE_MAP);

export function roleForProfile(profile: unknown): AppRole | null {
  return PROFILE_ROLE_MAP[String(profile)] ?? null;
}

export type PermissionLevel =
  | 'RW'           // Full read + write
  | 'R'            // Read-only
  | 'R_ASSIGNED'   // Read own assigned records only (assignment filtering deferred)
  | 'RW_ASSIGNED'  // Read+write own assigned records only (assignment filtering deferred)
  | 'R_OWN'        // Read own data via /me/* routes — NOT via admin routes
  | 'NONE';        // No access

export type AppModule =
  | 'MEMBERS'
  | 'CALENDAR'
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
  // #614: Calendar is its own permission area (#247) — it gates /calendar-events and
  // /class-sessions, which used to ride on TRAINING (front desk was read-only there).
  // Front desk creates and edits events; nutritionist stays read-only (not granted by
  // #247 or the #614 decision). Mirrored in apps/admin/src/config/permissions.ts.
  CALENDAR: {
    admin:                   'RW',
    trainer_performance:     'RW',
    trainer_perf_nutrition:  'RW',
    front_desk:              'RW',
    accountant:              'NONE',
    nutritionist:            'R',
    member:                  'NONE',
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

/**
 * #1070 — a **feature-level permission override**.
 *
 * The matrix above is per *module*, and a module is coarse on purpose: one cell
 * answers for every screen of that section. An override is the exception to
 * that, declared per **feature key** (the same dot-separated keys
 * `feature_flags` and the navigation are built from), and it says: whatever the
 * module gives this role, on *this* feature the role has that level instead.
 *
 * It is one declaration — mirrored for menus and page controls in
 * `apps/admin/src/config/permissions.ts`, which
 * `api/src/test/feature-permission-overrides.unit.test.ts` keeps in step —
 * because an override that reached only one side would show a write control the
 * API rejects, or hide one it allows (#611's defect, which is why the module
 * matrix is mirrored at all).
 *
 * Two properties are the rule rather than the implementation. It is matched on
 * the **exact** key a guard is given and never on an ancestor, so granting
 * `nutrition.personal_goals` says nothing about the rest of `nutrition` — that
 * narrowness is the whole point of overriding at the feature level. And it
 * replaces the module's level rather than widening it, in both directions: a
 * `NONE` override takes a feature away from a role the module admits.
 *
 * The one override today is #1070's: a **Personal Trainer**
 * (`trainer_performance`) has `RW` on Personal Goals, where `NUTRITION` gives
 * them `R_ASSIGNED`. It is deliberately not a change to the `NUTRITION` cell —
 * that would hand them the Nutrition Library, the plan templates and every
 * member's nutrition plan with it.
 */
export const FEATURE_PERMISSION_OVERRIDES: Record<string, Partial<Record<AppRole, PermissionLevel>>> = {
  'nutrition.personal_goals': { trainer_performance: 'RW' },
};

/** The level a feature key overrides for a role, or `null` when it inherits. */
export function featurePermissionOverride(
  featureKey: string | undefined,
  role: AppRole,
): PermissionLevel | null {
  if (!featureKey) return null;
  return FEATURE_PERMISSION_OVERRIDES[featureKey]?.[role] ?? null;
}

/** The level that actually applies: the feature's own override, else the module's. */
export function getFeaturePermission(
  role: AppRole,
  module: AppModule,
  featureKey?: string,
): PermissionLevel {
  return featurePermissionOverride(featureKey, role) ?? getPermission(role, module);
}

/** `canAccess` for a single feature of a module (#1070). */
export function canAccessFeature(role: AppRole, module: AppModule, featureKey?: string): boolean {
  const p = getFeaturePermission(role, module, featureKey);
  return p !== 'NONE' && p !== 'R_OWN';
}

/** `canWrite` for a single feature of a module (#1070). */
export function canWriteFeature(role: AppRole, module: AppModule, featureKey?: string): boolean {
  const p = getFeaturePermission(role, module, featureKey);
  return p === 'RW' || p === 'RW_ASSIGNED';
}
