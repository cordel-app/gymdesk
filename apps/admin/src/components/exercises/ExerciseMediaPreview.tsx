'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
// #967: the alt text is the name in the reader's own language.
import { exerciseName } from '@/lib/exerciseNames';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import {
  EXERCISE_GENDERS,
  type ExerciseGender,
  genderMediaKey,
  genderMediaMaster,
  genderMediaThumbnail,
} from '@/lib/exerciseGenderMedia';

/** The master size the server stores an exercise image at (#1420). */
const EXERCISE_GENDER_IMAGE_MASTER_SIZE = 1080;
import { exerciseMediaGridStyle, exerciseFieldLabelStyle } from './exerciseFieldChrome';
import type { ExerciseMediaRow } from './exerciseForm';

/**
 * The MEDIA section of a **read-only** expanded Exercise card (#965 §8, reshaped
 * by #1420 stage 3): the four gender-specific references — a male and a female
 * image, a male and a female video — shown and nothing else. No upload, no
 * replace, no remove: those live in `ExerciseEditor`'s own Media section, behind
 * `⋮ → Edit`, where every write on an Exercise lives (#797, #806 §11).
 *
 * It is one component for both Exercise screens, for the reason the editor is
 * (#806), and it renders the same grid the editor's `ExerciseGenderMedia` does —
 * a column per gender, the image above the video — so a value reads in the place
 * its control will be.
 *
 * Two properties are the rule rather than the implementation:
 *
 *  - **Nothing heavy is fetched to draw a card.** An image frame draws its 256 ×
 *    256 thumbnail, never the 1080 master (only `View full size` opens it, in a
 *    new tab), and a video frame draws its preview thumbnail; no `<video>` is
 *    mounted until someone asks to play one (#717 §9).
 *  - **Only a reference with a drawable scheme reaches the DOM.** The columns are
 *    ones a `PUT` can set to any string; the guard is inline at each sink for
 *    CodeQL's `js/xss-through-dom`.
 *
 * `playing` / `onPlay` are the caller's, so a page keeps one player at a time
 * across several expanded cards; which gender's clip is mounted inside that card
 * is local, since only one of its two can have been asked for.
 */
export function ExerciseMediaPreview({ exercise, playing, onPlay }: {
  exercise: ExerciseMediaRow;
  /** True while this exercise's player is the one mounted. */
  playing: boolean;
  onPlay: () => void;
}) {
  const t = useTranslations('exercises');
  const [which, setWhich] = React.useState<ExerciseGender | null>(null);
  return (
    <div style={exerciseMediaGridStyle}>
      {EXERCISE_GENDERS.map((gender) => (
        <div key={gender}>
          <p style={{ ...exerciseFieldLabelStyle, fontSize: 13, marginBottom: 10 }}>{t(`gender_${gender}` as any)}</p>
          <div style={{ marginBottom: 16 }}>
            <p style={exerciseFieldLabelStyle}>{t('label_image')}</p>
            <ImagePreview exercise={exercise} gender={gender} />
          </div>
          <div>
            <p style={exerciseFieldLabelStyle}>{t('label_video')}</p>
            <VideoPreview
              exercise={exercise}
              gender={gender}
              playing={playing && which === gender}
              onPlay={() => { setWhich(gender); onPlay(); }}
            />
          </div>
        </div>
      ))}
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

function ImagePreview({ exercise, gender }: { exercise: ExerciseMediaRow; gender: ExerciseGender }) {
  const t = useTranslations('exercises');
  const version = cacheKey(exercise);
  const key = genderMediaKey('image', gender);
  const master = genderMediaMaster(exercise, key);
  const thumbnail = genderMediaThumbnail(exercise, key) ?? master;
  const drawable = thumbnail != null && SAFE_IMAGE_SRC.test(thumbnail);
  const masterOpenable = master != null && SAFE_IMAGE_SRC.test(master);

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={imageFrameStyle}>
        {drawable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${thumbnail}?v=${version}`}
            alt={`${exerciseName(exercise)} — ${t(`gender_${gender}` as any)}`}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <span style={emptyFrameTextStyle}>{t('image_none')}</span>
        )}
      </div>
      {masterOpenable && (
        <a href={`${master}?v=${version}`} target="_blank" rel="noreferrer" style={mediaLinkStyle}>
          {t('image_view_full_size', { size: EXERCISE_GENDER_IMAGE_MASTER_SIZE })}
        </a>
      )}
    </div>
  );
}

function VideoPreview({ exercise, gender, playing, onPlay }: {
  exercise: ExerciseMediaRow;
  gender: ExerciseGender;
  playing: boolean;
  onPlay: () => void;
}) {
  const t = useTranslations('exercises');
  const version = cacheKey(exercise);
  const key = genderMediaKey('video', gender);
  const video = genderMediaMaster(exercise, key);
  const poster = genderMediaThumbnail(exercise, key);
  const posterDrawable = poster != null && SAFE_IMAGE_SRC.test(poster);
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
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
            {playable && <span aria-hidden="true" style={playOverlayStyle}>▶</span>}
          </button>
        ) : playable ? (
          <button type="button" onClick={onPlay} title={t('video_play')} style={posterButtonStyle(true)}>
            <span style={{ ...playOverlayStyle, color: 'var(--gd-link, #6c63ff)', textShadow: 'none' }}>▶</span>
          </button>
        ) : (
          <span style={emptyFrameTextStyle}>{hasVideo ? t('video_no_poster') : t('video_none')}</span>
        )}
      </div>
      {hasVideo && !playable && SAFE_IMAGE_SRC.test(video!) && (
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
