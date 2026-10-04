'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { cardSurfaceStyle, primaryActionColors, primaryBtnSmall } from '@/components/ui';
import {
  formControlStyle, formErrorStyle, formFieldLabelStyle, inlineActionsRowStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { CalendarStatusBadge } from '@/components/CalendarStatusBadge';
import { MemberSearchInput, type MemberResult } from './MemberSearchInput';

interface ClassSession {
  id: number;
  class_type_name: string;
  starts_at: string;
  ends_at: string;
  /** #193: the scheduled trainer — the occurrence's own configuration, and what Edit writes. */
  trainer_membership_id: number | null;
  trainer_name: string | null;
  /** #193: who is actually covering it, set through `PUT /:id/effective-trainer`. */
  effective_trainer_name: string | null;
  space_id: number | null;
  space_name: string | null;
  center_id: number | null;
  /**
   * #647: the occurrence's single Professional Service, inherited from the
   * Activity Type. Read-only here — #980's `Q1 multi` makes it a multi-valued
   * relation in a later stage, and it is modelled once with #973's.
   */
  professional_service_name: string | null;
  effective_capacity: number;
  effective_waitlist_mode: 'disabled' | 'open' | 'closed';
  booked_count: number;
  status: string;
  /**
   * #977 — the event's execution status as the API derives it: `scheduled`,
   * `not_used` (it ended with nobody booked), `completed` or `cancelled`.
   * Read, never re-derived: the panel must not be able to call a slot unused
   * that the calendar beside it calls scheduled.
   */
  execution_status: 'scheduled' | 'not_used' | 'completed' | 'cancelled' | null;
}

interface Booking {
  id: number;
  member_id: number;
  member_name: string;
  member_email: string;
  status: string;
  waitlist_position: number | null;
}

interface Space { id: number; name: string; status?: string; center_id?: number | null }
interface Trainer { gym_membership_id: number; name: string }

interface Props {
  sessionId: number;
  onClose: () => void;
  onMutated: () => void; // refetch calendar after cancel / time change
  canWrite: boolean;
  /**
   * #980 §6/§7: the lookups the Edit mode selects from. They are the page's
   * own `/spaces` and `/trainers` reads rather than a second fetch of each
   * from inside the panel — the calendar already holds both for its filter
   * bar and its event form.
   */
  spaces: Space[];
  trainers: Trainer[];
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
  ...cardSurfaceStyle,
  background: 'var(--gd-bg, #f9fafb)',
  padding: '12px 14px',
};

const btnBase: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 6, fontSize: 13,
  fontWeight: 600, cursor: 'pointer', border: 'none',
};

// #481: staff-override-able access-hook rejections (eligibility + entitlement).
// Mirrors the existing over-capacity "book anyway" pattern below — on one of
// these, offer a confirm-and-retry with `override_eligibility: true` rather
// than a hard failure toast.
// `allowance_exhausted` is gone with Included Services (#635 stage 4): a plan no
// longer caps bookings per activity type, so the gates that can reject are
// eligibility and center coverage.
const OVERRIDABLE_ACCESS_CODES = ['plan_not_eligible', 'plan_required', 'center_not_covered'];

// #979: the 409 codes the API answers when the trainer or space a cancellation
// freed has been taken by another session since. All four mean one thing to
// somebody reactivating an event — the slot is no longer theirs — so they share
// a line rather than needing four of their own.
const SLOT_CONFLICT_CODES = [
  'slot_fully_occupied', 'slot_not_shareable', 'activity_not_shareable', 'sharing_not_authorized',
];

