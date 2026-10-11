'use client';

import { useTranslations } from 'next-intl';
import { destructiveButtonStyle, secondaryButtonStyle } from '@/lib/memberChrome';
import { MemberDialog } from '@/components/MemberDialog';

/**
 * The one confirmation a member sees before their own booking is cancelled.
 *
 * Cancelling gives the place back, and a member who taps *Cancel booking* by
 * reflex — the button sits where *Book* was — had no second chance: a single
 * tap released it. The three screens that offer the action (My Bookings, the
 * Calendar sheet, the Home card) raise this dialog instead of calling the API
 * themselves, so the words are one set of `member_schedule` keys, like the
 * cancellation-window explanation beside them (#1162).
 *
 * It decides nothing about whether a booking *can* be cancelled — that is the
 * API's `can_cancel` — and it is shown only after that button was offered.
 */
export function CancelBookingConfirmDialog({ onConfirm, onClose, busy }: {
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  busy: boolean;
}) {
  const t = useTranslations('member_schedule');

  return (
    <MemberDialog
      labelledBy="cancel-booking-confirm-title"
      title={t('cancel_confirm_title')}
      onClose={busy ? () => {} : onClose}
      actions={(
        <>
          <button
            type="button"
            style={{ ...secondaryButtonStyle, flex: 1, padding: '10px 0', fontSize: 15, fontWeight: 600 }}
            onClick={onClose}
            disabled={busy}
          >
            {t('cancel_confirm_keep')}
          </button>
          <button
            type="button"
            style={{ ...destructiveButtonStyle, flex: 1, padding: '10px 0', fontSize: 15, fontWeight: 600, ...(busy ? { opacity: 0.6 } : null) }}
            onClick={() => { void onConfirm(); }}
            disabled={busy}
          >
            {busy ? '…' : t('cancel_confirm_yes')}
          </button>
        </>
      )}
    >
      <p style={{ margin: 0, fontSize: 15 }}>{t('cancel_confirm_body')}</p>
    </MemberDialog>
  );
}
