'use client';

import { useTranslations } from 'next-intl';
import { MemberDialog } from '@/components/MemberDialog';
import { exerciseImageFullSrc, type ExerciseMedia } from '@/lib/exerciseMedia';
import { ExerciseInfo, type ExerciseInfoFields } from './ExerciseInfo';
import { secondaryButtonStyle } from '@/lib/memberChrome';

/**
 * #1527 / #2419: the Members App's one exercise detail modal — image, name and the
 * exercise's facts. My Training and My Progress both render it. Presentational:
 * every value arrives already localized by the API.
 */
export function ExerciseDetailsModal({ name, src, info, onClose }: {
  name: string; src: string | null; info: ExerciseInfoFields; onClose: () => void;
}) {
  const t = useTranslations();
  return (
    <MemberDialog
      title={name}
      labelledBy="exercise-details-title"
      onClose={onClose}
      actions={<button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, padding: '10px 14px', borderRadius: 8 }}>{t('exercise_media.close')}</button>}
    >
      {src && <img src={src} alt={t('exercise_media.image_alt', { name })} style={{ display: 'block', width: '100%', maxWidth: 'none', height: 'auto', objectFit: 'contain', alignSelf: 'stretch' }} />}
      <ExerciseInfo info={info} />
    </MemberDialog>
  );
}

/**
 * #1527: what a member gets when they select an exercise card in My Training —
 * the image larger and the exercise's full Description beneath it. Presentational:
 * the description arrives already localized by the API (`exercise_description`).
 */
export function ExerciseDetailsDialog({ exercise, description, onClose }: {
  exercise: ExerciseMedia & { exercise_name?: string; exercise_short_description?: string | null; exercise_muscles?: string[] | null; exercise_primary_muscles?: string[] | null; exercise_category?: string | null; exercise_equipment?: string | null };
  description: string | null;
  onClose: () => void;
}) {
  return (
    <ExerciseDetailsModal
      name={exercise.exercise_name ?? ''}
      src={exerciseImageFullSrc(exercise)}
      onClose={onClose}
      info={{
        short_description: exercise.exercise_short_description, description,
        muscles: exercise.exercise_muscles, primary_muscles: exercise.exercise_primary_muscles, category: exercise.exercise_category, equipment: exercise.exercise_equipment,
      }}
    />
  );
}
