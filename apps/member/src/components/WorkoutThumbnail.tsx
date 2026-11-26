'use client';

import { ImagePreviewButton } from './ImagePreview';
import { MemberAvatar } from './MemberAvatar';
import { memberAvatarColors } from '@/lib/memberAvatar';
import {
  WORKOUT_THUMBNAIL_PLACEHOLDER,
  WORKOUT_THUMBNAIL_SIZE,
  workoutThumbnailView,
  type HeadingWorkout,
} from '@/lib/trainingWorkoutHeading';

/**
 * #3465 — a Workout's circular thumbnail in My Training, the meal-group
 * thumbnail's twin (`MealThumbnail`, #3404/#3428): the first exercise's picture
 * through the app's one avatar rendering, opening the app's one enlarged-image
 * dialog; a Workout with no exercise picture draws the **WO** placeholder in the
 * avatar's own colours and is not a button. Presentation only.
 */
export function WorkoutThumbnail({ workout, title }: { workout: HeadingWorkout; title: string }) {
  const view = workoutThumbnailView(workout);
  const size = WORKOUT_THUMBNAIL_SIZE;
  if (!view.thumbnailSrc) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: size, height: size, flexShrink: 0, borderRadius: '50%',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: Math.round(size * 0.32), fontWeight: 700, lineHeight: 1,
          ...memberAvatarColors(title),
        }}
      >
        {WORKOUT_THUMBNAIL_PLACEHOLDER}
      </span>
    );
  }
  return (
    <span style={{ width: size, height: size, flexShrink: 0, display: 'inline-flex' }}>
      <ImagePreviewButton
        src={view.fullSrc}
        alt={view.exerciseName ?? title}
        title={view.exerciseName ?? title}
        style={{ width: size, height: size, borderRadius: '50%' }}
      >
        <MemberAvatar
          member={{ name: title, image_url: view.fullSrc, image_thumbnail_url: view.thumbnailSrc }}
          size={size}
        />
      </ImagePreviewButton>
    </span>
  );
}
