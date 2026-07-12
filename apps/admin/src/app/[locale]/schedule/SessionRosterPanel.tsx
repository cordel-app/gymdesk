'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';

interface Session { id: number; class_type_name: string; starts_at: string; effective_capacity: number }
interface Booking {
  id: number;
  member_id: number;
  member_name: string;
  member_email: string;
  status: 'booked' | 'waitlisted' | 'cancelled' | 'attended' | 'no_show';
  waitlist_position: number | null;
  booked_at: string | null;
  attendance_confirmed_at: string | null;
}
interface Member { id: number; name: string; email: string }

export function SessionRosterPanel({ session, canAttendance, onClose }: {
  session: Session; canAttendance: boolean; onClose: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [bookings, setBookings] = useState<Booking[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [bs, ms] = await Promise.all([
        apiFetch<Booking[]>(`/bookings?session_id=${session.id}`),
        apiFetch<Member[]>('/members'),
      ]);
      setBookings(bs); setMembers(ms);
    } catch (err: any) { toast(err.message ?? t('schedule.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [session.id]);

  async function bookOne() {
    if (!adding) return;
    try {
      await apiFetch('/bookings', { method: 'POST', body: JSON.stringify({
        member_id: parseInt(adding, 10), class_session_id: session.id,
      }) });
      setAdding(''); load();
    } catch (err: any) { toast(err.message ?? t('schedule.error_generic')); }
  }

  async function cancelBooking(id: number) {
    try { await apiFetch(`/bookings/${id}`, { method: 'DELETE' }); load(); }
    catch (err: any) { toast(err.message ?? t('schedule.error_generic')); }
  }

  async function markAttendance(id: number, status: 'attended' | 'no_show') {
    try {
      await apiFetch(`/bookings/${id}/attendance`, { method: 'POST', body: JSON.stringify({ status }) });
      load();
    } catch (err: any) { toast(err.message ?? t('schedule.error_generic')); }
  }

  const booked = bookings.filter((b) => ['booked', 'attended', 'no_show'].includes(b.status));
  const waitlist = bookings.filter((b) => b.status === 'waitlisted').sort((a, b) => (a.waitlist_position ?? 0) - (b.waitlist_position ?? 0));

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 640 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('schedule.roster_title')}</h2>
        <p style={{ margin: '0 0 16px', color: '#666', fontSize: 14 }}>
          {session.class_type_name} · {session.starts_at.slice(0, 16).replace('T', ' ')} · {booked.length}/{session.effective_capacity}
        </p>

        {loading ? <p>{t('schedule.loading')}</p> : (
          <>
            <div style={{ marginBottom: 20 }}>
              <h3 style={h3}>{t('schedule.booked_heading')} ({booked.length})</h3>
              {booked.length === 0 ? <p style={hint}>{t('schedule.no_bookings')}</p> : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {booked.map((b) => (
                    <li key={b.id} style={row}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500 }}>{b.member_name}</div>
                        <div style={{ fontSize: 12, color: '#888' }}>{b.member_email}</div>
                      </div>
                      <StatusBadge status={b.status === 'booked' ? 'active' : b.status === 'attended' ? 'active' : 'cancelled'} label={t(`schedule.booking_status.${b.status}`)} />
                      {canAttendance && b.status === 'booked' && (
                        <>
                          <button onClick={() => markAttendance(b.id, 'attended')} style={btnSmall('#1e7e40')}>{t('schedule.mark_attended')}</button>
                          <button onClick={() => markAttendance(b.id, 'no_show')} style={btnSmall('#b26a00')}>{t('schedule.mark_no_show')}</button>
                        </>
                      )}
                      {canAttendance && b.status !== 'cancelled' && (
                        <button onClick={() => cancelBooking(b.id)} style={btnSmall('#c0392b')}>{t('schedule.cancel')}</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {waitlist.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={h3}>{t('schedule.waitlist_heading')} ({waitlist.length})</h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {waitlist.map((b) => (
                    <li key={b.id} style={row}>
                      <div style={{ width: 24, textAlign: 'center', color: '#888' }}>{b.waitlist_position}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500 }}>{b.member_name}</div>
                        <div style={{ fontSize: 12, color: '#888' }}>{b.member_email}</div>
                      </div>
                      {canAttendance && <button onClick={() => cancelBooking(b.id)} style={btnSmall('#c0392b')}>{t('schedule.cancel')}</button>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {canAttendance && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderTop: '1px solid #eee', paddingTop: 12 }}>
                <select value={adding} onChange={(e) => setAdding(e.target.value)}
                        style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}>
                  <option value="">{t('schedule.pick_member')}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name} — {m.email}</option>)}
                </select>
                <button onClick={bookOne} style={btnStyle('#6c63ff')}>{t('schedule.book_member')}</button>
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('schedule.close')}</button>
        </div>
      </div>
    </div>
  );
}

const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: '#333' };
const row: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f4f4f4' };
const hint: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
