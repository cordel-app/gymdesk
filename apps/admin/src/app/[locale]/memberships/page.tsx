'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';
import { MembershipLedgerModal } from './MembershipLedgerModal';
import { PromotionApplyModal } from './PromotionApplyModal';

interface Membership {
  id: number;
  member_id: number;
  membership_plan_id: number | null;
  base_price: string | null;
  plan_price_id: number | null;
  final_price: string | null;
  discount_reason: string | null;
  discount_expires_at: string | null;
  starts_at: string;
  ends_at: string | null;
  status: 'active' | 'paused' | 'cancelled' | 'expired';
  member_name: string;
  member_email: string;
  plan_name: string | null;
}

interface Member { id: number; name: string; email: string }
interface Plan   { id: number; name: string; base_price: string; status: 'active' | 'inactive' }
interface PlanPrice { id: number; price: string; valid_from: string; valid_to: string | null }

const STATUSES = ['active', 'paused', 'cancelled', 'expired'] as const;
const day = (d: string | null) => (d ? d.slice(0, 10) : '');
const today = () => new Date().toISOString().slice(0, 10);

const emptyForm = {
  member_id: '',
  membership_plan_id: '',
  starts_at: today(),
  ends_at: '',
  status: 'active' as (typeof STATUSES)[number],
  final_price: '',
  discount_reason: '',
  discount_expires_at: '',
};

/**
 * Mirrors the backend effectivePrice() in api/user-memberships.ts: pick the
 * price window whose valid_from <= date and (valid_to IS NULL OR >= date),
 * preferring the most recent valid_from; fall back to plan.base_price.
 */
function effectivePrice(plan: Plan, prices: PlanPrice[], date: string): number {
  const applicable = prices
    .filter((p) => day(p.valid_from) <= date && (p.valid_to === null || day(p.valid_to) >= date))
    .sort((a, b) => day(b.valid_from).localeCompare(day(a.valid_from)));
  return parseFloat(applicable[0]?.price ?? plan.base_price);
}

