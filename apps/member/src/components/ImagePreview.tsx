'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MemberDialog } from './MemberDialog';
import { memberTheme, secondaryButtonStyle } from '@/lib/memberChrome';

/**
 * #1878 — the Members App's one enlarged-image preview.
 *
 * `ImagePreviewButton` wraps a thumbnail the caller already drew and opens a
 * `MemberDialog` with the picture at its natural aspect ratio (never stretched)
 * and its description underneath. Dietary restrictions, goals and foods all use
 * it, so the preview cannot drift between sections. It renders the strings it is
 * handed and resolves nothing but its own close label; with no `src` it renders
 * its children untouched (nothing to enlarge).
 */
export function ImagePreviewButton({ src, alt, title, description = null, children, style }: {
  src: string | null | undefined;
  alt: string;
  title: string;
  description?: string | null;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);

  const titleId = `image-preview-${React.useId()}`;

  if (!src) return <>{children}</>;

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        aria-label={t('nutrition.image_preview_open', { name: title })}
        style={{ ...styles.trigger, ...style }}
      >
        {children}
      </button>
      {open && (
        <MemberDialog
          title={title}
          labelledBy={titleId}
          onClose={() => setOpen(false)}
          actions={
            <button type="button" onClick={() => setOpen(false)} style={{ ...secondaryButtonStyle, padding: '8px 16px', cursor: 'pointer' }}>
              {t('nutrition.image_preview_close')}
            </button>
          }
        >
          {broken ? (
            <p style={styles.description}>{t('nutrition.no_image')}</p>
          ) : (
            <img src={src} alt={alt} style={styles.image} onError={() => setBroken(true)} />
          )}
          {description && <p style={styles.description}>{description}</p>}
        </MemberDialog>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  trigger: { padding: 0, margin: 0, border: 'none', background: 'none', cursor: 'zoom-in', font: 'inherit', color: 'inherit', display: 'block', width: '100%', height: '100%' },
  image: { width: '100%', maxHeight: '60vh', objectFit: 'contain', display: 'block', borderRadius: 8, background: memberTheme.pageBackground },
  description: { margin: 0, fontSize: 14, color: memberTheme.textSecondary, overflowWrap: 'anywhere' },
};
