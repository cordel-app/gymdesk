'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { btnStyle, btnSmall } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BillingPolicy {
  id: number;
  initial_billing_interval: number;
  initial_billing_unit: string;
  recurring_billing_interval: number;
  recurring_billing_unit: string;
  initial_service_interval: number;
  initial_service_unit: string;
  recurring_service_interval: number;
  recurring_service_unit: string;
  auto_renew: boolean | number;
}

interface Allowance {
  id: number;
  activity_type_id: number;
  activity_type_name: string;
  allowance_type: 'unlimited' | 'session_count';
  session_count: number | null;
  recurrence_interval: number | null;
  recurrence_unit: string | null;
}

interface Center { id: number; name: string; }
interface PriceRow { id: number; price: string; valid_from: string; valid_to: string | null; }
interface ActivityType { id: number; name: string; }

interface Plan {
  id: number;
  name: string;
  description: string | null;
  lifecycle_status: 'draft' | 'active' | 'archived';
  enrollment_status: 'open' | 'closed' | 'paused';
  current_price: string | null;
  member_count: number;
  billing_policy: BillingPolicy | null;
  allowances: Allowance[];
  centers: Center[];
  price_history: PriceRow[];
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
}

const LIFECYCLE_STATUSES = ['draft', 'active', 'archived'] as const;
const ENROLLMENT_STATUSES = ['open', 'closed', 'paused'] as const;
const BILLING_UNITS = ['day', 'week', 'month', 'year'] as const;
const ALLOWANCE_TYPES = ['unlimited', 'session_count'] as const;

const emptyAddForm = {
  name: '',
  description: '',
  lifecycle_status: 'draft' as Plan['lifecycle_status'],
  enrollment_status: 'closed' as Plan['enrollment_status'],
};

const emptyBillingPolicy = {
  initial_billing_interval: 1,
  initial_billing_unit: 'month',
  recurring_billing_interval: 1,
  recurring_billing_unit: 'month',
  initial_service_interval: 1,
  initial_service_unit: 'month',
  recurring_service_interval: 1,
  recurring_service_unit: 'month',
  auto_renew: true,
};

