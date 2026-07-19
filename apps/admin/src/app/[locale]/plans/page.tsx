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
import { btnStyle } from '@/components/ui';

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

interface Plan {
  id: number;
  name: string;
  description: string | null;
  lifecycle_status: 'draft' | 'active' | 'archived';
  enrollment_status: 'open' | 'closed';
  current_price: string | null;
  member_count: number;
  billing_policy: BillingPolicy | null;
  allowances: Allowance[];
  centers: Center[];
  price_history: PriceRow[];
}

interface ActivityType { id: number; name: string; }

const LIFECYCLE_STATUSES = ['draft', 'active', 'archived'] as const;
const ENROLLMENT_STATUSES = ['open', 'closed'] as const;
const BILLING_UNITS = ['day', 'week', 'month', 'year'] as const;
const ALLOWANCE_TYPES = ['unlimited', 'session_count'] as const;

const emptyForm = {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(price: string | null) {
  if (price == null) return '—';
  return `€${parseFloat(price).toFixed(2)}`;
}

function fmtBillingInterval(interval: number, unit: string) {
  if (interval === 1) return unit;
  return `${interval} ${unit}s`;
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
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [billingForm, setBillingForm] = useState(emptyBillingPolicy);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Confirm dialogs
  const [deleting, setDeleting] = useState<Plan | null>(null);
  const [archiving, setArchiving] = useState<Plan | null>(null);

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

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ─── Plan CRUD ─────────────────────────────────────────────────────────────

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setBillingForm(emptyBillingPolicy);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(p: Plan) {
    setEditing(p);
    setForm({
      name: p.name,
      description: p.description ?? '',
      lifecycle_status: p.lifecycle_status,
      enrollment_status: p.enrollment_status,
    });
    setBillingForm(p.billing_policy ? {
      initial_billing_interval: p.billing_policy.initial_billing_interval,
      initial_billing_unit: p.billing_policy.initial_billing_unit,
      recurring_billing_interval: p.billing_policy.recurring_billing_interval,
      recurring_billing_unit: p.billing_policy.recurring_billing_unit,
      initial_service_interval: p.billing_policy.initial_service_interval,
      initial_service_unit: p.billing_policy.initial_service_unit,
      recurring_service_interval: p.billing_policy.recurring_service_interval,
      recurring_service_unit: p.billing_policy.recurring_service_unit,
      auto_renew: !!p.billing_policy.auto_renew,
    } : emptyBillingPolicy);
    setFormError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyForm);
    setBillingForm(emptyBillingPolicy);
    setFormError(null);
  }

  async function handleSave() {
    if (!form.name.trim()) { setFormError(t('plans.error_required')); return; }
    setSaving(true); setFormError(null);
    try {
      const planBody = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        lifecycle_status: form.lifecycle_status,
        enrollment_status: form.enrollment_status,
      };
      let planId: number;
      if (editing) {
        const updated = await apiFetch<Plan>(`/membership-plans/${editing.id}`, { method: 'PUT', body: JSON.stringify(planBody) });
        planId = updated.id;
      } else {
        const created = await apiFetch<Plan>('/membership-plans', { method: 'POST', body: JSON.stringify(planBody) });
        planId = created.id;
      }
      // Upsert billing policy
      await apiFetch(`/membership-plans/${planId}/billing-policy`, {
        method: 'PUT',
        body: JSON.stringify({
          ...billingForm,
          initial_billing_interval: Number(billingForm.initial_billing_interval),
          recurring_billing_interval: Number(billingForm.recurring_billing_interval),
          initial_service_interval: Number(billingForm.initial_service_interval),
          recurring_service_interval: Number(billingForm.recurring_service_interval),
        }),
      });
      closeModal();
      load();
    } catch (err: any) {
      setFormError(err.message ?? t('plans.error_generic'));
    } finally {
      setSaving(false);
    }
  }

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

  async function handleArchive() {
    if (!archiving) return;
    try {
      await apiFetch(`/membership-plans/${archiving.id}/archive`, { method: 'POST' });
      setArchiving(null);
      load();
    } catch (err: any) {
      setArchiving(null);
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  async function handleDuplicate(plan: Plan) {
    try {
      await apiFetch(`/membership-plans/${plan.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  async function handleToggleEnrollment(plan: Plan) {
    const newStatus = plan.enrollment_status === 'open' ? 'closed' : 'open';
    try {
      await apiFetch(`/membership-plans/${plan.id}/enrollment`, {
        method: 'PUT',
        body: JSON.stringify({ enrollment_status: newStatus }),
      });
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  // ─── Price sub-form ────────────────────────────────────────────────────────

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

  // ─── Allowance sub-form ────────────────────────────────────────────────────

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

  // ─── Centers sub-form ─────────────────────────────────────────────────────

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

  // ─── Render ────────────────────────────────────────────────────────────────

  if (gymLoading || !isAdmin) return null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('plans.title')}</h1>
        <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('plans.modal_add')}</button>
      </div>

      {/* Plan list */}
      {loading ? (
        <p style={{ color: '#888' }}>{t('plans.loading')}</p>
      ) : plans.length === 0 ? (
        <p style={{ color: '#888' }}>{t('plans.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {plans.map((plan) => (
            <PlanAccordionRow
              key={plan.id}
              plan={plan}
              expanded={expanded.has(plan.id)}
              onToggle={() => toggleExpand(plan.id)}
              onEdit={() => openEdit(plan)}
              onDuplicate={() => handleDuplicate(plan)}
              onToggleEnrollment={() => handleToggleEnrollment(plan)}
              onArchive={() => setArchiving(plan)}
              onDelete={() => setDeleting(plan)}
              onAddPrice={() => openAddPrice(plan.id)}
              onEditPrice={(row) => openEditPrice(plan.id, row)}
              onDeletePrice={(priceId) => handleDeletePrice(plan.id, priceId)}
              onAddAllowance={() => openAddAllowance(plan.id)}
              onDeleteAllowance={(id) => handleDeleteAllowance(plan.id, id)}
              onEditCenters={() => openCenters(plan)}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Add/Edit Plan Modal */}
      <CrudModal
        open={modalOpen}
        title={editing ? t('plans.modal_edit') : t('plans.modal_add')}
        error={formError}
        saving={saving}
        cancelLabel={t('plans.cancel')}
        saveLabel={saving ? t('plans.saving') : editing ? t('plans.save_changes') : t('plans.modal_add')}
        onCancel={closeModal}
        onSave={handleSave}
      >
        <FormLabel>{t('plans.label_name')}</FormLabel>
        <FormInput
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder={t('plans.placeholder_name')}
          autoFocus
        />

        <FormLabel>{t('plans.label_description')}</FormLabel>
        <FormInput
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder={t('plans.placeholder_description')}
        />

        <FormLabel>{t('plans.label_lifecycle_status')}</FormLabel>
        <select value={form.lifecycle_status} onChange={(e) => setForm({ ...form, lifecycle_status: e.target.value as any })} style={selectStyle}>
          {LIFECYCLE_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>

        <FormLabel>{t('plans.label_enrollment_status')}</FormLabel>
        <select value={form.enrollment_status} onChange={(e) => setForm({ ...form, enrollment_status: e.target.value as any })} style={selectStyle}>
          {ENROLLMENT_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>

        {/* Billing Policy */}
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

      {/* Confirm archive */}
      <ConfirmDialog
        open={archiving !== null}
        message={t('plans.confirm_archive')}
        confirmLabel={t('plans.archive')}
        cancelLabel={t('plans.cancel')}
        onConfirm={handleArchive}
        onCancel={() => setArchiving(null)}
      />
    </div>
  );
}

// ─── Accordion row ────────────────────────────────────────────────────────────

function PlanAccordionRow({
  plan, expanded, onToggle,
  onEdit, onDuplicate, onToggleEnrollment, onArchive, onDelete,
  onAddPrice, onEditPrice, onDeletePrice,
  onAddAllowance, onDeleteAllowance,
  onEditCenters,
  t,
}: {
  plan: Plan; expanded: boolean; onToggle: () => void;
  onEdit: () => void; onDuplicate: () => void; onToggleEnrollment: () => void;
  onArchive: () => void; onDelete: () => void;
  onAddPrice: () => void; onEditPrice: (row: PriceRow) => void; onDeletePrice: (id: number) => void;
  onAddAllowance: () => void; onDeleteAllowance: (id: number) => void;
  onEditCenters: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const menuItems: ContextMenuItem[] = [
    { label: t('plans.edit'), onClick: onEdit },
    { label: t('plans.duplicate'), onClick: onDuplicate },
    plan.enrollment_status === 'open'
      ? { label: t('plans.close_enrollment'), onClick: onToggleEnrollment }
      : { label: t('plans.open_enrollment'), onClick: onToggleEnrollment },
    ...(plan.lifecycle_status === 'active' ? [{ label: t('plans.archive'), onClick: onArchive }] : []),
    { label: t('plans.delete'), onClick: onDelete, danger: true },
  ];

  return (
    <div style={cardStyle}>
      {/* Collapsed row */}
      <div
        style={rowStyle}
        onClick={onToggle}
      >
        <span style={{ fontSize: 14, color: '#888', userSelect: 'none', marginRight: 6 }}>
          {expanded ? '▼' : '▶'}
        </span>
        <span style={{ fontWeight: 600, flex: 1, fontSize: 15 }}>{plan.name}</span>
        <span style={{ color: '#555', fontSize: 14, marginRight: 16 }}>{fmtPrice(plan.current_price)}</span>
        <StatusBadge status={plan.lifecycle_status} label={t(`status.${plan.lifecycle_status}`)} />
        <StatusBadge status={plan.enrollment_status === 'open' ? 'active' : 'inactive'} label={t(`status.${plan.enrollment_status}`)} />
        <span style={{ fontSize: 13, color: '#888', marginLeft: 8 }}>
          {plan.member_count} members
        </span>
        <div onClick={(e) => e.stopPropagation()} style={{ marginLeft: 12 }}>
          <ContextMenu items={menuItems} ariaLabel={`Actions for ${plan.name}`} />
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '0 16px 16px' }}>
          {/* Status section */}
          <SectionHeader title={t('plans.section_status')} />
          <DetailRow label={t('plans.label_lifecycle_status')} value={t(`status.${plan.lifecycle_status}`)} />
          <DetailRow label={t('plans.label_enrollment_status')} value={t(`status.${plan.enrollment_status}`)} />
          <DetailRow label="Members" value={String(plan.member_count)} />

          {/* Billing section */}
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

          {/* Centers section */}
          <SectionHeader title={t('plans.section_centers')} action={<button onClick={onEditCenters} style={linkBtn}>Edit</button>} />
          {(plan.centers ?? []).length === 0 ? (
            <DetailRow label="" value={t('plans.all_centers')} />
          ) : (
            (plan.centers ?? []).map((c) => <DetailRow key={c.id} label="" value={c.name} />)
          )}

          {/* Included Services section */}
          <SectionHeader title={t('plans.section_services')} action={<button onClick={onAddAllowance} style={linkBtn}>+ Add</button>} />
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
                <button onClick={() => onDeleteAllowance(a.id)} style={dangerLinkBtn}>✕</button>
              </div>
            ))
          )}

          {/* Price History section */}
          <SectionHeader title={t('plans.section_prices')} action={<button onClick={onAddPrice} style={linkBtn}>+ Add</button>} />
          {(plan.price_history ?? []).length === 0 ? (
            <p style={{ fontSize: 13, color: '#888', margin: '4px 0 0' }}>{t('plans.no_prices')}</p>
          ) : (
            (plan.price_history ?? []).map((row) => (
              <div key={row.id} style={{ ...detailRowStyle, alignItems: 'center' }}>
                <span style={labelStyle}>{String(row.valid_from).slice(0, 10)}{row.valid_to ? ` – ${String(row.valid_to).slice(0, 10)}` : ''}</span>
                <span style={valueStyle}>€{parseFloat(row.price).toFixed(2)}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => onEditPrice(row)} style={linkBtn}>Edit</button>
                  <button onClick={() => onDeletePrice(row.id)} style={dangerLinkBtn}>✕</button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
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

const detailRowStyle: React.CSSProperties = {
  display: 'flex', gap: 8, padding: '3px 0', fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  width: 200, flexShrink: 0, color: '#666',
};

const valueStyle: React.CSSProperties = {
  color: '#111', flex: 1,
};

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#6c63ff', padding: '0 2px',
};

const dangerLinkBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#c0392b', padding: '0 2px',
};
