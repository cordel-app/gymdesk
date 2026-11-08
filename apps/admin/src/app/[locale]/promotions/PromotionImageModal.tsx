'use client';

import React, { useState } from 'react';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';

/**
 * #2410 — clicking a Promotion's image in the listing. The full-size (1080 × 1080)
 * image with its aspect ratio kept, then whatever the page passes as `children`:
 * the Promotion's own Session / One-off / Periodical sections, drawn by the same
 * ProductBenefitView the card uses so the modal cannot disagree with it.
 */
export function PromotionImageModal({ name, imageUrl, version, onClose, closeLabel, noImageLabel, children }: {
  name: string;
  /** Full-size image (never the thumbnail). */
  imageUrl: string | null | undefined;
  version?: string | null;
  onClose: () => void;
  closeLabel: string;
  noImageLabel: string;
  children?: React.ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  React.useEffect(() => { setBroken(false); }, [imageUrl]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const src = imageUrl ?? null;
  const showImage = !!src && SAFE_IMAGE_SRC.test(src) && !broken;
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={name}
        style={{ ...modalStyle, width: 'min(1112px, 94vw)', maxHeight: '92vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 12px' }}>{name}</h2>
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`${src}${src!.includes('?') ? '&' : '?'}v=${encodeURIComponent(version ?? '')}`}
            alt={name} onError={() => setBroken(true)}
            style={{ display: 'block', width: '100%', maxWidth: 1080, height: 'auto', margin: '0 auto' }} />
        ) : (
          <p style={{ color: '#666', fontSize: 14 }}>{noImageLabel}</p>
        )}
        <div style={{ marginTop: 16 }}>{children}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" onClick={onClose} style={btnStyle('#444')}>{closeLabel}</button>
        </div>
      </div>
    </div>
  );
}
