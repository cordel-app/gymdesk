'use client';

import { useTranslations } from 'next-intl';
import {
  EXERCISE_GENDERS,
  EXERCISE_MEDIA_KINDS,
  type ExerciseGenderMediaValues,
  type GenderMediaKey,
  type PreparedGenderMedia,
  genderMediaKey,
} from '@/lib/exerciseGenderMedia';
import { ExerciseGenderMediaField } from './ExerciseGenderMediaField';
import { exerciseFieldLabelStyle, exerciseMediaGridStyle } from './exerciseFieldChrome';

/**
 * The Media section of the editor (#1420 stage 3): the four independent controls,
 * a column per gender with the image above the video. A wide card puts the two
 * genders side by side and a narrow one stacks them (`auto-fit`, no media query).
 *
 * The context supplies where an upload goes (`basePath`) and whether the *gym's*
 * bucket has to be ready (`requiresGymStorage`), so this section never asks which
 * kind of exercise it holds — the API contracts and permissions stay where they
 * were. With no `exerciseId` (the creation card) each control stages its prepared
 * body through `onStage` for the page to post once the exercise exists.
 */
export function ExerciseGenderMedia({
  exerciseId, values, basePath, requiresGymStorage, onChanged, onStage, disabled, disabledTitle,
}: {
  exerciseId: number | null;
  values: ExerciseGenderMediaValues | null;
  basePath?: string;
  requiresGymStorage?: boolean;
  onChanged?: (exercise: unknown) => void;
  onStage?: (key: GenderMediaKey, prepared: PreparedGenderMedia | null) => void;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  const t = useTranslations('exercises');
  return (
    <div style={exerciseMediaGridStyle}>
      {EXERCISE_GENDERS.map((gender) => (
        <div key={gender}>
          <p style={{ ...exerciseFieldLabelStyle, fontSize: 13, marginBottom: 10 }}>{t(`gender_${gender}` as any)}</p>
          {EXERCISE_MEDIA_KINDS.map((kind) => (
            <div key={kind} style={{ marginBottom: 20 }}>
              <p style={exerciseFieldLabelStyle}>{t(kind === 'image' ? 'label_image' : 'label_video')}</p>
              <ExerciseGenderMediaField
                kind={kind}
                gender={gender}
                exerciseId={exerciseId}
                values={values}
                basePath={basePath}
                requiresGymStorage={requiresGymStorage}
                onChanged={onChanged}
                onStaged={onStage ? (prepared) => onStage(genderMediaKey(kind, gender), prepared) : undefined}
                disabled={disabled}
                disabledTitle={disabledTitle}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
