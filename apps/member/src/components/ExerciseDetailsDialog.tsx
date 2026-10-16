'use client';

import { useTranslations } from 'next-intl';
import { MemberDialog } from '@/components/MemberDialog';
import { exerciseImageFullSrc, type ExerciseMedia } from '@/lib/exerciseMedia';
import { memberTheme, secondaryButtonStyle } from '@/lib/memberChrome';

/**
 * #1527: what a member gets when they select an exercise card in My Training —
 * the image larger and the exercise's full Description beneath it. Presentational:
 * the description arrives already localized by the API (`exercise_description`).
 */
export function ExerciseDetailsDialog({ exercise, description, onClose }: {
  exercise: ExerciseMedia & { exercise_name?: string };
  description: string | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const src = exerciseImageFullSrc(exercise);
  const name = exercise.exercise_name ?? '';
  return (
    <MemberDialog
      title={name}
      labelledBy="exercise-details-title"
      onClose={onClose}
      actions={<button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, padding: '10px 14px', borderRadius: 8 }}>{t('exercise_media.close')}</button>}
    >
      {src && <img src={src} alt={t('exercise_media.image_alt', { name })} style={{ display: 'block', width: '100%', maxHeight: '50vh', objectFit: 'contain' }} />}
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: memberTheme.text, whiteSpace: 'pre-wrap' }}>
        {description && description.trim() ? description : t('training.no_description')}
      </p>
    </MemberDialog>
  );
}