const emptyEditForm = {
  name: '',
  description: '',
  lifecycle_status: 'draft' as Plan['lifecycle_status'],
  enrollment_status: 'closed' as Plan['enrollment_status'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(price: string | null) {
  if (price == null) return '—';
  return `€${parseFloat(price).toFixed(2)}`;
}

function fmtBillingInterval(interval: number, unit: string) {
  if (interval === 1) return unit;
  return `${interval} ${unit}s`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PlansPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  // Accordion expand (view mode)
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Details modal
  const [detailsPlan, setDetailsPlan] = useState<Plan | null>(null);

  // Add Plan modal
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addForm, setAddForm] = useState(emptyAddForm);
  const [billingForm, setBillingForm] = useState(emptyBillingPolicy);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Confirm delete
  const [deleting, setDeleting] = useState<Plan | null>(null);

  // Price sub-form
  const [priceForm, setPriceForm] = useState({ price: '', valid_from: '', valid_to: '' });
  const [priceEditId, setPriceEditId] = useState<number | null>(null);
  const [priceForPlanId, setPriceForPlanId] = useState<number | null>(null);

  // Allowance sub-form
  const [allowanceForPlanId, setAllowanceForPlanId] = useState<number | null>(null);
  const [allowanceForm, setAllowanceForm] = useState({
    activity_type_id: '',
    allowance_type: 'unlimited',
    session_count: '',
    recurrence_interval: '1',
    recurrence_unit: 'month',
  });
  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);

  // Centers sub-form
  const [centersForPlanId, setCentersForPlanId] = useState<number | null>(null);
  const [allCenters, setAllCenters] = useState<Center[]>([]);
  const [selectedCenterIds, setSelectedCenterIds] = useState<number[]>([]);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  useEffect(() => {
    if (!gymLoading && !isAdmin) router.replace(`/${locale}`);
  }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await apiFetch<Plan[]>('/membership-plans');
      setPlans(data);
    } catch (err: any) {
      setPlans([]);
      toast(err.message ?? t('plans.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  // ─── Accordion toggle ───────────────────────────────────────────────────────

  function toggleExpand(id: number) {
    if (editingId === id) return; // don't collapse while editing
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ─── Inline edit ────────────────────────────────────────────────────────────

  function openInlineEdit(plan: Plan) {
    setEditingId(plan.id);
    setEditForm({
      name: plan.name,
      description: plan.description ?? '',
      lifecycle_status: plan.lifecycle_status,
      enrollment_status: plan.enrollment_status,
    });
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function handleInlineSave(plan: Plan) {
    if (!editForm.name.trim()) { setEditError(t('plans.error_required')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/membership-plans/${plan.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          lifecycle_status: editForm.lifecycle_status,
          enrollment_status: editForm.enrollment_status,
        }),
      });
      setEditingId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('plans.error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Add Plan modal ─────────────────────────────────────────────────────────

  function openAdd() {
    setAddForm(emptyAddForm);
    setBillingForm(emptyBillingPolicy);
    setAddError(null);
    setAddModalOpen(true);
  }

  function closeAdd() {
    setAddModalOpen(false);
    setAddForm(emptyAddForm);
    setBillingForm(emptyBillingPolicy);
    setAddError(null);
  }

  async function handleAdd() {
    if (!addForm.name.trim()) { setAddError(t('plans.error_required')); return; }
    setAddSaving(true); setAddError(null);
    try {
      const created = await apiFetch<Plan>('/membership-plans', {
        method: 'POST',
        body: JSON.stringify({
          name: addForm.name.trim(),
          description: addForm.description.trim() || null,
          lifecycle_status: addForm.lifecycle_status,
          enrollment_status: addForm.enrollment_status,
        }),
      });
      await apiFetch(`/membership-plans/${created.id}/billing-policy`, {
        method: 'PUT',
        body: JSON.stringify({
          ...billingForm,
          initial_billing_interval: Number(billingForm.initial_billing_interval),
          recurring_billing_interval: Number(billingForm.recurring_billing_interval),
          initial_service_interval: Number(billingForm.initial_service_interval),
          recurring_service_interval: Number(billingForm.recurring_service_interval),
        }),
      });
      closeAdd();
      load();
    } catch (err: any) {
      setAddError(err.message ?? t('plans.error_generic'));
    } finally {
      setAddSaving(false);
    }
  }

  // ─── Delete ─────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/membership-plans/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  // ─── Duplicate ──────────────────────────────────────────────────────────────

  async function handleDuplicate(plan: Plan) {
    try {
      await apiFetch(`/membership-plans/${plan.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  // ─── Price sub-form ─────────────────────────────────────────────────────────

  function openAddPrice(planId: number) {
    setPriceForPlanId(planId);
    setPriceEditId(null);
    setPriceForm({ price: '', valid_from: '', valid_to: '' });
  }

  function openEditPrice(planId: number, row: PriceRow) {
    setPriceForPlanId(planId);
    setPriceEditId(row.id);
    setPriceForm({ price: row.price, valid_from: row.valid_from, valid_to: row.valid_to ?? '' });
  }

  function closePriceForm() {
    setPriceForPlanId(null);
    setPriceEditId(null);
    setPriceForm({ price: '', valid_from: '', valid_to: '' });
  }

  async function handleSavePrice() {
    if (!priceForPlanId) return;
    const body = { price: parseFloat(priceForm.price), valid_from: priceForm.valid_from, valid_to: priceForm.valid_to || null };
    try {
      if (priceEditId) {
        await apiFetch(`/membership-plans/${priceForPlanId}/prices/${priceEditId}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await apiFetch(`/membership-plans/${priceForPlanId}/prices`, { method: 'POST', body: JSON.stringify(body) });
      }
      closePriceForm();
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  async function handleDeletePrice(planId: number, priceId: number) {
    try {
      await apiFetch(`/membership-plans/${planId}/prices/${priceId}`, { method: 'DELETE' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  // ─── Allowance sub-form ─────────────────────────────────────────────────────

  async function openAddAllowance(planId: number) {
    if (activityTypes.length === 0) {
      const data = await apiFetch<ActivityType[]>('/activity-types').catch(() => []);
      setActivityTypes(data);
    }
    setAllowanceForPlanId(planId);
    setAllowanceForm({ activity_type_id: '', allowance_type: 'unlimited', session_count: '', recurrence_interval: '1', recurrence_unit: 'month' });
  }

  async function handleSaveAllowance() {
    if (!allowanceForPlanId || !allowanceForm.activity_type_id) return;
    const body: any = {
      activity_type_id: Number(allowanceForm.activity_type_id),
      allowance_type: allowanceForm.allowance_type,
    };
    if (allowanceForm.allowance_type === 'session_count') {
      body.session_count = Number(allowanceForm.session_count);
      body.recurrence_interval = Number(allowanceForm.recurrence_interval);
      body.recurrence_unit = allowanceForm.recurrence_unit;
    }
    try {
      await apiFetch(`/membership-plans/${allowanceForPlanId}/allowances`, { method: 'POST', body: JSON.stringify(body) });
      setAllowanceForPlanId(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  async function handleDeleteAllowance(planId: number, allowanceId: number) {
    try {
      await apiFetch(`/membership-plans/${planId}/allowances/${allowanceId}`, { method: 'DELETE' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  // ─── Centers sub-form ───────────────────────────────────────────────────────

  async function openCenters(plan: Plan) {
    if (allCenters.length === 0) {
      const data = await apiFetch<Center[]>('/centers').catch(() => []);
      setAllCenters(data);
    }
    setCentersForPlanId(plan.id);
    setSelectedCenterIds((plan.centers ?? []).map((c) => c.id));
  }

  async function handleSaveCenters() {
    if (centersForPlanId == null) return;
    try {
      await apiFetch(`/membership-plans/${centersForPlanId}/centers`, {
        method: 'PUT',
        body: JSON.stringify({ center_ids: selectedCenterIds }),
      });
      setCentersForPlanId(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (gymLoading || !isAdmin) return null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('plans.title')}</h1>
        <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('plans.modal_add')}</button>
      </div>

      {/* Column headers */}
      {!loading && plans.length > 0 && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('plans.col_name')}</div>
          <div style={{ flex: 3 }}>{t('plans.col_description')}</div>
          <div style={{ flex: 2 }}>{t('plans.col_created_by')}</div>
          <div style={{ minWidth: 100 }}>{t('plans.col_created_at')}</div>
          <div style={{ minWidth: 90 }}>{t('plans.col_status')}</div>
          <div style={{ minWidth: 90 }}>{t('plans.col_enrollment')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {/* Plan list */}
      {loading ? (
        <p style={{ color: '#888' }}>{t('plans.loading')}</p>
      ) : plans.length === 0 ? (
        <p style={{ color: '#888' }}>{t('plans.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {plans.map((plan) => {
            const isEditing = editingId === plan.id;
            const isExpanded = isEditing || expanded.has(plan.id);
            const descText = plan.description
              ? plan.description.length > 60 ? plan.description.slice(0, 60) + '…' : plan.description
              : '—';

            const menuItems: ContextMenuItem[] = [
              { label: t('plans.details'), onClick: () => setDetailsPlan(plan) },
              { label: t('plans.edit'), onClick: () => openInlineEdit(plan) },
              { label: t('plans.duplicate'), onClick: () => handleDuplicate(plan) },
              { label: t('plans.delete'), onClick: () => setDeleting(plan), danger: true },
            ];

            return (
              <div key={plan.id} style={cardStyle}>
                {/* Row header */}
                <div style={rowStyle} onClick={() => toggleExpand(plan.id)}>
                  <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {plan.name}
                  </div>
                  <div style={{ flex: 3, fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {descText}
                  </div>
                  <div style={{ flex: 2, fontSize: 13, color: '#555', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {plan.created_by_name ?? '—'}
                  </div>
                  <div style={{ minWidth: 100, fontSize: 13, color: '#888', flexShrink: 0 }}>
                    {fmtDate(plan.created_at)}
                  </div>
                  <div style={{ minWidth: 90, flexShrink: 0 }}>
                    <StatusBadge status={plan.lifecycle_status} label={t(`status.${plan.lifecycle_status}`)} />
                  </div>
                  <div style={{ minWidth: 90, flexShrink: 0 }}>
                    <StatusBadge
                      status={plan.enrollment_status === 'open' ? 'active' : plan.enrollment_status === 'paused' ? 'paused' : 'inactive'}
                      label={t(`status.${plan.enrollment_status}`)}
                    />
                  </div>
                  <span style={{ fontSize: 14, color: '#aaa', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
                  <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
                    <ContextMenu items={menuItems} ariaLabel={`Actions for ${plan.name}`} />
                  </div>
                </div>

                {/* Inline edit form */}
                {isEditing && (
                  <div style={{ padding: '16px', borderTop: '1px solid #eee' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                      <div>
                        <label style={inlineLabelStyle}>{t('plans.label_name')} *</label>
                        <input
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          autoFocus
                          style={inlineInputStyle}
                        />
                      </div>
                      <div>
                        <label style={inlineLabelStyle}>{t('plans.label_description')}</label>
                        <input
                          value={editForm.description}
                          onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                          style={inlineInputStyle}
                        />
                      </div>
                      <div>
                        <label style={inlineLabelStyle}>{t('plans.label_lifecycle_status')}</label>
                        <select
                          value={editForm.lifecycle_status}
                          onChange={(e) => setEditForm({ ...editForm, lifecycle_status: e.target.value as Plan['lifecycle_status'] })}
                          style={inlineSelectStyle}
                        >
                          {LIFECYCLE_STATUSES.map((s) => (
                            <option key={s} value={s}>{t(`status.${s}`)}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={inlineLabelStyle}>{t('plans.label_enrollment_status')}</label>
                        <select
                          value={editForm.enrollment_status}
                          onChange={(e) => setEditForm({ ...editForm, enrollment_status: e.target.value as Plan['enrollment_status'] })}
                          style={inlineSelectStyle}
                        >
                          {ENROLLMENT_STATUSES.map((s) => (
                            <option key={s} value={s}>{t(`status.${s}`)}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {editError && <p style={{ color: '#c0392b', fontSize: 13, margin: '8px 0 0' }}>{editError}</p>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
                      <button onClick={cancelEdit} style={btnSmall('#888')}>{t('plans.cancel')}</button>
                      <button onClick={() => handleInlineSave(plan)} disabled={editSaving} style={btnSmall('#6c63ff')}>
                        {editSaving ? t('plans.saving') : t('plans.save_changes')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Accordion detail sections (view mode only) */}
                {isExpanded && !isEditing && (
                  <div style={{ padding: '0 16px 16px', borderTop: '1px solid #eee' }}>
                    <SectionHeader title={t('plans.section_status')} />
                    <DetailRow label={t('plans.label_lifecycle_status')} value={t(`status.${plan.lifecycle_status}`)} />
                    <DetailRow label={t('plans.label_enrollment_status')} value={t(`status.${plan.enrollment_status}`)} />
                    <DetailRow label="Members" value={String(plan.member_count)} />

                    <SectionHeader title={t('plans.section_billing')} />
                    {plan.billing_policy ? (
                      <>
                        <DetailRow label={t('plans.billing_initial')} value={fmtBillingInterval(plan.billing_policy.initial_billing_interval, plan.billing_policy.initial_billing_unit)} />
                        <DetailRow label={t('plans.billing_recurring')} value={`Every ${fmtBillingInterval(plan.billing_policy.recurring_billing_interval, plan.billing_policy.recurring_billing_unit)}`} />
                        <DetailRow label={t('plans.service_initial')} value={fmtBillingInterval(plan.billing_policy.initial_service_interval, plan.billing_policy.initial_service_unit)} />
                        <DetailRow label={t('plans.service_recurring')} value={fmtBillingInterval(plan.billing_policy.recurring_service_interval, plan.billing_policy.recurring_service_unit)} />
                        <DetailRow label={t('plans.auto_renew')} value={plan.billing_policy.auto_renew ? t('plans.yes') : t('plans.no')} />
                      </>
                    ) : (
                      <p style={{ fontSize: 13, color: '#888', margin: '4px 0 0' }}>{t('plans.no_billing')}</p>
                    )}

                    <SectionHeader title={t('plans.section_centers')} action={<button onClick={() => openCenters(plan)} style={linkBtn}>Edit</button>} />
                    {(plan.centers ?? []).length === 0 ? (
                      <DetailRow label="" value={t('plans.all_centers')} />
                    ) : (
                      (plan.centers ?? []).map((c) => <DetailRow key={c.id} label="" value={c.name} />)
                    )}

                    <SectionHeader title={t('plans.section_services')} action={<button onClick={() => openAddAllowance(plan.id)} style={linkBtn}>+ Add</button>} />
                    {(plan.allowances ?? []).length === 0 ? (
                      <p style={{ fontSize: 13, color: '#888', margin: '4px 0 0' }}>{t('plans.no_allowances')}</p>
                    ) : (
                      (plan.allowances ?? []).map((a) => (
                        <div key={a.id} style={{ ...detailRowStyle, alignItems: 'center' }}>
                          <span style={labelStyle}>{a.activity_type_name}</span>
                          <span style={valueStyle}>
                            {a.allowance_type === 'unlimited'
                              ? t('plans.unlimited')
                              : `${a.session_count} sessions / ${fmtBillingInterval(a.recurrence_interval ?? 1, a.recurrence_unit ?? 'month')}`}
                          </span>
                          <button onClick={() => handleDeleteAllowance(plan.id, a.id)} style={dangerLinkBtn}>✕</button>
                        </div>
                      ))
                    )}

                    <SectionHeader title={t('plans.section_prices')} action={<button onClick={() => openAddPrice(plan.id)} style={linkBtn}>+ Add</button>} />
                    {(plan.price_history ?? []).length === 0 ? (
                      <p style={{ fontSize: 13, color: '#888', margin: '4px 0 0' }}>{t('plans.no_prices')}</p>
                    ) : (
                      (plan.price_history ?? []).map((row) => (
                        <div key={row.id} style={{ ...detailRowStyle, alignItems: 'center' }}>
                          <span style={labelStyle}>{String(row.valid_from).slice(0, 10)}{row.valid_to ? ` – ${String(row.valid_to).slice(0, 10)}` : ''}</span>
                          <span style={valueStyle}>€{parseFloat(row.price).toFixed(2)}</span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button onClick={() => openEditPrice(plan.id, row)} style={linkBtn}>Edit</button>
                            <button onClick={() => handleDeletePrice(plan.id, row.id)} style={dangerLinkBtn}>✕</button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Details modal */}
      <CrudModal
        open={detailsPlan !== null}
        title={t('plans.details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('plans.details_close')}
        saveLabel=""
        onCancel={() => setDetailsPlan(null)}
        onSave={() => setDetailsPlan(null)}
      >
        {detailsPlan && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>
              {t('plans.details_section_general')}
            </div>
            <div>
              <span style={detailLabelStyle}>{t('plans.details_name')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 15, fontWeight: 500 }}>{detailsPlan.name}</p>
            </div>
            {detailsPlan.description && (
              <div>
                <span style={detailLabelStyle}>{t('plans.details_description')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{detailsPlan.description}</p>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('plans.details_status')}</span>
                <div style={{ marginTop: 4 }}>
                  <StatusBadge status={detailsPlan.lifecycle_status} label={t(`status.${detailsPlan.lifecycle_status}`)} />
                </div>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('plans.details_enrollment_status')}</span>
                <div style={{ marginTop: 4 }}>
                  <StatusBadge
                    status={detailsPlan.enrollment_status === 'open' ? 'active' : detailsPlan.enrollment_status === 'paused' ? 'paused' : 'inactive'}
                    label={t(`status.${detailsPlan.enrollment_status}`)}
                  />
                </div>
              </div>
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>
              {t('plans.details_section_audit')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('plans.details_created_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{new Date(detailsPlan.created_at).toLocaleString()}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('plans.details_created_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{detailsPlan.created_by_name ?? '—'}</p>
              </div>
              {detailsPlan.modified_at && (
                <div>
                  <span style={detailLabelStyle}>{t('plans.details_modified_at')}</span>
                  <p style={{ margin: '2px 0 0', fontSize: 14 }}>{new Date(detailsPlan.modified_at).toLocaleString()}</p>
                </div>
              )}
              {detailsPlan.modified_by_name && (
                <div>
                  <span style={detailLabelStyle}>{t('plans.details_modified_by')}</span>
                  <p style={{ margin: '2px 0 0', fontSize: 14 }}>{detailsPlan.modified_by_name}</p>
                </div>
              )}
              {detailsPlan.deleted_at && (
                <div>
                  <span style={detailLabelStyle}>{t('plans.details_deleted_at')}</span>
                  <p style={{ margin: '2px 0 0', fontSize: 14 }}>{new Date(detailsPlan.deleted_at).toLocaleString()}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </CrudModal>

      {/* Add Plan modal */}
      <CrudModal
        open={addModalOpen}
        title={t('plans.modal_add')}
        error={addError}
        saving={addSaving}
        cancelLabel={t('plans.cancel')}
        saveLabel={addSaving ? t('plans.saving') : t('plans.modal_add')}
        onCancel={closeAdd}
        onSave={handleAdd}
      >
        <FormLabel>{t('plans.label_name')}</FormLabel>
        <FormInput
          value={addForm.name}
          onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
          placeholder={t('plans.placeholder_name')}
          autoFocus
        />

        <FormLabel>{t('plans.label_description')}</FormLabel>
        <FormInput
          value={addForm.description}
          onChange={(e) => setAddForm({ ...addForm, description: e.target.value })}
          placeholder={t('plans.placeholder_description')}
        />

        <FormLabel>{t('plans.label_lifecycle_status')}</FormLabel>
        <select value={addForm.lifecycle_status} onChange={(e) => setAddForm({ ...addForm, lifecycle_status: e.target.value as any })} style={selectStyle}>
          {LIFECYCLE_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>

        <FormLabel>{t('plans.label_enrollment_status')}</FormLabel>
        <select value={addForm.enrollment_status} onChange={(e) => setAddForm({ ...addForm, enrollment_status: e.target.value as any })} style={selectStyle}>
          {ENROLLMENT_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>

        <div style={{ marginTop: 16, marginBottom: 4 }}>
          <strong style={{ fontSize: 13, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t('plans.section_billing')}
          </strong>
        </div>

        {(['initial_billing', 'recurring_billing', 'initial_service', 'recurring_service'] as const).map((key) => (
          <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <div style={{ width: 160, flexShrink: 0, fontSize: 14, color: '#555' }}>{t(`plans.label_${key}_interval`)}</div>
            <FormInput
              type="number" min="1"
              value={(billingForm as any)[`${key}_interval`]}
              onChange={(e) => setBillingForm({ ...billingForm, [`${key}_interval`]: parseInt(e.target.value) || 1 })}
              style={{ width: 70 }}
            />
            <select
              value={(billingForm as any)[`${key}_unit`]}
              onChange={(e) => setBillingForm({ ...billingForm, [`${key}_unit`]: e.target.value })}
              style={{ ...selectStyle, flex: 1 }}
            >
              {BILLING_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        ))}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
          <input
            type="checkbox"
            id="auto_renew"
            checked={!!billingForm.auto_renew}
            onChange={(e) => setBillingForm({ ...billingForm, auto_renew: e.target.checked })}
          />
          <label htmlFor="auto_renew" style={{ fontSize: 14, cursor: 'pointer' }}>{t('plans.label_auto_renew')}</label>
        </div>
      </CrudModal>

      {/* Price sub-form modal */}
      {priceForPlanId != null && (
        <CrudModal
          open
          title={priceEditId ? t('prices.edit_heading') : t('prices.add_heading')}
          error={null}
          saving={false}
          cancelLabel={t('plans.cancel')}
          saveLabel={t('plans.save_changes')}
          onCancel={closePriceForm}
          onSave={handleSavePrice}
        >
          <FormLabel>{t('prices.col_price')}</FormLabel>
          <FormInput type="number" min="0" step="0.01" value={priceForm.price} onChange={(e) => setPriceForm({ ...priceForm, price: e.target.value })} placeholder="0.00" />
          <FormLabel>{t('prices.col_from')}</FormLabel>
          <FormInput type="date" value={priceForm.valid_from} onChange={(e) => setPriceForm({ ...priceForm, valid_from: e.target.value })} />
          <FormLabel>{t('prices.col_to')} (optional)</FormLabel>
          <FormInput type="date" value={priceForm.valid_to} onChange={(e) => setPriceForm({ ...priceForm, valid_to: e.target.value })} />
        </CrudModal>
      )}

      {/* Allowance sub-form modal */}
      {allowanceForPlanId != null && (
        <CrudModal
          open
          title={t('plans.add_allowance')}
          error={null}
          saving={false}
          cancelLabel={t('plans.cancel')}
          saveLabel={t('plans.save_changes')}
          onCancel={() => setAllowanceForPlanId(null)}
          onSave={handleSaveAllowance}
        >
          <FormLabel>Activity Type</FormLabel>
          <select value={allowanceForm.activity_type_id} onChange={(e) => setAllowanceForm({ ...allowanceForm, activity_type_id: e.target.value })} style={selectStyle}>
            <option value="">Select…</option>
            {activityTypes.map((at) => <option key={at.id} value={at.id}>{at.name}</option>)}
          </select>

          <FormLabel>{t('plans.allowance_type')}</FormLabel>
          <select value={allowanceForm.allowance_type} onChange={(e) => setAllowanceForm({ ...allowanceForm, allowance_type: e.target.value })} style={selectStyle}>
            {ALLOWANCE_TYPES.map((a) => <option key={a} value={a}>{t(`plans.allowance_${a}`)}</option>)}
          </select>

          {allowanceForm.allowance_type === 'session_count' && (
            <>
              <FormLabel>{t('plans.session_count')}</FormLabel>
              <FormInput type="number" min="1" value={allowanceForm.session_count} onChange={(e) => setAllowanceForm({ ...allowanceForm, session_count: e.target.value })} />
              <FormLabel>{t('plans.recurrence')} (interval)</FormLabel>
              <FormInput type="number" min="1" value={allowanceForm.recurrence_interval} onChange={(e) => setAllowanceForm({ ...allowanceForm, recurrence_interval: e.target.value })} />
              <FormLabel>{t('plans.recurrence')} (unit)</FormLabel>
              <select value={allowanceForm.recurrence_unit} onChange={(e) => setAllowanceForm({ ...allowanceForm, recurrence_unit: e.target.value })} style={selectStyle}>
                {BILLING_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </>
          )}
        </CrudModal>
      )}

      {/* Centers sub-form modal */}
      {centersForPlanId != null && (
        <CrudModal
          open
          title={t('plans.section_centers')}
          error={null}
          saving={false}
          cancelLabel={t('plans.cancel')}
          saveLabel={t('plans.save_changes')}
          onCancel={() => setCentersForPlanId(null)}
          onSave={handleSaveCenters}
        >
          {allCenters.map((c) => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
              <input
                type="checkbox"
                id={`center_${c.id}`}
                checked={selectedCenterIds.includes(c.id)}
                onChange={(e) => {
                  setSelectedCenterIds((prev) =>
                    e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                  );
                }}
              />
              <label htmlFor={`center_${c.id}`} style={{ fontSize: 14, cursor: 'pointer' }}>{c.name}</label>
            </div>
          ))}
        </CrudModal>
      )}

      {/* Confirm delete */}
      <ConfirmDialog
        open={deleting !== null}
        message={t('plans.confirm_delete')}
        confirmLabel={t('plans.delete')}
        cancelLabel={t('plans.cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #eee', margin: '16px 0 8px', paddingBottom: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
      {action}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={detailRowStyle}>
      {label && <span style={labelStyle}>{label}</span>}
      <span style={valueStyle}>{value}</span>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 15, boxSizing: 'border-box', background: '#fff', marginBottom: 8,
};

const cardStyle: React.CSSProperties = {
  border: '1px solid #e2e2e6', borderRadius: 10, overflow: 'hidden', background: '#fff',
};

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'flex', padding: '6px 16px', gap: 10,
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 4,
};

const detailRowStyle: React.CSSProperties = {
  display: 'flex', gap: 8, padding: '3px 0', fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  width: 200, flexShrink: 0, color: '#666',
};

const valueStyle: React.CSSProperties = {
  color: '#111', flex: 1,
};

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const inlineSelectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const detailLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#6c63ff', padding: '0 2px',
};

const dangerLinkBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#c0392b', padding: '0 2px',
};
