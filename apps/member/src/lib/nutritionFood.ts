/**
 * #722 — the shape of one food on a member's nutrition plan, plus the pure
 * helpers the food card renders it with.
 *
 * The fields are exactly what `GET /me/nutrition-plan` returns for a meal item
 * (`api/src/api/me.ts`): the library item's translated name, its own image, the
 * quantity the plan prescribes, the role it plays in the meal and the
 * nutritional qualities the Nutrition Library classified it with (#644). The
 * Member app stores none of it — it renders what that one request already
 * carries.
 */

export interface NutritionFoodQuality {
  id: number;
  slug: string;
}

export interface NutritionFoodItem {
  id: number;
  item_name: string;
  component_type: string | null;
  /** DECIMAL(8,2) — mysql2 hands it over as a string ("250.00"). */
  quantity: number | string | null;
  unit: string | null;
  image_url?: string | null;
  qualities?: NutritionFoodQuality[];
}

/**
 * "250 g" for a whole number, "1.5 scoop" for a fractional one, and `null` when
 * the plan prescribes no quantity — the card then omits the line entirely
 * rather than rendering an empty one (§10).
 *
 * The trailing zeros of the DECIMAL column are dropped: the value is stored as
 * `250.00` and a member reads "250 g". The unit is whatever the plan recorded
 * (`g` is only its default), never assumed (§3).
 */
export function formatQuantity(
  quantity: number | string | null | undefined,
  unit: string | null | undefined,
): string | null {
  if (quantity == null || quantity === '') return null;
  const value = typeof quantity === 'number' ? quantity : Number(quantity);
  if (!Number.isFinite(value)) return null;
  // `toFixed(2)` then trim: 250.00 → "250", 1.50 → "1.5", 0.25 → "0.25".
  const amount = value.toFixed(2).replace(/\.?0+$/, '');
  const suffix = unit?.trim();
  return suffix ? `${amount} ${suffix}` : amount;
}

/**
 * #932 §1 — one dietary restriction of a member's nutrition plan.
 *
 * A restriction *is* a Nutrition Library food (`nutrition_library_item_id` is
 * NOT NULL on `member_nutrition_plan_restrictions`), so it carries the same
 * translated name and the same `image_url` a meal food does: there is no
 * separate image source for My Nutrition (§3).
 */
export interface NutritionRestrictionItem {
  id: number;
  nutrition_library_item_id: number;
  item_name: string;
  image_url?: string | null;
}

/** #932 §2 — one nutrition goal of a member's plan, as `GET /me/nutrition-plan` returns it. */
export interface NutritionGoalItem {
  id: number;
  /** A slug from the plan routers' closed vocabulary (`protein`, `water`, …). */
  item_name: string;
  quantity: number | string | null;
  unit: string | null;
  frequency: string | null;
}

/**
 * A label for a value that comes from the database, not from the code: a
 * `component_type` the CHECK constraint gains later, a nutritional quality slug
 * a migration adds (#644 added two), or a goal the vocabulary grows.
 *
 * next-intl has **no** locale fallback and **no** `defaultValue` option — a
 * missing key prints its own dotted path — so the fallback is decided here,
 * before `t()` is given the result (CLAUDE.md).
 */
export function translatedLabel(
  t: (key: any, values?: any) => string,
  key: string,
  fallback: string,
): string {
  try {
    const value = t(key as any);
    return !value || value === key ? fallback : value;
  } catch {
    return fallback;
  }
}

/** `weight_loss` → `Weight loss`, for a slug no locale file knows yet. */
export function humanizeSlug(slug: string): string {
  const spaced = slug.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : slug;
}

/**
 * What the member reads for a goal's name. The stored value is a slug
 * (`weight_loss`), which the page rendered verbatim before #932.
 */
export function goalLabel(t: (key: any, values?: any) => string, itemName: string): string {
  return translatedLabel(t, `nutrition.goal_name.${itemName}`, humanizeSlug(itemName));
}

/**
 * "1 l · daily" — the goal's value and how often it applies (§2). `frequency`
 * is free text with a `daily` default on the API side, so an unknown value is
 * humanised rather than dropped, and a goal with neither value nor frequency
 * yields `null` so the row omits the line instead of rendering an empty one.
 */
export function goalDetail(
  t: (key: any, values?: any) => string,
  goal: Pick<NutritionGoalItem, 'quantity' | 'unit' | 'frequency'>,
): string | null {
  const parts = [formatQuantity(goal.quantity, goal.unit)];
  const frequency = goal.frequency?.trim();
  if (frequency) {
    parts.push(translatedLabel(t, `nutrition.goal_frequency.${frequency}`, humanizeSlug(frequency)));
  }
  const line = parts.filter(Boolean).join(' · ');
  return line || null;
}
