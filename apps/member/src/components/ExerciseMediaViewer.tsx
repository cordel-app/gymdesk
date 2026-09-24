'use client';

import React, { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { youtubeEmbedUrl } from '@/lib/exerciseMedia';

/**
 * #723 — the larger views a member gets when they select an exercise's image or
 * video inside My Training Plan.
 *
 * Both are overlays on top of the plan rather than a route: the member never
 * leaves My Training Plan, so closing the viewer puts them back exactly where
 * they were, at the same scroll position and with the same day selected. The
 * Member app has no dialog component and no modal library (its dependencies are
 * Next, next-intl, Clerk and FullCalendar), so the shell below is the dialog
 * pattern the app already uses in `MemberImpersonationDialog`, plus the three
 * things a media viewer owes the member: Escape closes it, the close button
 * takes focus when it opens, and the element that opened it takes focus back
 * when it closes.
 */

function MediaOverlay({ label, onClose, children }: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKeyDown);

    // The plan behind the overlay must not scroll under the member's finger.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      style={styles.backdrop}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div style={styles.panel}>
        <div style={styles.panelHead}>
          <span style={styles.panelTitle}>{label}</span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('exercise_media.close')}
            style={styles.closeBtn}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ExerciseImageViewer({ src, name, onClose }: {
  src: string;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  return (
    <MediaOverlay label={t('exercise_media.image_alt', { name })} onClose={onClose}>
      <img src={src} alt={t('exercise_media.image_alt', { name })} style={styles.image} />
    </MediaOverlay>
  );
}

/**
 * The video itself — the first point at which anything is downloaded, because
 * this component only exists once the member has selected it (§Performance).
 * Neither player autoplays: the member presses play inside the viewer.
 */
export function ExerciseVideoViewer({ url, poster, name, onClose }: {
  url: string;
  poster?: string | null;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const embed = youtubeEmbedUrl(url);
  const label = t('exercise_media.video_of', { name });

  return (
    <MediaOverlay label={label} onClose={onClose}>
      {embed ? (
        <iframe
          src={embed}
          title={label}
          allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          style={styles.frame}
        />
      ) : (
        <video
          src={url}
          poster={poster ?? undefined}
          controls
          preload="metadata"
          playsInline
          style={styles.video}
        />
      )}
    </MediaOverlay>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 1000 },
  panel:      { background: '#fff', borderRadius: 12, padding: 12, width: '100%', maxWidth: 720, maxHeight: '90vh', overflow: 'auto' },
  panelHead:  { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  panelTitle: { flex: 1, fontSize: 14, fontWeight: 600, color: '#18181b' },
  closeBtn:   { width: 44, height: 44, borderRadius: '50%', border: '1px solid #e4e4e7', background: '#fff', color: '#18181b', fontSize: 18, lineHeight: 1, cursor: 'pointer', flex: '0 0 auto' },
  image:      { display: 'block', width: '100%', height: 'auto', maxHeight: '75vh', objectFit: 'contain' },
  video:      { display: 'block', width: '100%', maxHeight: '75vh', background: '#000', borderRadius: 8 },
  frame:      { display: 'block', width: '100%', aspectRatio: '16 / 9', border: 'none', borderRadius: 8, background: '#000' },
};
