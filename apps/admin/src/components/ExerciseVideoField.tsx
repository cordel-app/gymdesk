'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { btnSmall } from './ui';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import {
  ExerciseVideoProblem,
  PreparedExerciseVideo,
  exerciseVideoMaxMb,
  isPreparedExerciseVideo,
  prepareExerciseVideo,
} from '@/lib/exerciseVideoUpload';

/**
 * The Video control on a Gym Exercise (#719 §21): the poster of the video it
 * currently has, `Upload Video` / `Replace`, and `Remove`.
 *
 * The sibling of `ExerciseImageField` (part 1), with the same two modes:
 *
 *  - **Bound** (`exerciseId` given) — uploading and removing act on the server
 *    straight away (`POST`/`DELETE /exercises/:id/video`) and the row comes back
 *    updated. The video is not a form field: it is never part of the surrounding
 *    PUT, so saving or cancelling the editor cannot undo or re-apply it.
 *  - **Staged** (`exerciseId` null) — used while *creating* an exercise, which
 *    has no id to upload to yet. The prepared pair is handed to the parent,
 *    which uploads it once the exercise has been created.
 *
 * What it renders is the poster, never the video: no `<video>` element is
 * mounted here, so picking an exercise in a list never pulls an MP4 down (§17).
 * The reference it draws is whatever the exercise currently carries — a System
 * object it was imported with, a gym upload, or an external link — and the
 * component resolves nothing and never substitutes the Base Exercise's video for
 * a missing one (§13, the no-runtime-fallback rule).
 */
interface ExerciseVideoFieldProps {
  /** The exercise to act on, or null while one is being created. */
  exerciseId: number | null;
  /** The video reference the exercise currently carries. */
  videoUrl: string | null;
  /** Its stored poster, when it has one (a YouTube or external link has none). */
  posterUrl?: string | null;
  /** Bound mode: the exercise as the API returned it after the change. */
  onChanged?: (exercise: unknown) => void;
  /** Staged mode: the pair to upload after creation, or null when it was cleared. */
  onStaged?: (prepared: PreparedExerciseVideo | null) => void;
  disabled?: boolean;
  disabledTitle?: string;
}

export function ExerciseVideoField({
  exerciseId, videoUrl, posterUrl, onChanged, onStaged, disabled, disabledTitle,
}: ExerciseVideoFieldProps) {
  const t = useTranslations('exercises');
  const { apiFetch } = useApiClient();
  const { activeGym } = useGym();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Staged mode only: the captured poster, as its own `data:image/png` bytes —
  // exactly what the upload will carry. Not an object URL minted from the picked
  // file, so no string the page read out of the file input reaches the DOM
  // (CodeQL `js/xss-through-dom`, the lesson of part 1).
  const [stagedPoster, setStagedPoster] = useState<string | null>(null);
  const [staged, setStaged] = useState(false);

  const notConfigured = activeGym != null && !activeGym.storage_configured;
  const notInitialized = activeGym != null && activeGym.storage_configured && !activeGym.storage_folder_prefix;
  const blocked = disabled || notConfigured || notInitialized;

  const preview = stagedPoster ?? posterUrl ?? null;
  // `Replace`/`Remove` follow the *reference*: a video with no stored poster (a
  // YouTube link, or a legacy URL) still has something to remove.
  const hasVideo = staged || videoUrl != null || posterUrl != null;
  // Only a reference with a drawable scheme is handed to the DOM — same inline
  // guard as the image field, tested at the sink rather than behind a call.
  const drawable = preview != null && SAFE_IMAGE_SRC.test(preview);

  function problemMessage(problem: ExerciseVideoProblem): string {
    return t(`video_error_${problem}` as any);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy('upload');
    try {
      const prepared = await prepareExerciseVideo(file);
      if (!isPreparedExerciseVideo(prepared)) {
        // Nothing is sent, so the video already on the exercise is untouched —
        // including when it was the *poster* that could not be captured.
        setError(problemMessage(prepared));
        return;
      }
      if (exerciseId == null) {
        setStagedPoster(`data:image/png;base64,${prepared.poster}`);
        setStaged(true);
        onStaged?.(prepared);
        return;
      }
      const updated = await apiFetch(`/exercises/${exerciseId}/video`, {
        method: 'POST',
        body: JSON.stringify(prepared),
      });
      onChanged?.(updated);
    } catch (err: any) {
      setError(err.message ?? t('video_error_upload_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setError(null);
    if (exerciseId == null) {
      setStagedPoster(null);
      setStaged(false);
      onStaged?.(null);
      return;
    }
    setBusy('remove');
    try {
      const updated = await apiFetch(`/exercises/${exerciseId}/video`, { method: 'DELETE' });
      onChanged?.(updated);
    } catch (err: any) {
      setError(err.message ?? t('video_error_remove_failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div style={frameStyle}>
        {drawable ? (
          <span style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview!} alt="" loading="lazy" style={{ maxWidth: 138, maxHeight: 138, objectFit: 'cover' }} />
            {/* Play indicator — the poster is an image, this is what marks it a video (§15). */}
            <span aria-hidden="true" style={playStyle}>▶</span>
          </span>
        ) : (
          <span style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: 8 }}>
            {hasVideo ? t('video_no_poster') : t('video_none')}
          </span>
        )}
      </div>

      <p style={{ margin: '8px 0 6px', fontSize: 12, color: '#888' }}>
        {t('video_requirements', { size: exerciseVideoMaxMb() })}
      </p>

      {(notConfigured || notInitialized) && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#c0392b' }}>
          {notConfigured ? t('image_not_configured') : t('image_not_initialized')}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="video/mp4"
        style={{ display: 'none' }}
        onChange={handleFile}
        disabled={blocked || busy !== null}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={blocked || busy !== null}
          title={disabled ? disabledTitle : undefined}
          style={btnSmall('#6c63ff')}
        >
          {busy === 'upload' ? t('video_uploading') : hasVideo ? t('video_replace') : t('video_upload')}
        </button>
        {hasVideo && (
          <button
            type="button"
            onClick={handleRemove}
            disabled={blocked || busy !== null}
            title={disabled ? disabledTitle : undefined}
            style={btnSmall('#888')}
          >
            {busy === 'remove' ? t('video_removing') : t('video_remove')}
          </button>
        )}
      </div>
      {error && <p style={{ margin: '6px 0 0', fontSize: 12, color: '#c0392b' }}>{error}</p>}
    </div>
  );
}

/** A 1:1 frame for the poster — the same box the image field uses, so the two sit level. */
const frameStyle: React.CSSProperties = {
  width: 140,
  height: 140,
  flexShrink: 0,
  borderRadius: 8,
  border: '1px solid var(--gd-card-border, #e5e7eb)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  backgroundColor: '#f7f7fb',
};

const playStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#fff',
  fontSize: 34,
  lineHeight: 1,
  textShadow: '0 1px 4px rgba(0,0,0,.6)',
};
