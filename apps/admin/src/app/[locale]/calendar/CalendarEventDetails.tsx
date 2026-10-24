'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cardSurfaceStyle } from '@/components/ui';
import { CalendarStatusBadge } from '@/components/CalendarStatusBadge';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDate, formatGymTime } from '@/lib/gymFormat';
import { EventPanelHeader } from './EventPanelChrome';
import { eventDetailRows, eventTimeLines, type CalendarEventView } from './calendarEventView';

/**
 * #1891 stage 3 — the layout both calendar detail panels share: the header
 * (title, date, time range / All day / multi-day), the info card (rows,
 * capacity, status) and nothing else. Presentational: it takes a
 * `CalendarEventView` and decides no permission, names no endpoint and holds
 * no state. What only one kind has — the Activity session's waitlist and
 * eligibility rows, the enrolled list, the actions — is the panel's own and
 * arrives as `children` / is rendered after it, so an unsupported section is
 * absent rather than disabled.
 */
const STATUS_KEYS = ['scheduled', 'not_used', 'completed', 'cancelled', 'draft'];

const cardStyle: React.CSSProperties = {
  ...cardSurfaceStyle,
  background: 'var(--gd-bg, #f9fafb)',
  padding: '12px 14px',
};

/** One `Label: value` row of the info card; an unset value reads `—`. */
export function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ fontSize: 13, marginBottom: 4 }}>
      <span style={{ color: '#6b7280' }}>{label}: </span>
      {value?.trim() ? value : '—'}
    </div>
  );
}

export function CalendarEventHeader({ view, onClose, closeLabel }: {
  view: CalendarEventView; onClose: () => void; closeLabel?: string;
}) {
  const t = useTranslations('calendar');
  const gymFormat = useGymFormatSettings();
  const lines = eventTimeLines(view, {
    date: (v) => formatGymDate(v, gymFormat),
    time: (v) => formatGymTime(v, gymFormat),
    allDay: t('event_all_day'),
  });
  return <EventPanelHeader title={view.title} lines={lines} onClose={onClose} closeLabel={closeLabel} />;
}

export function CalendarEventInfoCard({ view, showRows = true, extraRows, children, footer }: {
  view: CalendarEventView;
  /** False while a panel draws its own controls in place of the values (Edit mode). */
  showRows?: boolean;
  /** Rows only one kind has (the session's waitlist and eligibility), after the common ones. */
  extraRows?: ReactNode;
  /** Edit-mode controls, between the rows and the capacity line. */
  children?: ReactNode;
  /** Edit-mode actions, after the status line. */
  footer?: ReactNode;
}) {
  const t = useTranslations('calendar');
  const statusLabel = STATUS_KEYS.includes(view.status) ? t(`status_${view.status}` as any) : view.status.toUpperCase();
  return (
    <div style={cardStyle} data-testid="calendar-event-info">
      {showRows && (
        <>
          {eventDetailRows(view).map((r) => (
            <DetailRow key={r.key} label={t(`event_${r.key === 'activity' ? 'activity_type' : r.key}` as any)} value={r.value} />
          ))}
          {extraRows}
        </>
      )}
      {children}
      {view.capacity && (
        <div style={{ fontSize: 13 }}>
          <span style={{ color: '#6b7280' }}>{t('event_capacity')}: </span>
          <span style={{ fontWeight: 600, color: view.capacity.enrolled >= view.capacity.total ? '#ef4444' : '#059669' }}>
            {view.capacity.enrolled} / {view.capacity.total}
          </span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <span style={{ fontSize: 13, color: '#6b7280' }}>{t('event_status')}:</span>
        <CalendarStatusBadge status={view.status} label={statusLabel} />
      </div>
      {footer}
    </div>
  );
}
