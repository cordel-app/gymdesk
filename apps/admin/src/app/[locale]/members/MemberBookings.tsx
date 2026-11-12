'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDate, formatGymTime } from '@/lib/gymFormat';
import { DataTable, type Column } from '@/components/DataTable';
import { cardMutedTextStyle, cardSectionLabelStyle, formErrorStyle } from '@/components/formChrome';
import { FilterBar, FilterField, filterButtonStyle, filterControlStyle } from '@/components/FilterBar';
import {
  EMPTY_PAST_BOOKING_FILTERS, bookingLocation, bookingStatusKey, eventCancelled, hasPastBookingFilters,
  pastBookingsPageCount, pastBookingsQuery, pastStatusFilterKey,
  type MemberBooking, type MemberUpcomingBookingsResponse, type PastBookingFilters, type PastBookingOption,
  type PastBookingsPage,
} from './bookingsTabView';

/**
 * #2720 — the Member card's **Bookings** tab. Read-only: the member's bookings
 * as `GET /members/:id/bookings` splits them, Upcoming (nearest first) above
 * Past (most recent first). Nothing is decided here.
 *
 * #2731 — Past is a collapsed *Past Events* section, read from
 * `GET /members/:id/bookings/past` only once it is first opened, filtered and
 * paginated (100 per page) by the API; collapsing it keeps the page loaded.
 */
export function MemberBookings({ memberId }: { memberId: number | string }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [data, setData] = useState<MemberUpcomingBookingsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  // #2731 — Past Events: collapsed and not fetched until first opened.
  const [pastOpen, setPastOpen] = useState(false);
  const [filters, setFilters] = useState<PastBookingFilters>(EMPTY_PAST_BOOKING_FILTERS);
  const [page, setPage] = useState(1);
  const [past, setPast] = useState<PastBookingsPage | null>(null);
  const [pastLoading, setPastLoading] = useState(false);
  const [pastFailed, setPastFailed] = useState(false);
  const pastRequest = useRef(0);

  useEffect(() => {
    let live = true;
    apiFetch<MemberUpcomingBookingsResponse>(`/members/${memberId}/bookings?scope=upcoming`)
      .then((r) => { if (live) { setData(r); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    setPastOpen(false);
    setPast(null);
    setFilters(EMPTY_PAST_BOOKING_FILTERS);
    setPage(1);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  function loadPast(nextFilters: PastBookingFilters, nextPage: number) {
    const seq = ++pastRequest.current;
    setPastLoading(true);
    apiFetch<PastBookingsPage>(`/members/${memberId}/bookings/past?${pastBookingsQuery(nextFilters, nextPage)}`)
      .then((r) => { if (seq === pastRequest.current) { setPast(r); setPastFailed(false); } })
      .catch(() => { if (seq === pastRequest.current) setPastFailed(true); })
      .finally(() => { if (seq === pastRequest.current) setPastLoading(false); });
  }

  function togglePast() {
    const opening = !pastOpen;
    setPastOpen(opening);
    if (opening && past === null && !pastLoading) loadPast(filters, page);
  }

  function changeFilter(key: keyof PastBookingFilters, value: string) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    setPage(1);
    loadPast(next, 1);
  }

  function clearFilters() {
    setFilters(EMPTY_PAST_BOOKING_FILTERS);
    setPage(1);
    loadPast(EMPTY_PAST_BOOKING_FILTERS, 1);
  }

  function goToPage(next: number) {
    setPage(next);
    loadPast(filters, next);
  }

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
  // #2731 §4 — the Past table adds the booking's own Professional Service.
  const serviceColumn: Column<MemberBooking> = {
    header: t('members.bookings_col_professional_service'),
    mobile: 'secondary',
    render: (b) => b.professional_service_name || '—',
  };
  const pastColumns = [...columns, serviceColumn];

  const optionSelect = (key: keyof PastBookingFilters, label: string, options: PastBookingOption[]) => (
    <FilterField label={label} htmlFor={`past-${key}-${memberId}`}>
      <select
        id={`past-${key}-${memberId}`}
        style={filterControlStyle}
        value={filters[key]}
        onChange={(e) => changeFilter(key, e.target.value)}
      >
        <option value="">{t('members.bookings_filter_all')}</option>
        {options.map((o) => <option key={o.id} value={String(o.id)}>{o.name || `#${o.id}`}</option>)}
      </select>
    </FilterField>
  );
  const pageCount = past ? pastBookingsPageCount(past.total, past.page_size) : 1;

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
        <button
          type="button"
          onClick={togglePast}
          aria-expanded={pastOpen}
          style={{
            ...cardSectionLabelStyle, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <span aria-hidden="true">{pastOpen ? '▾' : '▸'}</span>
          {t('members.bookings_past_events')}
          {past && <span style={cardMutedTextStyle}>({past.total})</span>}
        </button>
        {pastOpen && (
          <div style={{ marginTop: 8 }}>
            {past && (
              <FilterBar>
                {optionSelect('activity_type_id', t('members.bookings_filter_activity'), past.options.activities)}
                {optionSelect('center_id', t('members.bookings_filter_center'), past.options.centers)}
                {optionSelect('trainer_membership_id', t('members.bookings_filter_trainer'), past.options.trainers)}
                <FilterField label={t('members.bookings_filter_status')} htmlFor={`past-status-${memberId}`}>
                  <select
                    id={`past-status-${memberId}`}
                    style={filterControlStyle}
                    value={filters.status}
                    onChange={(e) => changeFilter('status', e.target.value)}
                  >
                    <option value="">{t('members.bookings_filter_all')}</option>
                    {past.options.statuses.map((s) => <option key={s} value={s}>{t(pastStatusFilterKey(s))}</option>)}
                  </select>
                </FilterField>
                {optionSelect('professional_service_id', t('members.bookings_filter_professional_service'), past.options.professional_services)}
                {hasPastBookingFilters(filters) && (
                  <button type="button" style={filterButtonStyle} onClick={clearFilters}>
                    {t('members.bookings_filter_clear')}
                  </button>
                )}
              </FilterBar>
            )}
            {pastFailed ? (
              <p style={formErrorStyle}>{t('members.bookings_error')}</p>
            ) : (
              <DataTable
                columns={pastColumns}
                rows={past?.rows ?? []}
                rowKey={(b) => b.id}
                loading={pastLoading && past === null}
                loadingText={t('members.bookings_loading')}
                emptyText={t('members.bookings_past_empty')}
              />
            )}
            {past && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, fontSize: 13, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  style={filterButtonStyle}
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1 || pastLoading}
                >
                  ← {t('members.bookings_page_previous')}
                </button>
                <span style={cardMutedTextStyle}>
                  {t('members.bookings_page_of', { page: past.page, pages: pageCount, total: past.total })}
                </span>
                <button
                  type="button"
                  style={filterButtonStyle}
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= pageCount || pastLoading}
                >
                  {t('members.bookings_page_next')} →
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
