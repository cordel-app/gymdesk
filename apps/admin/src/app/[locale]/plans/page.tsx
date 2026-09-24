'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { btnStyle, btnSmall, cardSurfaceStyle, readOnlyStyle } from '@/components/ui';
import { AssignPlanModal } from './AssignPlanModal';
import { PlanDetailModal } from './PlanDetailModal';
import { computeVatPreview } from '@/lib/priceVat';
import {
  SellableItemBenefitEditor,
  SellableItemBenefitView,
  SellableItemBenefitRow,
  SellableItemOption,
  toBenefitItems,
} from '@/components/SellableItemBenefits';

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

interface Center { id: number; name: string; }
// #547: `status` is the price's place in the plan's history — 'active' is the
// price in force, 'applied' the price in force that has already been pushed onto
// the plan's Assigned Plans, 'inactive' a superseded price kept for history.
type PriceStatus = 'active' | 'applied' | 'inactive';
interface PriceRow {
  id: number;
  price: string;
  valid_from: string;
  valid_to: string | null;
  status: PriceStatus;
  applied_at: string | null;
  tax_rate_percent: string | null;
}
// `type` / `billing_frequency` / `status` / `benefit_category` back the #635
// Benefit pickers; `benefit_category` is computed server-side (#550) and is the
// only classification source of truth — never re-derived here.
interface GymCharge extends SellableItemOption {
  charge_type_name: string | null;
  charge_type_code: string | null;
  amount: string | null;
  availability: string;
}
interface TaxRate { id: number; name: string; rate_percent: string; status: 'active' | 'inactive'; is_system: boolean | number; }

// #485: read-only, dynamically computed by the backend — never persisted.
interface ForecastLine {
  label: string;
  amount: number;
}
interface ForecastEvent { date: string; description: string; total: number; lines: ForecastLine[]; }
interface BillingForecast { available: boolean; reason: string | null; currency: string; events: ForecastEvent[]; }

interface Plan {
  id: number;
  name: string;
  description: string | null;
  lifecycle_status: 'draft' | 'active' | 'paused' | 'inactive';
  enrollment_status: 'public' | 'staff_only';
  member_limit: '1' | '2' | 'family';
  current_price: string | null;
  member_count: number;
  promotion_count: number;
  billing_policy: BillingPolicy | null;
  centers: Center[];
  price_history: PriceRow[];
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  // #635 stage 1: the three Sellable-Item-keyed Benefit sections, served with
  // the plan so a card renders them without three extra round trips.
  session_benefits: SellableItemBenefitRow[];
  oneoff_benefits: SellableItemBenefitRow[];
  periodical_benefits: SellableItemBenefitRow[];
  // #635 §7: Billing & Duration. null = never configured, which reads
  // differently from an explicit 0.
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  tax_rate_id: number | null;
  tax_behavior: 'inclusive' | 'exclusive';
  tax_rate_name: string | null;
  tax_rate_percent: string | null;
  amount_excl_tax: number | null;
  amount_incl_tax: number | null;
  billing_forecast: BillingForecast;
}

const LIFECYCLE_STATUSES = ['draft', 'active', 'paused', 'inactive'] as const;
const ENROLLMENT_STATUSES = ['public', 'staff_only'] as const;
const MEMBER_LIMITS = ['1', '2', 'family'] as const;
const BILLING_UNITS = ['day', 'week', 'month', 'year'] as const;

