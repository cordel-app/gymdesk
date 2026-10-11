'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { gymStorageBlock } from '@/lib/gymStorageReadiness';
import { btnSmall, primaryBtnSmall } from '@/components/ui';
import { alertTextColor, formHelpTextStyle } from '@/components/formChrome';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { MemberImagePreview, memberImagePreviewSrc } from '@/components/MemberImageField';
import {
  ACTIVITY_IMAGE_ACCEPT,
  isPreparedActivityImage,
  prepareActivityImage,
} from '@/lib/activityImageUpload';

/**
 * #1373 — an Activity Type's image, in the two moments the form needs it
 * (`MemberImageField`'s arrangement, #1374, one entity over; the preview is the
 * same shared 1:1 frame).
 *
 * **`immediate`** is the Edit-mode control: upload and removal act on the server
 * straight away (`POST`/`DELETE /activity-types/:id/image`) and hand the page the
 * row that came back. **`staged`** is the create form's: the id does not exist
 * until the activity is saved, so the prepared file is held and the page uploads
 * it right after `POST /activity-types` succeeds.
 */
export type ActivityImageTarget =
  | {
      kind: 'immediate';
      activityId: number;
      imageUrl: string | null;
      /** `modified_at` — the cache-buster, since the key is deterministic. */
      stamp: string | null | undefined;
      onChanged: (activity: unknown) => void;
      /** A file whose upload failed right after creation: shown with its error and a Retry. */
      retry?: { file: Blob; error: string } | null;
      onRetryConsumed?: () => void;
    }
  | {
      kind: 'staged';
      file: Blob | null;
      onFile: (file: Blob | null) => void;
    };

export function ActivityImageField({
  target, disabled, disabledTitle, label,
}: {
  target: ActivityImageTarget;
  disabled?: boolean;
  disabledTitle?: string;
  /** Resolves a key in the `activity_types` namespace. */
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

  async function uploadBlob(blob: Blob, activityId: number, onChanged: (a: unknown) => void) {
    setBusy('upload');
    try {
      // `uploadFetch`, never a hand-rolled fetch: the Next proxy cannot invent `x-gym-id` (#824).
      const updated = await uploadFetch(`/activity-types/${activityId}/image`, blob);
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
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy('prepare');
    const prepared = await prepareActivityImage(file);
    setBusy(null);
    if (!isPreparedActivityImage(prepared)) {
      setError(label(prepared));
      return;
    }
    if (target.kind === 'staged') { target.onFile(prepared); return; }
    await uploadBlob(prepared, target.activityId, target.onChanged);
  }

  async function handleRemove() {
    setError(null);
    if (target.kind === 'staged') { target.onFile(null); return; }
    setBusy('remove');
    try {
      const updated = await apiFetch(`/activity-types/${target.activityId}/image`, { method: 'DELETE' });
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

      {/* Disabled together with the button: a disabled button alone is still reachable (#823). */}
      <input
        ref={inputRef}
        type="file"
        accept={ACTIVITY_IMAGE_ACCEPT}
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
            onClick={() => uploadBlob(target.retry!.file, target.activityId, target.onChanged)}
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
