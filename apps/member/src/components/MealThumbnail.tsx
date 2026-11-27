'use client';

import { ImagePreviewButton } from './ImagePreview';
import { MemberAvatar } from './MemberAvatar';
import { MEAL_THUMBNAIL_SIZE, mealThumbnailView, type MealImageFields } from '@/lib/mealThumbnail';

/**
 * #3404 — a meal's fixed-size circular thumbnail in My Nutrition.
 *
 * The circle is the app's one avatar rendering (`MemberAvatar`: the picture
 * cropped with `object-fit: cover`, the initials of the meal's name when it has
 * none or the picture fails to load), and a tap opens the app's one enlarged-image
 * dialog (`ImagePreviewButton`) on the 1080 × 1080 image with the meal's name and
 * description. A meal with no image draws the initials and is not a button, since
 * there is nothing to enlarge. Presentation only: the title is the caller's.
 */
export function MealThumbnail({ meal, title, size = MEAL_THUMBNAIL_SIZE }: {
  meal: MealImageFields;
  title: string;
  /** #3490 — the Home summary draws the same circle smaller. */
  size?: number;
}) {
  const view = mealThumbnailView(meal);
  return (
    <span style={{ width: size, height: size, flexShrink: 0, display: 'inline-flex' }}>
      <ImagePreviewButton
        src={view.fullSrc}
        alt={title}
        title={title}
        description={view.description}
        style={{ width: size, height: size, borderRadius: '50%' }}
      >
        <MemberAvatar
          member={{
            id: meal.base_meal_id ?? null,
            name: title,
            image_url: meal.meal_image_url ?? null,
            image_thumbnail_url: meal.meal_image_thumbnail_url ?? null,
            modified_at: meal.meal_modified_at ?? null,
          }}
          size={size}
        />
      </ImagePreviewButton>
    </span>
  );
}