// Applied automatically to every new plan; staff can adjust it afterwards via the Billing Policy section.
const DEFAULT_BILLING_POLICY = {
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

const BILLING_POLICY_FIELDS = ['initial_billing', 'recurring_billing', 'initial_service', 'recurring_service'] as const;

// #635 §7: Billing & Duration — the Promotion's three fields, minus Pay
// Beforehand (the ticket lists Free Period, Paid Duration and Bonus Duration).
const DURATION_FIELDS = ['free_months', 'paid_months', 'bonus_months'] as const;
type DurationField = typeof DURATION_FIELDS[number];

// #635 §3–§5: the three Sellable-Item-keyed Benefit sections a Plan now has,
// same shape and same endpoints' contract as the Promotion ones (#550). Each is
// edited and saved on its own (§10) — `showFrequency` is read-only either way,
// since a periodical item's period is the Sellable Item's own billing frequency.
type BenefitSection = 'session' | 'oneoff' | 'periodical';
const BENEFIT_SECTIONS: {
  section: BenefitSection;
  endpoint: string;
  titleKey: string;
  emptyKey: string;
  addKey: string;
  showFrequency: boolean;
}[] = [
  { section: 'oneoff', endpoint: 'oneoff-benefits', titleKey: 'section_oneoff_benefits', emptyKey: 'no_oneoff_benefits', addKey: 'add_oneoff_benefit', showFrequency: false },
  { section: 'session', endpoint: 'session-benefits', titleKey: 'section_session_benefits', emptyKey: 'no_session_benefits', addKey: 'add_session_benefit', showFrequency: false },
  { section: 'periodical', endpoint: 'periodical-benefits', titleKey: 'section_plan_period_benefits', emptyKey: 'no_plan_period_benefits', addKey: 'add_period_benefit', showFrequency: true },
];

function savedBenefits(plan: Plan, section: BenefitSection): SellableItemBenefitRow[] {
  if (section === 'session') return plan.session_benefits ?? [];
  if (section === 'oneoff') return plan.oneoff_benefits ?? [];
  return plan.periodical_benefits ?? [];
}

const emptyEditForm = {
  name: '',
  description: '',
  lifecycle_status: 'draft' as Plan['lifecycle_status'],
  enrollment_status: 'staff_only' as Plan['enrollment_status'],
  member_limit: '1' as Plan['member_limit'],
};

type InlineNew = {
  name: string;
  description: string;
  lifecycle_status: Plan['lifecycle_status'];
  enrollment_status: Plan['enrollment_status'];
  member_limit: Plan['member_limit'];
  tax_rate_id: string;
  saving: boolean;
  error: string | null;
};

function emptyInlineNew(): InlineNew {
  return {
    name: '', description: '', lifecycle_status: 'draft', enrollment_status: 'staff_only', member_limit: '1',
    tax_rate_id: '', saving: false, error: null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

  // Status filter (aligned with the Promotions list header — the list endpoint
  // already supports ?lifecycle_status=, so this is presentation-only wiring)
  const [statusFilter, setStatusFilter] = useState('');

  // Accordion expand (view mode)
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Inline create
  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  // Confirm delete
  const [deleting, setDeleting] = useState<Plan | null>(null);

  // Assign Plan to Member(s) (#376)
  const [assigningPlan, setAssigningPlan] = useState<Plan | null>(null);

  // Details modal (#512)
  const [detailFor, setDetailFor] = useState<Plan | null>(null);

  // Pricing sub-form (inline, per plan) — price is always VAT-inclusive (#547)
  const [pricingForm, setPricingForm] = useState({ price: '', tax_rate_id: '' });
  const [pricingForPlanId, setPricingForPlanId] = useState<number | null>(null);
  const [pricingSaving, setPricingSaving] = useState(false);
  const [applyPricingFor, setApplyPricingFor] = useState<Plan | null>(null);
  const [applyingPricing, setApplyingPricing] = useState(false);

  // Centers sub-form (inline, per plan)
  const [centersForPlanId, setCentersForPlanId] = useState<number | null>(null);
  const [allCenters, setAllCenters] = useState<Center[]>([]);
  const [selectedCenterIds, setSelectedCenterIds] = useState<number[]>([]);

  // Billing policy sub-form (inline, per plan)
  const [billingEditForPlanId, setBillingEditForPlanId] = useState<number | null>(null);
  const [billingForm, setBillingForm] = useState(DEFAULT_BILLING_POLICY);
  const [billingSaving, setBillingSaving] = useState(false);

  // Charge benefits
  const [gymCharges, setGymCharges] = useState<GymCharge[]>([]);

  // Billing & Duration (#635 §7) — its own section, edited independently.
  const [durationEditForPlanId, setDurationEditForPlanId] = useState<number | null>(null);
  const [durationForm, setDurationForm] = useState<Record<DurationField, string>>({ free_months: '', paid_months: '', bonus_months: '' });
  const [durationSaving, setDurationSaving] = useState(false);

  // Session / One-off / Period Benefits (#635 §3–§5). Exactly one section of
  // one plan is editable at a time, which is what keeps a single draft
  // unambiguous — same rule Promotions adopted in #627.
  const [benefitEditFor, setBenefitEditFor] = useState<{ planId: number; section: BenefitSection } | null>(null);
  const [benefitDraft, setBenefitDraft] = useState<SellableItemBenefitRow[]>([]);
  const [benefitSaving, setBenefitSaving] = useState(false);

  // Tax rates (#413)
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('FINANCIALS');
  // Assigning a plan creates a user membership — a PAYMENTS write (front desk: RW), not FINANCIALS.
  const { canWrite: canAssign, readOnlyTitle: assignReadOnlyTitle } = useModuleAccess('PAYMENTS');

  useEffect(() => {
    if (!gymLoading && !canRead) router.replace(`/${locale}`);
  }, [gymLoading, canRead]);

  useEffect(() => {
    if (!gymLoading && activeGymId) {
      apiFetch<GymCharge[]>('/sellable-items?availability=available').then(setGymCharges).catch(() => {});
      apiFetch<TaxRate[]>('/taxes').then(setTaxRates).catch(() => setTaxRates([]));
    }
  }, [gymLoading, activeGymId]);

  function taxRateOptions(currentId: string) {
    const options = taxRates.filter((tr) => tr.status === 'active');
    if (currentId && !options.some((tr) => String(tr.id) === currentId)) {
      const current = taxRates.find((tr) => String(tr.id) === currentId);
      if (current) options.push(current);
    }
    return options;
  }

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('lifecycle_status', statusFilter);
      const qs = params.toString();
      const data = await apiFetch<Plan[]>(`/membership-plans${qs ? `?${qs}` : ''}`);
      setPlans(data);
    } catch (err: any) {
      setPlans([]);
      toast(err.message ?? t('plans.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

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
      member_limit: plan.member_limit,
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
          member_limit: editForm.member_limit,
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

  // ─── Inline create ──────────────────────────────────────────────────────────

  function openInlineNew() {
    setInlineNew(emptyInlineNew());
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() {
    setInlineNew(null);
  }

  async function saveInlineNew() {
    if (!inlineNew) return;
    if (!inlineNew.name.trim()) { setInlineNew({ ...inlineNew, error: t('plans.error_required') }); return; }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      const created = await apiFetch<Plan>('/membership-plans', {
        method: 'POST',
        body: JSON.stringify({
          name: inlineNew.name.trim(),
          description: inlineNew.description.trim() || null,
          lifecycle_status: inlineNew.lifecycle_status,
          enrollment_status: inlineNew.enrollment_status,
          member_limit: inlineNew.member_limit,
          tax_rate_id: inlineNew.tax_rate_id !== '' ? parseInt(inlineNew.tax_rate_id, 10) : null,
          // #547: a plan's price is always the final VAT-inclusive customer price.
          tax_behavior: 'inclusive',
        }),
      });
      await apiFetch(`/membership-plans/${created.id}/billing-policy`, {
        method: 'PUT',
        body: JSON.stringify(DEFAULT_BILLING_POLICY),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('plans.error_generic') });
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

  // ─── Billing policy sub-form ────────────────────────────────────────────────

  function openBillingEdit(plan: Plan) {
    const bp = plan.billing_policy;
    setBillingForm(bp ? {
      initial_billing_interval: bp.initial_billing_interval,
      initial_billing_unit: bp.initial_billing_unit,
      recurring_billing_interval: bp.recurring_billing_interval,
      recurring_billing_unit: bp.recurring_billing_unit,
      initial_service_interval: bp.initial_service_interval,
      initial_service_unit: bp.initial_service_unit,
      recurring_service_interval: bp.recurring_service_interval,
      recurring_service_unit: bp.recurring_service_unit,
      auto_renew: !!bp.auto_renew,
    } : DEFAULT_BILLING_POLICY);
    setBillingEditForPlanId(plan.id);
  }

  function cancelBillingEdit() {
    setBillingEditForPlanId(null);
  }

  async function handleSaveBilling(planId: number) {
    setBillingSaving(true);
    try {
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
      setBillingEditForPlanId(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    } finally {
      setBillingSaving(false);
    }
  }

  // ─── Pricing sub-form (#547) ────────────────────────────────────────────────
  // One editable price per plan, always VAT-inclusive. Saving supersedes the
  // current price, which moves to the price history below — nothing here ever
  // rewrites a price that was already in force.

  function openPricing(plan: Plan) {
    setPricingForPlanId(plan.id);
    setPricingForm({
      price: plan.current_price != null ? parseFloat(plan.current_price).toFixed(2) : '',
      tax_rate_id: plan.tax_rate_id != null ? String(plan.tax_rate_id) : '',
    });
  }

  function closePricingForm() {
    setPricingForPlanId(null);
    setPricingForm({ price: '', tax_rate_id: '' });
  }

  async function handleSavePricing(planId: number) {
    const price = parseFloat(pricingForm.price);
    if (isNaN(price) || price < 0) {
      toast(t('plans.error_price'));
      return;
    }
    setPricingSaving(true);
    try {
      await apiFetch(`/membership-plans/${planId}/pricing`, {
        method: 'PUT',
        body: JSON.stringify({
          price,
          tax_rate_id: pricingForm.tax_rate_id !== '' ? parseInt(pricingForm.tax_rate_id, 10) : null,
        }),
      });
      closePricingForm();
      toast(t('plans.pricing_saved'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    } finally {
      setPricingSaving(false);
    }
  }

  async function handleApplyPricing() {
    if (!applyPricingFor) return;
    setApplyingPricing(true);
    try {
      const result = await apiFetch<{ price: number; updated: number; kept_discounted: number }>(
        `/membership-plans/${applyPricingFor.id}/pricing/apply-to-assigned-plans`,
        { method: 'POST' },
      );
      setApplyPricingFor(null);
      toast(
        result.kept_discounted > 0
          ? t('plans.apply_price_done_with_discounts', { updated: result.updated, kept: result.kept_discounted })
          : t('plans.apply_price_done', { updated: result.updated }),
        'success',
      );
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    } finally {
      setApplyingPricing(false);
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

  // ─── Billing & Duration (#635 §7) ───────────────────────────────────────────

  function openDurationEdit(plan: Plan) {
    setDurationForm({
      free_months: plan.free_months != null ? String(plan.free_months) : '',
      paid_months: plan.paid_months != null ? String(plan.paid_months) : '',
      bonus_months: plan.bonus_months != null ? String(plan.bonus_months) : '',
    });
    setDurationEditForPlanId(plan.id);
  }

  function cancelDurationEdit() {
    setDurationEditForPlanId(null);
  }

  async function saveDurationEdit(planId: number) {
    setDurationSaving(true);
    try {
      // An emptied field is sent as null, restoring "not configured" rather
      // than writing a 0 the admin never typed.
      const body: Record<string, number | null> = {};
      for (const field of DURATION_FIELDS) {
        const raw = durationForm[field].trim();
        body[field] = raw === '' ? null : parseInt(raw, 10);
      }
      await apiFetch(`/membership-plans/${planId}`, { method: 'PUT', body: JSON.stringify(body) });
      setDurationEditForPlanId(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    } finally {
      setDurationSaving(false);
    }
  }

  // ─── Session / One-off / Period Benefits (#635 §3–§5) ───────────────────────

  function openBenefitEdit(plan: Plan, section: BenefitSection) {
    setBenefitDraft(savedBenefits(plan, section).map((b) => ({ ...b })));
    setBenefitEditFor({ planId: plan.id, section });
  }

  function cancelBenefitEdit() {
    setBenefitEditFor(null);
    setBenefitDraft([]);
  }

  function isEditingBenefit(planId: number, section: BenefitSection) {
    return benefitEditFor?.planId === planId && benefitEditFor.section === section;
  }

  async function saveBenefitEdit(planId: number, endpoint: string) {
    setBenefitSaving(true);
    try {
      await apiFetch(`/membership-plans/${planId}/${endpoint}`, {
        method: 'PUT',
        body: JSON.stringify({ items: toBenefitItems(benefitDraft) }),
      });
      setBenefitEditFor(null);
      setBenefitDraft([]);
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    } finally {
      setBenefitSaving(false);
    }
  }

  // Active, tenant-scoped items grouped by the server-computed category. New
  // selections only ever come from these; an item already attached to the plan
  // but since deactivated is merged back per-row by benefitRowOptions().
  function categoryItems(section: BenefitSection): GymCharge[] {
    return gymCharges.filter((gc) => gc.benefit_category === section && gc.status === 'active');
  }

  // ─── Render helpers ─────────────────────────────────────────────────────────

  function renderInlineNewRow() {
    if (!inlineNew) return null;
    return (
      <div style={cardStyle(true)}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.5fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={inlineLabelStyle}>{t('plans.label_name')} *</label>
              <input
                ref={newNameRef}
                value={inlineNew.name}
                onChange={(e) => setInlineNew({ ...inlineNew, name: e.target.value })}
                placeholder={t('plans.placeholder_name')}
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('plans.label_description')}</label>
              <input
                value={inlineNew.description}
                onChange={(e) => setInlineNew({ ...inlineNew, description: e.target.value })}
                placeholder={t('plans.placeholder_description')}
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('plans.label_lifecycle_status')}</label>
              <select
                value={inlineNew.lifecycle_status}
                onChange={(e) => setInlineNew({ ...inlineNew, lifecycle_status: e.target.value as Plan['lifecycle_status'] })}
                style={inlineSelectStyle}
              >
                {LIFECYCLE_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
              </select>
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('plans.label_enrollment_status')}</label>
              <select
                value={inlineNew.enrollment_status}
                onChange={(e) => setInlineNew({ ...inlineNew, enrollment_status: e.target.value as Plan['enrollment_status'] })}
                style={inlineSelectStyle}
              >
                {ENROLLMENT_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={inlineLabelStyle}>{t('plans.label_tax_rate')}</label>
              <select
                value={inlineNew.tax_rate_id}
                onChange={(e) => setInlineNew({ ...inlineNew, tax_rate_id: e.target.value })}
                style={inlineSelectStyle}
              >
                <option value="">{t('plans.tax_rate_default')}</option>
                {taxRateOptions(inlineNew.tax_rate_id).map((tr) => (
                  <option key={tr.id} value={tr.id}>{tr.name} ({parseFloat(tr.rate_percent)}%)</option>
                ))}
              </select>
            </div>
          </div>
          <p style={{ ...fieldDescStyle, margin: '0 0 6px' }}>
            {t('plans.tax_behavior_hint_inclusive')}
          </p>
          <p style={{ ...fieldDescStyle, margin: '0 0 12px' }}>
            {t('plans.default_billing_notice', {
              billing: fmtBillingInterval(DEFAULT_BILLING_POLICY.recurring_billing_interval, DEFAULT_BILLING_POLICY.recurring_billing_unit),
              service: fmtBillingInterval(DEFAULT_BILLING_POLICY.recurring_service_interval, DEFAULT_BILLING_POLICY.recurring_service_unit),
            })}
          </p>
          {inlineNew.error && <p style={{ color: '#c0392b', fontSize: 13, margin: '0 0 8px' }}>{inlineNew.error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('plans.cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving} style={btnSmall()}>
              {inlineNew.saving ? t('plans.saving') : t('plans.save_changes')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (gymLoading || !canRead) return null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('plans.title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={LIFECYCLE_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button onClick={openInlineNew} title={readOnlyTitle} style={readOnlyStyle(btnStyle(), !canWrite)} disabled={!canWrite || inlineNew !== null}>{t('plans.add')}</button>
        </div>
      </div>

      {/* Column headers */}
      {!loading && (plans.length > 0 || inlineNew) && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('plans.col_name')}</div>
          <div style={{ flex: 3 }}>{t('plans.col_description')}</div>
          <div style={{ flex: 2 }}>{t('plans.col_created_by')}</div>
          <div style={{ minWidth: 100 }}>{t('plans.col_created_at')}</div>
          <div style={{ minWidth: 90 }}>{t('plans.col_status')}</div>
          <div style={{ minWidth: 90 }}>{t('plans.col_enrollment')}</div>
          <div style={{ minWidth: 13, flexShrink: 0 }} />
          <div style={{ minWidth: 32, flexShrink: 0 }} />
        </div>
      )}

      {/* Inline create */}
      {renderInlineNewRow()}

      {/* Plan list */}
      {loading ? (
        <p style={{ color: '#888' }}>{t('plans.loading')}</p>
      ) : plans.length === 0 && !inlineNew ? (
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
              { label: t('plans.details'), onClick: () => setDetailFor(plan) },
              { label: t('plans.edit'), onClick: () => openInlineEdit(plan), disabled: !canWrite, title: readOnlyTitle },
              { label: t('plans.assign_to_member'), onClick: () => setAssigningPlan(plan), disabled: !canAssign, title: assignReadOnlyTitle },
              { label: t('plans.duplicate'), onClick: () => handleDuplicate(plan), disabled: !canWrite, title: readOnlyTitle },
              { label: t('plans.delete'), onClick: () => setDeleting(plan), danger: true, disabled: !canWrite, title: readOnlyTitle },
            ];

            return (
              <div key={plan.id} style={cardStyle(false)}>
                {/* Row header */}
                <div style={rowStyle} onClick={() => toggleExpand(plan.id)}>
                  <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {plan.name}
                  </div>
                  <div style={{ flex: 3, fontSize: 13.5, color: '#888', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {descText}
                  </div>
                  <div style={{ flex: 2, fontSize: 13, color: '#888', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                      status={plan.enrollment_status === 'public' ? 'active' : plan.enrollment_status === 'staff_only' ? 'paused' : 'inactive'}
                      label={t(`status.${plan.enrollment_status}`)}
                    />
                  </div>
                  <span style={{ fontSize: 13, color: '#aaa', flexShrink: 0, display: 'inline-block', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
                  <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
                    <ContextMenu items={menuItems} ariaLabel={`Actions for ${plan.name}`} />
                  </div>
                </div>

                {/* Inline edit form */}
                {isEditing && (
                  <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
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
                      <div>
                        <label style={inlineLabelStyle}>{t('plans.label_member_limit')}</label>
                        <select
                          value={editForm.member_limit}
                          onChange={(e) => setEditForm({ ...editForm, member_limit: e.target.value as Plan['member_limit'] })}
                          style={inlineSelectStyle}
                        >
                          {MEMBER_LIMITS.map((m) => (
                            <option key={m} value={m}>{t(`plans.member_limit_${m}`)}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {/* #547: price and VAT are edited together in the Pricing section below —
                        changing them there is what opens a new price and files the old one in
                        the history, so they are deliberately not repeated in this form. */}
                    <p style={{ ...fieldDescStyle, margin: '0 0 8px' }}>{t('plans.tax_rate_moved_hint')}</p>
                    {editError && <p style={{ color: '#c0392b', fontSize: 13, margin: '8px 0 0' }}>{editError}</p>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
                      <button onClick={cancelEdit} style={btnSmall('#888')}>{t('plans.cancel')}</button>
                      <button onClick={() => handleInlineSave(plan)} disabled={editSaving} style={btnSmall()}>
                        {editSaving ? t('plans.saving') : t('plans.save_changes')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Accordion detail sections (view mode only) */}
                {isExpanded && !isEditing && (
                  <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
                    <SectionHeader title={t('plans.section_status')} />
                    <DetailRow label={t('plans.label_lifecycle_status')} value={t(`status.${plan.lifecycle_status}`)} />
                    <DetailRow label={t('plans.label_enrollment_status')} value={t(`status.${plan.enrollment_status}`)} />
                    <DetailRow
                      label={t('plans.label_member_limit')}
                      value={
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#eef0ff', color: '#4b45c6' }}>
                          {t(`plans.member_limit_${plan.member_limit}`)}
                        </span>
                      }
                    />
                    <DetailRow label={t('plans.members_using_plan')} value={String(plan.member_count)} />

                    <SectionHeader
                      title={t('plans.section_billing')}
                      action={billingEditForPlanId === plan.id ? null : <button onClick={() => openBillingEdit(plan)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(linkBtn, !canWrite)}>{t('plans.edit')}</button>}
                    />
                    {billingEditForPlanId === plan.id ? (
                      <div style={{ margin: '6px 0 10px' }}>
                        {BILLING_POLICY_FIELDS.map((key) => (
                          <div key={key} style={{ marginBottom: 8 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <div style={{ width: 160, flexShrink: 0, fontSize: 13, color: '#555' }}>{t(`plans.label_${key}_interval`)}</div>
                              <input
                                type="number" min="1"
                                value={(billingForm as any)[`${key}_interval`]}
                                onChange={(e) => setBillingForm({ ...billingForm, [`${key}_interval`]: parseInt(e.target.value) || 1 })}
                                style={{ ...inlineInputStyle, width: 70 }}
                              />
                              <select
                                value={(billingForm as any)[`${key}_unit`]}
                                onChange={(e) => setBillingForm({ ...billingForm, [`${key}_unit`]: e.target.value })}
                                style={{ ...inlineSelectStyle, flex: 1 }}
                              >
                                {BILLING_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                              </select>
                            </div>
                            <div style={{ ...fieldDescStyle, marginLeft: 168 }}>{t(`plans.desc_${key}`)}</div>
                          </div>
                        ))}
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <input
                              type="checkbox"
                              id={`auto_renew_${plan.id}`}
                              checked={!!billingForm.auto_renew}
                              onChange={(e) => setBillingForm({ ...billingForm, auto_renew: e.target.checked })}
                            />
                            <label htmlFor={`auto_renew_${plan.id}`} style={{ fontSize: 13, cursor: 'pointer' }}>{t('plans.label_auto_renew')}</label>
                          </div>
                          <div style={{ ...fieldDescStyle, marginLeft: 26 }}>{t('plans.desc_auto_renew')}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <button onClick={cancelBillingEdit} style={btnSmall('#888')}>{t('plans.cancel')}</button>
                          <button onClick={() => handleSaveBilling(plan.id)} disabled={billingSaving} style={btnSmall()}>
                            {billingSaving ? t('plans.saving') : t('plans.save_changes')}
                          </button>
                        </div>
                      </div>
                    ) : plan.billing_policy ? (
                      <>
                        <DetailRow label={t('plans.billing_initial')} value={fmtBillingInterval(plan.billing_policy.initial_billing_interval, plan.billing_policy.initial_billing_unit)} description={t('plans.desc_initial_billing')} />
                        <DetailRow label={t('plans.billing_recurring')} value={`Every ${fmtBillingInterval(plan.billing_policy.recurring_billing_interval, plan.billing_policy.recurring_billing_unit)}`} description={t('plans.desc_recurring_billing')} />
                        <DetailRow label={t('plans.service_initial')} value={fmtBillingInterval(plan.billing_policy.initial_service_interval, plan.billing_policy.initial_service_unit)} description={t('plans.desc_initial_service')} />
                        <DetailRow label={t('plans.service_recurring')} value={fmtBillingInterval(plan.billing_policy.recurring_service_interval, plan.billing_policy.recurring_service_unit)} description={t('plans.desc_recurring_service')} />
                        <DetailRow label={t('plans.auto_renew')} value={plan.billing_policy.auto_renew ? t('plans.yes') : t('plans.no')} description={t('plans.desc_auto_renew')} />
                      </>
                    ) : (
                      <p style={hintSt}>{t('plans.no_billing')}</p>
                    )}

                    {/* #635 §7: Billing & Duration — the Promotion's Free Period /
                        Paid Duration / Bonus Duration, on the Plan itself. Its own
                        Edit/Save/Cancel (§10); nothing else on the card is unlocked
                        by it, and nothing bills off it yet (stage 3). */}
                    <SectionHeader
                      title={t('plans.section_billing_duration')}
                      action={durationEditForPlanId === plan.id ? null : (
                        <button onClick={() => openDurationEdit(plan)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(linkBtn, !canWrite)}>
                          {t('plans.edit')}
                        </button>
                      )}
                    />
                    {durationEditForPlanId === plan.id ? (
                      <div style={{ margin: '6px 0 10px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
                          {DURATION_FIELDS.map((field) => (
                            <div key={field}>
                              <label style={inlineLabelStyle}>{t(`plans.label_${field}`)}</label>
                              <input
                                type="number" min="0"
                                value={durationForm[field]}
                                onChange={(e) => setDurationForm({ ...durationForm, [field]: e.target.value })}
                                placeholder="0"
                                style={inlineInputStyle}
                              />
                            </div>
                          ))}
                        </div>
                        <p style={{ ...fieldDescStyle, margin: '0 0 8px' }}>{t('plans.desc_billing_duration')}</p>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <button onClick={cancelDurationEdit} style={btnSmall('#888')}>{t('plans.cancel')}</button>
                          <button onClick={() => saveDurationEdit(plan.id)} disabled={durationSaving} style={btnSmall()}>
                            {durationSaving ? t('plans.saving') : t('plans.save_changes')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      DURATION_FIELDS.map((field) => (
                        <DetailRow
                          key={field}
                          label={t(`plans.label_${field}`)}
                          value={plan[field] != null ? t('plans.months_value', { n: plan[field] }) : t('plans.not_configured')}
                        />
                      ))
                    )}

                    {/* #635 §3–§5: One-off / Session / Period Benefits, the same
                        three Sellable-Item-keyed sections a Promotion has, each with
                        its own independent Edit/Save/Cancel (§10) and no modal (§15). */}
                    {BENEFIT_SECTIONS.map(({ section, endpoint, titleKey, emptyKey, addKey, showFrequency }) => (
                      <div key={section}>
                        <SectionHeader
                          title={t(`plans.${titleKey}`)}
                          action={isEditingBenefit(plan.id, section) ? null : (
                            <button onClick={() => openBenefitEdit(plan, section)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(linkBtn, !canWrite)}>
                              {t('plans.edit')}
                            </button>
                          )}
                        />
                        {isEditingBenefit(plan.id, section) ? (
                          <div style={{ margin: '6px 0 10px' }}>
                            <SellableItemBenefitEditor
                              t={(key, values) => t(`plans.${key}` as any, values as any)}
                              addKey={addKey}
                              draft={benefitDraft}
                              setDraft={setBenefitDraft}
                              categoryItems={categoryItems(section)}
                              showFrequency={showFrequency}
                            />
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                              <button onClick={cancelBenefitEdit} style={btnSmall('#888')}>{t('plans.cancel')}</button>
                              <button onClick={() => saveBenefitEdit(plan.id, endpoint)} disabled={benefitSaving} style={btnSmall()}>
                                {benefitSaving ? t('plans.saving') : t('plans.save_changes')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <SellableItemBenefitView
                            t={(key, values) => t(`plans.${key}` as any, values as any)}
                            emptyKey={emptyKey}
                            rows={savedBenefits(plan, section)}
                            showFrequency={showFrequency}
                          />
                        )}
                      </div>
                    ))}

                    <SectionHeader
                      title={t('plans.section_centers')}
                      action={centersForPlanId === plan.id ? null : <button onClick={() => openCenters(plan)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(linkBtn, !canWrite)}>{t('plans.edit')}</button>}
                    />
                    {centersForPlanId === plan.id ? (
                      <div style={{ margin: '6px 0 10px' }}>
                        {allCenters.map((c) => (
                          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                            <input
                              type="checkbox"
                              id={`center_${plan.id}_${c.id}`}
                              checked={selectedCenterIds.includes(c.id)}
                              onChange={(e) => {
                                setSelectedCenterIds((prev) =>
                                  e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                                );
                              }}
                            />
                            <label htmlFor={`center_${plan.id}_${c.id}`} style={{ fontSize: 13, cursor: 'pointer' }}>{c.name}</label>
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                          <button onClick={() => setCentersForPlanId(null)} style={btnSmall('#888')}>{t('plans.cancel')}</button>
                          <button onClick={handleSaveCenters} style={btnSmall()}>{t('plans.save_changes')}</button>
                        </div>
                      </div>
                    ) : (plan.centers ?? []).length === 0 ? (
                      <DetailRow label="" value={t('plans.all_centers')} />
                    ) : (
                      (plan.centers ?? []).map((c) => <DetailRow key={c.id} label="" value={c.name} />)
                    )}

                    <SectionHeader
                      title={t('plans.section_pricing')}
                      action={pricingForPlanId === plan.id ? null : (
                        <button onClick={() => openPricing(plan)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(linkBtn, !canWrite)}>
                          {t('plans.edit_pricing')}
                        </button>
                      )}
                    />
                    {pricingForPlanId === plan.id ? (
                      <div style={{ margin: '6px 0 10px', padding: 10, background: 'rgba(0,0,0,0.02)', borderRadius: 6 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                          <div>
                            <label style={inlineLabelStyle}>{t('plans.label_price_incl_tax')}</label>
                            <input
                              type="number" min="0" step="0.01"
                              value={pricingForm.price}
                              onChange={(e) => setPricingForm({ ...pricingForm, price: e.target.value })}
                              placeholder="0.00"
                              style={inlineInputStyle}
                            />
                          </div>
                          <div>
                            <label style={inlineLabelStyle}>{t('plans.label_tax_rate')}</label>
                            <select
                              value={pricingForm.tax_rate_id}
                              onChange={(e) => setPricingForm({ ...pricingForm, tax_rate_id: e.target.value })}
                              style={inlineSelectStyle}
                            >
                              <option value="">{t('plans.tax_rate_default')}</option>
                              {taxRateOptions(pricingForm.tax_rate_id).map((tr) => (
                                <option key={tr.id} value={tr.id}>{tr.name} ({parseFloat(tr.rate_percent)}%)</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        {(() => {
                          // Req. 6/7/11/12: the entered price is always the final VAT-inclusive
                          // customer price — the net is derived from it live, and picking another
                          // VAT re-splits the same gross rather than stacking tax on top of it.
                          const selected = pricingForm.tax_rate_id !== ''
                            ? taxRates.find((tr) => String(tr.id) === pricingForm.tax_rate_id)
                            : taxRates.find((tr) => tr.is_system);
                          const ratePercent = selected ? parseFloat(selected.rate_percent) : null;
                          if (ratePercent == null || isNaN(ratePercent)) return null;
                          const priceNum = parseFloat(pricingForm.price);
                          const preview = !isNaN(priceNum) && priceNum >= 0
                            ? computeVatPreview(priceNum, ratePercent, 'inclusive')
                            : null;
                          return (
                            <p style={{ ...fieldDescStyle, margin: '0 0 8px' }}>
                              {t('plans.price_hint_inclusive', { rate: ratePercent })}
                              {preview && (
                                <> — {t('plans.price_preview', {
                                  excl: preview.amount_excl_tax.toFixed(2),
                                  incl: preview.amount_incl_tax.toFixed(2),
                                })}</>
                              )}
                            </p>
                          );
                        })()}
                        <p style={{ ...fieldDescStyle, margin: '0 0 8px' }}>{t('plans.pricing_save_hint')}</p>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <button onClick={closePricingForm} style={btnSmall('#888')}>{t('plans.cancel')}</button>
                          <button onClick={() => handleSavePricing(plan.id)} disabled={pricingSaving} style={btnSmall()}>
                            {pricingSaving ? t('plans.saving') : t('plans.save')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <DetailRow
                          label={t('plans.label_tax_rate')}
                          value={plan.tax_rate_name ? `${plan.tax_rate_name} (${parseFloat(plan.tax_rate_percent ?? '0')}%)` : t('plans.tax_rate_default')}
                        />
                        {plan.current_price != null && plan.amount_excl_tax != null && plan.amount_incl_tax != null && (
                          <DetailRow
                            label={t('plans.label_current_price')}
                            value={`€${plan.amount_incl_tax.toFixed(2)} ${t('plans.tax_included_suffix')} (${t('plans.price_preview', { excl: plan.amount_excl_tax.toFixed(2), incl: plan.amount_incl_tax.toFixed(2) })})`}
                          />
                        )}
                        {plan.current_price != null && (
                          <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '6px 0 10px' }}>
                            <button
                              onClick={() => setApplyPricingFor(plan)}
                              disabled={!canWrite}
                              title={readOnlyTitle}
                              style={readOnlyStyle(btnSmall(), !canWrite)}
                            >
                              {t('plans.apply_price_to_assigned')}
                            </button>
                          </div>
                        )}
                      </>
                    )}

                    <SectionHeader title={t('plans.section_prices')} />
                    {(plan.price_history ?? []).length === 0 ? (
                      <p style={hintSt}>{t('plans.no_prices')}</p>
                    ) : (
                      // Newest first — the plan's current price heads its own history.
                      [...(plan.price_history ?? [])]
                        .sort((a, b) =>
                          Number(a.status === 'inactive') - Number(b.status === 'inactive')
                          || String(b.valid_from).localeCompare(String(a.valid_from))
                          || b.id - a.id)
                        .map((row) => (
                          <div key={row.id} style={benefitRowStyle}>
                            <span style={benefitNameStyle}>
                              {String(row.valid_from).slice(0, 10)}{row.valid_to ? ` – ${String(row.valid_to).slice(0, 10)}` : ''}
                            </span>
                            <span style={benefitValueStyle}>
                              €{parseFloat(row.price).toFixed(2)}
                              {row.tax_rate_percent != null && ` (${t('plans.price_hint_inclusive', { rate: parseFloat(row.tax_rate_percent) })})`}
                            </span>
                            <span style={{ fontSize: 11, fontWeight: 600, color: row.status === 'inactive' ? '#888' : '#1e7e34' }}>
                              {t(`plans.price_status_${row.status}`)}
                            </span>
                          </div>
                        ))
                    )}

                    <SectionHeader title={t('plans.section_billing_forecast')} />
                    {plan.billing_forecast?.available ? (
                      <>
                        <p style={{ fontSize: 12, color: '#888', margin: '4px 0 10px', fontStyle: 'italic' }}>
                          ⚠ {t('plans.billing_forecast_disclaimer')}
                        </p>
                        {plan.billing_forecast.events.map((ev, i) => (
                          <div
                            key={i}
                            style={{
                              padding: '8px 0',
                              borderBottom: i < plan.billing_forecast.events.length - 1 ? '1px solid var(--gd-card-border, #f0f0f0)' : 'none',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                              <span>{ev.date} — {ev.description}</span>
                              <strong style={{ flexShrink: 0 }}>€{ev.total.toFixed(2)} {t('plans.forecast_total')}</strong>
                            </div>
                            {ev.lines.map((line, j) => (
                              <div key={j} style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                                • {line.label}: €{line.amount.toFixed(2)}
                              </div>
                            ))}
                          </div>
                        ))}
                      </>
                    ) : (
                      <p style={hintSt}>
                        {plan.billing_forecast?.reason ?? t('plans.billing_forecast_unavailable')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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

      {/* #547: pushing the plan's current price onto its Assigned Plans is
          confirmed explicitly — it changes what existing members pay. */}
      <ConfirmDialog
        open={applyPricingFor !== null}
        message={t('plans.confirm_apply_price', {
          name: applyPricingFor?.name ?? '',
          price: applyPricingFor?.amount_incl_tax != null ? applyPricingFor.amount_incl_tax.toFixed(2) : '',
        })}
        confirmLabel={t('plans.confirm_apply_price_yes')}
        cancelLabel={t('plans.cancel')}
        busy={applyingPricing}
        onConfirm={handleApplyPricing}
        onCancel={() => setApplyPricingFor(null)}
      />

      {/* Assign Plan to Member(s) (#376) */}
      {assigningPlan && (
        <AssignPlanModal
          plan={assigningPlan}
          onClose={() => setAssigningPlan(null)}
          onAssigned={() => {
            setAssigningPlan(null);
            toast(t('plans.assign_success'), 'success');
            load();
          }}
        />
      )}

      {/* Details modal (#512) — read-only, independent from the row's expand/collapse state */}
      {detailFor && (
        <PlanDetailModal plan={detailFor} onClose={() => setDetailFor(null)} />
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// Divider-above-label pattern, matching Promotions' subSectionSt + sectionLabelSt
// (see apps/admin/src/app/[locale]/promotions/page.tsx).
function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{ ...subSectionSt, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
      <span style={sectionLabelSt}>{title}</span>
      {action}
    </div>
  );
}

function DetailRow({ label, value, description }: { label: string; value: React.ReactNode; description?: string }) {
  return (
    <div>
      <div style={detailRowStyle}>
        {label && <span style={labelStyle}>{label}</span>}
        <span style={valueStyle}>{value}</span>
      </div>
      {description && <div style={{ ...fieldDescStyle, marginLeft: 208 }}>{description}</div>}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

// Card border/radius match Promotions' cardSt; the highlighted variant is reserved
// for the not-yet-saved "new plan" row, mirroring Promotions' "new" row treatment
// (existing rows keep a plain border while being edited).
const cardStyle = (highlighted: boolean): React.CSSProperties => ({
  ...cardSurfaceStyle,
  ...(highlighted ? { border: '1px solid #6c63ff' } : {}),
  overflow: 'hidden',
});

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', padding: '6px 20px', marginBottom: 4, gap: 12,
  fontSize: 11, fontWeight: 600, color: '#999', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const detailRowStyle: React.CSSProperties = {
  display: 'flex', gap: 12, padding: '4px 0', fontSize: 13.5,
};

const labelStyle: React.CSSProperties = {
  width: 200, flexShrink: 0, color: '#888',
};

const valueStyle: React.CSSProperties = {
  color: '#222', flex: 1,
};

// "Benefit"-style rows (Session / One-off / Period Benefits, Price History): name left, muted value trailing —
// mirrors Training Plan Templates' workout/exercise row layout (TrainingPlanTree.tsx BlockRow).
const benefitRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
  borderBottom: '1px solid var(--gd-card-border, #f4f4f6)',
};

const benefitNameStyle: React.CSSProperties = {
  fontWeight: 600, fontSize: 14, color: '#222', flex: 1, minWidth: 0,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const benefitValueStyle: React.CSSProperties = {
  fontSize: 12.5, color: '#888', flexShrink: 0,
};

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 4,
  textTransform: 'uppercase', letterSpacing: '0.04em',
};

// Section divider + label, matching Promotions' subSectionSt / sectionLabelSt.
const subSectionSt: React.CSSProperties = { paddingTop: 16, marginTop: 16, borderTop: '1px solid var(--gd-card-border, #eee)' };
const sectionLabelSt: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' };
const hintSt: React.CSSProperties = { color: '#aaa', fontSize: 13, margin: 0 };

const fieldDescStyle: React.CSSProperties = {
  fontSize: 12, color: '#888', marginTop: 2, marginBottom: 6,
};

const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const inlineSelectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--brand, #6c63ff)', padding: '0 2px',
};

const dangerLinkBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#c0392b', padding: '0 2px',
};
