'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { gymStorageBlock } from '@/lib/gymStorageReadiness';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { exerciseVideoMaxMb } from '@/lib/exerciseVideoUpload';
import {
  EXERCISE_IMAGE_INPUT_TYPES,
  type ExerciseGender,
  type ExerciseGenderMediaValues,
  type ExerciseMediaKind,
  type GenderMediaProblem,
  type PreparedGenderMedia,
  exerciseGenderImageMaxMb,
  genderMediaKey,
  genderMediaMaster,
  genderMediaPath,
  genderMediaThumbnail,
  isPreparedGenderMedia,
  prepareGenderImage,
  prepareGenderVideo,
} from '@/lib/exerciseGenderMedia';
import { btnSmall, primaryBtnSmall } from '../ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { imagePreviewFrameStyle, imagePreviewImageStyle } from '../imagePreviewFrame';

/**
 * One of an exercise's four media controls (#1420 stage 3): the male or female
 * **image**, or the male or female **video**. The editor renders four of these, and
 * they are independent — uploading one never touches another, and a video's
 * generated preview is that video's own, never an image control's value.
 *
 * Two modes, one component, as the legacy controls had:
 *
 *  - **Bound** (`exerciseId` given) — acts on the server straight away
 *    (`POST`/`DELETE <basePath>/:id/<kind>/<gender>`) and hands the row that
 *    comes back to `onChanged`. The media is never part of the surrounding `PUT`,
 *    so saving or cancelling the editor cannot undo or re-apply it.
 *  - **Staged** (`exerciseId` null) — while *creating*, there is no id to upload
 *    to; the prepared body is handed to the parent, which posts it once the
 *    exercise exists.
 *
 * The browser sends what was picked, as it is: the server makes the WebP master
 * and thumbnail (a video's frame is captured here because `sharp` cannot decode
 * MP4). It resolves nothing of its own — no fallback to the other gender, to the
 * Base Exercise or to a legacy column.
 */
export interface ExerciseGenderMediaFieldProps {
  kind: ExerciseMediaKind;
  gender: ExerciseGender;
  /** The exercise to act on, or null while one is being created. */
  exerciseId: number | null;
  /** The exercise's gendered references as the API returned them. */
  values: ExerciseGenderMediaValues | null;
  /** Bound mode: the exercise as the API returned it after the change. */
  onChanged?: (exercise: unknown) => void;
  /** Staged mode: the prepared body to post after creation, or null when cleared. */
  onStaged?: (prepared: PreparedGenderMedia | null) => void;
  /** `/exercises` for a Gym Exercise, `/platform/exercises` for a Base Exercise. */
  basePath?: string;
  /** False for a Base Exercise, whose objects live in the platform's folder. */
  requiresGymStorage?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
}

