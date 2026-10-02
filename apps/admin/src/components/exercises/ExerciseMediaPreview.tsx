'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { EXERCISE_IMAGE_MASTER_SIZE, SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { exerciseMediaGridStyle, exerciseFieldLabelStyle } from './exerciseFieldChrome';
import type { ExerciseMediaRow } from './exerciseForm';

/**
 * The MEDIA section of a **read-only** expanded Exercise card (#965 §8): the
 * image and the video, shown and nothing else — no upload, no replace, no
 * remove. Those live in `ExerciseEditor`'s own Media section, behind
 * `⋮ → Edit`, which is where every write on an Exercise lives (#797, #806 §11).
 *
 * It is one component for both Exercise screens, for the reason the editor is
 * (#806): the gym Exercises page and Cordel's Base Exercises page had grown two
 * different previews of the same two columns — one a pair of 160px thumbnails
 * beside the raw `video_url` text, the other a framed thumbnail with a poster
 * that doubles as a play control — so the same exercise read differently
 * depending on which page you opened it from.
 *
 * Two properties are the rule rather than the implementation:
 *
 *  - **Nothing heavy is fetched to draw a card.** The image frame draws the
 *    512×512 thumbnail, never the 2048×2048 master (#716 §4) — the master is only
 *    ever fetched by following `View full size`, which opens it in a new tab —
 *    and no `<video>` is mounted until someone asks to play one (#717 §9), so
 *    expanding a card never pulls an MP4 down.
 *  - **Only a reference with a drawable scheme reaches the DOM.** `image_url` and
 *    `video_url` are columns a `PUT` can set to any string, and on a row that was
 *    never uploaded to the video is typically a YouTube link — a reference this
 *    component *links to* rather than tries to play. (CodeQL `js/xss-through-dom`
 *    is the reason the guard is inline at the sink rather than assumed upstream.)
 *
 * `playing` / `onPlay` are the caller's, not this component's, so a page can keep
 * one player at a time across several expanded cards — a second clip starting
 * over the first is the whole reason the state is not internal.
 */
export function ExerciseMediaPreview({ exercise, playing, onPlay }: {
  exercise: ExerciseMediaRow;
  /** True while this exercise's player is the one mounted. */
  playing: boolean;
  onPlay: () => void;
}) {
  const t = useTranslations('exercises');
  return (
    <div style={exerciseMediaGridStyle}>
      <div>
        <p style={exerciseFieldLabelStyle}>{t('label_image')}</p>
        <ImagePreview exercise={exercise} />
      </div>
      <div>
        <p style={exerciseFieldLabelStyle}>{t('label_video')}</p>
        <VideoPreview exercise={exercise} playing={playing} onPlay={onPlay} />
      </div>
    </div>
  );
}

/**
 * A replacement reuses the deterministic object key, so the URL does not change —
 * `modified_at` is what busts the browser's cache (#715's rule).
 */
function cacheKey(exercise: ExerciseMediaRow): string {
  return encodeURIComponent(exercise.modified_at ?? exercise.created_at);
}

