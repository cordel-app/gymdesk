'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { btnSmall } from './ui';

/**
 * #417 stages 2-3: generic per-gym image upload widget backed by
 * POST /storage/uploads/:target. Replaces plain URL text inputs for image
 * fields (exercises.image_url, nutrition_library_items.image_url).
 */
interface ImageUploadFieldProps {
  uploadPath: string;
  value: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
}

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function ImageUploadField({ uploadPath, value, onChange, disabled }: ImageUploadFieldProps) {
  const t = useTranslations('common');
  const { apiFetch } = useApiClient();
  const { activeGym } = useGym();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notConfigured = activeGym != null && !activeGym.storage_configured;
  const notInitialized = activeGym != null && activeGym.storage_configured && !activeGym.storage_folder_prefix;
  const uploadBlocked = disabled || notConfigured || notInitialized;

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError(t('image_invalid_type'));
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const result = await apiFetch<{ url: string }>(uploadPath, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      onChange(result.url);
    } catch (err: any) {
      setError(err.message ?? t('image_upload_error'));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      {value && (
        <div style={{ marginBottom: 8 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="" style={{ maxWidth: 160, maxHeight: 120, borderRadius: 6, border: '1px solid #ddd', display: 'block', objectFit: 'contain' }} />
        </div>
      )}

      {(notConfigured || notInitialized) && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#c0392b' }}>
          {notConfigured ? t('image_not_configured') : t('image_not_initialized')}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_TYPES.join(',')}
        style={{ display: 'none' }}
        onChange={handleFile}
        disabled={uploadBlocked || uploading}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploadBlocked || uploading}
          style={btnSmall('#6c63ff')}
        >
          {uploading ? t('image_uploading') : value ? t('image_replace') : t('image_upload')}
        </button>
        {value && (
          <button type="button" onClick={() => onChange(null)} disabled={disabled || uploading} style={btnSmall('#888')}>
            {t('image_remove')}
          </button>
        )}
      </div>
      {error && <p style={{ margin: '6px 0 0', fontSize: 12, color: '#c0392b' }}>{error}</p>}
    </div>
  );
}
