'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ExerciseMedia, type ExerciseImageGender, type ExerciseImageThumb, exerciseImageThumbs, exerciseVideoPosterUrl, hasExerciseMedia,
} from './exerciseMedia';
import { ExerciseVideoModal } from './ExerciseVideoModal';
import { ExerciseInfoModal } from './exercises/ExerciseInfoModal';

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
export function ExerciseMediaThumbnails({ exercise, size = 28, part = 'all', exerciseId, onOpenImage }: {
  exercise: ExerciseMedia;
  /** When given, clicking the image opens the shared Exercise Detail Viewer (#2379). */
  exerciseId?: number;
  /**
   * #3407 — when given, a click on an image hands the caller its sex position
   * instead of opening a modal here (the workout tree keeps its one modal).
   */
  onOpenImage?: (gender: ExerciseImageGender | null) => void;
  size?: number;
  /**
   * `image` renders only the exercise image as a circular avatar (the workout
   * row puts it before the exercise name, #1647); `video` only the video tile.
   */
  part?: 'all' | 'image' | 'video';
}) {
  const t = useTranslations();
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});
  const [posterBroken, setPosterBroken] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  // #3407: the clicked image, so the modal opens that sex's own original.
  const [infoFor, setInfoFor] = useState<ExerciseImageThumb | null>(null);

  if (!hasExerciseMedia(exercise)) return null;

  // #3407: one thumbnail per sex position that has an image (male, then female).
  const images = part === 'video' ? [] : exerciseImageThumbs(exercise);
  const clickable = onOpenImage != null || exerciseId != null;
  const openImage = (img: ExerciseImageThumb) => (onOpenImage ? onOpenImage(img.gender) : setInfoFor(img));
  const videoUrl = part === 'image' ? null : (exercise.exercise_video_url ?? null);
  const posterSrc = exerciseVideoPosterUrl(exercise);
  const name = exercise.exercise_name ?? '';

  const tile: React.CSSProperties = {
    width: size, height: size, borderRadius: 5, border: '1px solid #eee',
    background: '#fafafa', objectFit: 'contain', display: 'block', flex: '0 0 auto',
  };
  const imageTile: React.CSSProperties = part === 'image'
    ? { ...tile, borderRadius: '50%', objectFit: 'cover' }
    : tile;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
      {images.map((img) => {
        const key = img.gender ?? 'default';
        if (!img.thumbnail || brokenImages[key]) return null;
        const alt = name ? t('exercise_media.image_alt', { name }) : t('exercise_media.image');
        const image = (
          <img
            src={img.thumbnail}
            alt={alt}
            title={name}
            loading="lazy"
            data-gender={img.gender ?? undefined}
            style={clickable ? { ...imageTile, cursor: 'zoom-in' } : imageTile}
            onError={() => setBrokenImages((b) => ({ ...b, [key]: true }))}
          />
        );
        return clickable ? (
          <button
            key={key}
            type="button"
            data-gender={img.gender ?? undefined}
            onClick={(e) => { e.stopPropagation(); openImage(img); }}
            aria-label={alt}
            style={{ display: 'inline-flex', lineHeight: 0, padding: 0, border: 0, background: 'none', cursor: 'zoom-in' }}
          >
            {image}
          </button>
        ) : <React.Fragment key={key}>{image}</React.Fragment>;
      })}
      {infoFor && exerciseId != null && (
        // #3407: the modal shows the clicked sex's original, never the thumbnail.
        <ExerciseInfoModal exerciseId={exerciseId} fallbackName={name} fallbackImageUrl={infoFor.original} gender={infoFor.gender} onClose={() => setInfoFor(null)} />
      )}

      {videoUrl && (
        <button
          type="button"
          onClick={() => setVideoOpen(true)}
          aria-label={name ? t('exercise_media.play_video_of', { name }) : t('exercise_media.play_video')}
          title={name}
          style={{ position: 'relative', display: 'inline-flex', lineHeight: 0, padding: 0, border: 0, background: 'none', cursor: 'pointer' }}
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
        </button>
      )}
      {videoUrl && videoOpen && (
        <ExerciseVideoModal url={videoUrl} title={name || undefined} onClose={() => setVideoOpen(false)} />
      )}
    </span>
  );
}
