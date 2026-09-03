'use client';

import { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { MemberSearchInput, type MemberResult } from './MemberSearchInput';

interface ClassSession {
  id: number;
  class_type_name: string;
  starts_at: string;
  ends_at: string;
  effective_trainer_name: string | null;
  space_name: string | null;
  effective_capacity: number;
  booked_count: number;
  status: string;
}

interface Booking {
  id: number;
  member_id: number;
  member_name: string;
  member_email: string;
  status: string;
  waitlist_position: number | null;
}

interface Props {
  sessionId: number;
  onClose: () => void;
  onMutated: () => void; // refetch calendar after cancel / time change
  canWrite: boolean;
}

const panelStyle: React.CSSProperties = {
  height: '100%', overflowY: 'auto', boxSizing: 'border-box',
  padding: 24, borderLeft: '1px solid #e5e7eb',
  background: 'var(--gd-card-bg, #fff)',
  display: 'flex', flexDirection: 'column', gap: 20,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#6b7280',
  textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8,
};

const cardStyle: React.CSSProperties = {
  background: 'var(--gd-bg, #f9fafb)', borderRadius: 8,
  padding: '12px 14px', border: '1px solid #e5e7eb',
};

const btnBase: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 6, fontSize: 13,
  fontWeight: 600, cursor: 'pointer', border: 'none',
};

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function ClassSessionDetailPanel({ sessionId, onClose, onMutated, canWrite }: Props) {
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [session, setSession] = useState<ClassSession | null>(null);
  const [enrolled, setEnrolled] = useState<Booking[]>([]);
  const [waitlist, setWaitlist] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);

  // Remove member flow
  const [removingBooking, setRemovingBooking] = useState<Booking | null>(null);
  const [removing, setRemoving] = useState(false);

  // Add member flow
  const [addMode, setAddMode] = useState<'none' | 'enroll' | 'waitlist'>('none');
  const [selectedMember, setSelectedMember] = useState<MemberResult | null>(null);
  const [addConfirmMsg, setAddConfirmMsg] = useState<string | null>(null);
  const [addOverCapacity, setAddOverCapacity] = useState(false);
  const [adding, setAdding] = useState(false);

  // Cancel flow
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  // Change time flow
  const [showChangeTime, setShowChangeTime] = useState(false);
  const [newStartsAt, setNewStartsAt] = useState('');
  const [newEndsAt, setNewEndsAt] = useState('');
  const [savingTime, setSavingTime] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, bookings] = await Promise.all([
        apiFetch<ClassSession>(`/class-sessions/${sessionId}`),
        apiFetch<Booking[]>(`/bookings?session_id=${sessionId}`),
      ]);
      setSession(s);
      setEnrolled(bookings.filter((b) => b.status === 'booked'));
      setWaitlist(bookings.filter((b) => b.status === 'waitlisted').sort((a, b2) => (a.waitlist_position ?? 0) - (b2.waitlist_position ?? 0)));
    } catch (err: any) {
      toast(err.message ?? 'Failed to load session');
    } finally {
      setLoading(false);
    }
  }, [sessionId, apiFetch, toast]);

  useEffect(() => { load(); }, [load]);

  // ── Remove member ──────────────────────────────────────────────────────────
  async function confirmRemove() {
    if (!removingBooking) return;
    setRemoving(true);
    try {
      await apiFetch(`/bookings/${removingBooking.id}`, { method: 'DELETE' });
      setRemovingBooking(null);
      await load();
    } catch (err: any) {
      toast(err.message ?? 'Failed to remove member');
    } finally {
      setRemoving(false);
    }
  }

  // ── Add member / waitlist ──────────────────────────────────────────────────
  function handleMemberSelect(mode: 'enroll' | 'waitlist', member: MemberResult) {
    if (!session) return;
    setSelectedMember(member);
    const alreadyEnrolled = enrolled.some((b) => b.member_id === member.id);
    const alreadyWaiting  = waitlist.some((b) => b.member_id === member.id);
    if (alreadyEnrolled) { setAddConfirmMsg(`${member.name} is already enrolled in this event.`); setAddOverCapacity(false); return; }
    if (alreadyWaiting)  { setAddConfirmMsg(`${member.name} is already on the waiting list.`);    setAddOverCapacity(false); return; }
    if (mode === 'enroll') {
      const over = enrolled.length >= session.effective_capacity;
      setAddOverCapacity(over);
      setAddConfirmMsg(over
        ? `Room capacity: ${session.effective_capacity}. Currently enrolled: ${enrolled.length}. Adding ${member.name} will exceed capacity.`
        : null,
      );
    } else {
      setAddOverCapacity(false);
      setAddConfirmMsg(null);
    }
  }

  async function confirmAdd() {
    if (!selectedMember || !session) return;
    setAdding(true);
    try {
      const body: Record<string, any> = { member_id: selectedMember.id, class_session_id: session.id };
      if (addMode === 'enroll' && addOverCapacity) body.force = true;
      if (addMode === 'waitlist') body.waitlist = true;
      await apiFetch('/bookings', { method: 'POST', body: JSON.stringify(body) });
      setSelectedMember(null);
      setAddConfirmMsg(null);
      setAddOverCapacity(false);
      setAddMode('none');
      await load();
    } catch (err: any) {
      toast(err.message ?? 'Failed to add member');
    } finally {
      setAdding(false);
    }
  }

  // ── Cancel event ──────────────────────────────────────────────────────────
  async function handleCancel() {
    if (!cancelReason.trim()) return;
    setCancelling(true);
    try {
      await apiFetch(`/class-sessions/${sessionId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ cancellation_reason: cancelReason }),
      });
      onMutated();
      onClose();
    } catch (err: any) {
      toast(err.message ?? 'Failed to cancel event');
    } finally {
      setCancelling(false);
    }
  }

  // ── Change time ───────────────────────────────────────────────────────────
  function openChangeTime() {
    if (!session) return;
    setNewStartsAt(toDateTimeLocal(new Date(session.starts_at)));
    setNewEndsAt(toDateTimeLocal(new Date(session.ends_at)));
    setShowChangeTime(true);
  }

  async function handleSaveTime() {
    setSavingTime(true);
    try {
      await apiFetch(`/class-sessions/${sessionId}`, {
        method: 'PUT',
        body: JSON.stringify({ starts_at: newStartsAt, ends_at: newEndsAt }),
      });
      setShowChangeTime(false);
      onMutated();
      await load();
    } catch (err: any) {
      toast(err.message ?? 'Failed to update time');
    } finally {
      setSavingTime(false);
    }
  }

  if (loading || !session) {
    return (
      <div style={panelStyle}>
        <div style={{ color: '#6b7280', fontSize: 14 }}>{loading ? 'Loading…' : 'Session not found.'}</div>
      </div>
    );
  }

  const isCancelled = session.status === 'cancelled';

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{session.class_type_name}</div>
          <div style={{ fontSize: 13, color: '#374151' }}>{fmt(session.starts_at)}</div>
          <div style={{ fontSize: 13, color: '#6b7280' }}>{fmtTime(session.starts_at)} – {fmtTime(session.ends_at)}</div>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280', padding: 4 }}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Info */}
      <div style={cardStyle}>
        {session.effective_trainer_name && (
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <span style={{ color: '#6b7280' }}>Trainer: </span>{session.effective_trainer_name}
          </div>
        )}
        {session.space_name && (
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <span style={{ color: '#6b7280' }}>Space: </span>{session.space_name}
          </div>
        )}
        <div style={{ fontSize: 13 }}>
          <span style={{ color: '#6b7280' }}>Capacity: </span>
          <span style={{ fontWeight: 600, color: enrolled.length >= session.effective_capacity ? '#ef4444' : '#059669' }}>
            {enrolled.length} / {session.effective_capacity}
          </span>
        </div>
        {isCancelled && (
          <div style={{ marginTop: 8, padding: '4px 8px', background: '#fef2f2', borderRadius: 4, fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
            CANCELLED
          </div>
        )}
      </div>

      {/* Enrolled members */}
      <div>
        <div style={sectionLabel}>Enrolled members ({enrolled.length})</div>
        {enrolled.length === 0 ? (
          <div style={{ fontSize: 13, color: '#6b7280' }}>No members enrolled.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {enrolled.map((b) => (
              <div key={b.id} style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{b.member_name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{b.member_email}</div>
                </div>
                {canWrite && !isCancelled && (
                  <button
                    onClick={() => setRemovingBooking(b)}
                    style={{ ...btnBase, background: '#fef2f2', color: '#dc2626', padding: '4px 10px', fontSize: 12 }}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {canWrite && !isCancelled && addMode !== 'enroll' && (
          <button
            onClick={() => { setAddMode('enroll'); setSelectedMember(null); setAddConfirmMsg(null); setAddOverCapacity(false); }}
            style={{ ...btnBase, background: '#6c63ff', color: '#fff', marginTop: 10, width: '100%' }}
          >
            + Add member
          </button>
        )}
        {canWrite && !isCancelled && addMode === 'enroll' && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <MemberSearchInput onSelect={(m) => handleMemberSelect('enroll', m)} disabled={adding} />
            {selectedMember && (
              <div style={{ fontSize: 13 }}>
                {addConfirmMsg ? (
                  <div style={{ color: addOverCapacity ? '#b45309' : '#dc2626', fontWeight: 600, marginBottom: 6 }}>
                    {addOverCapacity && '⚠ Capacity exceeded — '}
                    {addConfirmMsg}
                  </div>
                ) : (
                  <div style={{ color: '#374151', marginBottom: 6 }}>
                    Add <strong>{selectedMember.name}</strong> to this event?
                  </div>
                )}
                {/* Only show confirm if not a hard block (already enrolled/waitlisted) */}
                {(!addConfirmMsg || addOverCapacity) && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={confirmAdd}
                      disabled={adding}
                      style={{ ...btnBase, background: '#6c63ff', color: '#fff', flex: 1, opacity: adding ? 0.6 : 1 }}
                    >
                      {adding ? 'Adding…' : addOverCapacity ? 'Add anyway' : 'Confirm'}
                    </button>
                    <button
                      onClick={() => { setSelectedMember(null); setAddConfirmMsg(null); setAddOverCapacity(false); }}
                      style={{ ...btnBase, background: '#f3f4f6', color: '#374151' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {addConfirmMsg && !addOverCapacity && (
                  <button
                    onClick={() => { setSelectedMember(null); setAddConfirmMsg(null); }}
                    style={{ ...btnBase, background: '#f3f4f6', color: '#374151' }}
                  >
                    OK
                  </button>
                )}
              </div>
            )}
            {!selectedMember && (
              <button
                onClick={() => setAddMode('none')}
                style={{ ...btnBase, background: '#f3f4f6', color: '#374151' }}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

      {/* Waiting list */}
      <div>
        <div style={sectionLabel}>Waiting list ({waitlist.length})</div>
        {waitlist.length === 0 ? (
          <div style={{ fontSize: 13, color: '#6b7280' }}>No members on waiting list.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {waitlist.map((b, i) => (
              <div key={b.id} style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{i + 1}. {b.member_name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{b.member_email}</div>
                </div>
                {canWrite && !isCancelled && (
                  <button
                    onClick={() => setRemovingBooking(b)}
                    style={{ ...btnBase, background: '#fef2f2', color: '#dc2626', padding: '4px 10px', fontSize: 12 }}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {canWrite && !isCancelled && addMode !== 'waitlist' && (
          <button
            onClick={() => { setAddMode('waitlist'); setSelectedMember(null); setAddConfirmMsg(null); setAddOverCapacity(false); }}
            style={{ ...btnBase, background: '#f3f4f6', color: '#374151', marginTop: 10, width: '100%' }}
          >
            + Add to waiting list
          </button>
        )}
        {canWrite && !isCancelled && addMode === 'waitlist' && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <MemberSearchInput onSelect={(m) => handleMemberSelect('waitlist', m)} disabled={adding} />
            {selectedMember && (
              <div style={{ fontSize: 13 }}>
                {addConfirmMsg ? (
                  <div style={{ color: '#dc2626', fontWeight: 600, marginBottom: 6 }}>{addConfirmMsg}</div>
                ) : (
                  <div style={{ color: '#374151', marginBottom: 6 }}>
                    Add <strong>{selectedMember.name}</strong> to the waiting list?
                  </div>
                )}
                {!addConfirmMsg && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={confirmAdd}
                      disabled={adding}
                      style={{ ...btnBase, background: '#6c63ff', color: '#fff', flex: 1, opacity: adding ? 0.6 : 1 }}
                    >
                      {adding ? 'Adding…' : 'Add to waiting list'}
                    </button>
                    <button
                      onClick={() => { setSelectedMember(null); setAddConfirmMsg(null); }}
                      style={{ ...btnBase, background: '#f3f4f6', color: '#374151' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {addConfirmMsg && (
                  <button
                    onClick={() => { setSelectedMember(null); setAddConfirmMsg(null); }}
                    style={{ ...btnBase, background: '#f3f4f6', color: '#374151' }}
                  >
                    OK
                  </button>
                )}
              </div>
            )}
            {!selectedMember && (
              <button
                onClick={() => setAddMode('none')}
                style={{ ...btnBase, background: '#f3f4f6', color: '#374151' }}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {canWrite && !isCancelled && (
        <div>
          <div style={sectionLabel}>Actions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Change time */}
            {!showChangeTime ? (
              <button
                onClick={openChangeTime}
                style={{ ...btnBase, background: '#f3f4f6', color: '#374151', textAlign: 'left' }}
              >
                Change time
              </button>
            ) : (
              <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Change event time</div>
                <div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Start</div>
                  <input
                    type="datetime-local"
                    value={newStartsAt}
                    onChange={(e) => setNewStartsAt(e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 13 }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>End</div>
                  <input
                    type="datetime-local"
                    value={newEndsAt}
                    onChange={(e) => setNewEndsAt(e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 13 }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={handleSaveTime}
                    disabled={savingTime}
                    style={{ ...btnBase, background: '#6c63ff', color: '#fff', flex: 1, opacity: savingTime ? 0.6 : 1 }}
                  >
                    {savingTime ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => setShowChangeTime(false)}
                    style={{ ...btnBase, background: '#f3f4f6', color: '#374151' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Cancel event */}
            {!showCancelConfirm ? (
              <button
                onClick={() => setShowCancelConfirm(true)}
                style={{ ...btnBase, background: '#fef2f2', color: '#dc2626', textAlign: 'left' }}
              >
                Cancel event
              </button>
            ) : (
              <div style={{ ...cardStyle, border: '1px solid #fecaca', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#dc2626' }}>Cancel this event?</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  This will cancel this event only. Future events in the series will not be affected.
                </div>
                <textarea
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="Reason for cancellation…"
                  rows={2}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                    borderRadius: 4, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical',
                  }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={handleCancel}
                    disabled={!cancelReason.trim() || cancelling}
                    style={{ ...btnBase, background: '#dc2626', color: '#fff', flex: 1, opacity: (!cancelReason.trim() || cancelling) ? 0.6 : 1 }}
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel event'}
                  </button>
                  <button
                    onClick={() => { setShowCancelConfirm(false); setCancelReason(''); }}
                    style={{ ...btnBase, background: '#f3f4f6', color: '#374151' }}
                  >
                    Keep event
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Remove member confirmation overlay */}
      {removingBooking && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9998,
          background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--gd-card-bg, #fff)', borderRadius: 10, padding: 24,
            width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Remove member?</div>
            <div style={{ fontSize: 13, color: '#374151', marginBottom: 16 }}>
              <strong>{removingBooking.member_name}</strong> will be removed from this event.<br />
              {session && (
                <span style={{ color: '#6b7280' }}>
                  {fmt(session.starts_at)} · {fmtTime(session.starts_at)} – {fmtTime(session.ends_at)}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={confirmRemove}
                disabled={removing}
                style={{ ...btnBase, background: '#dc2626', color: '#fff', flex: 1, opacity: removing ? 0.6 : 1 }}
              >
                {removing ? 'Removing…' : 'Remove'}
              </button>
              <button
                onClick={() => setRemovingBooking(null)}
                style={{ ...btnBase, background: '#f3f4f6', color: '#374151', flex: 1 }}
              >
                Keep member
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
