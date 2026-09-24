'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AssignedPlanDetailsModal } from './AssignedPlanDetailsModal';
import { AdditionalPeriodicServices } from './AdditionalPeriodicServices';
import { AssignedPlanConfiguration } from './AssignedPlanConfiguration';
import { AssignedPlanPromotions } from './AssignedPlanPromotions';
import type { AssignedPlanDetail } from './types';

const EDITABLE_STATUSES = ['draft', 'awaiting_payment'];
const CLOSEABLE_STATUSES = ['awaiting_payment', 'active', 'paused'];

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null;
}

function fmtMoney(v: string | number | null) {
  return v != null ? `€${parseFloat(String(v)).toFixed(2)}` : '—';
}

interface EditForm {
  starts_at: string;
  ends_at: string;
  final_price: string;
  discount_reason: string;
  discount_expires_at: string;
}

export function AssignedPlanExpandedRow({ assignedPlanId, onChanged }: {
  assignedPlanId: number;
  onChanged: () => void;
}) {
  const t = useTranslations('assigned_plans_page');
  const tStatus = useTranslations('status');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const loadedRef = useRef(false);

  const [detail, setDetail] = useState<AssignedPlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showDetails, setShowDetails] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [closeStep, setCloseStep] = useState<'none' | 'confirm' | 'warn'>('none');
  const [closeWarnings, setCloseWarnings] = useState<string[]>([]);

  // #613: impersonation-aware; actions that apply to the plan's status are shown, disabled when not permitted.
  const { canWrite: canWritePayments, isAdmin, readOnlyTitle } = useModuleAccess('PAYMENTS');

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadDetail() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<AssignedPlanDetail>(`/user-memberships/${assignedPlanId}`);
      setDetail(data);
    } catch {
      setError(t('expanded_error'));
    } finally {
      setLoading(false);
    }
  }

  function startEdit() {
    if (!detail) return;
    setEditForm({
      starts_at: detail.starts_at.slice(0, 10),
      ends_at: detail.ends_at ? detail.ends_at.slice(0, 10) : '',
      final_price: detail.final_price != null ? String(detail.final_price) : '',
      discount_reason: detail.discount_reason ?? '',
      discount_expires_at: detail.discount_expires_at ? detail.discount_expires_at.slice(0, 10) : '',
    });
    setSaveError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setEditForm(null);
    setSaveError(null);
  }

  async function saveEdit() {
    if (!editForm) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}`, {
        method: 'PUT',
        body: JSON.stringify({
          starts_at: editForm.starts_at,
          ends_at: editForm.ends_at || null,
          final_price: editForm.final_price,
          discount_reason: editForm.discount_reason || null,
          discount_expires_at: editForm.discount_expires_at || null,
        }),
      });
      setEditing(false);
      setEditForm(null);
      await loadDetail();
      onChanged();
    } catch (err: any) {
      setSaveError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function runAction(action: 'submit' | 'pause' | 'reactivate') {
    setActionBusy(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/${action}`, { method: 'POST' });
      await loadDetail();
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmClose() {
    setActionBusy(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/close`, { method: 'POST', body: JSON.stringify({}) });
      setCloseStep('none');
      await loadDetail();
      onChanged();
    } catch (err: any) {
      if (err.status === 409 && Array.isArray(err.body?.warnings)) {
        setCloseWarnings(err.body.warnings);
        setCloseStep('warn');
      } else {
        setCloseStep('none');
        toast(err.message ?? t('error_generic'));
      }
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmCloseWithWarnings() {
    setActionBusy(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/close`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
      setCloseStep('none');
      await loadDetail();
      onChanged();
    } catch (err: any) {
      setCloseStep('none');
      toast(err.message ?? t('error_generic'));
    } finally {
      setActionBusy(false);
    }
  }

  if (loading) {
    return <div style={panel}><p style={dim}>{t('expanded_loading')}</p></div>;
  }
  if (error || !detail) {
    return (
      <div style={panel}>
        <p style={{ color: '#c0392b', fontSize: 14, margin: 0 }}>
          {error}{' '}
          <button onClick={loadDetail} style={retryBtn}>{t('retry')}</button>
        </p>
      </div>
    );
  }

  const canEdit = EDITABLE_STATUSES.includes(detail.status);
  const canSubmit = detail.status === 'draft';
  const canPause = detail.status === 'active';
  const canReactivate = detail.status === 'paused';
  const canClose = CLOSEABLE_STATUSES.includes(detail.status);
  const write = { disabled: !canWritePayments, title: readOnlyTitle };
  const adminOnly = { disabled: !isAdmin, title: isAdmin ? undefined : readOnlyTitle };

  const menuItems = [
    { label: t('action_details'), onClick: () => setShowDetails(true) },
    ...(canEdit && !editing ? [{ label: t('action_edit'), onClick: startEdit, ...write }] : []),
    ...(canSubmit ? [{ label: t('action_submit'), onClick: () => runAction('submit'), ...write }] : []),
    ...(canPause ? [{ label: t('action_pause'), onClick: () => runAction('pause'), ...write }] : []),
    ...(canReactivate ? [{ label: t('action_reactivate'), onClick: () => runAction('reactivate'), ...write }] : []),
    ...(canClose ? [{ label: t('action_close'), onClick: () => setCloseStep('confirm'), danger: true, ...adminOnly }] : []),
  ];

  return (
    <div style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{detail.plan_name ?? '—'}</div>
          <div style={{ marginTop: 4 }}>
            <StatusBadge status={detail.lifecycle_status} label={tStatus(detail.lifecycle_status as any)} />
          </div>
        </div>
        <ContextMenu ariaLabel={t('actions_for', { plan: detail.plan_name ?? '' })} items={menuItems} />
      </div>

      {editing && editForm ? (
        <Section label={t('section_edit')}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <LabeledInput label={t('label_start_date')}>
              <input type="date" value={editForm.starts_at} onChange={(e) => setEditForm({ ...editForm, starts_at: e.target.value })} style={inputStyle} />
            </LabeledInput>
            <LabeledInput label={t('label_end_date')}>
              <input type="date" value={editForm.ends_at} onChange={(e) => setEditForm({ ...editForm, ends_at: e.target.value })} style={inputStyle} />
            </LabeledInput>
            <LabeledInput label={t('detail_effective_price')}>
              <input type="number" min={0} step="0.01" value={editForm.final_price} onChange={(e) => setEditForm({ ...editForm, final_price: e.target.value })} style={inputStyle} />
            </LabeledInput>
            <LabeledInput label={t('label_discount_reason')}>
              <input type="text" value={editForm.discount_reason} onChange={(e) => setEditForm({ ...editForm, discount_reason: e.target.value })} style={inputStyle} />
            </LabeledInput>
            <LabeledInput label={t('label_discount_expires_at')}>
              <input type="date" value={editForm.discount_expires_at} onChange={(e) => setEditForm({ ...editForm, discount_expires_at: e.target.value })} style={inputStyle} />
            </LabeledInput>
          </div>
          {saveError && <p style={{ color: '#c0392b', fontSize: 12, margin: '8px 0 0' }}>{saveError}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={cancelEdit} disabled={saving} style={editBtnStyle}>{t('cancel')}</button>
            <button onClick={saveEdit} disabled={saving} style={{ ...editBtnStyle, background: '#111', color: '#fff', borderColor: '#111' }}>
              {saving ? t('saving') : t('save_changes')}
            </button>
          </div>
        </Section>
      ) : null}

      <Section label={t('section_members')}>
        {detail.members.map((m) => (
          <div key={m.member_id} style={{ fontSize: 14, marginBottom: 2 }}>
            {m.name} {m.is_owner ? <span style={{ color: '#888', fontSize: 12 }}>({t('label_owner')})</span> : null}
          </div>
        ))}
      </Section>

      <Section label={t('section_pricing')}>
        <Field label={t('detail_effective_price')}>{fmtMoney(detail.final_price)}</Field>
        {detail.billing_policy && (
          <Field label={t('label_billing_frequency')}>
            {detail.billing_policy.recurring_billing_interval} / {detail.billing_policy.recurring_billing_unit}
          </Field>
        )}
        <Field label={t('label_start_date')}>{fmtDate(detail.starts_at)}</Field>
        <Field label={t('label_end_date')}>{detail.ends_at ? fmtDate(detail.ends_at) : t('open_ended')}</Field>
        {detail.closed_at && <Field label={t('label_closure_date')}>{fmtDate(detail.closed_at)}</Field>}
        {detail.next_billing_date && <Field label={t('label_next_billing_date')}>{fmtDate(detail.next_billing_date)}</Field>}
        {detail.discount_reason && <Field label={t('label_discount_reason')}>{detail.discount_reason}</Field>}
      </Section>

      {/* #635 stage 4: this section listed the Plan's Included Services
          (`plan_allowances`) until the concept was retired (migration 177). It
          now shows the assignment's own snapshot — the three benefit kinds as
          they were captured at assignment time, which since stage 3 is also what
          it bills. A later edit of the Plan or of a Sellable Item never moves
          these lines (§13/§17).

          Stage 6 (§9/§10/§15) gives it the Membership Plan's own structure —
          Billing & Duration above the three benefit kinds — and makes every
          section independently editable: editing one edits *this member's*
          snapshot, never the Plan it came from. */}
      <Section label={t('section_configuration')}>
        <AssignedPlanConfiguration
          assignedPlanId={assignedPlanId}
          planStatus={detail.status}
          snapshot={detail.snapshot}
          canWrite={canWritePayments}
          readOnlyTitle={readOnlyTitle}
          onChanged={() => { loadDetail(); onChanged(); }}
        />
      </Section>

      {/* #635 stage 7 (§16): one expandable card per applied Promotion, each
          showing the configuration *that application* froze — never the
          Promotion's current definition, which may have been edited or
          deleted since. */}
      <Section label={t('section_promotions')}>
        <AssignedPlanPromotions
          assignedPlanId={assignedPlanId}
          promotions={detail.promotions}
          canWrite={canWritePayments}
          readOnlyTitle={readOnlyTitle}
          onChanged={() => { loadDetail(); onChanged(); }}
        />
      </Section>

      {/* #631: Additional Periodic Services belong to the Assigned Plan itself —
          not to the Membership Plan and not to the Promotions above it. */}
      <Section label={t('section_additional_services')}>
        <AdditionalPeriodicServices
          assignedPlanId={assignedPlanId}
          planStartsAt={detail.starts_at}
          planStatus={detail.status}
          services={detail.additional_services ?? []}
          canWrite={canWritePayments}
          readOnlyTitle={readOnlyTitle}
          onChanged={() => { loadDetail(); onChanged(); }}
        />
      </Section>

      <Section label={t('section_billing_events')}>
        {!detail.billing_events.available ? (
          <p style={dim}>{detail.billing_events.reason}</p>
        ) : detail.billing_events.events.length === 0 ? (
          <p style={dim}>{t('no_billing_events')}</p>
        ) : (
          <div>
            {detail.billing_events.events.map((ev, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #f5f5f5' }}>
                <span>
                  {fmtDate(ev.date)}
                  {ev.projected && <span style={{ marginLeft: 8, color: '#888', fontSize: 11 }}>({t('billing_event_projected')})</span>}
                  {ev.promotion_affected && <span style={{ marginLeft: 8, color: '#6c63ff', fontSize: 11 }}>({t('billing_event_promotion_affected')})</span>}
                </span>
                <span>{fmtMoney(ev.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {showDetails && (
        <AssignedPlanDetailsModal detail={detail} onClose={() => setShowDetails(false)} />
      )}

      {/* #630: the menu action reads "Cancel" now, so the dialog can't label both
          its buttons with it — the confirm button spells out what it cancels and
          the dismiss button says what happens instead of a second "Cancel". */}
      <ConfirmDialog
        open={closeStep === 'confirm'}
        message={t('confirm_close')}
        confirmLabel={t('action_close_confirm')}
        cancelLabel={t('action_close_dismiss')}
        onConfirm={confirmClose}
        onCancel={() => setCloseStep('none')}
        busy={actionBusy}
      />
      <ConfirmDialog
        open={closeStep === 'warn'}
        message={t('confirm_close_with_warnings', { warnings: closeWarnings.join(', ') })}
        confirmLabel={t('action_close_confirm')}
        cancelLabel={t('action_close_dismiss')}
        onConfirm={confirmCloseWithWarnings}
        onCancel={() => setCloseStep('none')}
        busy={actionBusy}
      />
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={sectionLabelStyle}>{label}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 4 }}>
      <span style={{ color: '#888', minWidth: 140, fontSize: 13 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

function LabeledInput({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const panel: React.CSSProperties = { padding: '16px 24px' };
const dim: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase',
  letterSpacing: '0.07em', marginBottom: 8,
};
const inputStyle: React.CSSProperties = { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, minWidth: 140 };
const editBtnStyle: React.CSSProperties = {
  background: 'none', border: '1px solid #d0d0d0', borderRadius: 4,
  padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: '#444',
};
const retryBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#6c63ff', cursor: 'pointer',
  fontSize: 13, padding: 0, textDecoration: 'underline',
};
