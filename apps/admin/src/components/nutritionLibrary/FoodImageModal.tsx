'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ProfessionalServiceImageModal } from '@/components/professionalServices/ProfessionalServiceImageModal';

export interface FoodImageTarget {
  name: string;
  /** Full-size image (`image_url`), never the thumbnail. */
  imageUrl: string | null | undefined;
  description: string | null | undefined;
  version?: string | null;
}

/**
 * #2307 — clicking a food's circular thumbnail in the Foods lists (Gym and Cordel Base)
 * opens the full-size picture with the complete description below it. It reuses the
 * Professional Services image modal (#2297), so layout, aspect ratio and dismissal
 * behave the same; only the labels come from the Nutrition Library namespace.
 */
export function FoodImageModal({ target, onClose }: { target: FoodImageTarget | null; onClose: () => void }) {
  const t = useTranslations('nutrition_library');
  return (
    <ProfessionalServiceImageModal
      target={target}
      onClose={onClose}
      closeLabel={t('close')}
      noImageLabel={t('no_image')}
      noDescriptionLabel={t('image_modal_no_description')}
    />
  );
}
