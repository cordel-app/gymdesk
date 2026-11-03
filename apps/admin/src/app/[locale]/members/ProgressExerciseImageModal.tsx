'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import type { ProgressSummary } from './progressView';

/**
 * #2295 — clicking an exercise thumbnail on the Member's Progress tab. Shows the full-size
 * image (`image_url`, already resolved by the API for the member's sex, never the thumbnail)
 * with its aspect ratio kept, and the complete description below. Both are optional.
 */
export function ProgressExerciseImageModal({ exercise, onClose }: { exercise: ProgressSummary | null; onClose: () => void }) {
  const t = useTranslations('members');
  const [broken, setBroken] = useState(false);
  if (!exercise) return null;
  const src = exercise.image_url ?? null;
  const showImage = !!src && SAFE_IMAGE_SRC.test(src) && !broken;
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div role="dialog" aria-label={exercise.exercise_name} style={{ ...modalStyle, width: 'min(1112px, 94vw)', maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 12px' }}>{exercise.exercise_name}</h2>
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src!} alt={exercise.exercise_name} onError={() => setBroken(true)}
            style={{ display: 'block', width: '100%', maxWidth: 1080, height: 'auto', margin: '0 auto' }} />
        ) : (
          <p style={{ color: '#666', fontSize: 14 }}>{t('progress_no_image')}</p>
        )}
        <p style={{ margin: '16px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>
          {exercise.description?.trim() ? exercise.description : t('progress_no_description')}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" onClick={onClose} style={btnStyle('#444')}>{t('progress_close')}</button>
        </div>
      </div>
    </div>
  );
}
