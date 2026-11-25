'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FoodThumbnail } from '@/components/nutritionLibrary/FoodThumbnail';
import { ProfessionalServiceImageModal } from '@/components/professionalServices/ProfessionalServiceImageModal';

/**
 * #3377 — the one clickable rendering of a Nutrition Goal's thumbnail in a
 * nutrition plan. The shared plan tree draws it for the Nutrition Plan
 * Templates, the Base Nutrition Plan Templates and the Assigned Nutrition
 * Plans, so the three sections cannot diverge. Clicking it opens the app's
 * existing image-and-description modal (the one Base Meals use, #3328) with
 * the full 1080 × 1080 `image_url` and the goal's name and description, which
 * the API resolves for the request's locale. The thumbnail keeps reading
 * `image_thumbnail_url`.
 */
export interface NutritionGoalImageTarget {
  /** The goal's displayed name (localized). */
  name: string;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export function NutritionGoalImageModal({ goal, onClose }: { goal: NutritionGoalImageTarget | null; onClose: () => void }) {
  const t = useTranslations('nutrition_plan_templates');
  return (
    <ProfessionalServiceImageModal
      target={goal ? { name: goal.name, imageUrl: goal.image_url, description: goal.description } : null}
      onClose={onClose}
      closeLabel={t('tree_goal_image_close')}
      noImageLabel={t('tree_goal_image_none')}
      noDescriptionLabel={t('tree_goal_no_description')}
    />
  );
}

/** The goal's thumbnail; a button that opens {@link NutritionGoalImageModal}. */
export function NutritionGoalThumbnail({ goal, size = 36 }: { goal: NutritionGoalImageTarget; size?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={goal.name}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        style={{ border: 'none', background: 'none', padding: 0, cursor: 'zoom-in', borderRadius: '50%', flexShrink: 0, lineHeight: 0 }}
      >
        <FoodThumbnail imageUrl={goal.image_thumbnail_url ?? goal.image_url} size={size} />
      </button>
      <NutritionGoalImageModal goal={open ? goal : null} onClose={() => setOpen(false)} />
    </>
  );
}
