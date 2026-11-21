'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { overlayStyle, modalStyle, btnStyle, primaryBtnSmall } from '@/components/ui';
import { secondaryBtnSmall, cardMutedTextStyle, formControlStyle, dashedAddBtnStyle } from '@/components/formChrome';
import { MemberSearchInput, type MemberResult } from '@/app/[locale]/calendar/MemberSearchInput';
import { addAttendeeBody, classifyAddRefusal, isClassFull, type ServiceOption } from '@/lib/bookingAdd';

// #1877 — the attendee list behind Today's classes. One dialog, two modes: `view`
// only reads, `celebrate` also records attendance (the calendar panel's own
// `POST /bookings/:id/attendance`) and confirms the class took place
// (`POST /class-sessions/:id/complete`). Both reuse the existing routes and rules.

interface Attendee {
  id: number;
  member_id: number;
  effective_capacity?: number | string | null;
  member_name: string;
  status: string;
  attendance_status: 'pending' | 'present' | 'absent';
  service_consumed?: number | boolean;
  service_returned?: number | boolean;
}

export type AttendeesMode = 'view' | 'celebrate';

export function HomeClassAttendees({ sessionId, sessionName, mode, hasService, onClose, onCompleted, onChanged }: {
  sessionId: number;
  sessionName: string;
  mode: AttendeesMode;
  /** #3096: the class is linked to a Professional Service, so an absence may be refunded. */
  hasService?: boolean;
  onClose: () => void;
  onCompleted: () => void;
  /** #3096: an attendee was added, so the card behind the dialog is out of date. */
  onChanged?: () => void;
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

  // #3096: giving back the session an absence spent is the calendar panel's own
  // route and rule (`POST /bookings/:id/refund-balance`), offered only for a
  // class linked to a Professional Service whose spend is still unreturned.
  async function refund(b: Attendee) {
    if (busyId !== null) return;
    setBusyId(b.id);
    try {
      const updated = await apiFetch<Attendee>(`/bookings/${b.id}/refund-balance`, { method: 'POST' });
      setRows((cur) => (cur ?? []).map((r) => (r.id === b.id ? { ...r, ...updated } : r)));
    } catch (err: any) {
      toast(err?.message ?? tc('refund_balance_error'));
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
              {celebrate && hasService && b.attendance_status === 'absent' && !!b.service_consumed && (
                <button type="button" disabled={busyId !== null} style={secondaryBtnSmall} onClick={() => refund(b)}>{tc('refund_balance')}</button>
              )}
            </div>
          ))}
        </div>

        {celebrate && rows && (
          <AddAttendee sessionId={sessionId} rows={rows} onAdded={async () => { await load(); onChanged?.(); }} />
        )}

        {celebrate && rows && pending > 0 && <p style={{ ...cardMutedTextStyle, marginTop: 10 }}>{t('celebrate_pending', { count: pending })}</p>}
        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnStyle('#aaa')}>{t('close')}</button>
          {celebrate && <button type="button" onClick={complete} disabled={completing} style={primaryBtnSmall()} data-testid="home-complete-class">{completing ? t('celebrate_completing') : t('celebrate_complete')}</button>}
        </div>
      </div>
    </div>
  );
}

// #3096: adding an attendee from Start. It is the calendar panel's own
// `POST /bookings` with the same three confirmations (class full, which
// Professional Service, eligibility override); `lib/bookingAdd.ts` reads the
// API's refusals for both.
function AddAttendee({ sessionId, rows, onAdded }: {
  sessionId: number;
  rows: Attendee[];
  onAdded: () => Promise<void> | void;
}) {
  const t = useTranslations('home');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [member, setMember] = useState<MemberResult | null>(null);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [override, setOverride] = useState<string | null>(null);
  const [needsOverride, setNeedsOverride] = useState(false);
  const [busy, setBusy] = useState(false);

  function reset(keepOpen: boolean) {
    setMember(null); setServices([]); setServiceId(null); setOverride(null); setNeedsOverride(false); setOpen(keepOpen);
  }

  if (!open) {
    return <button type="button" style={{ ...dashedAddBtnStyle, marginTop: 10 }} onClick={() => setOpen(true)} data-testid="home-add-attendee">{t('add_attendee')}</button>;
  }

  const already = member != null && rows.some((r) => Number(r.member_id) === member.id);
  const full = isClassFull(rows);

  async function submit() {
    if (!member || busy) return;
    setBusy(true);
    try {
      const result = await apiFetch<{ status?: string }>('/bookings', {
        method: 'POST',
        body: JSON.stringify(addAttendeeBody({ memberId: member.id, sessionId, force: full, serviceId, override: needsOverride })),
      });
      if (result?.status === 'waitlisted') toast(t('add_attendee_waitlisted', { name: member.name }));
      reset(false);
      await onAdded();
    } catch (err: any) {
      const refusal = classifyAddRefusal(err);
      if (refusal.kind === 'choose_service') {
        setServices(refusal.services); setServiceId(null);
      } else if (refusal.kind === 'override') {
        setNeedsOverride(true);
        setOverride(refusal.message ?? t('add_attendee_not_eligible'));
        setServices(refusal.services);
        setServiceId(refusal.services.length === 1 ? refusal.services[0].id : null);
      } else {
        toast(refusal.message ?? t('class_error'));
      }
    } finally {
      setBusy(false);
    }
  }

  const mustChoose = services.length > 1 && serviceId == null;

  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="home-add-attendee-form">
      <MemberSearchInput placeholder={t('add_attendee_search')} disabled={busy}
        onSelect={(m) => { reset(true); setMember(m); }} />
      {member && already && <p style={{ ...cardMutedTextStyle, margin: 0 }}>{t('add_attendee_already', { name: member.name })}</p>}
      {member && !already && (
        <>
          <p style={{ margin: 0, fontSize: 13 }}>
            {override ?? (full ? t('add_attendee_full', { name: member.name, booked: rows.length }) : t('add_attendee_confirm', { name: member.name }))}
          </p>
          {services.length > 1 && (
            <select value={serviceId ?? ''} aria-label={t('add_attendee_service')} style={{ ...formControlStyle, width: '100%' }}
              onChange={(e) => setServiceId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('add_attendee_service')}</option>
              {services.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
        </>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        {member && !already && (
          <button type="button" style={{ ...primaryBtnSmall(), opacity: busy || mustChoose ? 0.6 : 1 }} disabled={busy || mustChoose} onClick={submit} data-testid="home-add-attendee-confirm">
            {busy ? t('add_attendee_adding') : needsOverride || full ? t('add_attendee_anyway') : t('add_attendee_add')}
          </button>
        )}
        <button type="button" style={secondaryBtnSmall} disabled={busy} onClick={() => reset(false)}>{t('add_attendee_cancel')}</button>
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
