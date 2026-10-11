/**
 * The one place that decides what `created_by` / `modified_by` / `deleted_by`
 * hold (#1182 stage 1).
 *
 * The canonical representation is a **plain-text snapshot** of whoever actually
 * executed the operation — no actor type, no foreign key, no `_by_name` /
 * `_by_type` pair. `Pedro` when Pedro acted, `Oscar (impersonating Pedro)` when
 * the superadmin Oscar acted as him. It is a snapshot so it stays valid after
 * the underlying user or membership is deleted or renamed, and `NULL` means the
 * actor is unknown (never an invented one — §14).
 *
 * Pure: no DB, no Express. Later stages call these helpers from every mutation
 * path of an in-scope table; none of them hand-builds the string or the column
 * list for itself. Stage 2 (migrations 264–265) converted the primary business
 * entities to it: #799's `_by_name`/`_by_type` pair became the plain-text
 * columns, the FK-shaped tables gained them and the `*_by_membership_id`
 * columns stay as the frozen record of who acted before.
 */

/** The audit actions a table can carry, and the columns each one writes. */
export type AuditAction = 'created' | 'modified' | 'deleted';

/** A request's actor, as `TenantContext` reports it. */
export interface AuditActorSource {
  /** The authenticated user's own display name (the superadmin's when impersonating). */
  actorName: string | null | undefined;
  /** Set only while a superadmin impersonates somebody; their display name. */
  impersonatedActorName?: string | null;
  /** True when `x-impersonate-as` is in effect, whether or not the target has a name. */
  impersonating?: boolean;
}

/** What a nightly run, a webhook or any other non-person writer records. */
export const SYSTEM_ACTOR = 'System';

/** Upper bound of the `VARCHAR` the audit columns use (matches migration 126/178/196's `created_by_name`). */
export const AUDIT_ACTOR_MAX_LENGTH = 255;

function clean(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The text stored for one actor, or `null` when nobody can be named.
 *
 * - normal user: their own name;
 * - superadmin impersonating: `Oscar (impersonating Pedro)`, the *real* actor
 *   first — and `Oscar (impersonating)` when the target has no usable name, so
 *   the impersonation is never lost from the record;
 * - an unnamed actor is `null`, never `''` and never a placeholder.
 */
export function resolveMutationActor(source: AuditActorSource): string | null {
  const actor = clean(source.actorName);
  const target = clean(source.impersonatedActorName);
  const impersonating = source.impersonating ?? target !== null;
  if (!actor) return null;
  let text = actor;
  if (impersonating) text = target ? `${actor} (impersonating ${target})` : `${actor} (impersonating)`;
  return text.length > AUDIT_ACTOR_MAX_LENGTH ? text.slice(0, AUDIT_ACTOR_MAX_LENGTH) : text;
}

/** The actor for a request that went through `tenantContext`. */
export function resolveRequestActor(ctx: {
  actorName: string | null;
  impersonatedUserId?: string;
  impersonatedActorName?: string | null;
}): string | null {
  return resolveMutationActor({
    actorName: ctx.actorName,
    impersonatedActorName: ctx.impersonatedActorName,
    impersonating: ctx.impersonatedUserId !== undefined,
  });
}

/** The actor for a platform (`/platform/*`) request: the superadmin, never impersonating. */
export function resolvePlatformActor(superadminName: string | null | undefined): string | null {
  return resolveMutationActor({ actorName: superadminName });
}

/** `System`: the nightly runs, the payment webhook, the dunning escalation. */
export function resolveSystemActor(): string {
  return SYSTEM_ACTOR;
}

/** Column names for one action. `created` has `created_at`/`created_by`, and so on. */
export function auditColumnNames(action: AuditAction): { at: string; by: string } {
  return { at: `${action}_at`, by: `${action}_by` };
}

/**
 * Column/value pairs for an INSERT: `created_by` only. `created_at` keeps its
 * database default, so it is never supplied by the application's clock.
 */
export function createdAuditValues(actor: string | null): { created_by: string | null } {
  return { created_by: actor };
}

/**
 * SET fragment + params for an UPDATE that modifies a row. `modified_at` is
 * written from the database clock (`UTC_TIMESTAMP()`), the actor as a parameter.
 */
export function modifiedAuditSet(actor: string | null): { sql: string; params: [string | null] } {
  return { sql: 'modified_at = UTC_TIMESTAMP(), modified_by = ?', params: [actor] };
}

/** SET fragment + params for a soft delete. */
export function deletedAuditSet(actor: string | null): { sql: string; params: [string | null] } {
  return { sql: 'deleted_at = UTC_TIMESTAMP(), deleted_by = ?', params: [actor] };
}

/**
 * SET fragment + params for a restore: the row is live again, so the deleted
 * pair is cleared (the restore itself is a modification and is recorded as one).
 */
export function restoredAuditSet(actor: string | null): { sql: string; params: [string | null] } {
  return {
    sql: 'deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?',
    params: [actor],
  };
}

/**
 * The API field every in-scope entity reports (§15): the stored text, `null`
 * when unknown. One shape for every entity — a string, not an object.
 */
export function auditActorField(stored: string | null | undefined): string | null {
  return clean(stored);
}

/**
 * Tables that carry the standard audit columns under this mechanism. Each stage
 * appends its tables here together with its migration, and
 * `audit-actor.unit.test.ts` then holds every `INSERT INTO` one of them to
 * naming `created_by` and every business `UPDATE` to naming `modified_by` /
 * `deleted_by`.
 *
 * Stage 2 (#1182): the primary business entities. Stage 3: assignments and
 * lifecycle tables.
 */
export const AUDITED_TABLES: readonly string[] = [
  'activity_types',
  'calendar_events',
  'centers',
  'class_packages',
  'exercises',
  'gym_holiday_hours',
  'gym_operating_hours',
  'gym_personal_goals',
  'gyms',
  'member_nutrition_plans',
  'member_personal_goals',
  'members',
  'membership_plans',
  'nutrition_goals',
  'nutrition_library_items',
  'nutrition_plan_templates',
  'payment_providers',
  'personal_goals',
  'products',
  'professional_services',
  'spaces',
  'staff',
  'tax_rates',
  'themes',
  'training_plan_templates',
  'workout_templates',
  // Stage 3 (migrations 266–267)
  'calendar_event_bookings',
  'calendar_event_series',
  'class_package_transactions',
  'gym_professional_services',
  'member_centers',
  'member_personal_goal_readings',
  'member_products_oneoff_snapshot',
  'member_recurring_slots',
  'member_training_plans',
  'product_sets',
  'promotions',
  'training_plans',
  'user_class_packages',
  'user_membership_promotions',
  'user_memberships',
];
