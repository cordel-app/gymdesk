// #3404 — what a meal's circular thumbnail in My Nutrition shows, and what its
// Details dialog opens onto.
//
// Pure, no React and no `t()`. The pictures are the meal's Base Meal (#3328):
// `GET /me/nutrition-plan` reports `meal_image_thumbnail_url` (256 × 256) and
// `meal_image_url` (1080 × 1080) beside the localized `meal_description`, so
// nothing here reads another source. Both are cache-busted on the Base Meal's
// `meal_modified_at` through `memberAvatarSrc()`, because the object key is
// deterministic (a replacement rewrites the same key, #3350).
import { memberAvatarSrc } from './memberAvatar';

export interface MealImageFields {
  base_meal_id?: number | null;
  meal_image_url?: string | null;
  meal_image_thumbnail_url?: string | null;
  meal_description?: string | null;
  meal_modified_at?: string | null;
}

export interface MealThumbnailView {
  /** The circle's picture: the thumbnail, the master for a meal that has none; `null` draws initials. */
  thumbnailSrc: string | null;
  /** The dialog's full-size picture; `null` means there is nothing to enlarge. */
  fullSrc: string | null;
  /** The meal's description in the member's language, `null` when blank. */
  description: string | null;
}

export function mealThumbnailView(meal: MealImageFields): MealThumbnailView {
  const modifiedAt = meal.meal_modified_at ?? null;
  const fullSrc = memberAvatarSrc(meal.meal_image_url, modifiedAt);
  const thumbnailSrc = memberAvatarSrc(meal.meal_image_thumbnail_url, modifiedAt) ?? fullSrc;
  const description = meal.meal_description?.trim() || null;
  return { thumbnailSrc, fullSrc: fullSrc ?? thumbnailSrc, description };
}

/** The fixed diameter of every meal thumbnail and placeholder, in px. */
export const MEAL_THUMBNAIL_SIZE = 40;
