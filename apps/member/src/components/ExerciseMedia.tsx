'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ExerciseMedia as ExerciseMediaFields, exerciseImageFullSrc, exerciseImageSrc,
  exerciseVideoKind, exerciseVideoPosterUrl, hasExerciseMedia,
} from '@/lib/exerciseMedia';
import { ExerciseImageViewer, ExerciseVideoViewer } from './ExerciseMediaViewer';
import { memberTheme } from '@/lib/memberChrome';

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
export function ExerciseMedia({ exercise, size = 52, fill = false }: {
  exercise: ExerciseMediaFields;
  size?: number;
  /** #1527: the image is the card's own visual area — full width, square, no inner frame. */
  fill?: boolean;
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

  // #1527: on a card the image is the card's own visual area and plain
  // (the card opens the details; the play button sits by the name), so it
  // is neither a button nor a video tile.
  if (fill) {
    if (!thumbSrc) return null;
    return (
      <span style={{ display: 'block', width: '100%', aspectRatio: '1 / 1', lineHeight: 0 }}>
        <img
          src={thumbSrc}
          alt={name ? t('exercise_media.image_alt', { name }) : t('exercise_media.image')}
          loading="lazy"
          decoding="async"
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain', border: 'none', borderRadius: 0, background: 'transparent' }}
          onError={() => setImageBroken(true)}
        />
      </span>
    );
  }

  const tile: React.CSSProperties = fill
    ? { ...styles.tile, ...styles.tileFill, width: '100%', height: '100%' }
    : { ...styles.tile, width: size, height: size };
  const boxSize: React.CSSProperties = fill ? { width: '100%', aspectRatio: '1 / 1' } : { width: size, height: size };
  const playIndicator = (
    <span aria-hidden="true" style={{ ...styles.play, fontSize: Math.round(size * 0.4) }}>▶</span>
  );

  return (
    <span style={fill ? { ...styles.row, display: 'flex', width: '100%' } : styles.row}>
      {thumbSrc && (
        <button
          type="button"
          onClick={() => setViewer('image')}
          aria-label={name ? t('exercise_media.view_image_of', { name }) : t('exercise_media.view_image')}
          style={{ ...styles.tileBtn, ...boxSize }}
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
          style={{ ...styles.tileBtn, ...styles.videoBtn, ...boxSize }}
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
          style={{ ...styles.tileBtn, ...styles.videoBtn, ...boxSize }}
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
  tileFill:    { border: 'none', borderRadius: 0, background: 'transparent' },
  videoBtn:    { overflow: 'hidden' },
  tile:        { borderRadius: 8, border: `1px solid ${memberTheme.cardBorderColor}`, background: memberTheme.pageBackground, display: 'block' },
  emptyPoster: {
    background: `color-mix(in srgb, ${memberTheme.primaryButton} 10%, ${memberTheme.surface})`,
    border: `1px solid color-mix(in srgb, ${memberTheme.primaryButton} 25%, ${memberTheme.surface})`,
  },
  play:        { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: memberTheme.primaryButtonText, lineHeight: 1, textShadow: '0 1px 3px rgba(0,0,0,.55)' },
};