export default function MembershipsPage() {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Membership | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priceHint, setPriceHint] = useState<number | null>(null); // effective price for chosen plan/date
  const [priceOverridden, setPriceOverridden] = useState(false);

  const [cancelling, setCancelling] = useState<Membership | null>(null);
  const [ledgerFor, setLedgerFor] = useState<Membership | null>(null);
  const [promotionsFor, setPromotionsFor] = useState<Membership | null>(null);

  const canWrite = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'staff';
  const isAdmin  = isSuperadmin || activeGym?.role === 'admin';

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [ms, mem, pl] = await Promise.all([
        apiFetch<Membership[]>(`/user-memberships${statusFilter ? `?status=${statusFilter}` : ''}`),
        apiFetch<Member[]>('/members'),
        apiFetch<Plan[]>('/membership-plans?status=active'),
      ]);
      setMemberships(ms);
      setMembers(mem);
      setPlans(pl);
    } catch (err: any) {
      setMemberships([]);
      toast(err.message ?? t('memberships.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  // Compute the effective price whenever plan or start date changes in ADD mode
  // (or when editing but the user hasn't manually overridden). The user can
  // still type a different final_price — that flips the override flag on.
  useEffect(() => {
    if (!modalOpen) return;
    const planId = parseInt(form.membership_plan_id, 10);
    if (!planId) { setPriceHint(null); return; }
    const plan = plans.find((p) => p.id === planId);
    if (!plan) { setPriceHint(null); return; }
    let cancelled = false;
    apiFetch<PlanPrice[]>(`/membership-plans/${planId}/prices`)
      .then((prices) => {
        if (cancelled) return;
        const eff = effectivePrice(plan, prices, form.starts_at || today());
        setPriceHint(eff);
        if (!priceOverridden) setForm((f) => ({ ...f, final_price: eff.toFixed(2) }));
      })
      .catch(() => { if (!cancelled) setPriceHint(parseFloat(plan.base_price)); });
    return () => { cancelled = true; };
  }, [form.membership_plan_id, form.starts_at, modalOpen]);

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setPriceHint(null);
    setPriceOverridden(false);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(m: Membership) {
    setEditing(m);
    setForm({
      member_id: String(m.member_id),
      membership_plan_id: m.membership_plan_id != null ? String(m.membership_plan_id) : '',
      starts_at: day(m.starts_at),
      ends_at: day(m.ends_at),
      status: m.status,
      final_price: m.final_price ?? '',
      discount_reason: m.discount_reason ?? '',
      discount_expires_at: day(m.discount_expires_at),
    });
    // Assume the existing final_price is intentional; only recompute-and-autofill
    // if the user changes the plan or starts_at.
    setPriceOverridden(true);
    setPriceHint(null);
    setError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyForm);
    setError(null);
  }

  function onFinalPriceChange(v: string) {
    setPriceOverridden(true);
    setForm({ ...form, final_price: v });
  }

  const overrideActive = useMemo(() => {
    if (!form.final_price || priceHint === null) return false;
    const parsed = parseFloat(form.final_price);
    return !isNaN(parsed) && Math.abs(parsed - priceHint) > 0.005;
  }, [form.final_price, priceHint]);

  async function handleSave() {
    if (!editing) {
      if (!form.member_id || !form.membership_plan_id || !form.starts_at) {
        setError(t('memberships.error_required'));
        return;
      }
    }
    const parsedFinal = form.final_price ? parseFloat(form.final_price) : null;
    if (form.final_price && (parsedFinal === null || isNaN(parsedFinal) || parsedFinal < 0)) {
      setError(t('memberships.error_price'));
      return;
    }
    if (overrideActive && !form.discount_reason.trim()) {
      setError(t('memberships.error_discount_reason'));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (editing) {
        const body: Record<string, unknown> = {
          starts_at: form.starts_at || null,
          ends_at: form.ends_at || null,
          status: form.status,
          final_price: form.final_price === '' ? null : parsedFinal,
          discount_reason: form.discount_reason.trim() || null,
          discount_expires_at: form.discount_expires_at || null,
        };
        await apiFetch(`/user-memberships/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        const body: Record<string, unknown> = {
          member_id: parseInt(form.member_id, 10),
          membership_plan_id: parseInt(form.membership_plan_id, 10),
          starts_at: form.starts_at,
          ends_at: form.ends_at || null,
        };
        if (overrideActive && parsedFinal !== null) {
          body.final_price = parsedFinal;
          body.discount_reason = form.discount_reason.trim();
          if (form.discount_expires_at) body.discount_expires_at = form.discount_expires_at;
        }
        await apiFetch('/user-memberships', { method: 'POST', body: JSON.stringify(body) });
      }
      closeModal();
      load();
    } catch (err: any) {
      setError(err.message ?? t('memberships.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel() {
    if (!cancelling) return;
    try {
      await apiFetch(`/user-memberships/${cancelling.id}`, { method: 'DELETE' });
      setCancelling(null);
      load();
    } catch (err: any) {
      setCancelling(null);
      toast(err.message ?? t('memberships.error_generic'));
    }
  }

  if (gymLoading) return null;

  const columns: Column<Membership>[] = [
    { header: t('memberships.col_member'), render: (m) => m.member_name },
    { header: t('memberships.col_plan'),   render: (m) => m.plan_name ?? '—' },
    { header: t('memberships.col_status'), width: 110, render: (m) => <StatusBadge status={m.status} label={t(`status.${m.status}`)} /> },
    { header: t('memberships.col_price'),  width: 110, render: (m) => m.final_price ? parseFloat(m.final_price).toFixed(2) : '—' },
    { header: t('memberships.col_starts'), width: 130, render: (m) => day(m.starts_at) },
    { header: t('memberships.col_ends'),   width: 130, render: (m) => day(m.ends_at) || <em style={{ color: '#888' }}>{t('memberships.ongoing')}</em> },
    {
      header: t('memberships.col_actions'),
      width: 240,
      render: (m) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setLedgerFor(m)} style={btnSmall('#6c63ff')}>{t('memberships.ledger')}</button>
          {canWrite && <button onClick={() => setPromotionsFor(m)} style={btnSmall('#7d3cbd')}>{t('memberships.promotions')}</button>}
          {canWrite && <button onClick={() => openEdit(m)} style={btnSmall('#444')}>{t('memberships.edit')}</button>}
          {isAdmin && m.status !== 'cancelled' && (
            <button onClick={() => setCancelling(m)} style={btnSmall('#c0392b')}>{t('memberships.cancel_action')}</button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('memberships.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          {canWrite && <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('memberships.add')}</button>}
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={memberships}
        rowKey={(m) => m.id}
        loading={loading}
        loadingText={t('memberships.loading')}
        emptyText={t('memberships.empty')}
      />

      <CrudModal
        open={modalOpen}
        title={editing ? t('memberships.modal_edit') : t('memberships.modal_add')}
        error={error}
        saving={saving}
        cancelLabel={t('memberships.cancel')}
        saveLabel={saving ? t('memberships.saving') : editing ? t('memberships.save_changes') : t('memberships.modal_add')}
        onCancel={closeModal}
        onSave={handleSave}
      >
        <FormLabel>{t('memberships.label_member')} *</FormLabel>
        <select
          value={form.member_id}
          onChange={(e) => setForm({ ...form, member_id: e.target.value })}
          disabled={!!editing}
          style={selectStyle}
        >
          <option value="">{t('memberships.pick_member')}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>{m.name} — {m.email}</option>
          ))}
        </select>

        <FormLabel>{t('memberships.label_plan')} *</FormLabel>
        <select
          value={form.membership_plan_id}
          onChange={(e) => { setPriceOverridden(false); setForm({ ...form, membership_plan_id: e.target.value }); }}
          disabled={!!editing}
          style={selectStyle}
        >
          <option value="">{t('memberships.pick_plan')}</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <FormLabel>{t('memberships.label_starts')} *</FormLabel>
            <FormInput
              type="date"
              value={form.starts_at}
              onChange={(e) => { setPriceOverridden(false); setForm({ ...form, starts_at: e.target.value }); }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <FormLabel>{t('memberships.label_ends')}</FormLabel>
            <FormInput
              type="date"
              value={form.ends_at}
              onChange={(e) => setForm({ ...form, ends_at: e.target.value })}
            />
          </div>
        </div>

        <FormLabel>{t('memberships.label_final_price')}</FormLabel>
        <FormInput
          type="number"
          min="0"
          step="0.01"
          value={form.final_price}
          onChange={(e) => onFinalPriceChange(e.target.value)}
          placeholder="0.00"
        />
        {priceHint !== null && (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: overrideActive ? '#b26a00' : '#666' }}>
            {overrideActive
              ? t('memberships.override_hint', { price: priceHint.toFixed(2) })
              : t('memberships.effective_hint', { price: priceHint.toFixed(2) })}
          </p>
        )}

        {overrideActive && (
          <>
            <FormLabel>{t('memberships.label_discount_reason')} *</FormLabel>
            <FormInput
              value={form.discount_reason}
              onChange={(e) => setForm({ ...form, discount_reason: e.target.value })}
              placeholder={t('memberships.placeholder_discount_reason')}
            />
            <FormLabel>{t('memberships.label_discount_expires')}</FormLabel>
            <FormInput
              type="date"
              value={form.discount_expires_at}
              onChange={(e) => setForm({ ...form, discount_expires_at: e.target.value })}
            />
          </>
        )}

        {editing && (
          <>
            <FormLabel>{t('memberships.label_status')}</FormLabel>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as any })}
              style={selectStyle}
            >
              {STATUSES.map((s) => {
                // Backend rejects staff-initiated cancellations via PUT; hide the option
                if (s === 'cancelled' && !isAdmin) return null;
                return <option key={s} value={s}>{t(`status.${s}`)}</option>;
              })}
            </select>
          </>
        )}
      </CrudModal>

      <ConfirmDialog
        open={cancelling !== null}
        message={t('memberships.confirm_cancel', { member: cancelling?.member_name ?? '' })}
        confirmLabel={t('memberships.cancel_action')}
        cancelLabel={t('memberships.cancel')}
        onConfirm={handleCancel}
        onCancel={() => setCancelling(null)}
      />

      {ledgerFor && (
        <MembershipLedgerModal
          membership={ledgerFor}
          canRecord={canWrite}
          onClose={() => setLedgerFor(null)}
        />
      )}

      {promotionsFor && (
        <PromotionApplyModal
          membership={promotionsFor}
          onClose={() => { setPromotionsFor(null); load(); }}
        />
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6,
  border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff',
};
