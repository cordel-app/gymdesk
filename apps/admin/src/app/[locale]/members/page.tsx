'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { MemberExpandedRow } from './MemberExpandedRow';
import { MemberDetailModal } from './MemberDetailModal';
import { MemberEditForm, MemberEditFormValues } from './MemberEditForm';

interface Plan {
  id: number;
  name: string;
  base_price: string;
}

interface Member {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  date_of_birth: string | null;
  gender: string | null;
  address: string | null;
  emergency_contact: string | null;
  notes: string | null;
  fare_id: number | null;
  fare_name: string | null;
  clerk_user_id: string | null;
  invitation_id: string | null;
  account_status: 'active' | 'invited' | 'not_enrolled';
  enrollment_status: string | null;
  payment_status: string | null;
}

const emptyForm = {
  name: '',
  email: '',
  phone: '',
  fare_id: '',
};

const emptyEditForm: MemberEditFormValues = {
  name: '',
  phone: '',
  date_of_birth: '',
  gender: '',
  address: '',
  emergency_contact: '',
  notes: '',
};

const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'expired'] as const;
const ENROLLMENT_STATUSES = ['active', 'paused', 'cancelled', 'expired'] as const;

export default function MembersPage() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, isSuperadmin, loading: gymLoading } = useGym();
  const { centers } = useCenter();
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [centerFilter, setCenterFilter] = useState<string>(searchParams.get('centerId') ?? '');
  const [searchQuery, setSearchQuery] = useState<string>(searchParams.get('q') ?? '');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<string>(searchParams.get('payment_status') ?? '');
  const [enrollmentStatusFilter, setEnrollmentStatusFilter] = useState<string>(searchParams.get('enrollment_status') ?? '');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<Member | null>(null);
  const [expandedMemberIds, setExpandedMemberIds] = useState<Set<number>>(new Set());

  const showCenters = centers.length > 1;
  const [assignedCenterIds, setAssignedCenterIds] = useState<Set<number>>(new Set());
  const [defaultCenterId, setDefaultCenterId] = useState<number | null>(null);

  // Inline editing (Member is edited on the expanded row, not in a modal — #365)
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<MemberEditFormValues>(emptyEditForm);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [editAssignedCenterIds, setEditAssignedCenterIds] = useState<Set<number>>(new Set());
  const [editDefaultCenterId, setEditDefaultCenterId] = useState<number | null>(null);

  useEffect(() => {
    if (editingId === null) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editingId]);

  const canManageTraining = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'TRAINING'));

  const buildParams = useCallback(() => {
    const p = new URLSearchParams();
    if (centerFilter) p.set('centerId', centerFilter);
    if (searchQuery.trim()) p.set('q', searchQuery.trim());
    if (paymentStatusFilter) p.set('payment_status', paymentStatusFilter);
    if (enrollmentStatusFilter) p.set('enrollment_status', enrollmentStatusFilter);
    return p;
  }, [centerFilter, searchQuery, paymentStatusFilter, enrollmentStatusFilter]);

  async function load() {
    if (!activeGymId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = buildParams();
      const [membersData, plansData] = await Promise.all([
        apiFetch<Member[]>(`/members${params.toString() ? `?${params}` : ''}`),
        apiFetch<Plan[]>('/membership-plans?status=active').catch(() => []),
      ]);
      setMembers(membersData);
      setPlans(plansData);
    } catch (err: any) {
      setMembers([]);
      toast(err.message ?? t('members.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!gymLoading) load();
  }, [activeGymId, gymLoading, centerFilter, searchQuery, paymentStatusFilter, enrollmentStatusFilter]);

  function syncUrl(updates: { centerId?: string; q?: string; payment_status?: string; enrollment_status?: string }) {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) p.set(k, v); else p.delete(k);
    }
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function handleCenterFilter(v: string) {
    setCenterFilter(v);
    syncUrl({ centerId: v });
  }

  function handleSearch(v: string) {
    setSearchQuery(v);
    syncUrl({ q: v });
  }

  function handlePaymentFilter(v: string) {
    setPaymentStatusFilter(v);
    syncUrl({ payment_status: v });
  }

  function handleEnrollmentFilter(v: string) {
    setEnrollmentStatusFilter(v);
    syncUrl({ enrollment_status: v });
  }

  function openAdd() {
    setForm(emptyForm);
    setError(null);
    setAssignedCenterIds(centers.length === 1 ? new Set([centers[0].id]) : new Set());
    setDefaultCenterId(centers.length === 1 ? centers[0].id : null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setForm(emptyForm);
    setError(null);
    setAssignedCenterIds(new Set());
    setDefaultCenterId(null);
  }

  function toggleCenter(id: number, checked: boolean) {
    const next = new Set(assignedCenterIds);
    if (checked) next.add(id); else next.delete(id);
    setAssignedCenterIds(next);
    if (!checked && defaultCenterId === id) setDefaultCenterId(null);
    if (checked && next.size === 1) setDefaultCenterId(id);
  }

  async function handleAdd() {
    if (!form.name.trim() || !form.email.trim()) {
      setError(t('members.error_required'));
      return;
    }
    if (showCenters) {
      if (assignedCenterIds.size === 0) { setError(t('members.error_no_center')); return; }
      if (defaultCenterId == null || !assignedCenterIds.has(defaultCenterId)) { setError(t('members.error_default_not_assigned')); return; }
    }
    setSaving(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
        fare_id: form.fare_id ? parseInt(form.fare_id) : null,
      };
      if (showCenters) {
        body.center_ids = Array.from(assignedCenterIds);
        body.default_center_id = defaultCenterId;
      }
      await apiFetch('/members', { method: 'POST', body: JSON.stringify(body) });
      closeModal();
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  function guardUnsaved(action: () => void) {
    if (editingId !== null) setPendingAction(() => action);
    else action();
  }

  async function startEdit(m: Member) {
    setEditingId(m.id);
    setEditForm({
      name: m.name,
      phone: m.phone ?? '',
      date_of_birth: m.date_of_birth?.slice(0, 10) ?? '',
      gender: m.gender ?? '',
      address: m.address ?? '',
      emergency_contact: m.emergency_contact ?? '',
      notes: m.notes ?? '',
    });
    setEditError(null);
    setExpandedMemberIds((prev) => {
      const next = new Set(prev);
      next.add(m.id);
      return next;
    });
    if (showCenters) {
      try {
        const rows = await apiFetch<{ center_id: number; is_default: boolean }[]>(`/members/${m.id}/centers`);
        setEditAssignedCenterIds(new Set(rows.map((r) => r.center_id)));
        setEditDefaultCenterId(rows.find((r) => r.is_default)?.center_id ?? null);
      } catch {
        setEditAssignedCenterIds(new Set());
        setEditDefaultCenterId(null);
      }
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(emptyEditForm);
    setEditError(null);
    setEditAssignedCenterIds(new Set());
    setEditDefaultCenterId(null);
  }

  function toggleEditCenter(id: number, checked: boolean) {
    const next = new Set(editAssignedCenterIds);
    if (checked) next.add(id); else next.delete(id);
    setEditAssignedCenterIds(next);
    if (!checked && editDefaultCenterId === id) setEditDefaultCenterId(null);
    if (checked && next.size === 1) setEditDefaultCenterId(id);
  }

  async function saveEdit() {
    if (!editForm.name.trim()) { setEditError(t('members.error_required')); return; }
    if (showCenters) {
      if (editAssignedCenterIds.size === 0) { setEditError(t('members.error_no_center')); return; }
      if (editDefaultCenterId == null || !editAssignedCenterIds.has(editDefaultCenterId)) { setEditError(t('members.error_default_not_assigned')); return; }
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const editedId = editingId!;
      const body: Record<string, unknown> = {
        name: editForm.name.trim(),
        phone: editForm.phone.trim() || null,
        date_of_birth: editForm.date_of_birth || null,
        gender: editForm.gender || null,
        address: editForm.address.trim() || null,
        emergency_contact: editForm.emergency_contact.trim() || null,
        notes: editForm.notes.trim() || null,
      };
      await apiFetch(`/members/${editedId}`, { method: 'PUT', body: JSON.stringify(body) });
      if (showCenters) {
        await apiFetch(`/members/${editedId}/centers`, {
          method: 'PUT',
          body: JSON.stringify({ center_ids: Array.from(editAssignedCenterIds), default_center_id: editDefaultCenterId }),
        });
      }
      setEditingId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('members.error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm(t('members.confirm_delete'))) return;
    try {
      await apiFetch(`/members/${id}`, { method: 'DELETE' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'));
    }
  }

  async function handleInvite(id: number) {
    try {
      await apiFetch(`/members/${id}/invite`, { method: 'POST' });
      toast(t('members.toast_invited'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'), 'error');
    }
  }

  async function handleReinvite(id: number) {
    try {
      await apiFetch(`/members/${id}/reinvite`, { method: 'POST' });
      toast(t('members.toast_reinvited'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'), 'error');
    }
  }

  async function handleRevokeInvite(id: number) {
    if (!confirm(t('members.confirm_revoke'))) return;
    try {
      await apiFetch(`/members/${id}/revoke-invite`, { method: 'POST' });
      toast(t('members.toast_revoked'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'), 'error');
    }
  }

  function toggleExpand(m: Member) {
    setExpandedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
      return next;
    });
  }

  function buildActions(m: Member): ContextMenuItem[] {
    const linked = !!m.clerk_user_id;
    const pendingInvite = !linked && !!m.invitation_id;
    const items: ContextMenuItem[] = [];

    if (!linked && !pendingInvite) {
      items.push({ label: t('members.action_invite'), onClick: () => guardUnsaved(() => handleInvite(m.id)) });
    }
    if (pendingInvite) {
      items.push({ label: t('members.action_reinvite'), onClick: () => guardUnsaved(() => handleReinvite(m.id)) });
      items.push({ label: t('members.action_revoke'), onClick: () => guardUnsaved(() => handleRevokeInvite(m.id)) });
    }
    items.push({ label: t('members.edit'), onClick: () => guardUnsaved(() => startEdit(m)) });
    items.push({ label: t('members.action_details'), onClick: () => guardUnsaved(() => setDetailFor(m)) });
    items.push({ label: t('members.delete'), onClick: () => guardUnsaved(() => handleDelete(m.id)), danger: true });

    return items;
  }

  const columns: Column<Member>[] = [
    {
      header: t('members.col_name'),
      render: (m) => (
        <div style={{ fontWeight: 500 }}>{m.name}</div>
      ),
    },
    {
      header: t('members.col_payment_status'),
      width: 120,
      render: (m) => m.payment_status
        ? <StatusBadge status={m.payment_status} label={t(`members.payment_status_${m.payment_status}`) || m.payment_status} />
        : <span style={{ color: '#bbb' }}>{t('members.payment_status_none')}</span>,
    },
    {
      header: t('members.col_enrollment_status'),
      width: 120,
      render: (m) => m.enrollment_status
        ? <StatusBadge status={m.enrollment_status} label={t(`members.enrollment_status_${m.enrollment_status}`) || m.enrollment_status} />
        : <span style={{ color: '#bbb' }}>{t('members.enrollment_status_none')}</span>,
    },
    {
      header: t('members.col_actions'),
      width: 60,
      render: (m) => (
        <ContextMenu
          items={buildActions(m)}
          ariaLabel={`${t('members.col_actions')} — ${m.name}`}
        />
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>{t('members.title')}</h1>
        <button onClick={() => guardUnsaved(openAdd)} style={btnStyle('#6c63ff')}>{t('members.add')}</button>
      </div>

      {/* Toolbar: search + filters */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={t('members.placeholder_search')}
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, minWidth: 200 }}
        />
        {showCenters && (
          <select
            value={centerFilter}
            onChange={(e) => handleCenterFilter(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff' }}
          >
            <option value="">{t('members.all_centers')}</option>
            {centers.map((c) => (
              <option key={c.id} value={String(c.id)}>{c.name}</option>
            ))}
          </select>
        )}
        <StatusFilter
          value={paymentStatusFilter}
          onChange={handlePaymentFilter}
          allLabel={t('members.all_payment_statuses')}
          options={PAYMENT_STATUSES.map((s) => ({ value: s, label: t(`members.payment_status_${s}`) }))}
        />
        <StatusFilter
          value={enrollmentStatusFilter}
          onChange={handleEnrollmentFilter}
          allLabel={t('members.all_enrollment_statuses')}
          options={ENROLLMENT_STATUSES.map((s) => ({ value: s, label: t(`members.enrollment_status_${s}`) }))}
        />
      </div>

      <DataTable
        columns={columns}
        rows={members}
        rowKey={(m) => m.id}
        loading={loading}
        loadingText={t('members.loading')}
        emptyText={t('members.empty')}
        expandedRowKeys={expandedMemberIds}
        onToggleExpand={(m) => guardUnsaved(() => toggleExpand(m))}
        renderExpanded={(m) => (
          <>
            {editingId === m.id && (
              <MemberEditForm
                form={editForm}
                error={editError}
                saving={editSaving}
                showCenters={showCenters}
                centers={centers}
                assignedCenterIds={editAssignedCenterIds}
                defaultCenterId={editDefaultCenterId}
                onChange={setEditForm}
                onToggleCenter={toggleEditCenter}
                onDefaultCenterChange={setEditDefaultCenterId}
                onSave={saveEdit}
                onCancel={cancelEdit}
              />
            )}
            <MemberExpandedRow memberId={m.id} canManageTraining={canManageTraining} />
          </>
        )}
      />

      {/* Add modal (editing a member happens inline on the expanded row — #365) */}
      {modalOpen && (
        <div style={overlayStyle} onClick={closeModal}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px' }}>{t('members.modal_add')}</h2>

            <label style={labelStyle}>{t('members.label_name')}</label>
            <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('members.placeholder_name')} autoFocus />

            <label style={labelStyle}>{t('members.label_email')}</label>
            <input style={inputStyle} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t('members.placeholder_email')} />

            <label style={labelStyle}>{t('members.label_phone')}</label>
            <input style={inputStyle} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t('members.placeholder_phone')} />

            {plans.length > 0 && (
              <>
                <label style={labelStyle}>{t('members.label_fare')}</label>
                <select style={inputStyle} value={form.fare_id} onChange={(e) => setForm({ ...form, fare_id: e.target.value })}>
                  <option value="">{t('members.fare_none')}</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} — {parseFloat(p.base_price).toFixed(2)}</option>
                  ))}
                </select>
              </>
            )}

            {showCenters && (
              <>
                <label style={labelStyle}>{t('members.assigned_centers')}</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6, padding: 10 }}>
                  {centers.map((c) => (
                    <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input type="checkbox" checked={assignedCenterIds.has(c.id)}
                             onChange={(e) => toggleCenter(c.id, e.target.checked)} />
                      {c.name}
                    </label>
                  ))}
                </div>

                <label style={labelStyle}>{t('members.default_center')}</label>
                <select style={inputStyle} value={defaultCenterId ?? ''} onChange={(e) => setDefaultCenterId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">{t('members.default_center_none')}</option>
                  {centers.filter((c) => assignedCenterIds.has(c.id)).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </>
            )}

            {error && <p style={{ color: '#c0392b', margin: '8px 0 0', fontSize: 14 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button onClick={closeModal} style={btnStyle('#aaa')} disabled={saving}>{t('members.cancel')}</button>
              <button onClick={handleAdd} style={btnStyle('#6c63ff')} disabled={saving}>
                {saving ? t('members.saving') : t('members.modal_add')}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailFor && (
        <MemberDetailModal memberId={detailFor.id} memberName={detailFor.name} onClose={() => setDetailFor(null)} />
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        message={t('members.unsaved_changes')}
        confirmLabel={t('members.unsaved_discard')}
        cancelLabel={t('members.cancel')}
        onConfirm={() => {
          const action = pendingAction!;
          setPendingAction(null);
          cancelEdit();
          action();
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
}
const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
const modalStyle: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 32, width: 460, maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 14, fontWeight: 500, marginBottom: 4, marginTop: 14, color: '#333' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' };