function ImagePreview({ exercise }: { exercise: ExerciseMediaRow }) {
  const t = useTranslations('exercises');
  const version = cacheKey(exercise);
  const thumbnail = exercise.image_thumbnail_url ?? exercise.image_url;
  const drawable = thumbnail != null && SAFE_IMAGE_SRC.test(thumbnail);
  const master = exercise.image_url;
  const masterOpenable = master != null && SAFE_IMAGE_SRC.test(master);

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={imageFrameStyle}>
        {drawable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${thumbnail}?v=${version}`}
            alt={exercise.name}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <span style={emptyFrameTextStyle}>{t('image_none')}</span>
        )}
      </div>
      {masterOpenable && (
        <a href={`${master}?v=${version}`} target="_blank" rel="noreferrer" style={mediaLinkStyle}>
          {t('image_view_full_size', { size: EXERCISE_IMAGE_MASTER_SIZE })}
        </a>
      )}
    </div>
  );
}

function VideoPreview({ exercise, playing, onPlay }: {
  exercise: ExerciseMediaRow;
  playing: boolean;
  onPlay: () => void;
}) {
  const t = useTranslations('exercises');
  const version = cacheKey(exercise);
  const poster = exercise.video_thumbnail_url;
  const posterDrawable = poster != null && SAFE_IMAGE_SRC.test(poster);
  const video = exercise.video_url;
  const hasVideo = video != null;
  // An uploaded object is an `.mp4` this deployment stored; anything else the
  // column holds is a link, and a `<video>` would only fail to decode it.
  const playable = video != null && PLAYABLE_VIDEO_SRC.test(video);
  const mounted = playing && playable;

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={videoFrameStyle}>
        {mounted ? (
          // `controls` + `preload="metadata"` and nothing else: #717 §8 is
          // explicit that nothing starts playing on its own.
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={`${video}?v=${version}`}
            poster={posterDrawable ? `${poster}?v=${version}` : undefined}
            controls
            preload="metadata"
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
          />
        ) : posterDrawable ? (
          <button
            type="button"
            onClick={() => playable && onPlay()}
            title={playable ? t('video_play') : undefined}
            style={posterButtonStyle(playable)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${poster}?v=${version}`}
              alt=""
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            {playable && <span aria-hidden="true" style={playOverlayStyle}>▶</span>}
          </button>
        ) : playable ? (
          // A clip with no stored poster — there is nothing to draw, but it is
          // still playable, so the frame offers the player rather than a dead
          // "No preview".
          <button type="button" onClick={onPlay} title={t('video_play')} style={posterButtonStyle(true)}>
            <span style={{ ...playOverlayStyle, color: 'var(--gd-link, #6c63ff)', textShadow: 'none' }}>▶</span>
          </button>
        ) : (
          <span style={emptyFrameTextStyle}>{hasVideo ? t('video_no_poster') : t('video_none')}</span>
        )}
      </div>
      {hasVideo && !playable && SAFE_IMAGE_SRC.test(video!) && (
        // An external link the exercise carries — shown as what it is rather than
        // played, since nothing here can vouch for what is behind it.
        <a href={video!} target="_blank" rel="noreferrer" style={{ ...mediaLinkStyle, wordBreak: 'break-all' }}>
          {video}
        </a>
      )}
    </div>
  );
}

/**
 * Which references this component will hand to a `<video src>`: an `http(s)` URL
 * whose path ends in `.mp4`, which is what an upload produces. A YouTube watch
 * page is a link, not a clip (#717 §8).
 */
const PLAYABLE_VIDEO_SRC = /^https?:\/\/[^?#]+\.mp4(?:[?#]|$)/i;

/**
 * A 1:1 frame for the exercise image. The checkerboard is what makes a
 * transparent background legible as transparency rather than as white, and
 * `objectFit: contain` keeps the square undistorted (#715's frame).
 */
const imageFrameStyle: React.CSSProperties = {
  width: 160,
  height: 160,
  flexShrink: 0,
  borderRadius: 8,
  border: '1px solid var(--gd-card-border, #e5e7eb)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  backgroundColor: '#fff',
  backgroundImage:
    'linear-gradient(45deg, #eee 25%, transparent 25%), linear-gradient(-45deg, #eee 25%, transparent 25%),'
    + ' linear-gradient(45deg, transparent 75%, #eee 75%), linear-gradient(-45deg, transparent 75%, #eee 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
};

/** A 16:9 frame for the poster and, once asked for, the player itself. */
const videoFrameStyle: React.CSSProperties = {
  width: 240,
  height: 160,
  flexShrink: 0,
  borderRadius: 8,
  border: '1px solid var(--gd-card-border, #e5e7eb)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  backgroundColor: '#f7f7fb',
};

/** The poster doubles as the play control, so it is a button rather than a div. */
function posterButtonStyle(playable: boolean): React.CSSProperties {
  return {
    position: 'relative',
    display: 'block',
    width: '100%',
    height: '100%',
    padding: 0,
    border: 'none',
    background: 'none',
    cursor: playable ? 'pointer' : 'default',
    lineHeight: 0,
  };
}

const playOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#fff',
  fontSize: 38,
  lineHeight: 1,
  textShadow: '0 1px 6px rgba(0,0,0,.65)',
};

const emptyFrameTextStyle: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: 12,
  textAlign: 'center',
  padding: 8,
};

const mediaLinkStyle: React.CSSProperties = { fontSize: 12.5, color: 'var(--gd-link, #4b45c6)' };
