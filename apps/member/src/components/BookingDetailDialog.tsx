'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MemberDialog } from './MemberDialog';
import { ActivityMetaIcon } from './ActivityMetaIcon';
import { bookingDetailRows, type BookingDetailInput } from '@/lib/bookingDetail';
import { CANCELLATION_NOTICE_TITLE_KEY, cancellationNoticeKey, type CancellableBooking } from '@/lib/bookingCancellation';
import { memberTheme, noticeStyle, secondaryButtonStyle, destructiveButtonStyle } from '@/lib/memberChrome';

/**
 * #2476 — the Members App's one booking detail dialog, opened from the image of
 * Home → My Next Bookings and of Bookings → My Bookings. Both pass the row
 * `GET /me/schedule` returns, so they show the same information; the page owns
 * the cancellation (the API, the confirmation and the reload), this only offers
 * the action under the same rule as My Bookings (`can_cancel`, never a client
 * date comparison) and the explanation where it is not allowed.
 */
export interface BookingDetailData extends BookingDetailInput, Partial<CancellableBooking> {
  title: string;
  /** Already formatted by the page in the gym's own date and time convention. */
  whenLabel: string;
  description?: string | null;
  imageUrl?: string | null;
  my_booking_id?: number | null;
}

export function BookingDetailDialog({ booking, onClose, onCancel, busy = false }: {
  booking: BookingDetailData;
  onClose: () => void;
  /** Called with the booking id when the member taps Cancel; the page confirms and cancels. */
  onCancel?: (bookingId: number) => void;
  busy?: boolean;
}) {
  const t = useTranslations();
  const [broken, setBroken] = useState(false);
  const titleId = `booking-detail-${React.useId()}`;
  const rows = bookingDetailRows(booking);
  const canCancel = !!onCancel && !!booking.my_booking_id && !!booking.my_booking_status && booking.can_cancel === true;
  const noticeKey = booking.my_booking_id && booking.my_booking_status && booking.can_cancel !== undefined
    ? cancellationNoticeKey({ can_cancel: booking.can_cancel, cancellation_block: booking.cancellation_block ?? null, professional_service: !!booking.professional_service })
    : null;

  return (
    <MemberDialog
      title={booking.title}
      labelledBy={titleId}
      onClose={onClose}
      actions={
        <>
          <button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, padding: '8px 16px', cursor: 'pointer' }}>
            {t('booking_detail.close')}
          </button>
          {canCancel && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onCancel!(booking.my_booking_id!)}
              style={{ ...destructiveButtonStyle, padding: '8px 16px', cursor: busy ? 'default' : 'pointer' }}
            >
              {busy ? '…' : t('booking_detail.cancel')}
            </button>
          )}
        </>
      }
    >
      {booking.imageUrl?.trim() && !broken && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={booking.imageUrl.trim()} alt={booking.title} style={styles.image} onError={() => setBroken(true)} />
      )}
      <p style={styles.when}>{booking.whenLabel}</p>
      {booking.description?.trim() && <p style={styles.description}>{booking.description.trim()}</p>}
      {rows.map((row) => (
        <p key={row.icon} style={styles.row}>
          <ActivityMetaIcon name={row.icon} size={16} />
          <span style={styles.label}>{t(row.labelKey)}:</span>
          <span>{row.text ?? t(row.valueKey!, row.values)}</span>
        </p>
      ))}
      {noticeKey && (
        <div style={styles.notice}>
          <strong>{t(CANCELLATION_NOTICE_TITLE_KEY)}</strong> {t(noticeKey)}
        </div>
      )}
    </MemberDialog>
  );
}

const styles: Record<string, React.CSSProperties> = {
  image: { width: '100%', height: 'auto', objectFit: 'contain', display: 'block', borderRadius: 8, background: memberTheme.pageBackground },
  when: { margin: 0, fontSize: 14, color: memberTheme.textSecondary },
  description: { margin: 0, fontSize: 14, color: memberTheme.textSecondary, overflowWrap: 'anywhere' },
  row: { margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, color: memberTheme.text },
  label: { color: memberTheme.textMuted },
  notice: { ...noticeStyle('warning'), fontSize: 13 },
};
