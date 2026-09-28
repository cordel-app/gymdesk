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
import { ExampleTimeline } from '@/components/ExampleTimeline';
import {
  SellableItemBenefitEditor,
  SellableItemBenefitView,
  SellableItemBenefitRow,
  SellableItemOption,
  toBenefitItems,
} from '@/components/SellableItemBenefits';
import {
  DEFAULT_PLAN_BILLING_FREQUENCY,
  EMPTY_PLAN_GENERAL_FORM,
  ENROLLMENT_STATUSES,
  LIFECYCLE_STATUSES,
  MEMBER_LIMITS,
  PLAN_BILLING_FREQUENCIES,
  PLAN_BILLING_FREQUENCY_OPTIONS,
  PLAN_GENERAL_EDITABLE_FIELDS,
  PLAN_GENERAL_FIELDS,
  PLAN_TIMELINE_STATUS_LABEL_KEYS,
  PlanBillingFrequency,
  PlanExampleTimeline,
  PlanGeneralField,
  PlanGeneralFormValues,
  PlanGeneralRow,
  formatPlanCurrentPrice,
  formatPlanGeneralField,
  formatPlanTimelineBilling,
  isPlanGeneralFormValid,
  legacyBillingFrequencyText,
  memberLimitChipStyle,
  planBillingFrequencyOf,
  planBillingPolicyBody,
  planTimelineRowTone,
  toPlanGeneralFormValues,
  toPlanGeneralUpdatePayload,
} from './planProfile';

// ─── Types ────────────────────────────────────────────────────────────────────