// The execution statuses with a `calendar.status_*` translation. next-intl has
// no locale fallback and no `defaultValue` option, so the label is decided
// before `t()` is called (CLAUDE.md) and anything else shows its raw value.
const EXECUTION_STATUS_KEYS = ['scheduled', 'not_used', 'completed', 'cancelled', 'draft'];

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function ClassSessionDetailPanel({
  sessionId, onClose, onMutated, canWrite, spaces, trainers,
}: Props) {
  const t = useTranslations('calendar');
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
  // #481: staff-override confirm for an access-hook rejection (eligibility/entitlement).
  const [accessOverrideError, setAccessOverrideError] = useState<{ code: string; message: string } | null>(null);
  const [overriding, setOverriding] = useState(false);

  // #977 — Mark as completed flow (§4/§11): a past event with bookings is
  // never completed automatically, so this is the explicit confirmation.
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  // #979 — Reactivate flow (§1/§2): the one action a cancelled event offers.
  const [showReactivateConfirm, setShowReactivateConfirm] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [reactivateError, setReactivateError] = useState<string | null>(null);

  // Cancel flow
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  // #980 §8 — Edit mode for the occurrence's own configuration (Trainer,
  // Space). The panel reads until `Edit` is chosen, exactly as an expanded
  // list card does (#797), and the draft lives here rather than in the info
  // card so Cancel can throw it away.
  const [editingDetails, setEditingDetails] = useState(false);
  const [draftTrainerId, setDraftTrainerId] = useState('');
  const [draftSpaceId, setDraftSpaceId] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

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
      // #481: eligibility/entitlement rejections offer a staff override instead
      // of a hard failure, mirroring the existing over-capacity confirm above.
      const code = err.body?.code;
      if (code && OVERRIDABLE_ACCESS_CODES.includes(code)) {
        setAccessOverrideError({ code, message: err.message ?? 'This member cannot be added to this event.' });
      } else {
        toast(err.message ?? 'Failed to add member');
      }
    } finally {
      setAdding(false);
    }
  }

  // #481: retry the same add request with override_eligibility, after staff
  // confirms past the eligibility/entitlement warning.
  async function confirmOverrideAdd() {
    if (!selectedMember || !session) return;
    setOverriding(true);
    try {
      const body: Record<string, any> = {
        member_id: selectedMember.id, class_session_id: session.id, override_eligibility: true,
      };
      if (addMode === 'enroll' && addOverCapacity) body.force = true;
      if (addMode === 'waitlist') body.waitlist = true;
      await apiFetch('/bookings', { method: 'POST', body: JSON.stringify(body) });
      setAccessOverrideError(null);
      setSelectedMember(null);
      setAddConfirmMsg(null);
      setAddOverCapacity(false);
      setAddMode('none');
      await load();
    } catch (err: any) {
      toast(err.message ?? 'Failed to add member');
    } finally {
      setOverriding(false);
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

  // ── Reactivate event ──────────────────────────────────────────────────────
  // #979 — undo a cancellation. Unlike `Cancel event`, which closes the panel,
  // this reloads and stays: §8 wants the status, the capacity, the enrolled
  // members and the waiting list to read as restored immediately, and those
  // are the very sections above this button. Nothing is re-booked — the
  // bookings were never cancelled with the event — so there is no second
  // request to make here.
  async function handleReactivate() {
    setReactivating(true);
    setReactivateError(null);
    try {
      await apiFetch(`/class-sessions/${sessionId}/reactivate`, { method: 'POST' });
      setShowReactivateConfirm(false);
      onMutated();
      await load();
    } catch (err: any) {
      const code = err?.body?.code;
      setReactivateError(
        code && SLOT_CONFLICT_CODES.includes(code) ? t('reactivate_blocked_slot')
        : code === 'not_cancelled' ? t('reactivate_blocked_not_cancelled')
        : err.message ?? t('error_generic'),
      );
    } finally {
      setReactivating(false);
    }
  }

  // ── Edit details (#980 stage 1) ────────────────────────────────────────────
  // Trainer and Space are the occurrence's own columns (migration 082), so
  // editing them here overrides the Activity Type's defaults for this one
  // occurrence and changes nothing on the Activity itself (§12).
  function openEditDetails() {
    if (!session) return;
    setDraftTrainerId(session.trainer_membership_id ? String(session.trainer_membership_id) : '');
    setDraftSpaceId(session.space_id ? String(session.space_id) : '');
    setDetailsError(null);
    setEditingDetails(true);
  }

  function cancelEditDetails() {
    setEditingDetails(false);
    setDetailsError(null);
  }

  async function handleSaveDetails() {
    if (!session) return;
    // Only a field the admin actually changed is sent: the `PUT` treats a
    // present key as an instruction to write it, and re-sending the stored
    // space would 400 on a space the gym has since deactivated — which is
    // exactly the value the panel must still be able to display.
    const body: Record<string, unknown> = {};
    const nextTrainer = draftTrainerId ? Number(draftTrainerId) : null;
    const nextSpace   = draftSpaceId   ? Number(draftSpaceId)   : null;
    if (nextTrainer !== (session.trainer_membership_id ?? null)) body.trainer_membership_id = nextTrainer;
    if (nextSpace   !== (session.space_id ?? null))              body.space_id              = nextSpace;

    if (Object.keys(body).length === 0) { setEditingDetails(false); return; }

    setSavingDetails(true);
    setDetailsError(null);
    try {
      // §9: one request, so the UPDATE is one statement — a failure leaves the
      // occurrence exactly as it was rather than half written.
      await apiFetch(`/class-sessions/${sessionId}`, { method: 'PUT', body: JSON.stringify(body) });
      setEditingDetails(false);
      onMutated();
      await load();
    } catch (err: any) {
      const code = err?.body?.code;
      setDetailsError(
        code && SLOT_CONFLICT_CODES.includes(code) ? t('details_blocked_slot')
        : err.message ?? t('error_generic'),
      );
    } finally {
      setSavingDetails(false);
    }
  }

  // ── Change time ───────────────────────────────────────────────────────────
  function openChangeTime() {
    if (!session) return;
    setNewStartsAt(toDateTimeLocal(new Date(session.starts_at)));
    setNewEndsAt(toDateTimeLocal(new Date(session.ends_at)));
    setShowChangeTime(true);
  }

  // #977 §11 — the explicit confirmation that the session took place. It
  // preserves every booking and every attendance record (the route writes the
  // event's status and nothing else), and who confirmed it and when is the
  // audit row's. The 400 it can answer is actionable rather than generic:
  // attendance still pending, or no trainer on the event.
  async function handleMarkCompleted() {
    setCompleting(true);
    setCompleteError(null);
    try {
      await apiFetch(`/class-sessions/${sessionId}/complete`, { method: 'POST' });
      setShowCompleteConfirm(false);
      onMutated();
      await load();
    } catch (err: any) {
      const pending = Number(err?.body?.pending_count ?? 0);
      setCompleteError(
        err?.body?.missing_trainer ? t('complete_blocked_trainer')
        : pending > 0 ? t('complete_blocked_attendance', { count: pending })
        : err.message ?? t('error_generic'),
      );
    } finally {
      setCompleting(false);
    }
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
  const waitlistOpen = session.effective_waitlist_mode === 'open';
  // #977 — the four execution statuses, read from the API. `scheduled` is
  // also what a past event with bookings reads until somebody confirms it
  // (§13), which is exactly when the action below is worth offering; a
  // `not_used` slot may still be completed deliberately, which is how
  // `Completed · 0 attendees` is reached (§5).
  const executionStatus = session.execution_status ?? session.status;
  const hasEnded = new Date(session.ends_at).getTime() <= Date.now();
  const canMarkCompleted = canWrite && hasEnded
    && (executionStatus === 'scheduled' || executionStatus === 'not_used');
  const statusLabel = EXECUTION_STATUS_KEYS.includes(executionStatus)
    ? t(`status_${executionStatus}` as any)
    : executionStatus.toUpperCase();

  // #980 §6/§7 — what each lookup offers. A space is offered when it belongs
  // to this occurrence's own center and is active, which is the rule the route
  // enforces (`validateSessionRefs`); the value the occurrence already holds is
  // offered too, as a *disabled* option, so an occurrence sitting on a space
  // the gym has since deactivated still reads correctly instead of appearing
  // to have none. The same for a trainer whose role has changed since.
  const selectableSpaces = spaces.filter((sp) =>
    (sp.status === undefined || sp.status === 'active')
    && (sp.center_id == null || session.center_id == null || sp.center_id === session.center_id));
  const spaceOptions = [
    ...selectableSpaces.map((sp) => ({ id: sp.id, name: sp.name, unavailable: false })),
    ...(session.space_id && !selectableSpaces.some((sp) => sp.id === session.space_id)
      ? [{ id: session.space_id, name: session.space_name ?? String(session.space_id), unavailable: true }]
      : []),
  ];
  const trainerOptions = [
    ...trainers.map((tr) => ({ gym_membership_id: tr.gym_membership_id, name: tr.name, unavailable: false })),
    ...(session.trainer_membership_id
      && !trainers.some((tr) => tr.gym_membership_id === session.trainer_membership_id)
      ? [{
          gym_membership_id: session.trainer_membership_id,
          name: session.trainer_name ?? String(session.trainer_membership_id),
          unavailable: true,
        }]
      : []),
  ];

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
        {/* #980 §8 — read-only mode: the occurrence's current configuration,
            as values. A row is kept with a `—` rather than hidden when the
            field is unset, so the card does not change shape when `Edit`
            opens and so "no trainer yet" is visible rather than absent. (The
            no-placeholder rule in #981 is the *event box*'s, where a dangling
            `·` is the whole problem; a detail card is the app's `—`.) */}
        {!editingDetails && (
          <>
            <DetailRow label={t('event_professional_service')} value={session.professional_service_name} />
            <DetailRow label={t('event_trainer')} value={session.trainer_name} />
            {/* #193: who is covering it, when that is somebody else. Not part
                of this form — it is confirmed through its own route. */}
            {session.effective_trainer_name && session.effective_trainer_name !== session.trainer_name && (
              <DetailRow label={t('event_covering_trainer')} value={session.effective_trainer_name} />
            )}
            <DetailRow label={t('event_space')} value={session.space_name} />
          </>
        )}

        {/* Edit mode: the same two fields as controls, in the card they were
            values in. The Professional Service stays a value — `Q1 multi`
            makes it a multi-valued relation in a later stage, and a control
            the `PUT` cannot carry does not belong in a form (#974). */}
        {editingDetails && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 12 }}>
            <DetailRow label={t('event_professional_service')} value={session.professional_service_name} />
            <div>
              <label style={formFieldLabelStyle} htmlFor="session-trainer">{t('event_trainer')}</label>
              <select
                id="session-trainer"
                value={draftTrainerId}
                onChange={(e) => setDraftTrainerId(e.target.value)}
                disabled={savingDetails}
                style={formControlStyle}
              >
                <option value="">—</option>
                {trainerOptions.map((tr) => (
                  <option key={tr.gym_membership_id} value={tr.gym_membership_id} disabled={tr.unavailable}>
                    {tr.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={formFieldLabelStyle} htmlFor="session-space">{t('event_space')}</label>
              <select
                id="session-space"
                value={draftSpaceId}
                onChange={(e) => setDraftSpaceId(e.target.value)}
                disabled={savingDetails}
                style={formControlStyle}
              >
                <option value="">—</option>
                {spaceOptions.map((sp) => (
                  <option key={sp.id} value={sp.id} disabled={sp.unavailable}>{sp.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div style={{ fontSize: 13 }}>
          <span style={{ color: '#6b7280' }}>Capacity: </span>
          <span style={{ fontWeight: 600, color: enrolled.length >= session.effective_capacity ? '#ef4444' : '#059669' }}>
            {enrolled.length} / {session.effective_capacity}
          </span>
        </div>
        {/* #977 §7 — the execution status, in the calendar's own badge rather
            than a red CANCELLED line of this panel's own: one status
            vocabulary, one look, and `Not used` and `Completed` are as worth
            saying here as `Cancelled` ever was. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{t('event_status')}:</span>
          <CalendarStatusBadge status={executionStatus} label={statusLabel} />
        </div>

        {/* §8/§9 — Cancel / Save Changes, in the card whose fields they
            commit (#929), with the form's one error line above them. */}
        {editingDetails && (
          <>
            {detailsError && <p style={formErrorStyle}>{detailsError}</p>}
            <div style={inlineActionsRowStyle}>
              <button
                onClick={handleSaveDetails}
                disabled={savingDetails}
                style={{ ...primaryBtnSmall(), opacity: savingDetails ? 0.6 : 1 }}
              >
                {savingDetails ? t('saving') : t('save_changes')}
              </button>
              <button onClick={cancelEditDetails} disabled={savingDetails} style={secondaryBtnSmall}>
                {t('cancel')}
              </button>
            </div>
          </>
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
            style={{ ...btnBase, ...primaryActionColors, marginTop: 10, width: '100%' }}
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
                      style={{ ...btnBase, ...primaryActionColors, flex: 1, opacity: adding ? 0.6 : 1 }}
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
        {canWrite && !isCancelled && !waitlistOpen && (
          <p style={{ fontSize: 12.5, color: '#6b7280', marginTop: 10 }}>
            The waiting list for this activity is {session.effective_waitlist_mode === 'closed' ? 'closed' : 'disabled'}.
          </p>
        )}
        {canWrite && !isCancelled && waitlistOpen && addMode !== 'waitlist' && (
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
                      style={{ ...btnBase, ...primaryActionColors, flex: 1, opacity: adding ? 0.6 : 1 }}
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
      {canWrite && (
        <div>
          <div style={sectionLabel}>Actions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* #979 §1 — a cancelled event offers exactly one action, and the
                three below are not among them: completing it, moving it or
                cancelling it again all act on a slot nobody is holding. */}
            {isCancelled ? (
              !showReactivateConfirm ? (
                <button
                  onClick={() => { setShowReactivateConfirm(true); setReactivateError(null); }}
                  style={{ ...btnBase, ...primaryActionColors, textAlign: 'left' }}
                >
                  {t('reactivate')}
                </button>
              ) : (
                /* §2 — the confirmation, as this panel's own inline confirm
                   card: the shape `Mark as completed` and `Cancel event`
                   already use, so a cancelled event's panel does not grow a
                   second overlay style of its own. */
                <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{t('reactivate_confirm_title')}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{t('reactivate_confirm_message')}</div>
                  {reactivateError && (
                    <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 600 }}>{reactivateError}</div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={handleReactivate}
                      disabled={reactivating}
                      style={{ ...btnBase, ...primaryActionColors, flex: 1, opacity: reactivating ? 0.6 : 1 }}
                    >
                      {reactivating ? t('reactivating') : t('reactivate')}
                    </button>
                    <button
                      onClick={() => { setShowReactivateConfirm(false); setReactivateError(null); }}
                      disabled={reactivating}
                      style={{ ...btnBase, background: '#f3f4f6', color: '#374151' }}
                    >
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              )
            ) : (
            <>
            {/* #980 §8 — the one entry point into Edit mode, beside the
                panel's other actions. Absent while the form is open, so the
                panel is never offering to open a form it is already showing
                (#797), and absent on a cancelled event, whose trainer and
                space nobody is holding (#979 §1). */}
            {!editingDetails && (
              <button
                onClick={openEditDetails}
                style={{ ...btnBase, background: '#f3f4f6', color: '#374151', textAlign: 'left' }}
              >
                {t('edit_details')}
              </button>
            )}

            {/* #977 §4/§11 — Mark as completed. Offered only once the event
                has ended and only while it is awaiting confirmation: a future
                event needs no action from the teacher (§2), and an empty slot
                that passed is already `Not used` without one (§3). */}
            {canMarkCompleted && (
              !showCompleteConfirm ? (
                <button
                  onClick={() => { setShowCompleteConfirm(true); setCompleteError(null); }}
                  style={{ ...btnBase, ...primaryActionColors, textAlign: 'left' }}
                >
                  {t('mark_completed')}
                </button>
              ) : (
                <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{t('mark_completed_confirm_title')}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{t('mark_completed_confirm_message')}</div>
                  {completeError && (
                    <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 600 }}>{completeError}</div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={handleMarkCompleted}
                      disabled={completing}
                      style={{ ...btnBase, ...primaryActionColors, flex: 1, opacity: completing ? 0.6 : 1 }}
                    >
                      {completing ? t('marking_completed') : t('mark_completed')}
                    </button>
                    <button
                      onClick={() => { setShowCompleteConfirm(false); setCompleteError(null); }}
                      disabled={completing}
                      style={{ ...btnBase, background: '#f3f4f6', color: '#374151' }}
                    >
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              )
            )}

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
                    style={{ ...btnBase, ...primaryActionColors, flex: 1, opacity: savingTime ? 0.6 : 1 }}
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
            </>
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
              <span style={{ color: '#6b7280' }}>
                {fmt(session.starts_at)} · {fmtTime(session.starts_at)} – {fmtTime(session.ends_at)}
              </span>
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

      {/* #481: eligibility/entitlement override confirmation overlay */}
      {accessOverrideError && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9998,
          background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--gd-card-bg, #fff)', borderRadius: 10, padding: 24,
            width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: '#b45309' }}>⚠ Booking restriction</div>
            <div style={{ fontSize: 13, color: '#374151', marginBottom: 8 }}>
              {accessOverrideError.message}
            </div>
            <div style={{ fontSize: 13, color: '#374151', marginBottom: 16 }}>
              Do you want to add them anyway?
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={confirmOverrideAdd}
                disabled={overriding}
                style={{ ...btnBase, background: '#b45309', color: '#fff', flex: 1, opacity: overriding ? 0.6 : 1 }}
              >
                {overriding ? 'Adding…' : 'Add anyway'}
              </button>
              <button
                onClick={() => setAccessOverrideError(null)}
                disabled={overriding}
                style={{ ...btnBase, background: '#f3f4f6', color: '#374151', flex: 1 }}
              >
                Cancel
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

/**
 * One `Label: value` row of the info card, in the card's own compact voice.
 *
 * It is deliberately not `CardDetailRow` (#929): that is the Membership Plan
 * card's 200px-label layout, and this panel is 380px wide by default. An unset
 * value reads `—` rather than disappearing, so the card keeps its shape when
 * Edit opens.
 */
function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ fontSize: 13, marginBottom: 4 }}>
      <span style={{ color: '#6b7280' }}>{label}: </span>
      {value?.trim() ? value : '—'}
    </div>
  );
}
