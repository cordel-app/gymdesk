'use client';

import React, { useRef, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { gymStorageBlock } from '@/lib/gymStorageReadiness';
import { primaryBtnSmall } from '@/components/ui';
import { alertTextColor, formHelpTextStyle, secondaryBtnSmall } from '@/components/formChrome';
import { ACTIVITY_IMAGE_ACCEPT, isPreparedActivityImage, prepareActivityImage } from '@/lib/activityImageUpload';

/**
 * #1382 — the image under a Calendar Event's title: the event's own image, else
 * its Activity's, else a placeholder. Which one shows is the API's
 * (`effective_image_url`, `calendarEventImages.ts`); this only draws it and,
 * for staff who may write, uploads or removes the **event's own** override
 * (`POST`/`DELETE /class-sessions/:id/image`). The Activity's image is never
 * written from here, and a failed replacement leaves the previous image because
 * the server only repoints the row after the upload succeeded.
 */
export function EventImageControl({
  sessionId, effectiveUrl, ownUrl, stamp, canEdit, onChanged, label,
}: {
  sessionId: number;
  effectiveUrl: string | null;
  /** The event's own override; Remove is offered only while there is one. */
  ownUrl: string | null;
  /** `modified_at` — the cache-buster, since the key is deterministic. */
  stamp: string | null | undefined;
  canEdit: boolean;
  onChanged: () => void;
  /** Resolves a key in the `calendar` namespace. */
  label: (key: string) => string;
}) {
  const { apiFetch, uploadFetch } = useApiClient();
  const { activeGym } = useGym();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'prepare' | 'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const storageBlock = gymStorageBlock(activeGym, true);
  const blocked = storageBlock !== null;
  const src = effectiveUrl
    ? `${effectiveUrl}${stamp ? `${effectiveUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(stamp))}` : ''}`
    : null;

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy('prepare');
    const prepared = await prepareActivityImage(file);
    if (!isPreparedActivityImage(prepared)) {
      setBusy(null);
      setError(label(prepared));
      return;
    }
    setBusy('upload');
    try {
      await uploadFetch(`/class-sessions/${sessionId}/image`, prepared);
      onChanged();
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
      await apiFetch(`/class-sessions/${sessionId}/image`, { method: 'DELETE' });
      onChanged();
    } catch (err: any) {
      setError(err.message ?? label('image_error_remove_failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div
        style={{
          width: '100%', aspectRatio: '16 / 9', maxHeight: 180, overflow: 'hidden', borderRadius: 8,
          background: 'var(--gd-bg, #f3f4f6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: 12, color: '#6b7280' }}>{label('event_image_none')}</span>
        )}
      </div>
      {canEdit && (
        <div style={{ marginTop: 8 }}>
          {blocked && (
            <p style={{ margin: '0 0 8px', fontSize: 12, color: alertTextColor }}>
              {storageBlock === 'not_configured' ? label('image_not_configured') : label('image_not_initialized')}
            </p>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={ACTIVITY_IMAGE_ACCEPT}
            style={{ display: 'none' }}
            onChange={handleFile}
            disabled={blocked || busy !== null}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={blocked || busy !== null}
              style={{ ...primaryBtnSmall(), opacity: blocked || busy !== null ? 0.6 : 1 }}
            >
              {busy === 'prepare' || busy === 'upload' ? label('event_image_uploading') : label('event_image_upload')}
            </button>
            {ownUrl && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={busy !== null}
                style={{ ...secondaryBtnSmall, opacity: busy !== null ? 0.6 : 1 }}
              >
                {busy === 'remove' ? label('event_image_removing') : label('event_image_remove')}
              </button>
            )}
          </div>
          <p style={{ ...formHelpTextStyle, margin: '6px 0 0' }}>{label('event_image_help')}</p>
          {error && <p style={{ margin: '6px 0 0', fontSize: 12, color: alertTextColor }} role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
