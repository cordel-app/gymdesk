'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ImagePreviewButton } from './ImagePreview';
import { ActivityMetaIcon } from './ActivityMetaIcon';
import { memberTheme } from '@/lib/memberChrome';

/**
 * #2500 — the Professional Services an event accepts, each with its own
 * circular thumbnail and its own capacity. My Bookings and the Calendar sheet
 * render this one component. The list and every capacity are the API's
 * (`professional_services` on `/me/schedule` and `/me/bookings`): nothing here
 * sums or substitutes the event's total. Renders nothing for an empty list.
 */
export interface EventService {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  capacity: number;
}

const SIZE = 40;

export function EventServicesList({ services }: { services: EventService[] | null | undefined }) {
  const t = useTranslations('event_services');
  if (!services || services.length === 0) return null;
  return (
    <div style={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <div style={styles.title}>
        <ActivityMetaIcon name="service" size={15} />
        <span>{t('title')}</span>
      </div>
      {services.map((s) => {
        const thumb = (s.image_thumbnail_url || s.image_url || '').trim();
        const full = (s.image_url || s.image_thumbnail_url || '').trim();
        const circle = thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" style={styles.img} />
        ) : (
          <span style={styles.placeholder} role="img" aria-label={t('no_image')}>
            <ActivityMetaIcon name="service" size={18} />
          </span>
        );
        return (
          <div key={s.id} style={styles.row}>
            <div style={styles.thumb}>
              {full ? (
                <ImagePreviewButton
                  src={full}
                  alt={t('image_alt', { name: s.name })}
                  title={s.name}
                  description={s.description?.trim() || null}
                  style={{ width: SIZE, height: SIZE, borderRadius: '50%', overflow: 'hidden' }}
                >
                  {circle}
                </ImagePreviewButton>
              ) : circle}
            </div>
            <span style={styles.name}>{s.name}</span>
            <span style={styles.capacity}>{t('capacity', { n: s.capacity })}</span>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0' },
  title: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: memberTheme.textMuted },
  row: { display: 'flex', alignItems: 'center', gap: 10 },
  thumb: { width: SIZE, height: SIZE, flex: '0 0 auto', borderRadius: '50%', overflow: 'hidden' },
  img: { width: SIZE, height: SIZE, objectFit: 'cover', display: 'block', borderRadius: '50%' },
  placeholder: { width: SIZE, height: SIZE, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: memberTheme.pageBackground, color: memberTheme.textMuted },
  name: { flex: 1, minWidth: 0, fontSize: 14, color: memberTheme.text, overflowWrap: 'anywhere' },
  capacity: { flex: '0 0 auto', fontSize: 13, color: memberTheme.textSecondary, whiteSpace: 'nowrap' },
};
