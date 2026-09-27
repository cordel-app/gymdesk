'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { gymStorageBlock } from '@/lib/gymStorageReadiness';
import { btnSmall } from './ui';
import { ConfirmDialog } from './ConfirmDialog';
import {
  EXERCISE_IMAGE_MASTER_SIZE,
  ExerciseImageProblem,
  PreparedExerciseImage,
  SAFE_IMAGE_SRC,
  isPreparedExerciseImage,
  prepareExerciseImage,
} from '@/lib/exerciseImageUpload';

/**
 * The Image control on an Exercise (#719 §21): the image it currently has,
 * `Upload Image` / `Replace`, and `Remove`. Since #806 both editing surfaces
 * render it — a Gym Exercise and a Base Exercise — with `basePath` naming the
 * context's own route, so the Media UI is one implementation (AC2, AC6).
 *
 * Two modes, one component:
 *
 *  - **Bound** (`exerciseId` given) — the exercise exists, so uploading and
 *    removing act on the server straight away (`POST`/`DELETE
 *    <basePath>/:id/image`) and the row comes back updated. The image is not a
 *    form field: it is never part of the surrounding PUT, so saving or
 *    cancelling the editor cannot undo or re-apply it.
 *  - **Staged** (`exerciseId` null) — used while *creating* an exercise, which
 *    has no id to upload to yet. The prepared pair is handed to the parent,
 *    which uploads it once the exercise has been created.
 *
 * What it renders is whatever the exercise currently references: a System
 * object it was imported with, a gym upload, or an external URL — the component
 * resolves nothing and never substitutes the Base Exercise's image for a
 * missing one (§13, the no-runtime-fallback rule).
 */
interface ExerciseImageFieldProps {
  /** The exercise to act on, or null while one is being created. */
  exerciseId: number | null;
  /** The master reference the exercise currently carries. */
  imageUrl: string | null;
  /** Its 512×512 companion, when it has one (a legacy or external image has none). */
  thumbnailUrl?: string | null;
  /** Bound mode: the exercise as the API returned it after the change. */
  onChanged?: (exercise: unknown) => void;
  /** Staged mode: the pair to upload after creation, or null when it was cleared. */
  onStaged?: (prepared: PreparedExerciseImage | null) => void;
  /**
   * Where the upload goes (#806 §6/§7): `/exercises` for a Gym Exercise,
   * `/platform/exercises` for a Base Exercise. The **context** supplies it, so
   * this control never asks which kind of exercise it is holding — the API
   * contracts and permissions stay where they were.
   */
  basePath?: string;
  /**
   * Whether the *gym's* own bucket has to be ready. A Base Exercise's objects
   * live in the platform's folder (`cordel/…`), which no gym's storage settings
   * gate, so the Base Exercises page passes `false` — otherwise the control
   * would refuse an upload because the superadmin's currently selected gym has
   * no bucket of its own.
   */
  requiresGymStorage?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
}

