'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { type ExerciseGenderMediaValues } from '@/lib/exerciseGenderMedia';

const SIZE = 28;

const thumbStyle: React.CSSProperties = {
  width: SIZE, height: SIZE, borderRadius: '50%', objectFit: 'cover', flexShrink: 0,
  background: 'var(--gd-app-bg, #f3f4f6)', border: '1px solid var(--gd-card-border, #e5e7eb)', boxSizing: 'border-box',
};

function Thumb({ src, label }: { src: string | null; label: string }) {
  const [broken, setBroken] = React.useState(false);
  const show = !!src && SAFE_IMAGE_SRC.test(src) && !broken;
  if (show) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src!} alt={label} title={label} loading="lazy" onError={() => setBroken(true)} style={thumbStyle} />;
  }
  // Neutral placeholder: a missing variant never hides the other one.
  return <span role="img" aria-label={label} title={label} style={{ ...thumbStyle, display: 'inline-block' }} />;
}

/**
 * The male and female thumbnails shown before an exercise's name in the Base
 * Exercises and Exercises lists (#1561). Presentation only: it draws the two
 * thumbnails the API reports. Since #1704 each position has already fallen back,
 * on its own, to the primary muscle's image of that sex (server-side).
 */
export function ExerciseListThumbnails({ exercise }: {
  exercise: ExerciseGenderMediaValues & {
    effective_image_male_thumbnail_url?: string | null;
    effective_image_female_thumbnail_url?: string | null;
  };
}) {
  const t = useTranslations('exercises');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <Thumb src={exercise.effective_image_male_thumbnail_url ?? exercise.image_male_thumbnail_url ?? null} label={t('gender_male')} />
      <Thumb src={exercise.effective_image_female_thumbnail_url ?? exercise.image_female_thumbnail_url ?? null} label={t('gender_female')} />
    </span>
  );
}
