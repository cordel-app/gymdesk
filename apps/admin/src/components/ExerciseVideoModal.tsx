'use client';

import React, { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { btnStyle, modalStyle, overlayStyle } from './ui';
import { youtubeVideoId } from './exerciseMedia';

/**
 * #2199 — an exercise video plays in a modal over the current page instead of
 * opening a new browser tab. A YouTube link is embedded; any other URL (an MP4
 * in the bucket) plays in a native `<video>` with its own controls. The player
 * mounts only while the modal is open, so no video is downloaded to draw a row.
 */
export function ExerciseVideoModal({ url, title, onClose }: {
  url: string;
  title?: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const youtubeId = youtubeVideoId(url);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const label = title ? t('exercise_media.play_video_of', { name: title }) : t('exercise_media.play_video');

  return (
    <div style={overlayStyle} onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{ ...modalStyle, width: 720, padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>{title}</h2>}
        {youtubeId ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1`}
            title={label}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            style={{ width: '100%', aspectRatio: '16 / 9', border: 0, borderRadius: 8, background: '#000' }}
          />
        ) : (
          <video
            src={url}
            controls
            autoPlay
            playsInline
            style={{ width: '100%', maxHeight: '70vh', borderRadius: 8, background: '#000' }}
          />
        )}
        <div style={{ display: 'flex', marginTop: 16 }}>
          <button type="button" onClick={onClose} style={btnStyle('#aaa')}>{t('exercise_media.close_video')}</button>
        </div>
      </div>
    </div>
  );
}
