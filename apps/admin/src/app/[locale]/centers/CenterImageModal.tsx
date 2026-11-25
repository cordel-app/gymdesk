'use client';

import React, { useState } from 'react';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { ExerciseInfoFieldRow } from '@/components/exercises/ExerciseInfoModal';

/**
 * #3342 — opened by a Center's thumbnail in the list: the full-size
 * 1080 × 1080 image, then the description in the request locale, drawn with the
 * Exercise description's own row (same icon, same presentation). Labels are the
 * page's; the modal resolves none.
 */
export function CenterImageModal({ name, imageUrl, description, descriptionLabel, closeLabel, onClose }: {
  name: string;
  imageUrl: string | null;
  description: string | null;
  descriptionLabel: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label={name}
        style={{ ...modalStyle, width: 'min(520px, 94vw)', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 12px' }}>{name}</h2>
        {imageUrl && !broken ? (
          <img
            src={imageUrl} alt={name} onError={() => setBroken(true)}
            style={{ display: 'block', width: '100%', height: 'auto', maxHeight: '60vh', objectFit: 'contain', borderRadius: 8, background: '#fafafa' }}
          />
        ) : null}
        {description?.trim() ? (
          <ExerciseInfoFieldRow id="description" label={descriptionLabel}>{description}</ExerciseInfoFieldRow>
        ) : null}
        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" style={btnStyle('#888')} onClick={onClose}>{closeLabel}</button>
        </div>
      </div>
    </div>
  );
}
