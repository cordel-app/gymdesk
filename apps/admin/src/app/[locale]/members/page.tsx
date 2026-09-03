'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { MemberTrainingPlansModal } from './MemberTrainingPlansModal';
import { MemberPaymentsModal } from './MemberPaymentsModal';
import { MemberExpandedRow } from './MemberExpandedRow';

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
  fare_id: number | null;
  fare_name: string | null;
  clerk_user_id: string | null;
  invitation_id: string | null;
  account_status: 'active' | 'invited' | 'not_enrolled';
  membership_status: string | null;
}

const emptyForm = { name: '', email: '', phone: '', fare_id: '' };

export default function MembersPage() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, isSuperadmin, loading: gymLoading } = useGym();
  const { centers } = useCenter();
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [centerFilter, setCenterFilter] = useState<string>(searchParams.get('centerId') ?? '');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trainingPlansFor, setTrainingPlansFor] = useState<Member | null>(null);
  const [paymentsFor, setPaymentsFor] = useState<Member | null>(null);
  const [memberClerkStatus, setMemberClerkStatus] = useState<{ status: string; userId: string | null } | null>(null);
  const [memberClerkLoading, setMemberClerkLoading] = useState(false);
  const [expandedMemberIds, setExpandedMemberIds] = useState<Set<number>>(new Set());

  const showCenters = centers.length > 1;
  const [assignedCenterIds, setAssignedCenterIds] = useState<Set<number>>(new Set());
  const [defaultCenterId, setDefaultCenterId] = useState<number | null>(null);

  const canManageTraining = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'TRAINING'));
  const canManagePayments = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'PAYMENTS'));

  async function load() {
    if (!activeGymId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [membersData, plansData] = await Promise.all([
        apiFetch<Member[]>(`/members${centerFilter ? `?centerId=${centerFilter}` : ''}`),
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

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, centerFilter]);

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setAssignedCenterIds(centers.length === 1 ? new Set([centers[0].id]) : new Set());
    setDefaultCenterId(centers.length === 1 ? centers[0].id : null);
    setModalOpen(true);
  }

  async function openEdit(m: Member) {
    setEditing(m);
    setForm({ name: m.name, email: m.email, phone: m.phone ?? '', fare_id: m.fare_id ? String(m.fare_id) : '' });
    setError(null);
    setModalOpen(true);
    setMemberClerkStatus(null);
    setMemberClerkLoading(true);
    apiFetch<{ status: string; userId: string | null }>(`/members/${m.id}/clerk-status`)
      .then(setMemberClerkStatus)
      .catch(() => setMemberClerkStatus({ status: 'error', userId: null }))
      .finally(() => setMemberClerkLoading(false));
    if (showCenters) {
      try {
        const rows = await apiFetch<{ center_id: number; is_default: boolean }[]>(`/members/${m.id}/centers`);
        setAssignedCenterIds(new Set(rows.map((r) => r.center_id)));
        setDefaultCenterId(rows.find((r) => r.is_default)?.center_id ?? null);
      } catch {
        setAssignedCenterIds(new Set());
        setDefaultCenterId(null);
      }
    }
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setAssignedCenterIds(new Set());
    setDefaultCenterId(null);
    setMemberClerkStatus(null);
  }

  function toggleCenter(id: number, checked: boolean) {
    const next = new Set(assignedCenterIds);
    if (checked) next.add(id); else next.delete(id);
    setAssignedCenterIds(next);
    if (!checked && defaultCenterId === id) setDefaultCenterId(null);
    if (checked && next.size === 1) setDefaultCenterId(id);
  }

  async function handleSave() {
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
    const body: Record<string, unknown> = { name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() || null, fare_id: form.fare_id ? parseInt(form.fare_id) : null };
    if (showCenters) {
      body.center_ids = Array.from(assignedCenterIds);
      body.default_center_id = defaultCenterId;
    }
    try {
      if (editing) {
        await apiFetch(`/members/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
        if (showCenters) {
          await apiFetch(`/members/${editing.id}/centers`, {
            method: 'PUT',
            body: JSON.stringify({ center_ids: Array.from(assignedCenterIds), default_center_id: defaultCenterId }),
          });
        }
      } else {
        await apiFetch('/members', { method: 'POST', body: JSON.stringify(body) });
      }
      closeModal();
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'));
    } finally {
      setSaving(false);
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

    items.push({ label: t('members.edit'), onClick: () => openEdit(m) });

    if (!linked && !pendingInvite) {
      items.push({ label: t('members.action_invite'), onClick: () => handleInvite(m.id) });
    }
    if (pendingInvite) {
      items.push({ label: t('members.action_reinvite'), onClick: () => handleReinvite(m.id) });
      items.push({ label: t('members.action_revoke'), onClick: () => handleRevokeInvite(m.id) });
    }
    if (canManageTraining) {
      items.push({ label: t('members.training_plans'), onClick: () => setTrainingPlansFor(m) });
    }
    if (canManagePayments) {
      items.push({ label: t('members.payments'), onClick: () => setPaymentsFor(m) });
    }
    items.push({ label: t('members.delete'), onClick: () => handleDelete(m.id), danger: true });

    return items;
  }

  const columns: Column<Member>[] = [
    {
      header: t('members.col_name'),
      render: (m) => (
        <div>
          <div style={{ fontWeight: 500 }}>{m.name}</div>
          <div style={{ fontSize: 12, color: '#888' }}>{m.email}</div>
        </div>
      ),
    },
    {
      header: t('members.col_account_status'),
      width: 130,
      render: (m) => (
        <StatusBadge
          status={m.account_status}
          label={t(`members.account_status_${m.account_status}`)}
        />
      ),
    },
    {
      header: t('members.col_membership_status'),
      width: 130,
      render: (m) => m.membership_status
        ? <StatusBadge status={m.membership_status} label={t(`members.membership_status_${m.membership_status}`) || m.membership_status} />
        : <span style={{ color: '#bbb' }}>—</span>,
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('members.title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {showCenters && (
            <select
              value={centerFilter}
              onChange={(e) => setCenterFilter(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff' }}
            >
              <option value="">{t('members.all_centers')}</option>
              {centers.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name}</option>
              ))}
            </select>
          )}
          <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('members.add')}</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={members}
        rowKey={(m) => m.id}
        loading={loading}
        loadingText={t('members.loading')}
        emptyText={t('members.empty')}
        expandedRowKeys={expandedMemberIds}
        onToggleExpand={toggleExpand}
        renderExpanded={(m) => (
          <MemberExpandedRow memberId={m.id} canManageTraining={canManageTraining} />
        )}
      />

      {modalOpen && (
        <div style={overlayStyle} onClick={closeModal}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px' }}>{editing ? t('members.modal_edit') : t('members.modal_add')}</h2>

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

            {editing && (
              <>
                <hr style={{ border: 'none', borderTop: '1px solid #e8e8ed', margin: '20px 0 16px' }} />
                <div style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
                  {t('members.clerk_section_title')}
                </div>
                {memberClerkLoading ? (
                  <p style={{ fontSize: 14, color: '#888', margin: 0 }}>{t('members.clerk_loading')}</p>
                ) : memberClerkStatus ? (
                  <div>
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>{t('members.clerk_status_label')}</div>
                      <div style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                          background: memberClerkStatus.status === 'active' ? '#2ecc71'
                            : memberClerkStatus.status === 'suspended' ? '#e74c3c'
                            : memberClerkStatus.status === 'invited' ? '#3498db'
                            : '#999',
                        }} />
                        {memberClerkStatus.status === 'not_enrolled' ? t('members.clerk_not_enrolled')
                          : memberClerkStatus.status === 'invited' ? t('members.clerk_invited')
                          : memberClerkStatus.status === 'active' ? t('members.clerk_active')
                          : memberClerkStatus.status === 'suspended' ? t('members.clerk_suspended')
                          : t('members.clerk_error')}
                      </div>
                    </div>
                    {memberClerkStatus.userId && (
                      <div>
                        <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>{t('members.clerk_user_id_label')}</div>
                        <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#555' }}>{memberClerkStatus.userId}</div>
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            )}

            {error && <p style={{ color: '#c0392b', margin: '8px 0 0', fontSize: 14 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button onClick={closeModal} style={btnStyle('#aaa')} disabled={saving}>{t('members.cancel')}</button>
              <button onClick={handleSave} style={btnStyle('#6c63ff')} disabled={saving}>
                {saving ? t('members.saving') : editing ? t('members.save_changes') : t('members.modal_add')}
              </button>
            </div>
          </div>
        </div>
      )}

      {trainingPlansFor && (
        <MemberTrainingPlansModal memberId={trainingPlansFor.id} memberName={trainingPlansFor.name} onClose={() => setTrainingPlansFor(null)} />
      )}

      {paymentsFor && (
        <MemberPaymentsModal memberId={paymentsFor.id} memberName={paymentsFor.name} onClose={() => setPaymentsFor(null)} />
      )}
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
}
const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
const modalStyle: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 32, width: 420, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 14, fontWeight: 500, marginBottom: 4, marginTop: 14, color: '#333' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' };
