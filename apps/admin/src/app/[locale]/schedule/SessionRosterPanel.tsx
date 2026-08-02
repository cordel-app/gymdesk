'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';

interface Session {
  id: number;
  class_type_name: string;
  starts_at: string;
  effective_capacity: number;
  status: 'scheduled' | 'cancelled' | 'completed';
  trainer_membership_id: number | null;
  effective_trainer_membership_id: number | null;
  attendance_present: number;
  attendance_absent: number;
  attendance_pending: number;
  booked_count: number;
}

interface Booking {
  id: number;
  member_id: number;
  member_name: string;
  member_email: string;
  status: 'booked' | 'waitlisted' | 'cancelled';
  attendance_status: 'pending' | 'present' | 'absent';
  waitlist_position: number | null;
  booked_at: string | null;
}

interface Trainer {
  gym_membership_id: number;
  name: string;
}

interface Member { id: number; name: string; email: string }

export function SessionRosterPanel({ session: initialSession, canAttendance, trainers, onClose, onSessionUpdated }: {
  session: Session;
  canAttendance: boolean;
  trainers: Trainer[];
  onClose: () => void;
  onSessionUpdated?: (updated: Session) => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [session, setSession] = useState<Session>(initialSession);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState('');
  const [busyBooking, setBusyBooking] = useState<number | null>(null);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [completionError, setCompletionError] = useState<{ pending_count?: number; missing_trainer?: boolean } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [bs, ms, updated] = await Promise.all([
        apiFetch<Booking[]>(`/bookings?session_id=${session.id}`),
        apiFetch<Member[]>('/members'),
        apiFetch<Session>(`/class-sessions/${session.id}`),
      ]);
      setBookings(bs);
      setMembers(ms);
      setSession(updated);
    } catch (err: any) {
      toast(err.message ?? t('schedule.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [session.id]);

  async function markAttendance(bookingId: number, status: 'present' | 'absent') {
    setBusyBooking(bookingId);
    try {
      await apiFetch(`/bookings/${bookingId}/attendance`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      load();
    } catch (err: any) {
      toast(err.message ?? t('schedule.error_generic'));
    } finally {
      setBusyBooking(null);
    }
  }

  async function bulkPresent() {
    try {
      const result = await apiFetch<{ updated: number }>(`/class-sessions/${session.id}/bulk-present`, { method: 'POST' });
      toast(t('schedule.bulk_present_done', { n: result.updated }));
      load();
    } catch (err: any) {
      toast(err.message ?? t('schedule.error_generic'));
    }
  }

  async function setEffectiveTrainer(trainerMembershipId: number | null) {
    try {
      const updated = await apiFetch<Session>(`/class-sessions/${session.id}/effective-trainer`, {
        method: 'PUT',
        body: JSON.stringify({ trainer_membership_id: trainerMembershipId }),
      });
      setSession(updated);
      onSessionUpdated?.(updated);
    } catch (err: any) {
      toast(err.message ?? t('schedule.error_generic'));
    }
  }

  async function completeSession() {
    setCompletionError(null);
    try {
      const updated = await apiFetch<Session>(`/class-sessions/${session.id}/complete`, { method: 'POST' });
      setSession(updated);
      onSessionUpdated?.(updated);
      toast(t('schedule.complete_success'));
    } catch (err: any) {
      if (err.pending_count !== undefined || err.missing_trainer !== undefined) {
        setCompletionError(err);
      } else {
        toast(err.message ?? t('schedule.error_generic'));
      }
    } finally {
      setConfirmComplete(false);
    }
  }

  async function bookOne() {
    if (!adding) return;
    try {
      const result = await apiFetch<{ status: string; over_capacity?: boolean }>('/bookings', {
        method: 'POST',
        body: JSON.stringify({ member_id: parseInt(adding, 10), class_session_id: session.id }),
      });
      setAdding('');
      if (result.over_capacity) toast(t('schedule.over_capacity_warning'));
      load();
    } catch (err: any) {
      // If waitlisted and canAttendance, offer to force-add.
      if (err.message?.includes('waitlisted') || err.status === 400) {
        toast(err.message ?? t('schedule.error_generic'));
      } else {
        toast(err.message ?? t('schedule.error_generic'));
      }
    }
  }

  async function cancelBooking(id: number) {
    try {
      await apiFetch(`/bookings/${id}`, { method: 'DELETE' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('schedule.error_generic'));
    }
  }

  const confirmed = bookings.filter((b) => b.status === 'booked');
  const waitlist = bookings
    .filter((b) => b.status === 'waitlisted')
    .sort((a, b) => (a.waitlist_position ?? 0) - (b.waitlist_position ?? 0));

  const canComplete = session.status === 'scheduled';
  const effectiveTrainerId = session.effective_trainer_membership_id ?? session.trainer_membership_id;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 680, maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
           onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>{session.class_type_name}</h2>
          <p style={{ margin: '0 0 8px', color: '#666', fontSize: 13 }}>
            {session.starts_at.slice(0, 16).replace('T', ' ')}
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
            <span style={pill('#1e7e40')}>{t('schedule.attendance_status.present')}: {session.attendance_present}</span>
            <span style={pill('#b26a00')}>{t('schedule.attendance_status.pending')}: {session.attendance_pending}</span>
            <span style={pill('#c0392b')}>{t('schedule.attendance_status.absent')}: {session.attendance_absent}</span>
            <span style={{ ...pill('#666'), marginLeft: 'auto' }}>
              {t('schedule.booked_heading')}: {session.booked_count}/{session.effective_capacity}
            </span>
          </div>
        </div>

        {loading ? <p style={{ color: '#888' }}>{t('schedule.loading')}</p> : (
          <>
            {/* Confirmed bookings — attendance section */}
            <section style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <h3 style={h3}>{t('schedule.booked_heading')} ({confirmed.length})</h3>
                {canAttendance && session.status === 'scheduled' && confirmed.some((b) => b.attendance_status === 'pending') && (
                  <button onClick={bulkPresent} style={btnSmall('#1e7e40')}>{t('schedule.bulk_present')}</button>
                )}
              </div>

              {confirmed.length === 0 ? (
                <p style={hint}>{t('schedule.no_bookings')}</p>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {confirmed.map((b) => {
                    const busy = busyBooking === b.id;
                    return (
                      <li key={b.id} style={row}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.member_name}</div>
                          <div style={{ fontSize: 12, color: '#888' }}>{b.member_email}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                          <AttendanceBadge status={b.attendance_status} t={t} />
                          {canAttendance && session.status === 'scheduled' && (
                            <>
                              <button
                                onClick={() => markAttendance(b.id, 'present')}
                                disabled={busy || b.attendance_status === 'present'}
                                style={attendanceBtn('#1e7e40', b.attendance_status === 'present')}>
                                {busy ? '…' : t('schedule.mark_present')}
                              </button>
                              <button
                                onClick={() => markAttendance(b.id, 'absent')}
                                disabled={busy || b.attendance_status === 'absent'}
                                style={attendanceBtn('#c0392b', b.attendance_status === 'absent')}>
                                {busy ? '…' : t('schedule.mark_absent')}
                              </button>
                            </>
                          )}
                          {canAttendance && (
                            <button onClick={() => cancelBooking(b.id)} style={btnSmall('#888')} title={t('schedule.cancel')}>✕</button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Waitlist */}
            {waitlist.length > 0 && (
              <section style={{ marginBottom: 20 }}>
                <h3 style={h3}>{t('schedule.waitlist_heading')} ({waitlist.length})</h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {waitlist.map((b) => (
                    <li key={b.id} style={row}>
                      <div style={{ width: 24, textAlign: 'center', color: '#888', fontWeight: 600 }}>{b.waitlist_position}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500 }}>{b.member_name}</div>
                        <div style={{ fontSize: 12, color: '#888' }}>{b.member_email}</div>
                      </div>
                      {canAttendance && (
                        <button onClick={() => cancelBooking(b.id)} style={btnSmall('#888')} title={t('schedule.cancel')}>✕</button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Effective trainer */}
            {canAttendance && (
              <section style={{ marginBottom: 20 }}>
                <h3 style={h3}>{t('schedule.effective_trainer')}</h3>
                <select
                  value={effectiveTrainerId ?? ''}
                  onChange={(e) => setEffectiveTrainer(e.target.value ? Number(e.target.value) : null)}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}>
                  <option value="">{t('schedule.effective_trainer_placeholder')}</option>
                  {trainers.map((tr) => (
                    <option key={tr.gym_membership_id} value={tr.gym_membership_id}>{tr.name}</option>
                  ))}
                </select>
                {session.effective_trainer_membership_id && (
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: '#888' }}>
                    {t('schedule.effective_trainer_confirmed')}
                  </p>
                )}
              </section>
            )}

            {/* Add member */}
            {canAttendance && session.status === 'scheduled' && (
              <section style={{ borderTop: '1px solid #eee', paddingTop: 12, marginBottom: 16 }}>
                <h3 style={h3}>{t('schedule.add_member_heading')}</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select value={adding} onChange={(e) => setAdding(e.target.value)}
                          style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}>
                    <option value="">{t('schedule.pick_member')}</option>
                    {members
                      .filter((m) => !bookings.some((b) => b.member_id === m.id && b.status !== 'cancelled'))
                      .map((m) => <option key={m.id} value={m.id}>{m.name} — {m.email}</option>)}
                  </select>
                  <button onClick={bookOne} style={btnStyle('#6c63ff')}>{t('schedule.book_member')}</button>
                </div>
              </section>
            )}

            {/* Completion error feedback */}
            {completionError && (
              <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>
                {completionError.pending_count! > 0 && (
                  <div>{t('schedule.complete_blocked_pending', { n: completionError.pending_count })}</div>
                )}
                {completionError.missing_trainer && (
                  <div>{t('schedule.complete_blocked_no_trainer')}</div>
                )}
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 12, borderTop: '1px solid #eee' }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('schedule.close')}</button>
          {canAttendance && canComplete && (
            <button onClick={() => setConfirmComplete(true)} style={btnStyle('#1e7e40')}>
              {t('schedule.complete_session')}
            </button>
          )}
          {session.status === 'completed' && (
            <StatusBadge status="active" label={t('schedule.status.completed')} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmComplete}
        message={t('schedule.complete_session_confirm', {
          pending: session.attendance_pending,
          name: session.class_type_name,
        })}
        confirmLabel={t('schedule.complete_session')}
        cancelLabel={t('schedule.close')}
        onConfirm={completeSession}
        onCancel={() => setConfirmComplete(false)}
      />
    </div>
  );
}

function AttendanceBadge({ status, t }: { status: 'pending' | 'present' | 'absent'; t: (key: string) => string }) {
  const color = status === 'present' ? '#1e7e40' : status === 'absent' ? '#c0392b' : '#888';
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color, padding: '2px 6px', borderRadius: 4, border: `1px solid ${color}`, whiteSpace: 'nowrap' }}>
      {t(`schedule.attendance_status.${status}`)}
    </span>
  );
}

const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: '#333' };
const row: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f4f4f4' };
const hint: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };

function pill(color: string): React.CSSProperties {
  return { background: color + '18', color, border: `1px solid ${color}40`, borderRadius: 12, padding: '2px 10px', fontWeight: 600 };
}

function attendanceBtn(color: string, active: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    borderRadius: 6,
    border: `1px solid ${color}`,
    background: active ? color : 'white',
    color: active ? 'white' : color,
    fontSize: 13,
    fontWeight: 600,
    cursor: active ? 'default' : 'pointer',
    minWidth: 80,
    minHeight: 40,
  };
}