export function ExerciseGenderMediaField({
  kind, gender, exerciseId, values, onChanged, onStaged,
  basePath = '/exercises', requiresGymStorage = true, disabled, disabledTitle,
}: ExerciseGenderMediaFieldProps) {
  const t = useTranslations('exercises');
  const { apiFetch } = useApiClient();
  const { activeGym } = useGym();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Staged mode only: a `data:image/…` URL built from the prepared body — never an
  // object URL minted from the picked file, so nothing the page read out of the
  // file input reaches the DOM (CodeQL `js/xss-through-dom`).
  const [stagedPreview, setStagedPreview] = useState<string | null>(null);

  const key = genderMediaKey(kind, gender);
  const storageBlock = gymStorageBlock(activeGym, requiresGymStorage);
  const notConfigured = storageBlock === 'not_configured';
  const notInitialized = storageBlock === 'not_initialized';
  const blocked = disabled || notConfigured || notInitialized;

  const master = genderMediaMaster(values, key);
  const thumbnail = genderMediaThumbnail(values, key);
  const preview = stagedPreview ?? thumbnail ?? (kind === 'image' ? master : null);
  const hasMedia = stagedPreview != null || master != null;
  // Tested inline at the sink rather than through a helper, so the guard reads to
  // CodeQL as the sanitiser it is (see `SAFE_IMAGE_SRC`).
  const drawable = preview != null && SAFE_IMAGE_SRC.test(preview);

  const problemMessage = (problem: GenderMediaProblem) => t(`gender_media_error_${problem}` as any, {
    size: kind === 'image' ? exerciseGenderImageMaxMb() : exerciseVideoMaxMb(),
  });

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy('upload');
    try {
      const prepared = kind === 'image' ? await prepareGenderImage(file) : await prepareGenderVideo(file);
      if (!isPreparedGenderMedia(prepared)) {
        // Nothing is sent, so the media already on the exercise is untouched.
        setError(problemMessage(prepared));
        return;
      }
      if (exerciseId == null) {
        setStagedPreview(prepared.preview);
        onStaged?.(prepared);
        return;
      }
      const updated = await apiFetch(genderMediaPath(basePath, exerciseId, kind, gender), {
        method: 'POST',
        body: JSON.stringify(prepared.body),
      });
      onChanged?.(updated);
    } catch (err: any) {
      setError(err.message ?? t('gender_media_error_upload_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setError(null);
    if (exerciseId == null) {
      setStagedPreview(null);
      onStaged?.(null);
      return;
    }
    setBusy('remove');
    try {
      const updated = await apiFetch(genderMediaPath(basePath, exerciseId, kind, gender), { method: 'DELETE' });
      onChanged?.(updated);
    } catch (err: any) {
      setError(err.message ?? t('gender_media_error_remove_failed'));
    } finally {
      setBusy(null);
    }
  }

  const accept = kind === 'image' ? EXERCISE_IMAGE_INPUT_TYPES.join(',') : 'video/mp4';
  const noun = kind === 'image' ? t('label_image') : t('label_video');

  return (
    <div data-gender-media={key}>
      <div style={imagePreviewFrameStyle()}>
        {drawable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview!} alt="" loading="lazy" style={imagePreviewImageStyle} />
        ) : (
          <span style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: 8 }}>
            {hasMedia ? t('video_no_poster') : t(kind === 'image' ? 'image_none' : 'video_none')}
          </span>
        )}
      </div>

      <p style={{ margin: '8px 0 6px', fontSize: 12, color: '#888' }}>
        {kind === 'image'
          ? t('gender_media_image_requirements', { size: exerciseGenderImageMaxMb() })
          : t('gender_media_video_requirements', { size: exerciseVideoMaxMb() })}
      </p>

      {(notConfigured || notInitialized) && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#c0392b' }}>
          {notConfigured ? t('image_not_configured') : t('image_not_initialized')}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={handleFile}
        disabled={blocked || busy !== null}
        aria-label={t('gender_media_input_label', { kind: noun, gender: t(`gender_${gender}` as any) })}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={blocked || busy !== null}
          title={disabled ? disabledTitle : undefined}
          style={primaryBtnSmall()}
        >
          {busy === 'upload' ? t('image_uploading') : hasMedia ? t('gender_media_replace') : t('gender_media_upload')}
        </button>
        {hasMedia && (
          <button
            type="button"
            onClick={() => (exerciseId == null ? handleRemove() : setConfirmingRemove(true))}
            disabled={blocked || busy !== null}
            title={disabled ? disabledTitle : undefined}
            style={btnSmall('#888')}
          >
            {busy === 'remove' ? t('image_removing') : t('image_remove')}
          </button>
        )}
      </div>
      {error && <p role="alert" style={{ margin: '6px 0 0', fontSize: 12, color: '#c0392b' }}>{error}</p>}

      <ConfirmDialog
        open={confirmingRemove}
        message={t('gender_media_confirm_remove', { kind: noun.toLowerCase(), gender: t(`gender_${gender}` as any).toLowerCase() })}
        confirmLabel={t('image_remove')}
        cancelLabel={t('cancel')}
        busy={busy === 'remove'}
        onConfirm={() => { setConfirmingRemove(false); handleRemove(); }}
        onCancel={() => setConfirmingRemove(false)}
      />
    </div>
  );
}
