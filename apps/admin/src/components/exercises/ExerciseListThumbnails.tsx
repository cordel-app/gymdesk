'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { overlayStyle, modalStyle } from '@/components/ui';
import { type ExerciseGenderMediaValues } from '@/lib/exerciseGenderMedia';

const SIZE = 28;

const thumbStyle: React.CSSProperties = {
  width: SIZE, height: SIZE, borderRadius: '50%', objectFit: 'cover', flexShrink: 0,
  background: 'var(--gd-app-bg, #f3f4f6)', border: '1px solid var(--gd-card-border, #e5e7eb)', boxSizing: 'border-box',
};

/** #2220: the full-size image behind a thumbnail, shown in a modal. Falls back to the thumbnail when no master exists (muscle fallback). */
function FullSizeModal({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const t = useTranslations('exercises');
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <div style={{ ...modalStyle, width: 'auto', padding: 16, position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button type="button" aria-label={t('close_image')} onClick={onClose}
          style={{ position: 'absolute', top: 4, right: 8, border: 'none', background: 'transparent', fontSize: 20, cursor: 'pointer', color: 'inherit' }}>×</button>
        {broken ? (
          <p style={{ margin: 24 }}>{t('image_unavailable')}</p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={label} onError={() => setBroken(true)}
            style={{ display: 'block', width: 'min(1080px, 90vw)', maxHeight: '85vh', aspectRatio: '1 / 1', objectFit: 'contain' }} />
        )}
      </div>
    </div>
  );
}

function Thumb({ src, full, label }: { src: string | null; full?: string | null; label: string }) {
  const [broken, setBroken] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const show = !!src && SAFE_IMAGE_SRC.test(src) && !broken;
  if (show) {
    const big = full && SAFE_IMAGE_SRC.test(full) ? full : src!;
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src!} alt={label} title={label} loading="lazy" onError={() => setBroken(true)}
          onClick={(e) => { e.stopPropagation(); setOpen(true); }} style={{ ...thumbStyle, cursor: 'zoom-in' }} />
        {open && <FullSizeModal src={big} label={label} onClose={() => setOpen(false)} />}
      </>
    );
  }
  // Neutral placeholder: a missing variant never hides the other one.
  return <span role="img" aria-label={label} title={label} style={{ ...thumbStyle, display: 'inline-block' }} />;
}

/**
 * The male and female thumbnails shown before an exercise's name in the Base
 * Exercises and Exercises lists (#1561). Presentation only: it draws the two
 * thumbnails the API reports. Since #1704 each position has already fallen back,
 * on its own, to the primary muscle's image of that sex (server-side).
 */
export function ExerciseListThumbnails({ exercise }: {
  exercise: ExerciseGenderMediaValues & {
    effective_image_male_thumbnail_url?: string | null;
    effective_image_female_thumbnail_url?: string | null;
  };
}) {
  const t = useTranslations('exercises');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <Thumb src={exercise.effective_image_male_thumbnail_url ?? exercise.image_male_thumbnail_url ?? null} full={exercise.image_male_url} label={t('gender_male')} />
      <Thumb src={exercise.effective_image_female_thumbnail_url ?? exercise.image_female_thumbnail_url ?? null} full={exercise.image_female_url} label={t('gender_female')} />
    </span>
  );
}
