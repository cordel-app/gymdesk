'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ExerciseMedia, exerciseImageSrc, exerciseVideoPosterUrl, hasExerciseMedia,
} from './exerciseMedia';

/**
 * #720 — the media thumbnails shown at the right of every workout exercise row.
 *
 * Deliberately dumb: it takes the URLs the exercise already carries and renders
 * what is there. No source/ownership/import/fallback logic lives here (§8) —
 * that belongs to the Exercises domain, not to a workout.
 *
 * Nothing heavy is fetched: the image is lazy-loaded (and is the 512 × 512
 * thumbnail once #719 produces one), and a video is represented by its poster
 * or a play tile, never by a `<video>` element, so no MP4 is downloaded to draw
 * a row (§3, §10). A thumbnail that fails to load hides itself and leaves the
 * other one alone (§13).
 */
export function ExerciseMediaThumbnails({ exercise, size = 28 }: {
  exercise: ExerciseMedia;
  size?: number;
}) {
  const t = useTranslations();
  const [imageBroken, setImageBroken] = useState(false);
  const [posterBroken, setPosterBroken] = useState(false);

  if (!hasExerciseMedia(exercise)) return null;

  const imageSrc = exerciseImageSrc(exercise);
  const videoUrl = exercise.exercise_video_url ?? null;
  const posterSrc = exerciseVideoPosterUrl(exercise);
  const name = exercise.exercise_name ?? '';

  const tile: React.CSSProperties = {
    width: size, height: size, borderRadius: 5, border: '1px solid #eee',
    background: '#fafafa', objectFit: 'contain', display: 'block', flex: '0 0 auto',
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
      {imageSrc && !imageBroken && (
        <img
          src={imageSrc}
          alt={name ? t('exercise_media.image_alt', { name }) : t('exercise_media.image')}
          title={name}
          loading="lazy"
          style={tile}
          onError={() => setImageBroken(true)}
        />
      )}

      {videoUrl && (
        <a
          href={videoUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={name ? t('exercise_media.play_video_of', { name }) : t('exercise_media.play_video')}
          title={name}
          style={{ position: 'relative', display: 'inline-flex', lineHeight: 0, textDecoration: 'none' }}
        >
          {posterSrc && !posterBroken ? (
            <img
              src={posterSrc}
              alt=""
              loading="lazy"
              style={{ ...tile, objectFit: 'cover' }}
              onError={() => setPosterBroken(true)}
            />
          ) : (
            <span style={{ ...tile, background: '#f0eefc', border: '1px solid #e2def8' }} />
          )}
          {/* Play indicator — the only thing that marks the tile as a video (§3). */}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: Math.round(size * 0.42), lineHeight: 1,
              textShadow: '0 1px 3px rgba(0,0,0,.55)',
            }}
          >
            ▶
          </span>
        </a>
      )}
    </span>
  );
}
