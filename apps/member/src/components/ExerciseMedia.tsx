'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ExerciseMedia as ExerciseMediaFields, exerciseImageFullSrc, exerciseImageSrc,
  exerciseVideoKind, exerciseVideoPosterUrl, hasExerciseMedia,
} from '@/lib/exerciseMedia';
import { ExerciseImageViewer, ExerciseVideoViewer } from './ExerciseMediaViewer';

/**
 * #723 — the image and video of one exercise, rendered inside that exercise's
 * own row of My Training Plan.
 *
 * It lives next to the exercise's sets and reps, never in a media section of
 * its own, so the plan's hierarchy, ordering and navigation are untouched and
 * an exercise that appears in three workouts shows its media three times.
 *
 * Deliberately dumb, like the Admin app's `ExerciseMediaThumbnails` (#720) and
 * the Member app's `NutritionFoodCard` (#722): it renders the URLs the exercise
 * already carries and resolves nothing. Nothing heavy is fetched to draw a row
 * — the image is lazy-loaded and a video is represented by its poster or a play
 * tile, never by a `<video>` element, which is only mounted inside the viewer
 * once the member has selected it. An exercise with no media renders nothing at
 * all, and a thumbnail that fails to load hides itself and leaves the other one
 * alone.
 */
export function ExerciseMedia({ exercise, size = 52 }: {
  exercise: ExerciseMediaFields;
  size?: number;
}) {
  const t = useTranslations();
  const [imageBroken, setImageBroken] = useState(false);
  const [posterBroken, setPosterBroken] = useState(false);
  const [viewer, setViewer] = useState<'image' | 'video' | null>(null);

  if (!hasExerciseMedia(exercise)) return null;

  const name = exercise.exercise_name ?? '';
  const thumbSrc = imageBroken ? null : exerciseImageSrc(exercise);
  const fullSrc = exerciseImageFullSrc(exercise);
  const videoUrl = exercise.exercise_video_url ?? null;
  const videoKind = exerciseVideoKind(videoUrl);
  const posterSrc = posterBroken ? null : exerciseVideoPosterUrl(exercise);

  const tile: React.CSSProperties = { ...styles.tile, width: size, height: size };
  const playIndicator = (
    <span aria-hidden="true" style={{ ...styles.play, fontSize: Math.round(size * 0.4) }}>▶</span>
  );

  return (
    <span style={styles.row}>
      {thumbSrc && (
        <button
          type="button"
          onClick={() => setViewer('image')}
          aria-label={name ? t('exercise_media.view_image_of', { name }) : t('exercise_media.view_image')}
          style={{ ...styles.tileBtn, width: size, height: size }}
        >
          <img
            src={thumbSrc}
            alt={name ? t('exercise_media.image_alt', { name }) : t('exercise_media.image')}
            loading="lazy"
            decoding="async"
            style={{ ...tile, objectFit: 'contain' }}
            onError={() => setImageBroken(true)}
          />
        </button>
      )}

      {videoUrl && videoKind !== 'external' && (
        <button
          type="button"
          onClick={() => setViewer('video')}
          aria-label={name ? t('exercise_media.play_video_of', { name }) : t('exercise_media.play_video')}
          style={{ ...styles.tileBtn, ...styles.videoBtn, width: size, height: size }}
        >
          {posterSrc ? (
            <img
              src={posterSrc}
              alt=""
              loading="lazy"
              decoding="async"
              style={{ ...tile, objectFit: 'cover' }}
              onError={() => setPosterBroken(true)}
            />
          ) : (
            <span style={{ ...tile, ...styles.emptyPoster }} />
          )}
          {playIndicator}
        </button>
      )}

      {/* A page this app cannot embed (a Vimeo page, a gym's own site): opening
          it in a new tab still leaves My Training Plan untouched behind it. */}
      {videoUrl && videoKind === 'external' && (
        <a
          href={videoUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={name ? t('exercise_media.play_video_of', { name }) : t('exercise_media.play_video')}
          style={{ ...styles.tileBtn, ...styles.videoBtn, width: size, height: size }}
        >
          {posterSrc ? (
            <img
              src={posterSrc}
              alt=""
              loading="lazy"
              decoding="async"
              style={{ ...tile, objectFit: 'cover' }}
              onError={() => setPosterBroken(true)}
            />
          ) : (
            <span style={{ ...tile, ...styles.emptyPoster }} />
          )}
          {playIndicator}
        </a>
      )}

      {viewer === 'image' && fullSrc && (
        <ExerciseImageViewer src={fullSrc} name={name} onClose={() => setViewer(null)} />
      )}
      {viewer === 'video' && videoUrl && (
        <ExerciseVideoViewer
          url={videoUrl}
          poster={posterSrc}
          name={name}
          onClose={() => setViewer(null)}
        />
      )}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row:         { display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' },
  tileBtn:     { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 'none', background: 'none', cursor: 'pointer', lineHeight: 0, borderRadius: 8, flex: '0 0 auto', textDecoration: 'none' },
  videoBtn:    { overflow: 'hidden' },
  tile:        { borderRadius: 8, border: '1px solid #e4e4e7', background: '#fafafa', display: 'block' },
  emptyPoster: { background: '#eeecff', border: '1px solid #e2def8' },
  play:        { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', lineHeight: 1, textShadow: '0 1px 3px rgba(0,0,0,.55)' },
};
