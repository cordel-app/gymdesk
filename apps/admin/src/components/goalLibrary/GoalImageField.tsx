'use client';

import React, { useRef, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { gymStorageBlock } from '@/lib/gymStorageReadiness';
import { btnSmall, primaryBtnSmall } from '@/components/ui';
// The app's one red and its one help-text treatment: a literal here would be a
// second source of truth for both (#929, #1070 exported `alertTextColor`).
import { alertTextColor, formHelpTextStyle } from '@/components/formChrome';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  imagePreviewFrameStyle,
  imagePreviewImageStyle,
} from '@/components/imagePreviewFrame';
// The app's one client-side image reader and its one safe-`src` guard. Named
// after the feature that first needed them (#719) rather than after what they
// do, but duplicating either here would be a second implementation of the same
// rule — which is the thing #806 and #1011 keep pointing at.
import { SAFE_IMAGE_SRC, readImageDimensions } from '@/lib/exerciseImageUpload';
import { GoalRow, PERSONAL_GOAL_IMAGE_MAX_SIZE } from './goalProfile';

/**
 * The Image control on a Personal Goal (#1035 stage 2, §4/§5): the image it
 * currently has, `Upload image` / `Replace`, and `Remove`.
 *
 * **One control for both screens**, the `ExerciseImageField` arrangement (#806):
 * `basePath` names the context's own route — `/personal-goals` for a gym's own
 * goal, `/platform/personal-goals` for a System one — so this component names no
 * endpoint and decides no permission, and `requiresGymStorage` is what keeps a
 * System goal (whose object lives under `cordel/`, gated by no gym's bucket) out
 * of whichever gym a superadmin happens to have selected (#823).
 *
 * It is **not a form field**: the upload and the removal act on the server
 * straight away and hand the page the row that came back, so the surrounding
 * `PUT` neither carries nor can undo them. That is deliberate — the object key
 * is built from the goal's id, which only exists once the row does, which is also
 * why the *create* form offers no image control and says to upload it from Edit
 * (the Base Nutrition Library's own answer, #715).
 *
 * The browser's checks exist to give a clear error *before* the upload, never
 * instead of it: the server re-reads the PNG signature and the dimensions from
 * the bytes themselves (#715 §8).
 */
