'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { gymStorageBlock } from '@/lib/gymStorageReadiness';
import { btnSmall, primaryBtnSmall } from '@/components/ui';
import { alertTextColor, formHelpTextStyle } from '@/components/formChrome';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  IMAGE_PREVIEW_FRAME_SIZE,
  imagePreviewFrameStyle,
  imagePreviewImageStyle,
} from '@/components/imagePreviewFrame';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import {
  MEMBER_IMAGE_ACCEPT,
  isPreparedMemberImage,
  prepareMemberImage,
} from '@/lib/memberImageUpload';

/**
 * #1374 — a Member's profile image, in the two moments the Member card needs it.
 *
 * **`immediate`** is the Edit-mode control, `GoalImageField`'s arrangement
 * (#1035): the upload and the removal act on the server straight away
 * (`POST`/`DELETE /members/:id/image`) and hand the page the row that came back,
 * so the surrounding `PUT` neither carries nor can undo them — the object key is
 * built from the member's id, which is why nothing can be uploaded for a Member
 * who does not exist yet.
 *
 * **`staged`** is the create form's: the id does not exist until the Member is
 * saved (#1374 §2), so the picked file is prepared, previewed and *held*, and the
 * page uploads it right after `POST /members` succeeds. A staged file is never
 * sent from here.
 *
 * What differs from the goal control is what the browser does to the file:
 * staff pick any photograph, and `prepareMemberImage()` crops and scales it to
 * the one 512 × 512 PNG the server accepts, so the control's own checks are
 * about decodability rather than about size. The server still re-reads the
 * signature and the dimensions from the bytes (#715 §8).
 *
 * The chrome is shared: the preview frame (`imagePreviewFrame.ts`), the storage
 * block (`gymStorageBlock()`, #823, disabling the hidden `<input>` together with
 * the button), the Theme's primary button (#912/#954) and the app's one red.
 */
export type MemberImageTarget =
  | {
      kind: 'immediate';
      memberId: number;
      imageUrl: string | null;
      /** `modified_at` — the cache-buster, since the key is deterministic. */
      stamp: string | null | undefined;
      /** The Member as the API returned it after the change. */
      onChanged: (member: unknown) => void;
      /**
       * A file whose upload failed right after the Member was created (#1374
       * §2): shown with its error and a Retry, so creating the Member did not
       * silently discard the failure or the file.
       */
      retry?: { file: Blob; error: string } | null;
      onRetryConsumed?: () => void;
    }
  | {
      kind: 'staged';
      file: Blob | null;
      onFile: (file: Blob | null) => void;
    };

