'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MemberAvatar } from '@/components/MemberAvatar';
import { ProfessionalServiceImageModal } from '@/components/professionalServices/ProfessionalServiceImageModal';

/**
 * #3328 — the one rendering of a Base Meal's image, wherever a meal is shown:
 * Cordel → Base Meals now, and (stage 2) the meals of the Nutrition Plan
 * Templates, the Base Nutrition Plan Templates and the Assigned Nutrition Plans.
 * The issue requires one modal for all of them, so no page renders its own:
 * the circular thumbnail is a button that opens {@link MealImageModal}, the
 * app's existing image-and-description modal, with the full 1080 × 1080 image
 * and the description the API already resolved for the request's locale.
 */
export interface MealImageTarget {
  display_name: string;
  display_description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  modified_at?: string | null;
}

export function MealImageModal({ meal, onClose }: { meal: MealImageTarget | null; onClose: () => void }) {
  const t = useTranslations('base_meals');
  return (
    <ProfessionalServiceImageModal
      target={meal ? {
        name: meal.display_name,
        imageUrl: meal.image_url,
        description: meal.display_description,
        version: meal.modified_at ?? null,
      } : null}
      onClose={onClose}
      closeLabel={t('close')}
      noImageLabel={t('image_none')}
      noDescriptionLabel={t('no_description')}
    />
  );
}

/** The circular thumbnail left of a meal's name; clicking it opens {@link MealImageModal}. */
export function MealThumbnail({ meal, size = 36 }: { meal: MealImageTarget; size?: number }) {
  const [open, setOpen] = useState(false);
  const thumb = meal.image_thumbnail_url ?? meal.image_url;
  return (
    <>
      <button
        type="button"
        aria-label={meal.display_name}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        style={{ border: 'none', background: 'none', padding: 0, cursor: 'zoom-in', borderRadius: '50%', flexShrink: 0, lineHeight: 0 }}
      >
        <MemberAvatar name={meal.display_name} imageUrl={thumb} stamp={meal.modified_at} size={size} />
      </button>
      <MealImageModal meal={open ? meal : null} onClose={() => setOpen(false)} />
    </>
  );
}
