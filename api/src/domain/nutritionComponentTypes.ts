/**
 * #812 / #1624: the `component_type` of a meal item — the role a food plays
 * inside a meal, and what the admin UI calls the **Food Type**.
 *
 * Templates and assigned plans accept the same seven values
 * (`chk_nptmi_component_type`, migration 111; `chk_mnpmi_comp`, widened from
 * four to seven by migration 283 / #1624, #294 having widened the template
 * table only). One list is the source of truth for both.
 *
 * The list lives in **two** places — below and the CHECKs named beside it.
 * Adding a value here without the migration makes every insert of it fail with
 * a CHECK violation; adding it to the CHECK alone makes the route reject it with
 * a 400 and keeps it out of the Food Type selector.
 *
 * The order is the order the selector offers them in, so it is product order
 * (courses, then the catch-alls), not alphabetical.
 */
export const TEMPLATE_COMPONENT_TYPES = [
  'main_dish', 'side', 'sauce', 'drink', 'dessert', 'other', 'additional',
] as const;

export const MEMBER_PLAN_COMPONENT_TYPES = TEMPLATE_COMPONENT_TYPES;

export type TemplateComponentType = typeof TEMPLATE_COMPONENT_TYPES[number];
export type MemberPlanComponentType = typeof MEMBER_PLAN_COMPONENT_TYPES[number];

/**
 * Whether `value` is a component type the given surface accepts. The routes use
 * this instead of comparing against a locally declared list, so the validation a
 * caller hits and the options `GET …/component-types` advertises cannot drift.
 */
export function isComponentType(types: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && types.includes(value);
}