export function ExerciseImageField({
  exerciseId, imageUrl, thumbnailUrl, onChanged, onStaged, basePath = '/exercises', requiresGymStorage = true, disabled, disabledTitle,
}: ExerciseImageFieldProps) {
  const t = useTranslations('exercises');
  const { apiFetch } = useApiClient();
  const { activeGym } = useGym();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // #717 §7, generalised by #806: removing media is destructive, so it asks
  // first rather than acting on the click. Both editing surfaces render this
  // control, so the rule now holds for a Gym Exercise as well as a Base one.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Staged mode only: the prepared thumbnail, as its own `data:image/png`
  // bytes. Not an object URL minted from the picked file: the frame draws the
  // 512×512 companion rather than the 2048 master (§17), it is exactly what the
  // upload will carry, there is nothing to revoke, and no string the page read
  // out of the file input reaches the DOM (CodeQL `js/xss-through-dom`).
  const [stagedPreview, setStagedPreview] = useState<string | null>(null);

  // #823: one rule for both storage blocks, shared with the Theme editors —
  // `requiresGymStorage` is what keeps a Base Exercise (platform folder) out of
  // the currently selected gym's storage state.
  const storageBlock = gymStorageBlock(activeGym, requiresGymStorage);
  const notConfigured = storageBlock === 'not_configured';
  const notInitialized = storageBlock === 'not_initialized';
  const blocked = disabled || notConfigured || notInitialized;

  // The thumbnail is what this control draws when there is one — the master is
  // 2048×2048 and has no business being downloaded for a 120px frame (§17).
  const preview = stagedPreview ?? thumbnailUrl ?? imageUrl ?? null;
  const hasImage = preview != null;
  // `Replace`/`Remove` follow the *reference*, but only a reference with a
  // drawable scheme is handed to the DOM — see `SAFE_IMAGE_SRC`. Tested here
  // rather than through `isSafeImageSrc()` so the guard sits inline at the sink.
  const drawable = preview != null && SAFE_IMAGE_SRC.test(preview);

  function problemMessage(problem: ExerciseImageProblem): string {
    return t(`image_error_${problem}` as any);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy('upload');
    try {
      const prepared = await prepareExerciseImage(file);
      if (!isPreparedExerciseImage(prepared)) {
        // Nothing is sent, so the image already on the exercise is untouched —
        // including when it was the *thumbnail* that could not be produced.
        setError(problemMessage(prepared));
        return;
      }
      if (exerciseId == null) {
        setStagedPreview(`data:image/png;base64,${prepared.thumbnail}`);
        onStaged?.(prepared);
        return;
      }
      const updated = await apiFetch(`${basePath}/${exerciseId}/image`, {
        method: 'POST',
        body: JSON.stringify(prepared),
      });
      onChanged?.(updated);
    } catch (err: any) {
      setError(err.message ?? t('image_error_upload_failed'));
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
      const updated = await apiFetch(`${basePath}/${exerciseId}/image`, { method: 'DELETE' });
      onChanged?.(updated);
    } catch (err: any) {
      setError(err.message ?? t('image_error_remove_failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div style={frameStyle}>
        {drawable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview!} alt="" loading="lazy" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        ) : (
          <span style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: 8 }}>{t('image_none')}</span>
        )}
      </div>

      <p style={{ margin: '8px 0 6px', fontSize: 12, color: '#888' }}>
        {t('image_requirements', { size: EXERCISE_IMAGE_MASTER_SIZE })}
      </p>

      {(notConfigured || notInitialized) && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#c0392b' }}>
          {notConfigured ? t('image_not_configured') : t('image_not_initialized')}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/png"
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
          {busy === 'upload' ? t('image_uploading') : hasImage ? t('image_replace') : t('image_upload')}
        </button>
        {hasImage && (
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
      {error && <p style={{ margin: '6px 0 0', fontSize: 12, color: '#c0392b' }}>{error}</p>}

      <ConfirmDialog
        open={confirmingRemove}
        message={t('image_confirm_remove')}
        confirmLabel={t('image_remove')}
        cancelLabel={t('cancel')}
        busy={busy === 'remove'}
        onConfirm={() => { setConfirmingRemove(false); handleRemove(); }}
        onCancel={() => setConfirmingRemove(false)}
      />
    </div>
  );
}

/**
 * A 1:1 frame for the image. The checkerboard is what makes a transparent
 * background legible as transparency rather than as white, and `objectFit:
 * contain` keeps the square undistorted (#715's frame, same reasoning).
 */
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
  backgroundColor: '#fff',
  backgroundImage:
    'linear-gradient(45deg, #eee 25%, transparent 25%), linear-gradient(-45deg, #eee 25%, transparent 25%),'
    + ' linear-gradient(45deg, transparent 75%, #eee 75%), linear-gradient(-45deg, transparent 75%, #eee 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
};