export function GoalImageField({
  goal, basePath, requiresGymStorage = true, disabled, disabledTitle, label, onChanged,
}: {
  goal: GoalRow;
  /** `/personal-goals` or `/platform/personal-goals` — the page's, never this component's. */
  basePath: string;
  /**
   * Whether the *gym's* own bucket has to be ready. A System goal's object lives
   * in the platform's folder (`cordel/goals/…`), which no gym's storage settings
   * gate, so Cordel's Base Personal Goals page passes `false`.
   */
  requiresGymStorage?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  /** Resolves a key in the calling page's own namespace (#901). */
  label: (key: string) => string;
  /** The goal as the API returned it after the change. */
  onChanged: (goal: GoalRow) => void;
}) {
  const { apiFetch, uploadFetch } = useApiClient();
  const { activeGym } = useGym();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Removing an image is destructive, so it asks first rather than acting on the
  // click — the rule #717 §7 set and #806 generalised to both Exercise screens.
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // #823: one rule for both storage blocks, shared with every other per-gym
  // upload control — never a second derivation of the `activeGym` pair.
  const storageBlock = gymStorageBlock(activeGym, requiresGymStorage);
  const notConfigured = storageBlock === 'not_configured';
  const notInitialized = storageBlock === 'not_initialized';
  const blocked = disabled || notConfigured || notInitialized;

  const imageUrl = goal.image_url ?? null;
  // Cache-busted on the row's own `modified_at`, because the object key is
  // deterministic: a replacement rewrites the same key, so without this the
  // browser would keep showing the picture it already has. The same device
  // Cordel's Base Nutrition Library already uses.
  const stamp = goal.modified_at ?? goal.created_at;
  const previewSrc = imageUrl ? `${imageUrl}?v=${encodeURIComponent(stamp)}` : null;
  // Only a reference with a drawable scheme is handed to the DOM. Tested inline
  // rather than through a helper call so the guard sits at the sink, which is
  // what keeps CodeQL's `js/xss-through-dom` reading it (#767's note).
  const drawable = previewSrc != null && SAFE_IMAGE_SRC.test(previewSrc);

  /** `null` when the file may be uploaded, otherwise the locale key saying why not. */
  async function checkFile(file: File): Promise<string | null> {
    if (file.type !== 'image/png') return 'image_error_not_a_png';
    const dimensions = await readImageDimensions(file);
    if (!dimensions) return 'image_error_unreadable';
    if (
      dimensions.width > PERSONAL_GOAL_IMAGE_MAX_SIZE
      || dimensions.height > PERSONAL_GOAL_IMAGE_MAX_SIZE
    ) {
      return 'image_error_too_large_dimensions';
    }
    return null;
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared so picking the same file twice still fires `onChange`.
    e.target.value = '';
    if (!file) return;
    setError(null);
    const problem = await checkFile(file);
    if (problem) {
      // Nothing is sent, so the image already on the goal is untouched.
      setError(label(problem));
      return;
    }
    setBusy('upload');
    try {
      // `uploadFetch` rather than a hand-rolled fetch against the Next proxy:
      // that proxy forwards `x-gym-id` but cannot invent it, so an upload
      // sending only the bearer token reaches `tenantContext` with no gym and
      // answers a bare 401 (CLAUDE.md, #824).
      const updated = await uploadFetch(`${basePath}/${goal.id}/image`, file);
      onChanged(updated as GoalRow);
    } catch (err: any) {
      setError(err.message ?? label('image_error_upload_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setError(null);
    setBusy('remove');
    try {
      const updated = await apiFetch<GoalRow>(`${basePath}/${goal.id}/image`, { method: 'DELETE' });
      onChanged(updated);
    } catch (err: any) {
      setError(err.message ?? label('image_error_remove_failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div style={imagePreviewFrameStyle()}>
        {drawable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewSrc!} alt="" loading="lazy" style={imagePreviewImageStyle} />
        ) : (
          <span style={{ ...formHelpTextStyle, margin: 0, textAlign: 'center', padding: 8 }}>
            {label('image_none')}
          </span>
        )}
      </div>

      <p style={{ ...formHelpTextStyle, margin: '8px 0 6px' }}>{label('image_requirements')}</p>

      {(notConfigured || notInitialized) && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: alertTextColor }}>
          {notConfigured ? label('image_not_configured') : label('image_not_initialized')}
        </p>
      )}

      {/* Disabled together with the button: a disabled button alone is still
          reachable through `inputRef.current?.click()` (#823). */}
      <input
        ref={inputRef}
        type="file"
        accept="image/png"
        style={{ display: 'none' }}
        onChange={handleFile}
        disabled={blocked || busy !== null}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={blocked || busy !== null}
          title={disabled ? disabledTitle : undefined}
          // #912/#954: the Theme's Primary Button colours through the shared
          // helper, never a lilac literal. `Remove` beside it stays neutral.
          style={primaryBtnSmall()}
        >
          {busy === 'upload'
            ? label('image_uploading')
            : imageUrl ? label('image_replace') : label('image_upload')}
        </button>
        {imageUrl && (
          <button
            type="button"
            onClick={() => setConfirmingRemove(true)}
            disabled={blocked || busy !== null}
            title={disabled ? disabledTitle : undefined}
            style={btnSmall('#888')}
          >
            {busy === 'remove' ? label('image_removing') : label('image_remove')}
          </button>
        )}
      </div>
      {error && <p style={{ margin: '6px 0 0', fontSize: 12, color: alertTextColor }}>{error}</p>}

      <ConfirmDialog
        open={confirmingRemove}
        message={label('image_confirm_remove')}
        confirmLabel={label('image_remove')}
        cancelLabel={label('cancel')}
        busy={busy === 'remove'}
        onConfirm={() => { setConfirmingRemove(false); handleRemove(); }}
        onCancel={() => setConfirmingRemove(false)}
      />
    </div>
  );
}
