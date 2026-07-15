'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { MemberTrainingPlansModal } from './MemberTrainingPlansModal';

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
  fare_price: string | null;
}

const emptyForm = { name: '', email: '', phone: '', fare_id: '' };

export default function MembersPage() {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, isSuperadmin, loading: gymLoading } = useGym();
  const { centers } = useCenter();
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trainingPlansFor, setTrainingPlansFor] = useState<Member | null>(null);

  // #59: only shown once a gym actually has more than one center — a
  // single-center gym behaves exactly as before this feature existed.
  const showCenters = centers.length > 1;
  const [assignedCenterIds, setAssignedCenterIds] = useState<Set<number>>(new Set());
  const [defaultCenterId, setDefaultCenterId] = useState<number | null>(null);

  const canManageTraining = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'coach';

  async function load() {
    if (!activeGymId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [membersData, plansData] = await Promise.all([
        apiFetch<Member[]>('/members'),
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

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

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

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('members.title')}</h1>
        <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('members.add')}</button>
      </div>

      {loading ? (
        <p style={{ color: '#666' }}>{t('members.loading')}</p>
      ) : members.length === 0 ? (
        <p style={{ color: '#666' }}>{t('members.empty')}</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
              <th style={th}>{t('members.col_name')}</th>
              <th style={th}>{t('members.col_email')}</th>
              <th style={th}>{t('members.col_phone')}</th>
              <th style={th}>{t('members.col_fare')}</th>
              <th style={{ ...th, width: 120 }}>{t('members.col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={td}>{m.name}</td>
                <td style={td}>{m.email}</td>
                <td style={td}>{m.phone ?? '—'}</td>
                <td style={td}>{m.fare_name ? `${m.fare_name} (${parseFloat(m.fare_price!).toFixed(2)})` : '—'}</td>
                <td style={{ ...td, display: 'flex', gap: 8 }}>
                  {canManageTraining && (
                    <button onClick={() => setTrainingPlansFor(m)} style={btnSmall('#6c63ff')}>{t('members.training_plans')}</button>
                  )}
                  <button onClick={() => openEdit(m)} style={btnSmall('#444')}>{t('members.edit')}</button>
                  <button onClick={() => handleDelete(m.id)} style={btnSmall('#c0392b')}>{t('members.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
    </div>
  );
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' };
const th: React.CSSProperties = { padding: '12px 16px', fontWeight: 600, fontSize: 15 };
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 15 };
function btnStyle(bg: string): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
}
function btnSmall(bg: string): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: 13 };
}
const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
const modalStyle: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 32, width: 420, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 14, fontWeight: 500, marginBottom: 4, marginTop: 14, color: '#333' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' };