// #635 stage 13 (migration 189): Initial Billing, Initial Service and
// Recurring Service are gone — nothing billed off them. What survives is the
// Billing frequency, which the BILLING & DURATION section now carries, and
// Auto-renew beside it.
interface BillingPolicy {
  id: number;
  recurring_billing_interval: number;
  recurring_billing_unit: string;
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

// #816: the plan's own General columns are declared once, in `planProfile.ts`,
// and the row type extends that declaration — the expanded card's read-only
// GENERAL section and the inline Edit form render the same field list from it.
interface Plan extends PlanGeneralRow {
  id: number;
  current_price: string | null;
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
  pay_beforehand_months: number | null;
  tax_rate_id: number | null;
  tax_behavior: 'inclusive' | 'exclusive';
  tax_rate_name: string | null;
  tax_rate_percent: string | null;
  amount_excl_tax: number | null;
  amount_incl_tax: number | null;
  // #818: the Example timeline — read-only, computed by the backend on every
  // read, never persisted. Its rows are the Plan's own billing periods.
  example_timeline: PlanExampleTimeline;
}

// Applied automatically to every new plan; staff can adjust it afterwards in
// the Billing & Duration section. #820: the cadence comes from the Billing
// frequency declaration rather than being spelled out again here.
const DEFAULT_BILLING_POLICY = planBillingPolicyBody(DEFAULT_PLAN_BILLING_FREQUENCY, true);

// #635 §7 + stage 13: Billing & Duration — the Promotion's four fields, in the
// Promotion's own order. Pre-paid Duration is a slice of the Paid Duration, so
// it sits next to it.
const DURATION_FIELDS = ['free_months', 'paid_months', 'pay_beforehand_months', 'bonus_months'] as const;
type DurationField = typeof DURATION_FIELDS[number];

// The section's draft: the four durations, plus the cadence and Auto-renew it
// absorbed from the retired Billing Policy section.
//
// #820: the cadence is one choice — `billing_frequency` — not a number and a
// unit. `legacy_cadence` carries the text of a stored cadence that is neither
// option (a Plan configured before #820) so the editor can say what saving will
// change it to instead of silently relabelling it; it is seeded on open and
// never edited.
type DurationForm = Record<DurationField, string> & {
  billing_frequency: PlanBillingFrequency;
  legacy_cadence: string | null;
  auto_renew: boolean;
};

const EMPTY_DURATION_FORM: DurationForm = {
  free_months: '', paid_months: '', pay_beforehand_months: '', bonus_months: '',
  billing_frequency: DEFAULT_PLAN_BILLING_FREQUENCY,
  legacy_cadence: null,
  auto_renew: DEFAULT_BILLING_POLICY.auto_renew,
};

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

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// #818: a plain YYYY-MM-DD boundary from the Example timeline, read in the
// viewer's locale. Parsed field by field rather than with `new Date(str)`, which
// reads a bare date as UTC midnight and can render the previous day west of
// Greenwich — the same reason the Promotions page parses its timeline dates.
function fmtTimelineDate(dateStr: string, locale: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PlansPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  // #820: how a stored cadence reads on screen — "Month" / "4 Weeks" for the two
  // configurable ones, and the plain "Every 2 months" form for a Plan configured
  // before the rule, which still bills on it and must still say so.
  const billingFrequencyText = (interval: number, unit: string): string => {
    const freq = planBillingFrequencyOf(interval, unit);
    return freq
      ? t(`plans.${PLAN_BILLING_FREQUENCY_OPTIONS[freq].labelKey}` as any)
      : legacyBillingFrequencyText(interval, unit);
  };

  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  // Status filter (aligned with the Promotions list header — the list endpoint
  // already supports ?lifecycle_status=, so this is presentation-only wiring)
  const [statusFilter, setStatusFilter] = useState('');

  // Accordion expand (view mode)
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<PlanGeneralFormValues>(EMPTY_PLAN_GENERAL_FORM);
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

  // Charge benefits
  const [gymCharges, setGymCharges] = useState<GymCharge[]>([]);

  // Billing & Duration (#635 §7, stage 13) — the Plan's only billing section,
  // edited independently: the four durations plus the cadence and Auto-renew
  // that used to live in a second "Billing Policy" section of their own.
  const [durationEditForPlanId, setDurationEditForPlanId] = useState<number | null>(null);
  const [durationForm, setDurationForm] = useState<DurationForm>(EMPTY_DURATION_FORM);
  const [durationSaving, setDurationSaving] = useState(false);

  // Session / One-off / Period Benefits (#635 §3–§5). Exactly one section of
  // one plan is editable at a time, which is what keeps a single draft
  // unambiguous — same rule Promotions adopted in #627.
  const [benefitEditFor, setBenefitEditFor] = useState<{ planId: number; section: BenefitSection } | null>(null);
  const [benefitDraft, setBenefitDraft] = useState<SellableItemBenefitRow[]>([]);
  const [benefitSaving, setBenefitSaving] = useState(false);

  // Tax rates (#413)
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);

