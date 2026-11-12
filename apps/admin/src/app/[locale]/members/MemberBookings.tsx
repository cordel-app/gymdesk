'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDate, formatGymTime } from '@/lib/gymFormat';
import { DataTable, type Column } from '@/components/DataTable';
import { cardMutedTextStyle, cardSectionLabelStyle, formErrorStyle } from '@/components/formChrome';
import {
  bookingLocation, bookingStatusKey, eventCancelled,
  type MemberBooking, type MemberBookingsResponse,
} from './bookingsTabView';

/**
 * #2720 — the Member card's **Bookings** tab. Read-only: the member's bookings
 * as `GET /members/:id/bookings` splits them, Upcoming (nearest first) above
 * Past (most recent first). Nothing is decided here.
 */
export function MemberBookings({ memberId }: { memberId: number | string }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [data, setData] = useState<MemberBookingsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    apiFetch<MemberBookingsResponse>(`/members/${memberId}/bookings`)
      .then((r) => { if (live) { setData(r); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  const columns: Column<MemberBooking>[] = [
    {
      header: t('members.bookings_col_event'),
      mobile: 'name',
      render: (b) => b.event_name || '—',
      title: (b) => b.event_name ?? undefined,
    },
    { header: t('members.bookings_col_date'), mobile: 'secondary', render: (b) => formatGymDate(b.starts_at, gym) },
    {
      header: t('members.bookings_col_time'),
      mobile: 'secondary',
      render: (b) => b.ends_at
        ? `${formatGymTime(b.starts_at, gym)} – ${formatGymTime(b.ends_at, gym)}`
        : formatGymTime(b.starts_at, gym),
    },
    {
      header: t('members.bookings_col_status'),
      mobile: 'keep',
      render: (b) => (
        <span>
          {t(bookingStatusKey(b))}
          {b.status === 'waitlisted' && b.waitlist_position != null ? ` #${b.waitlist_position}` : ''}
          {eventCancelled(b) && <span style={cardMutedTextStyle}> · {t('members.booking_event_cancelled')}</span>}
        </span>
      ),
    },
    { header: t('members.bookings_col_location'), mobile: 'secondary', render: (b) => bookingLocation(b) ?? '—' },
    { header: t('members.bookings_col_trainer'), mobile: 'secondary', render: (b) => b.trainer_name || '—' },
  ];

  if (failed) return <p style={formErrorStyle}>{t('members.bookings_error')}</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={cardSectionLabelStyle}>{t('members.bookings_upcoming')}</div>
        <DataTable
          columns={columns}
          rows={data?.upcoming ?? []}
          rowKey={(b) => b.id}
          loading={data === null}
          loadingText={t('members.bookings_loading')}
          emptyText={t('members.bookings_upcoming_empty')}
        />
      </div>
      <div>
        <div style={cardSectionLabelStyle}>{t('members.bookings_past')}</div>
        <DataTable
          columns={columns}
          rows={data?.past ?? []}
          rowKey={(b) => b.id}
          loading={data === null}
          loadingText={t('members.bookings_loading')}
          emptyText={t('members.bookings_past_empty')}
        />
      </div>
    </div>
  );
}
