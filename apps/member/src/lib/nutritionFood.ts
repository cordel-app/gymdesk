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