  // #817: Price History is a collapsible card, collapsed every time the plan is
  // expanded. Membership plan ids whose Price History the user has opened —
  // absent means collapsed, which is why the default needs no seeding, and
  // `toggleExpand` drops the id again so re-expanding a plan starts collapsed.
  const [priceHistoryOpen, setPriceHistoryOpen] = useState<Set<number>>(new Set());

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
    // #817: collapsing the plan forgets that its Price History was open, so the
    // next expand shows the header alone again.
    setPriceHistoryOpen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function togglePriceHistory(id: number) {
    setPriceHistoryOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ─── Inline edit ────────────────────────────────────────────────────────────

  // #816: `⋮ → Edit` is the only entry point into every editor this card has,
  // so it also expands the card — leaving Edit then reveals the read-only view
  // rather than collapsing the row the staff member was reading.
  function openInlineEdit(plan: Plan) {
    closeSectionForms();
    setEditingId(plan.id);
    setExpanded((prev) => new Set(prev).add(plan.id));
    setEditForm(toPlanGeneralFormValues(plan));
    setEditError(null);
  }

  // The section-level editors are only reachable from Edit mode, so leaving it
  // closes any one of them that is still open with a half-typed draft.
  function closeSectionForms() {
    setPricingForPlanId(null);
    setPricingForm({ price: '', tax_rate_id: '' });
    setCentersForPlanId(null);
    setDurationEditForPlanId(null);
    setBenefitEditFor(null);
    setBenefitDraft([]);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
    closeSectionForms();
  }

  async function handleInlineSave(plan: Plan) {
    if (!isPlanGeneralFormValid(editForm)) { setEditError(t('plans.error_required')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/membership-plans/${plan.id}`, {
        method: 'PUT',
        body: JSON.stringify(toPlanGeneralUpdatePayload(editForm)),
      });
      setEditingId(null);
      closeSectionForms();
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
    const bp = plan.billing_policy;
    setDurationForm({
      free_months: plan.free_months != null ? String(plan.free_months) : '',
      paid_months: plan.paid_months != null ? String(plan.paid_months) : '',
      pay_beforehand_months: plan.pay_beforehand_months != null ? String(plan.pay_beforehand_months) : '',
      bonus_months: plan.bonus_months != null ? String(plan.bonus_months) : '',
      // #820: the stored pair maps onto one of the two options, or onto none —
      // a Plan configured before the rule. It is not coerced silently: the
      // dropdown falls back to the default and the notice below it names the
      // cadence the Plan is on today.
      billing_frequency: (bp && planBillingFrequencyOf(bp.recurring_billing_interval, bp.recurring_billing_unit))
        || DEFAULT_PLAN_BILLING_FREQUENCY,
      legacy_cadence: bp && !planBillingFrequencyOf(bp.recurring_billing_interval, bp.recurring_billing_unit)
        ? legacyBillingFrequencyText(bp.recurring_billing_interval, bp.recurring_billing_unit)
        : null,
      auto_renew: bp ? !!bp.auto_renew : DEFAULT_BILLING_POLICY.auto_renew,
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
      // The cadence and Auto-renew are the same section to the user but a
      // different resource to the API (`billing_policies`), so the section's
      // Save writes both. The durations go first: they are what the section is
      // about, and a rejected one must not leave a changed cadence behind.
      await apiFetch(`/membership-plans/${planId}/billing-policy`, {
        method: 'PUT',
        // #820: still the `(interval, unit)` pair the API and every assignment
        // snapshot use — the single dropdown only decides which of the two
        // pairs it is.
        body: JSON.stringify(planBillingPolicyBody(durationForm.billing_frequency, durationForm.auto_renew)),
      });
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

  // #816 GENERAL: one field list, two renderings. `generalValue()` is the
  // read-only one (and the only place the em dash convention is applied);
  // `renderGeneralControl()` is the Edit form's, because every control needs its
  // own type, options and validation. A field added to PLAN_GENERAL_FIELDS
  // reaches the read-only view; making it `editable` is what asks for a control.
  function generalValue(plan: Plan, field: PlanGeneralField): string {
    return formatPlanGeneralField(
      plan,
      field,
      (key) => t(`status.${key}`),
      (value) => t(`plans.member_limit_${value}`),
    );
  }

  function renderGeneralControl(plan: Plan, field: PlanGeneralField) {
    const id = `plan-${plan.id}-${field.key}`;
    switch (field.key) {
      case 'name':
        return (
          <input
            id={id}
            value={editForm.name}
            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
            autoFocus
            style={inlineInputStyle}
          />
        );
      case 'description':
        return (
          <input
            id={id}
            value={editForm.description}
            onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
            style={inlineInputStyle}
          />
        );
      case 'lifecycle_status':
        return (
          <select
            id={id}
            value={editForm.lifecycle_status}
            onChange={(e) => setEditForm({ ...editForm, lifecycle_status: e.target.value as PlanGeneralFormValues['lifecycle_status'] })}
            style={inlineSelectStyle}
          >
            {LIFECYCLE_STATUSES.map((st) => <option key={st} value={st}>{t(`status.${st}`)}</option>)}
          </select>
        );
      case 'enrollment_status':
        return (
          <select
            id={id}
            value={editForm.enrollment_status}
            onChange={(e) => setEditForm({ ...editForm, enrollment_status: e.target.value as PlanGeneralFormValues['enrollment_status'] })}
            style={inlineSelectStyle}
          >
            {ENROLLMENT_STATUSES.map((st) => <option key={st} value={st}>{t(`status.${st}`)}</option>)}
          </select>
        );
      case 'member_limit':
        return (
          <select
            id={id}
            value={editForm.member_limit}
            onChange={(e) => setEditForm({ ...editForm, member_limit: e.target.value as PlanGeneralFormValues['member_limit'] })}
            style={inlineSelectStyle}
          >
            {MEMBER_LIMITS.map((m) => <option key={m} value={m}>{t(`plans.member_limit_${m}`)}</option>)}
          </select>
        );
      default:
        return null;
    }
  }

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
              billing: t(`plans.${PLAN_BILLING_FREQUENCY_OPTIONS[DEFAULT_PLAN_BILLING_FREQUENCY].labelKey}` as any),
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
            // #817 §1: collapsed by default — an id only lands in the set by clicking.
            const isPriceHistoryOpen = priceHistoryOpen.has(plan.id);
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

                {/* #816: expanding a Membership Plan reads it — the complete
                    plan, in PLAN_SECTION_ORDER's order, with no control that
                    writes. `⋮ → Edit` is the single entry point into the General
                    form *and* into the section-level editors, which is why every
                    section's `Edit` button is rendered only while `isEditing`. */}
                {isExpanded && (
                  <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
                    {/* GENERAL (§3) — the plan's own columns, declared once in planProfile.ts */}
                    <SectionHeader title={t('plans.section_general')} />
                    {isEditing ? (
                      <div style={{ margin: '6px 0 10px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                          {PLAN_GENERAL_EDITABLE_FIELDS.map((field) => (
                            <div key={field.key}>
                              <label htmlFor={`plan-${plan.id}-${field.key}`} style={inlineLabelStyle}>
                                {t(`plans.${field.labelKey}`)}
                              </label>
                              {renderGeneralControl(plan, field)}
                            </div>
                          ))}
                        </div>
                        {/* #547: price and VAT are edited in the Pricing section below —
                            changing them there is what opens a new price and files the old
                            one in the history, so they are deliberately not repeated here. */}
                        <p style={{ ...fieldDescStyle, margin: '8px 0' }}>{t('plans.tax_rate_moved_hint')}</p>
                        {editError && <p style={{ color: '#c0392b', fontSize: 13, margin: '8px 0 0' }}>{editError}</p>}
                        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
                          <button onClick={cancelEdit} style={btnSmall('#888')}>{t('plans.cancel')}</button>
                          <button onClick={() => handleInlineSave(plan)} disabled={editSaving} style={btnSmall()}>
                            {editSaving ? t('plans.saving') : t('plans.save_changes')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      PLAN_GENERAL_FIELDS.map((field) => (
                        <DetailRow
                          key={field.key}
                          label={t(`plans.${field.labelKey}`)}
                          value={
                            field.format === 'member_limit'
                              ? <span style={memberLimitChipStyle}>{generalValue(plan, field)}</span>
                              : generalValue(plan, field)
                          }
                        />
                      ))
                    )}

                    {/* PRICING (§4) — immediately after GENERAL, and read-only
                        unless the card is in Edit mode. One price per plan, always
                        VAT-inclusive (#547): the same resource as before, reached
                        from a different place. */}
                    <SectionHeader
                      title={t('plans.section_pricing')}
                      action={isEditing && pricingForPlanId !== plan.id ? (
                        <button onClick={() => openPricing(plan)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(linkBtn, !canWrite)}>
                          {t('plans.edit_pricing')}
                        </button>
                      ) : null}
                    />
                    {isEditing && pricingForPlanId === plan.id ? (
                      <div style={{ margin: '6px 0 10px', padding: 10, background: 'rgba(0,0,0,0.02)', borderRadius: 6 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                          <div>
                            <label htmlFor={`plan-${plan.id}-price`} style={inlineLabelStyle}>{t('plans.label_price_incl_tax')}</label>
                            <input
                              id={`plan-${plan.id}-price`}
                              type="number" min="0" step="0.01"
                              value={pricingForm.price}
                              onChange={(e) => setPricingForm({ ...pricingForm, price: e.target.value })}
                              placeholder="0.00"
                              style={inlineInputStyle}
                            />
                          </div>
                          <div>
                            <label htmlFor={`plan-${plan.id}-tax-rate`} style={inlineLabelStyle}>{t('plans.label_tax_rate')}</label>
                            <select
                              id={`plan-${plan.id}-tax-rate`}
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
                        <DetailRow
                          label={t('plans.label_current_price')}
                          value={formatPlanCurrentPrice(
                            plan,
                            t('plans.tax_included_suffix'),
                            (excl, incl) => t('plans.price_preview', { excl, incl }),
                          )}
                        />
                        {/* Pushing the price onto the plan's Assigned Plans changes what
                            existing members pay — a write, so it belongs to Edit mode. */}
                        {isEditing && plan.current_price != null && (
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

                    {/* #635 §7 + stage 13: Billing & Duration — the Promotion's
                        Free Period / Paid Duration / Pre-paid Duration / Bonus
                        Duration, on the Plan itself, plus the Billing frequency
                        and Auto-renew that used to be a "Billing Policy" section
                        of their own. It is the Plan's only billing section now,
                        with its own Save/Cancel (§10) behind `⋮ → Edit`. */}
                    <SectionHeader
                      title={t('plans.section_billing_duration')}
                      action={isEditing && durationEditForPlanId !== plan.id ? (
                        <button onClick={() => openDurationEdit(plan)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(linkBtn, !canWrite)}>
                          {t('plans.edit')}
                        </button>
                      ) : null}
                    />
                    {isEditing && durationEditForPlanId === plan.id ? (
                      <div style={{ margin: '6px 0 10px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 8 }}>
                          {DURATION_FIELDS.map((field) => (
                            <div key={field}>
                              <label htmlFor={`plan-${plan.id}-${field}`} style={inlineLabelStyle}>{t(`plans.label_${field}`)}</label>
                              <input
                                id={`plan-${plan.id}-${field}`}
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
                        {/* The cadence: how often the member is charged, which
                            the durations do not say (stage 13). #820: one
                            dropdown of the two cadences a gym bills on — the
                            number box and the unit list are gone, and the pair
                            they used to spell out is derived on save. */}
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                          <label htmlFor={`plan-${plan.id}-billing-frequency`} style={{ width: 160, flexShrink: 0, fontSize: 13, color: '#555' }}>{t('plans.label_billing_frequency')}</label>
                          <select
                            id={`plan-${plan.id}-billing-frequency`}
                            value={durationForm.billing_frequency}
                            onChange={(e) => setDurationForm({ ...durationForm, billing_frequency: e.target.value as PlanBillingFrequency })}
                            style={{ ...inlineSelectStyle, flex: 1 }}
                          >
                            {PLAN_BILLING_FREQUENCIES.map((freq) => (
                              <option key={freq} value={freq}>{t(`plans.${PLAN_BILLING_FREQUENCY_OPTIONS[freq].labelKey}` as any)}</option>
                            ))}
                          </select>
                        </div>
                        <div style={{ ...fieldDescStyle, marginLeft: 168, marginBottom: 10 }}>{t('plans.desc_recurring_billing')}</div>
                        {/* A Plan configured before #820 may sit on a cadence
                            neither option names. Saving this section moves it to
                            the selected one, so it is said out loud rather than
                            happening quietly behind an unchanged-looking form. */}
                        {durationForm.legacy_cadence && (
                          <div style={{ ...fieldDescStyle, marginLeft: 168, marginTop: -6, marginBottom: 10, color: '#8a6d1f' }}>
                            {t('plans.billing_frequency_legacy_notice', { current: durationForm.legacy_cadence })}
                          </div>
                        )}
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <input
                              type="checkbox"
                              id={`auto_renew_${plan.id}`}
                              checked={durationForm.auto_renew}
                              onChange={(e) => setDurationForm({ ...durationForm, auto_renew: e.target.checked })}
                            />
                            <label htmlFor={`auto_renew_${plan.id}`} style={{ fontSize: 13, cursor: 'pointer' }}>{t('plans.label_auto_renew')}</label>
                          </div>
                          <div style={{ ...fieldDescStyle, marginLeft: 26 }}>{t('plans.desc_auto_renew')}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <button onClick={cancelDurationEdit} style={btnSmall('#888')}>{t('plans.cancel')}</button>
                          <button onClick={() => saveDurationEdit(plan.id)} disabled={durationSaving} style={btnSmall()}>
                            {durationSaving ? t('plans.saving') : t('plans.save_changes')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {DURATION_FIELDS.map((field) => (
                          <DetailRow
                            key={field}
                            label={t(`plans.label_${field}`)}
                            value={plan[field] != null ? t('plans.months_value', { n: plan[field] }) : t('plans.not_configured')}
                          />
                        ))}
                        {plan.billing_policy ? (
                          <>
                            <DetailRow
                              label={t('plans.label_billing_frequency')}
                              value={billingFrequencyText(plan.billing_policy.recurring_billing_interval, plan.billing_policy.recurring_billing_unit)}
                              description={t('plans.desc_recurring_billing')}
                            />
                            <DetailRow label={t('plans.auto_renew')} value={plan.billing_policy.auto_renew ? t('plans.yes') : t('plans.no')} description={t('plans.desc_auto_renew')} />
                          </>
                        ) : (
                          <p style={hintSt}>{t('plans.no_billing')}</p>
                        )}
                      </>
                    )}

                    {/* #635 §3–§5: One-off / Session / Period Benefits, the same
                        three Sellable-Item-keyed sections a Promotion has, each with
                        its own independent Save/Cancel (§10) and no modal (§15).
                        #816 §6–§8: the Plan keeps these names — never the
                        Promotion's, which #815 renamed. */}
                    {BENEFIT_SECTIONS.map(({ section, endpoint, titleKey, emptyKey, addKey, showFrequency }) => (
                      <div key={section}>
                        <SectionHeader
                          title={t(`plans.${titleKey}`)}
                          action={isEditing && !isEditingBenefit(plan.id, section) ? (
                            <button onClick={() => openBenefitEdit(plan, section)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(linkBtn, !canWrite)}>
                              {t('plans.edit')}
                            </button>
                          ) : null}
                        />
                        {isEditing && isEditingBenefit(plan.id, section) ? (
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

                    {/* CENTERS (§9) */}
                    <SectionHeader
                      title={t('plans.section_centers')}
                      action={isEditing && centersForPlanId !== plan.id ? (
                        <button onClick={() => openCenters(plan)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(linkBtn, !canWrite)}>
                          {t('plans.edit')}
                        </button>
                      ) : null}
                    />
                    {isEditing && centersForPlanId === plan.id ? (
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

                    {/* EXAMPLE TIMELINE (§10, #818) — the Promotion card's own
                        simulation, for a Plan: one row per billing period of the
                        Plan's cadence, each row's Status and Billing decided
                        server-side by the same rule the nightly run prices a
                        cycle with. Read-only by nature — computed on every read
                        and never persisted, and a Membership Plan is not
                        assigned to anybody, so the dates are an illustration
                        from a hypothetical enrollment today. */}
                    <SectionHeader title={t('plans.section_example_timeline')} />
                    {plan.example_timeline?.available ? (
                      <>
                        {plan.example_timeline.anchorDate && (
                          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#666' }}>
                            {t('plans.timeline_example_note', {
                              date: fmtTimelineDate(plan.example_timeline.anchorDate, locale),
                            })}
                          </p>
                        )}
                        <ExampleTimeline
                          labels={{
                            period: t('plans.col_period'),
                            dates: t('plans.col_dates'),
                            status: t('plans.col_status'),
                            billing: t('plans.col_billing'),
                          }}
                          rows={plan.example_timeline.periods.map((row) => ({
                            key: row.period,
                            period: row.endsOn ? String(row.period) : `${row.period}+`,
                            dates: row.endsOn
                              ? `${fmtTimelineDate(row.startsOn, locale)} – ${fmtTimelineDate(row.endsOn, locale)}`
                              : t('plans.timeline_dates_from', { date: fmtTimelineDate(row.startsOn, locale) }),
                            status: t(`plans.${PLAN_TIMELINE_STATUS_LABEL_KEYS[row.status]}` as any),
                            billing: formatPlanTimelineBilling(
                              row,
                              t('plans.timeline_no_charge'),
                              t('plans.tax_included_suffix'),
                            ),
                            tone: planTimelineRowTone(row.status),
                          }))}
                          footnotes={
                            <>
                              <p style={{ margin: '8px 0 0', fontSize: 11, color: '#aaa', fontStyle: 'italic' }}>
                                {t('plans.timeline_disclaimer')}
                              </p>
                              <p style={{ margin: '4px 0 0', fontSize: 11, color: '#aaa', fontStyle: 'italic' }}>
                                {t('plans.timeline_duration_disclaimer')}
                              </p>
                              <p style={{ margin: '4px 0 0', fontSize: 11, color: '#aaa', fontStyle: 'italic' }}>
                                {t('plans.timeline_promotions_disclaimer')}
                              </p>
                            </>
                          }
                        />
                      </>
                    ) : (
                      // The server's `reason` is a single, known condition (no
                      // billing frequency configured), so it is said in the
                      // viewer's language rather than relayed in English.
                      <p style={hintSt}>{t('plans.timeline_unavailable')}</p>
                    )}

                    {/* PRICE HISTORY (§11, #817 §1) — after the numbered sections,
                        with its existing behaviour: a superseded price is never
                        rewritten. #817 frames it as a collapsible card that starts
                        collapsed, so a plan with a long price history no longer
                        buries the sections above it — only the framing changes,
                        the rows inside it are untouched. */}
                    <CollapsibleSectionHeader
                      title={t('plans.section_prices')}
                      open={isPriceHistoryOpen}
                      onToggle={() => togglePriceHistory(plan.id)}
                    />
                    {isPriceHistoryOpen && ((plan.price_history ?? []).length === 0 ? (
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
                    ))}
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

/**
 * #817 §1 — a section header that opens and closes its own body. The whole
 * header is the control (a real `<button>` carrying `aria-expanded`, the
 * treatment #632 established for the Theme Colors groups), so the label, the
 * chevron and the keyboard focus target are one thing rather than three.
 *
 * It is deliberately separate from `SectionHeader`'s `action` slot: an action is
 * a second control *beside* a static label, and mixing the two would make the
 * label both a button and not a button depending on a prop.
 */
function CollapsibleSectionHeader({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <div style={{ ...subSectionSt, marginBottom: 8 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          width: '100%', padding: 0, background: 'none', border: 'none', cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={sectionLabelSt}>{title}</span>
        <span
          aria-hidden="true"
          style={{
            fontSize: 13, color: '#aaa', display: 'inline-block',
            transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s',
          }}
        >
          ▾
        </span>
      </button>
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
