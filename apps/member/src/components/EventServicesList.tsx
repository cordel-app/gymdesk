'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ImagePreviewButton } from './ImagePreview';
import { ActivityMetaIcon } from './ActivityMetaIcon';
import { memberTheme } from '@/lib/memberChrome';
import type { ServiceChoice } from '@/lib/serviceSelection';

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

/**
 * #2587 — `bookedId` shows only the service the member's booking used, with a
 * `Booked` chip; `choose` makes each row a selectable option with its balance
 * (a zero balance is disabled) and the validation line above the action.
 */
export interface ServiceChooser {
  choices: ServiceChoice[];
  chosenId: number | null;
  onChoose: (id: number) => void;
}

export function EventServicesList({ services, bookedId = null, choose = null }: {
  services: EventService[] | null | undefined;
  bookedId?: number | null;
  choose?: ServiceChooser | null;
}) {
  const t = useTranslations('event_services');
  if (!services || services.length === 0) return null;
  if (bookedId != null) {
    const used = services.find((s) => s.id === bookedId);
    if (used) services = [used]; else bookedId = null;
  }
  return (
    <div style={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <div style={styles.title}>
        <ActivityMetaIcon name="service" size={15} />
        <span>{t('title')}</span>
      </div>
      <div role={choose ? 'radiogroup' : undefined} aria-label={choose ? t('title') : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
        const choice = choose?.choices.find((c) => c.id === s.id) ?? null;
        const selected = !!choose && choose.chosenId === s.id;
        const rowEl = (
          <>
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
            {bookedId != null && <span style={styles.chip}>{t('booked')}</span>}
            {choice ? (
              <span style={styles.capacity}>{choice.balance == null ? '' : t('balance', { n: choice.balance })}</span>
            ) : (
              <span style={styles.capacity}>{t('capacity', { n: s.capacity })}</span>
            )}
          </>
        );
        if (!choose || !choice) return <div key={s.id} style={styles.row}>{rowEl}</div>;
        return (
          <div
            key={s.id}
            role="radio"
            aria-checked={selected}
            aria-disabled={choice.disabled}
            tabIndex={choice.disabled ? -1 : 0}
            onClick={() => { if (!choice.disabled) choose.onChoose(s.id); }}
            onKeyDown={(e) => { if (!choice.disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose.onChoose(s.id); } }}
            style={{
              ...styles.row, ...styles.option,
              ...(selected ? styles.optionSelected : null),
              ...(choice.disabled ? styles.optionDisabled : null),
            }}
          >
            {rowEl}
          </div>
        );
      })}
      </div>
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
  chip: { flex: '0 0 auto', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: memberTheme.pageBackground, color: memberTheme.textSecondary, border: `1px solid ${memberTheme.separator}` },
  option: { padding: 8, borderRadius: 10, border: `1px solid ${memberTheme.separator}`, cursor: 'pointer' },
  optionSelected: { borderColor: memberTheme.primaryButton, boxShadow: `0 0 0 2px ${memberTheme.primaryButton}` },
  optionDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  capacity: { flex: '0 0 auto', fontSize: 13, color: memberTheme.textSecondary, whiteSpace: 'nowrap' },
};
