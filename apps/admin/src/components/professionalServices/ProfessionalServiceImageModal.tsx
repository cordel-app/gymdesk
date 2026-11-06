'use client';

import React, { useState } from 'react';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';

export interface ProfessionalServiceImageTarget {
  name: string;
  /** Full-size image (never the thumbnail). */
  imageUrl: string | null | undefined;
  /** Already resolved for the current locale by the API. */
  description: string | null | undefined;
  version?: string | null;
}

/**
 * #2297 — clicking a Professional Service image (Members → Professional Services,
 * the gym's Professional Services and Cordel's Base ones). One modal for all three:
 * the full-size image with its aspect ratio kept, then the complete description.
 * Both are optional; labels come from the caller's namespace.
 */
export function ProfessionalServiceImageModal({ target, onClose, closeLabel, noImageLabel, noDescriptionLabel, children }: {
  target: ProfessionalServiceImageTarget | null;
  onClose: () => void;
  closeLabel: string;
  noImageLabel: string;
  noDescriptionLabel: string;
  /** #2408: extra detail under the description (a plan's pricing, billing, products). */
  children?: React.ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  React.useEffect(() => { setBroken(false); }, [target?.imageUrl]);
  React.useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, onClose]);
  if (!target) return null;
  const src = target.imageUrl ?? null;
  const showImage = !!src && SAFE_IMAGE_SRC.test(src) && !broken;
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={target.name}
        style={{ ...modalStyle, width: 'min(1112px, 94vw)', maxHeight: '92vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 12px' }}>{target.name}</h2>
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`${src}${src!.includes('?') ? '&' : '?'}v=${encodeURIComponent(target.version ?? '')}`}
            alt={target.name} onError={() => setBroken(true)}
            style={{ display: 'block', width: '100%', maxWidth: 1080, height: 'auto', margin: '0 auto' }} />
        ) : (
          <p style={{ color: '#666', fontSize: 14 }}>{noImageLabel}</p>
        )}
        <p style={{ margin: '16px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>
          {target.description?.trim() ? target.description : noDescriptionLabel}
        </p>
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" onClick={onClose} style={btnStyle('#444')}>{closeLabel}</button>
        </div>
      </div>
    </div>
  );
}
