'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { btnSmall, primaryBtnSmall } from './ui';
import { ConfirmDialog } from './ConfirmDialog';
import { imagePreviewFrameStyle, imagePreviewImageStyle } from './imagePreviewFrame';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { MUSCLE_IMAGE_ACCEPT, isPreparedMuscleImage, prepareMuscleImage } from '@/lib/muscleImageUpload';

/**
 * One sex's image of a muscle (#1412): the current picture, Upload/Replace and
 * Remove, acting on the server straight away (`POST`/`DELETE
 * <basePath>/:id/image/:sex`). Male and female are two instances, so each is
 * uploaded, replaced and removed independently. The file is sent as picked (#1413). The control resolves nothing:
 * it draws what the muscle references for this sex, and never the other sex's.
 */
interface MuscleImageFieldProps {
  muscleId: number;
  sex: 'male' | 'female';
  imageUrl: string | null;
  thumbnailUrl: string | null;
  basePath: string;
  onChanged: (muscle: unknown) => void;
}

export function MuscleImageField({ muscleId, sex, imageUrl, thumbnailUrl, basePath, onChanged }: MuscleImageFieldProps) {
  const t = useTranslations('muscles_page');
  const { apiFetch, uploadFetch } = useApiClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const preview = thumbnailUrl ?? imageUrl;
  const drawable = preview != null && SAFE_IMAGE_SRC.test(preview);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy('upload');
    try {
      const prepared = prepareMuscleImage(file);
      if (!isPreparedMuscleImage(prepared)) {
        setError(t(prepared));
        return;
      }
      // The picture goes up as picked; the server makes the master and the thumbnail (#1413).
      const updated = await uploadFetch(`${basePath}/${muscleId}/image/${sex}`, prepared);
      onChanged(updated);
    } catch (err: any) {
      setError(err.message ?? t('image_error_upload_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setError(null);
    setBusy('remove');
    try {
      onChanged(await apiFetch(`${basePath}/${muscleId}/image/${sex}`, { method: 'DELETE' }));
    } catch (err: any) {
      setError(err.message ?? t('image_error_remove_failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div style={imagePreviewFrameStyle()}>
        {drawable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview!} alt="" loading="lazy" style={imagePreviewImageStyle} />
        ) : (
          <span style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: 8 }}>{t('image_none')}</span>
        )}
      </div>
      <input ref={inputRef} type="file" accept={MUSCLE_IMAGE_ACCEPT} style={{ display: 'none' }} onChange={handleFile} disabled={busy !== null} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy !== null} style={primaryBtnSmall()}>
          {busy === 'upload' ? t('image_uploading') : preview ? t('image_replace') : t('image_upload')}
        </button>
        {preview && (
          <button type="button" onClick={() => setConfirmingRemove(true)} disabled={busy !== null} style={btnSmall('#888')}>
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
