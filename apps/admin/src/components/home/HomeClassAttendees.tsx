'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { overlayStyle, modalStyle, btnStyle, primaryBtnSmall } from '@/components/ui';
import { secondaryBtnSmall, cardMutedTextStyle } from '@/components/formChrome';

// #1877 — the attendee list behind Today's classes. One dialog, two modes: `view`
// only reads, `celebrate` also records attendance (the calendar panel's own
// `POST /bookings/:id/attendance`) and confirms the class took place
// (`POST /class-sessions/:id/complete`). Both reuse the existing routes and rules.

interface Attendee {
  id: number;
  member_name: string;
  status: string;
  attendance_status: 'pending' | 'present' | 'absent';
}

export type AttendeesMode = 'view' | 'celebrate';

export function HomeClassAttendees({ sessionId, sessionName, mode, onClose, onCompleted }: {
  sessionId: number;
  sessionName: string;
  mode: AttendeesMode;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const t = useTranslations('home');
  const tc = useTranslations('calendar');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const [rows, setRows] = useState<Attendee[] | null>(null);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [completing, setCompleting] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const all = await apiFetch<Attendee[]>(`/bookings?session_id=${sessionId}`);
      setRows(all.filter((b) => b.status === 'booked'));
    } catch {
      setError(true);
    }
  }, [apiFetch, sessionId]);

  useEffect(() => { load(); }, [load]);

  async function setAttendance(b: Attendee, status: 'present' | 'absent') {
    if (busyId !== null) return;
    setBusyId(b.id);
    try {
      const updated = await apiFetch<Attendee>(`/bookings/${b.id}/attendance`, { method: 'POST', body: JSON.stringify({ status }) });
      setRows((cur) => (cur ?? []).map((r) => (r.id === b.id ? { ...r, ...updated } : r)));
    } catch (err: any) {
      toast(err?.message ?? tc('attendance_error'));
    } finally {
      setBusyId(null);
    }
  }

  async function complete() {
    if (completing) return;
    setCompleting(true);
    try {
      await apiFetch(`/class-sessions/${sessionId}/complete`, { method: 'POST' });
      onCompleted();
      onClose();
    } catch (err: any) {
      toast(err?.body?.missing_trainer ? tc('complete_blocked_trainer') : err?.message ?? t('class_error'));
    } finally {
      setCompleting(false);
    }
  }

  const celebrate = mode === 'celebrate';
  const pending = (rows ?? []).filter((r) => r.attendance_status === 'pending').length;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div role="dialog" aria-label={sessionName} style={{ ...modalStyle, width: 480, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()} data-testid="home-attendees">
        <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>{celebrate ? t('celebrate_title', { name: sessionName }) : t('attendees_title', { name: sessionName })}</h3>
        {celebrate && <p style={{ ...cardMutedTextStyle, margin: '0 0 8px' }}>{t('celebrate_hint')}</p>}

        <div style={{ maxHeight: '50vh', overflowY: 'auto', marginTop: 8 }}>
          {error ? (
            <p style={cardMutedTextStyle}>{t('attendees_error')} <button type="button" style={secondaryBtnSmall} onClick={load}>{t('retry')}</button></p>
          ) : rows === null ? (
            <p style={cardMutedTextStyle}>{t('loading')}</p>
          ) : rows.length === 0 ? (
            <p style={cardMutedTextStyle}>{t('attendees_empty')}</p>
          ) : rows.map((b) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderTop: '1px solid var(--gd-border, #e5e7eb)' }} data-testid={`home-attendee-${b.id}`}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{b.member_name}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: b.attendance_status === 'absent' ? '#b45309' : b.attendance_status === 'present' ? '#047857' : '#6b7280' }}>
                  {busyId === b.id ? tc('attendance_saving') : tc(`attendance_${b.attendance_status === 'pending' ? 'unconfirmed' : b.attendance_status}` as any)}
                </div>
              </div>
              {celebrate && (
                <div style={{ display: 'flex', gap: 6 }} role="group" aria-label={b.member_name}>
                  <button type="button" disabled={busyId !== null} aria-pressed={b.attendance_status === 'present'} onClick={() => setAttendance(b, 'present')}
                    style={{ ...(b.attendance_status === 'present' ? primaryBtnSmall() : secondaryBtnSmall), opacity: busyId !== null ? 0.6 : 1 }}>{tc('attendance_mark_present')}</button>
                  <button type="button" disabled={busyId !== null} aria-pressed={b.attendance_status === 'absent'} onClick={() => setAttendance(b, 'absent')}
                    style={{ ...(b.attendance_status === 'absent' ? primaryBtnSmall() : secondaryBtnSmall), opacity: busyId !== null ? 0.6 : 1 }}>{tc('attendance_mark_absent')}</button>
                </div>
              )}
            </div>
          ))}
        </div>

        {celebrate && rows && pending > 0 && <p style={{ ...cardMutedTextStyle, marginTop: 10 }}>{t('celebrate_pending', { count: pending })}</p>}
        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnStyle('#aaa')}>{t('close')}</button>
          {celebrate && <button type="button" onClick={complete} disabled={completing} style={primaryBtnSmall()} data-testid="home-complete-class">{completing ? t('celebrate_completing') : t('celebrate_complete')}</button>}
        </div>
      </div>
    </div>
  );
}

// Cancelling uses the calendar's own route and its reason rule: a class that has
// not ended needs a reason, which the booked members receive in the alert.
export function HomeClassCancel({ sessionId, sessionName, hasEnded, onClose, onCancelled }: {
  sessionId: number;
  sessionName: string;
  hasEnded: boolean;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const t = useTranslations('home');
  const tc = useTranslations('calendar');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (busy || (!hasEnded && !reason.trim())) return;
    setBusy(true);
    try {
      await apiFetch(`/class-sessions/${sessionId}/cancel`, {
        method: 'POST',
        body: JSON.stringify(hasEnded ? {} : { cancellation_reason: reason }),
      });
      onCancelled();
      onClose();
    } catch (err: any) {
      toast(err?.message ?? t('class_error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div role="dialog" aria-label={sessionName} style={{ ...modalStyle, width: 400, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()} data-testid="home-cancel-class">
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>{t('cancel_confirm', { name: sessionName })}</p>
        {!hasEnded && (
          <>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} aria-label={t('cancel_reason')} placeholder={t('cancel_reason')}
              style={{ width: '100%', boxSizing: 'border-box', marginTop: 12 }} />
            <p style={{ ...cardMutedTextStyle, margin: '6px 0 0' }}>{tc('cancel_reason_note')}</p>
          </>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnStyle('#aaa')} disabled={busy}>{t('cancel_keep')}</button>
          <button type="button" onClick={confirm} style={btnStyle('#c0392b')} disabled={busy || (!hasEnded && !reason.trim())}>{t('cancel_class')}</button>
        </div>
      </div>
    </div>
  );
}