export function MemberImageField({
  target, disabled, disabledTitle, label,
}: {
  target: MemberImageTarget;
  disabled?: boolean;
  disabledTitle?: string;
  /** Resolves a key in the `members` namespace (#901). */
  label: (key: string) => string;
}) {
  const { apiFetch, uploadFetch } = useApiClient();
  const { activeGym } = useGym();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'prepare' | 'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const storageBlock = gymStorageBlock(activeGym, true);
  const notConfigured = storageBlock === 'not_configured';
  const notInitialized = storageBlock === 'not_initialized';
  const blocked = disabled || notConfigured || notInitialized;

  // A staged file is previewed from an object URL of its own, released when it
  // is replaced or the control unmounts.
  const stagedFile = target.kind === 'staged' ? target.file : null;
  const [stagedSrc, setStagedSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!stagedFile) { setStagedSrc(null); return; }
    const url = URL.createObjectURL(stagedFile);
    setStagedSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [stagedFile]);

  const hasImage = target.kind === 'staged' ? !!target.file : !!target.imageUrl;
  const shownError = error ?? (target.kind === 'immediate' ? target.retry?.error ?? null : null);

  async function uploadBlob(blob: Blob, memberId: number, onChanged: (m: unknown) => void) {
    setBusy('upload');
    try {
      // `uploadFetch` rather than a hand-rolled fetch against the Next proxy:
      // that proxy forwards `x-gym-id` but cannot invent it (#824).
      const updated = await uploadFetch(`/members/${memberId}/image`, blob);
      onChanged(updated);
      if (target.kind === 'immediate') target.onRetryConsumed?.();
    } catch (err: any) {
      setError(err.message ?? label('image_error_upload_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared so picking the same file twice still fires `onChange`.
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy('prepare');
    const prepared = await prepareMemberImage(file);
    setBusy(null);
    if (!isPreparedMemberImage(prepared)) {
      // Nothing is sent, so the image already on the member is untouched.
      setError(label(prepared));
      return;
    }
    if (target.kind === 'staged') {
      target.onFile(prepared);
      return;
    }
    await uploadBlob(prepared, target.memberId, target.onChanged);
  }

  async function handleRemove() {
    setError(null);
    if (target.kind === 'staged') {
      target.onFile(null);
      return;
    }
    setBusy('remove');
    try {
      const updated = await apiFetch(`/members/${target.memberId}/image`, { method: 'DELETE' });
      target.onChanged(updated);
    } catch (err: any) {
      setError(err.message ?? label('image_error_remove_failed'));
    } finally {
      setBusy(null);
    }
  }

  const previewSrc = target.kind === 'staged'
    ? stagedSrc
    : memberImagePreviewSrc(target.imageUrl, target.stamp);

  return (
    <div>
      <MemberImagePreview src={previewSrc} emptyLabel={label('image_none')} />

      <p style={{ ...formHelpTextStyle, margin: '8px 0 6px' }}>
        {target.kind === 'staged' && target.file ? label('image_staged') : label('image_requirements')}
      </p>

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
        accept={MEMBER_IMAGE_ACCEPT}
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
          style={primaryBtnSmall()}
        >
          {busy === 'upload' || busy === 'prepare'
            ? label('image_uploading')
            : hasImage ? label('image_replace') : label('image_upload')}
        </button>
        {target.kind === 'immediate' && target.retry && (
          <button
            type="button"
            onClick={() => uploadBlob(target.retry!.file, target.memberId, target.onChanged)}
            disabled={blocked || busy !== null}
            style={primaryBtnSmall()}
          >
            {label('image_retry')}
          </button>
        )}
        {hasImage && (
          <button
            type="button"
            onClick={() => (target.kind === 'staged' ? handleRemove() : setConfirmingRemove(true))}
            disabled={blocked || busy !== null}
            title={disabled ? disabledTitle : undefined}
            style={btnSmall('#888')}
          >
            {busy === 'remove' ? label('image_removing') : label('image_remove')}
          </button>
        )}
      </div>
      {shownError && <p style={{ margin: '6px 0 0', fontSize: 12, color: alertTextColor }}>{shownError}</p>}

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

/**
 * The stored image's `src`: cache-busted on the row's own `modified_at`,
 * because the object key is deterministic — a replacement rewrites the same key,
 * so without this the browser would keep showing the picture it already has.
 */
export function memberImagePreviewSrc(
  imageUrl: string | null | undefined,
  stamp: string | null | undefined,
): string | null {
  if (!imageUrl) return null;
  return stamp ? `${imageUrl}?v=${encodeURIComponent(stamp)}` : imageUrl;
}

/**
 * The one rendering of a Member's image, for the editor and the read-only
 * Profile alike: the shared 1:1 frame, the picture contained in it, and a
 * placeholder sentence when there is none (never a broken-image icon, #830).
 */
export function MemberImagePreview({
  src, emptyLabel, size = IMAGE_PREVIEW_FRAME_SIZE,
}: { src: string | null; emptyLabel: string; size?: number }) {
  // Only a reference with a drawable scheme is handed to the DOM. Tested inline
  // rather than through a helper call so the guard sits at the sink (#767).
  const drawable = src != null && SAFE_IMAGE_SRC.test(src);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  return (
    <div style={imagePreviewFrameStyle(size)}>
      {drawable && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src!} alt="" loading="lazy" style={imagePreviewImageStyle} onError={() => setFailed(true)} />
      ) : (
        <span style={{ ...formHelpTextStyle, margin: 0, textAlign: 'center', padding: 8 }}>{emptyLabel}</span>
      )}
    </div>
  );
}
