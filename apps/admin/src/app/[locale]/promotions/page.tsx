'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnSmall, btnStyle, readOnlyStyle } from '@/components/ui';
import { PromotionDetailModal } from './PromotionDetailModal';
import { isAllSelected, isIndeterminate, toggleSelectAll } from '@/lib/suitablePlansSelection';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Promo {
  id: number;
  name: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  stackable: number;
  lifecycle_status: 'active' | 'inactive';
  created_at: string;
  created_by_name: string | null;
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  pay_beforehand_months: number | null;
}

type PromotionTimelineStatus = 'free_promotion' | 'pay_promotion' | 'prepaid_promotion' | 'bonus_promotion' | 'pay_regular';
interface PromotionTimelinePeriod {
  period: number;
  status: PromotionTimelineStatus;
  startsOn: string;
  endsOn: string | null;
  billingAction: string | null;
  billingValue: number | null;
}
interface PromotionTimelineResponse { periods: PromotionTimelinePeriod[] }

interface MembershipPlan {
  id: number;
  name: string;
  // Secondary identifying info surfaced by GET /membership-plans (enrichPlan) —
  // shown alongside the name in the Suitable Membership Plans picker (#554).
  current_price?: string | number | null;
  enrollment_status?: string | null;
}
interface AssociatedPlan { id: number; name: string }
interface GymCharge {
  id: number;
  name: string;
  type: string;
  billing_frequency: string | null;
  status: string;
  // #550: server-computed via classifySellableItem() — the single source of
  // truth for which Promotion benefit section a Sellable Item belongs to.
  benefit_category: 'session' | 'oneoff' | 'periodical';
}
interface ChargeType { id: number; code: string; name: string; is_gym_charge: number }
interface PeriodBenefit {
  id: number;
  charge_type_id: number;
  charge_type_code: string;
  charge_type_name: string;
  quantity: number;
  frequency_interval: number;
  frequency_unit: 'week' | 'month';
  duration_months: number | null;
  enabled: number;
  // Membership Fee Benefits (#551) is the only remaining user of this shape —
  // the generic Period/Included Benefits it once coexisted with were retired
  // in #550 stage 3, replaced by the Sellable-Item-keyed benefits below.
  action: string | null;
  value: string | null;
}

// #550 stage 3: Session / One-off / Periodical Benefits — replaces the old
// Included Benefits + generic Period Benefits sections, keyed to a real
// Sellable Item (`gym_charges`) instead of the old `charge_types`
// pseudo-catalog. `gym_charge_*` fields come straight off GET
// /promotions/:id/{session,oneoff,periodical}-benefits (joined server-side),
// which is why an item that has since gone inactive still resolves to its
// real name/status here instead of falling back to "#<id>" — same pattern as
// Suitable Membership Plans (#554) and Suitable Membership Plans' `cachedPlans`.
interface SellableItemBenefit {
  gym_charge_id: number;
  quantity: number;
  gym_charge_name: string;
  gym_charge_type: string;
  gym_charge_billing_frequency: string | null;
  gym_charge_status: string;
}

const LIFECYCLE_STATUSES = ['active', 'inactive'] as const;
const CHARGE_ACTIONS = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'] as const;
const FREQ_UNITS = ['week', 'month'] as const;
const NEW_ID = 0;

const iso = (v: string) => (v ? v.slice(0, 10) : '');
const truncate = (s: string | null, n = 60) =>
  s ? (s.length > n ? s.slice(0, n) + '…' : s) : '—';

// Build a locale date string like "1 Aug 2026"
function fmtDate(d: Date, locale: string) {
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Parse a YYYY-MM-DD string (as returned by the /promotions/timeline endpoint) as a local Date
function parseDateStr(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// #625: total Promotion duration in months (free + paid + bonus). This is the
// ceiling for the Membership Fee Benefit duration. Pay Beforehand is excluded —
// it only reclassifies paid months as prepaid, it never lengthens the Promotion.
function promotionDurationFromForm(form: { free_months: string; paid_months: string; bonus_months: string }): number {
  const n = (v: string) => Math.max(0, parseInt(v, 10) || 0);
  return n(form.free_months) + n(form.paid_months) + n(form.bonus_months);
}

function emptyEditForm(promo?: Promo) {
  return {
    name: promo?.name ?? '',
    description: promo?.description ?? '',
    starts_at: promo ? iso(promo.starts_at) : '',
    ends_at: promo ? iso(promo.ends_at) : '',
    stackable: promo ? !!promo.stackable : false,
    lifecycle_status: (promo?.lifecycle_status ?? 'active') as 'active' | 'inactive',
    free_months: promo?.free_months != null ? String(promo.free_months) : '',
    paid_months: promo?.paid_months != null ? String(promo.paid_months) : '',
    pay_beforehand_months: promo?.pay_beforehand_months != null ? String(promo.pay_beforehand_months) : '',
    bonus_months: promo?.bonus_months != null ? String(promo.bonus_months) : '',
  };
}
type EditForm = ReturnType<typeof emptyEditForm>;

// ─── Component ────────────────────────────────────────────────────────────────

export default function PromotionsPage() {
  const t = useTranslations('promotions');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasNewRow, setHasNewRow] = useState(false);

  const [statusFilter, setStatusFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Active Membership Plans for this tenant — the source of truth for new
  // selections in the Suitable Membership Plans section (#554). Loaded on its
  // own (rather than folded into loadLookups' Promise.all below) so it can
  // show its own loading/empty/error state independent of the other lookups.
  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [plansStatus, setPlansStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [gymCharges, setGymCharges] = useState<GymCharge[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  // Full { id, name } objects for whatever plans are currently associated
  // with a promotion — from GET /promotions/:id/plans, which is not limited
  // to active plans, so a plan that has since gone inactive still resolves
  // to its name instead of falling back to "#<id>" (#554).
  const [cachedPlans, setCachedPlans] = useState<Record<number, AssociatedPlan[]>>({});
  const [cachedMf, setCachedMf] = useState<Record<number, PeriodBenefit | null>>({});
  const [cachedSessionB, setCachedSessionB] = useState<Record<number, SellableItemBenefit[]>>({});
  const [cachedOneoffB, setCachedOneoffB] = useState<Record<number, SellableItemBenefit[]>>({});
  const [cachedPeriodicalB, setCachedPeriodicalB] = useState<Record<number, SellableItemBenefit[]>>({});

  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm());
  const [plansDraft, setPlansDraft] = useState<number[]>([]);
  const [mfDraft, setMfDraft] = useState<PeriodBenefit | null>(null);
  const [sessionDraft, setSessionDraft] = useState<SellableItemBenefit[]>([]);
  const [oneoffDraft, setOneoffDraft] = useState<SellableItemBenefit[]>([]);
  const [periodicalDraft, setPeriodicalDraft] = useState<SellableItemBenefit[]>([]);

  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [detailFor, setDetailFor] = useState<Promo | null>(null);
  const [deleting, setDeleting] = useState<Promo | null>(null);

  const [timeline, setTimeline] = useState<PromotionTimelineResponse | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('FINANCIALS');

  const membershipFeeName = chargeTypes.find((c) => c.code === 'membership_fee')?.name ?? 'Membership Fee';

  // #550: active, tenant-scoped Sellable Items, grouped by the server-computed
  // `benefit_category` — the only classification source of truth (never
  // re-derived from name/type/frequency here). New selections only ever come
  // from these three lists; an item already associated with a promotion but
  // since deactivated is merged in separately per-row (see benefitRowOptions).
  const activeSessionItems = gymCharges.filter((gc) => gc.benefit_category === 'session');
  const activeOneoffItems = gymCharges.filter((gc) => gc.benefit_category === 'oneoff');
  const activePeriodicalItems = gymCharges.filter((gc) => gc.benefit_category === 'periodical');

  // Existing selections must remain visible/editable even after the
  // underlying Sellable Item goes inactive (#550) — so a row's own saved
  // gym_charge_id is always offered as an option, even if it fell out of the
  // active-only `categoryItems` list above.
  function benefitRowOptions(categoryItems: GymCharge[], row: SellableItemBenefit) {
    const opts = categoryItems.map((c) => ({ id: c.id, name: c.name, inactive: false }));
    if (!opts.some((o) => o.id === row.gym_charge_id)) {
      opts.unshift({ id: row.gym_charge_id, name: row.gym_charge_name, inactive: true });
    }
    return opts;
  }

  function defaultMfDraft(): PeriodBenefit {
    return {
      id: -1, charge_type_id: 0, charge_type_code: 'membership_fee', charge_type_name: membershipFeeName,
      quantity: 1, frequency_interval: 1, frequency_unit: 'month', duration_months: null, enabled: 1,
      action: 'no_benefit', value: null,
    };
  }

  useEffect(() => {
    if (!gymLoading && !canRead) router.replace(`/${locale}`);
  }, [gymLoading, canRead]);

  useEffect(() => {
    if (!gymLoading && canRead) { loadPlans(); loadOtherLookups(); }
  }, [gymLoading, canRead, activeGymId]);

  useEffect(() => {
    if (!gymLoading && canRead) load();
  }, [activeGymId, gymLoading, statusFilter, search]);

  // Live forecast preview — recalculated by the backend (not duplicated here).
  // Shown as soon as a card is opened (view or edit), using the unsaved edit
  // form while editing that same card, or the promotion's own saved values
  // otherwise — so the simulation never requires entering edit mode first.
  useEffect(() => {
    if (expandedId === null) { setTimeline(null); setTimelineError(null); return; }
    let free_months: string, paid_months: string, pay_beforehand_months: string, bonus_months: string;
    let mfAction: string, mfEnabled: boolean, mfValue: string | null, mfDurationMonths: number | null;
    if (editingId === expandedId) {
      ({ free_months, paid_months, pay_beforehand_months, bonus_months } = editForm);
      mfAction = mfDraft?.action || 'no_benefit';
      mfEnabled = !!mfDraft?.enabled;
      mfValue = mfDraft?.value ?? null;
      mfDurationMonths = mfDraft?.duration_months ?? null;
    } else {
      const promo = rows.find((r) => r.id === expandedId);
      if (!promo) { setTimeline(null); setTimelineError(null); return; }
      free_months = promo.free_months != null ? String(promo.free_months) : '';
      paid_months = promo.paid_months != null ? String(promo.paid_months) : '';
      pay_beforehand_months = promo.pay_beforehand_months != null ? String(promo.pay_beforehand_months) : '';
      bonus_months = promo.bonus_months != null ? String(promo.bonus_months) : '';
      const savedMf = cachedMf[expandedId] ?? null;
      mfAction = savedMf?.action || 'no_benefit';
      mfEnabled = !!savedMf?.enabled;
      mfValue = savedMf?.value ?? null;
      mfDurationMonths = savedMf?.duration_months ?? null;
    }
    if (!free_months && !paid_months && !pay_beforehand_months && !bonus_months) {
      setTimeline(null);
      setTimelineError(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          free_months: free_months || '0',
          paid_months: paid_months || '0',
          pay_beforehand_months: pay_beforehand_months || '0',
          bonus_months: bonus_months || '0',
          membership_fee_action: mfAction,
          membership_fee_enabled: mfEnabled ? '1' : '0',
        });
        if (mfValue != null && mfValue !== '') qs.set('membership_fee_value', mfValue);
        if (mfDurationMonths != null) qs.set('membership_fee_duration_months', String(mfDurationMonths));
        const data = await apiFetch<PromotionTimelineResponse>(`/promotions/timeline?${qs.toString()}`);
        setTimeline(data);
        setTimelineError(null);
      } catch (err: any) {
        setTimeline(null);
        setTimelineError(err.message ?? t('error_generic'));
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    expandedId, editingId, rows, cachedMf,
    editForm.free_months, editForm.paid_months, editForm.pay_beforehand_months, editForm.bonus_months,
    mfDraft?.action, mfDraft?.value, mfDraft?.enabled, mfDraft?.duration_months,
  ]);

  // #625: when the Promotion duration shrinks while editing (e.g. reducing
  // free/paid/bonus months), an already-entered Membership Fee Benefit duration
  // must be re-constrained down to the new maximum so it never outlasts the
  // Promotion. Only clamps an explicit (non-null) over-long value; a null
  // (unbounded) duration is left alone.
  useEffect(() => {
    if (editingId == null) return;
    const max = promotionDurationFromForm(editForm);
    setMfDraft((prev) => {
      if (!prev || prev.duration_months == null) return prev;
      if (max > 0 && prev.duration_months > max) return { ...prev, duration_months: max };
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, editForm.free_months, editForm.paid_months, editForm.bonus_months]);

  // Source of truth for the Suitable Membership Plans picker (#554): active,
  // tenant-scoped plans loaded dynamically from the Membership Plans API —
  // never hardcoded, never duplicated here. Own loading/error state so the
  // section can show it independent of the other lookups below.
  async function loadPlans() {
    setPlansStatus('loading');
    try {
      const pl = await apiFetch<MembershipPlan[]>('/membership-plans?lifecycle_status=active');
      setPlans(pl);
      setPlansStatus('ready');
    } catch {
      setPlans([]);
      setPlansStatus('error');
    }
  }

  async function loadOtherLookups() {
    try {
      const [gc, ct] = await Promise.all([
        apiFetch<GymCharge[]>('/sellable-items?availability=available'),
        apiFetch<ChargeType[]>('/charge-types'),
      ]);
      setGymCharges(gc);
      setChargeTypes(ct);
    } catch { /* non-critical */ }
  }

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('lifecycle_status', statusFilter);
      if (search) params.set('q', search);
      const qs = params.toString();
      setRows(await apiFetch<Promo[]>(`/promotions${qs ? `?${qs}` : ''}`));
    } catch (err: any) {
      setRows([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  async function loadSubResources(promoId: number) {
    try {
      const [ap, mf, sessionB, oneoffB, periodicalB] = await Promise.all([
        apiFetch<AssociatedPlan[]>(`/promotions/${promoId}/plans`),
        apiFetch<PeriodBenefit | null>(`/promotions/${promoId}/membership-fee-benefit`),
        apiFetch<SellableItemBenefit[]>(`/promotions/${promoId}/session-benefits`),
        apiFetch<SellableItemBenefit[]>(`/promotions/${promoId}/oneoff-benefits`),
        apiFetch<SellableItemBenefit[]>(`/promotions/${promoId}/periodical-benefits`),
      ]);
      setCachedPlans((prev) => ({ ...prev, [promoId]: ap }));
      setCachedMf((prev) => ({ ...prev, [promoId]: mf }));
      setCachedSessionB((prev) => ({ ...prev, [promoId]: sessionB }));
      setCachedOneoffB((prev) => ({ ...prev, [promoId]: oneoffB }));
      setCachedPeriodicalB((prev) => ({ ...prev, [promoId]: periodicalB }));
      return { ap, mf, sessionB, oneoffB, periodicalB };
    } catch {
      return {
        ap: [] as AssociatedPlan[], mf: null as PeriodBenefit | null,
        sessionB: [] as SellableItemBenefit[], oneoffB: [] as SellableItemBenefit[], periodicalB: [] as SellableItemBenefit[],
      };
    }
  }

  // ─── Expand / Edit ──────────────────────────────────────────────────────────

  function toggleExpand(id: number) {
    if (editingId === id) return;
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      if (id !== NEW_ID) loadSubResources(id);
    }
  }

  async function enterEdit(promo: Promo) {
    setExpandedId(promo.id);
    setEditingId(promo.id);
    setEditForm(emptyEditForm(promo));
    setEditError(null);
    const { ap, mf, sessionB, oneoffB, periodicalB } = await loadSubResources(promo.id);
    setPlansDraft(ap.map((p) => p.id));
    setMfDraft(mf ? { ...mf } : defaultMfDraft());
    setSessionDraft(sessionB.map((b) => ({ ...b })));
    setOneoffDraft(oneoffB.map((b) => ({ ...b })));
    setPeriodicalDraft(periodicalB.map((b) => ({ ...b })));
    setTimeout(() => nameInputRef.current?.focus(), 60);
  }

  function cancelEdit() {
    if (editingId === NEW_ID) setHasNewRow(false);
    setEditingId(null);
    setExpandedId(null);
    setEditError(null);
  }

  // ─── New Promotion (temp row) ────────────────────────────────────────────────

  function handleNew() {
    if (hasNewRow) return;
    setHasNewRow(true);
    setExpandedId(NEW_ID);
    setEditingId(NEW_ID);
    setEditForm(emptyEditForm());
    setPlansDraft([]);
    setMfDraft(defaultMfDraft());
    setSessionDraft([]);
    setOneoffDraft([]);
    setPeriodicalDraft([]);
    setEditError(null);
    setTimeout(() => nameInputRef.current?.focus(), 60);
  }

  // ─── Save ────────────────────────────────────────────────────────────────────

  async function handleSave(promoId: number) {
    if (!editForm.name.trim() || !editForm.starts_at || !editForm.ends_at) {
      setEditError(t('error_required'));
      return;
    }
    if (new Date(editForm.starts_at) > new Date(editForm.ends_at)) {
      setEditError(t('error_dates'));
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const body = {
        name: editForm.name.trim(),
        description: editForm.description.trim() || null,
        starts_at: editForm.starts_at,
        ends_at: editForm.ends_at,
        stackable: editForm.stackable,
        lifecycle_status: editForm.lifecycle_status,
        free_months: editForm.free_months !== '' ? parseInt(editForm.free_months, 10) : null,
        paid_months: editForm.paid_months !== '' ? parseInt(editForm.paid_months, 10) : null,
        pay_beforehand_months: editForm.pay_beforehand_months !== '' ? parseInt(editForm.pay_beforehand_months, 10) : 0,
        bonus_months: editForm.bonus_months !== '' ? parseInt(editForm.bonus_months, 10) : null,
      };

      let id = promoId;
      if (promoId === NEW_ID) {
        const created = await apiFetch<Promo>('/promotions', { method: 'POST', body: JSON.stringify(body) });
        id = created.id;
        setHasNewRow(false);
      } else {
        await apiFetch(`/promotions/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      }

      await apiFetch(`/promotions/${id}/plans`, {
        method: 'PUT',
        body: JSON.stringify({ membership_plan_ids: plansDraft }),
      });

      // #550: Session / One-off / Periodical Benefits, keyed to a real
      // Sellable Item — server-side classification (classifySellableItem())
      // is the enforcement backstop, this is just the replace-all payload shape.
      const toBenefitItems = (draft: SellableItemBenefit[]) =>
        draft.map((b) => ({ gym_charge_id: b.gym_charge_id, quantity: b.quantity }));
      await apiFetch(`/promotions/${id}/session-benefits`, {
        method: 'PUT',
        body: JSON.stringify({ items: toBenefitItems(sessionDraft) }),
      });
      await apiFetch(`/promotions/${id}/oneoff-benefits`, {
        method: 'PUT',
        body: JSON.stringify({ items: toBenefitItems(oneoffDraft) }),
      });
      await apiFetch(`/promotions/${id}/periodical-benefits`, {
        method: 'PUT',
        body: JSON.stringify({ items: toBenefitItems(periodicalDraft) }),
      });

      if (mfDraft) {
        const mfAction = mfDraft.action || 'no_benefit';
        const mfNeedsValue = ['percentage_discount', 'fixed_discount', 'fixed_price'].includes(mfAction);
        await apiFetch(`/promotions/${id}/membership-fee-benefit`, {
          method: 'PUT',
          body: JSON.stringify({
            quantity: mfDraft.quantity,
            frequency_interval: mfDraft.frequency_interval,
            frequency_unit: mfDraft.frequency_unit,
            duration_months: mfDraft.duration_months,
            enabled: mfDraft.enabled,
            action: mfAction,
            value: mfNeedsValue ? (parseFloat(mfDraft.value ?? '') || 0) : null,
          }),
        });
      }

      setEditingId(null);
      setExpandedId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Duplicate ───────────────────────────────────────────────────────────────

  async function handleDuplicate(promo: Promo) {
    try {
      const dup = await apiFetch<Promo>(`/promotions/${promo.id}/duplicate`, { method: 'POST' });
      await load();
      enterEdit(dup);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/promotions/${deleting.id}`, { method: 'DELETE' });
      if (expandedId === deleting.id) { setExpandedId(null); setEditingId(null); }
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Membership Fee benefit draft helper (#551 — singleton) ──────────────

  function updateMfDraft(patch: Partial<PeriodBenefit>) {
    setMfDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  // ─── Session / One-off / Periodical benefit draft helpers (#550) ─────────
  // Shared by all three sections — the only difference between them is which
  // `categoryItems` list (active Sellable Items of that classification) and
  // which draft/setter they operate on.

  function addBenefitRow(
    setDraft: (fn: (prev: SellableItemBenefit[]) => SellableItemBenefit[]) => void,
    categoryItems: GymCharge[],
    draft: SellableItemBenefit[],
  ) {
    const next = categoryItems.find((c) => !draft.some((d) => d.gym_charge_id === c.id));
    if (!next) return;
    setDraft((prev) => [
      ...prev,
      {
        gym_charge_id: next.id, quantity: 1, gym_charge_name: next.name,
        gym_charge_type: next.type, gym_charge_billing_frequency: next.billing_frequency,
        gym_charge_status: next.status,
      },
    ]);
  }

  function updateBenefitRow(
    setDraft: (fn: (prev: SellableItemBenefit[]) => SellableItemBenefit[]) => void,
    categoryItems: GymCharge[],
    idx: number,
    patch: Partial<SellableItemBenefit>,
  ) {
    setDraft((prev) => prev.map((r, i) => {
      if (i !== idx) return r;
      const next = { ...r, ...patch };
      if (patch.gym_charge_id != null) {
        const item = categoryItems.find((c) => c.id === patch.gym_charge_id);
        if (item) {
          next.gym_charge_name = item.name;
          next.gym_charge_type = item.type;
          next.gym_charge_billing_frequency = item.billing_frequency;
          next.gym_charge_status = item.status;
        }
      }
      return next;
    }));
  }

  // ─── Suitable Membership Plans: Select All (#554) ─────────────────────────
  // Selection math itself lives in lib/suitablePlansSelection.ts (unit
  // tested there) — this just wires it to component state and to the native
  // checkbox's `indeterminate` DOM property, which React has no prop for.

  const selectAllRef = useRef<HTMLInputElement>(null);
  const activePlanIds = plans.map((p) => p.id);
  const allPlansSelected = isAllSelected(activePlanIds, plansDraft);
  const somePlansSelected = isIndeterminate(activePlanIds, plansDraft);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = somePlansSelected;
  }, [somePlansSelected, expandedId, editingId]);

  function toggleSelectAllPlans(checked: boolean) {
    setPlansDraft((prev) => toggleSelectAll(prev, activePlanIds, checked));
  }

  function formatPlanSecondaryInfo(p: MembershipPlan): string | null {
    if (p.current_price != null && p.current_price !== '') {
      const n = parseFloat(String(p.current_price));
      if (!isNaN(n)) return `${n.toFixed(2)}€`;
    }
    if (p.enrollment_status) return tStatus(p.enrollment_status as any);
    return null;
  }

  // ─── Search debounce ──────────────────────────────────────────────────────

  function handleSearchChange(val: string) {
    setSearchInput(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(val), 300);
  }

  if (gymLoading || !canRead) return null;

  // ─── Timeline preview ─────────────────────────────────────────────────────
  // The Free/Pay/Prepaid/Bonus/Regular classification is computed by the
  // backend (GET /promotions/timeline, see api/src/domain/promotionTimeline.ts)
  // — this only renders whatever periods it returns, using stable status keys
  // to pick the translated label/billing text and row styling.

  const STATUS_LABEL_KEYS: Record<PromotionTimelineStatus, string> = {
    free_promotion: 'timeline_free',
    pay_promotion: 'timeline_pay_promo',
    prepaid_promotion: 'timeline_prepaid_promo',
    bonus_promotion: 'timeline_bonus',
    pay_regular: 'timeline_pay_regular',
  };

  // Billing column (#552): free/bonus periods are always "No charge" and the
  // trailing regular period is always "Regular price". A paid promotional
  // period reflects the promotion's Membership Fee Benefit — `waive` reads
  // as "No charge" same as a free period, no benefit (or none configured)
  // reads as "Regular price", and a discount/fixed-price benefit names its
  // value using the existing currency formatting (a plain "123.45€" suffix,
  // matching the convention already used elsewhere, e.g. AssignedPlanExpandedRow's fmtMoney).
  function billingLabelFor(row: PromotionTimelinePeriod): string {
    if (row.status === 'free_promotion' || row.status === 'bonus_promotion') return t('timeline_no_charge');
    if (row.status === 'pay_regular') return t('timeline_regular_price');
    const action = row.billingAction;
    const value = row.billingValue ?? 0;
    if (!action || action === 'no_benefit') return t('timeline_regular_price');
    if (action === 'waive') return t('timeline_no_charge');
    const base = t('timeline_promo_price');
    if (action === 'percentage_discount') return `${base} (${value}%)`;
    if (action === 'fixed_price') return `${base} (${value.toFixed(2)}€)`;
    if (action === 'fixed_discount') return `${base} (-${value.toFixed(2)}€)`;
    return base;
  }

  // #550: shared row/grid renderer for the Session / One-off / Periodical
  // Benefit sections — identical shape, differing only in which category's
  // active items back the picker and whether the (read-only, Sellable-Item-
  // derived) Frequency column is shown.
  function renderSellableItemBenefitSection(opts: {
    titleKey: string;
    addKey: string;
    draft: SellableItemBenefit[];
    setDraft: (fn: (prev: SellableItemBenefit[]) => SellableItemBenefit[]) => void;
    categoryItems: GymCharge[];
    showFrequency: boolean;
  }) {
    const { titleKey, addKey, draft, setDraft, categoryItems, showFrequency } = opts;
    const hasMoreToAdd = categoryItems.some((c) => !draft.some((d) => d.gym_charge_id === c.id));
    return (
      <div style={subSectionSt}>
        <p style={sectionLabelSt}>{t(titleKey as any)}</p>
        {draft.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: showFrequency ? '1.3fr 80px 100px 28px' : '1.3fr 80px 28px',
              gap: '3px 8px', alignItems: 'center', marginBottom: 8,
            }}
          >
            <span style={colHeaderSt}>{t('col_sellable_item')}</span>
            <span style={colHeaderSt}>{t('col_quantity')}</span>
            {showFrequency && <span style={colHeaderSt}>{t('col_frequency')}</span>}
            <span />
            {draft.map((row, idx) => (
              <div key={row.gym_charge_id} style={{ display: 'contents' }}>
                <select
                  value={row.gym_charge_id}
                  onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, { gym_charge_id: parseInt(e.target.value, 10) })}
                  style={inlineSelectSt}
                >
                  {benefitRowOptions(categoryItems, row).map((o) => (
                    <option key={o.id} value={o.id}>{o.inactive ? `${o.name} ${t('inactive_item_tag')}` : o.name}</option>
                  ))}
                </select>
                <input
                  type="number" min="1" value={row.quantity}
                  onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, { quantity: parseInt(e.target.value, 10) || 1 })}
                  style={{ ...inlineSelectSt, width: '100%' }}
                />
                {showFrequency && (
                  <span style={{ fontSize: 13, color: '#666' }}>
                    {row.gym_charge_billing_frequency ? t(`frequency_${row.gym_charge_billing_frequency}` as any) : '—'}
                  </span>
                )}
                <button
                  onClick={() => setDraft((prev) => prev.filter((_, i) => i !== idx))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c0392b', fontSize: 14, padding: 0 }}
                >✕</button>
              </div>
            ))}
          </div>
        )}
        {hasMoreToAdd && (
          <button onClick={() => addBenefitRow(setDraft, categoryItems, draft)} style={btnSmall('#6c63ff')}>{t(addKey as any)}</button>
        )}
      </div>
    );
  }

  // Read-only counterpart of renderSellableItemBenefitSection, used by
  // renderViewSection (card not in edit mode).
  function renderSellableItemBenefitViewSection(
    titleKey: string, emptyKey: string, rows: SellableItemBenefit[], showFrequency: boolean,
  ) {
    return (
      <div style={subSectionSt}>
        <p style={sectionLabelSt}>{t(titleKey as any)}</p>
        {rows.length === 0
          ? <p style={hintSt}>{t(emptyKey as any)}</p>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={thSt}>{t('col_sellable_item')}</th>
                  <th style={thSt}>{t('col_quantity')}</th>
                  {showFrequency && <th style={thSt}>{t('col_frequency')}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.gym_charge_id}>
                    <td style={tdSt}>{r.gym_charge_name}{r.gym_charge_status !== 'active' && ` ${t('inactive_item_tag')}`}</td>
                    <td style={tdSt}>{r.quantity}</td>
                    {showFrequency && (
                      <td style={tdSt}>{r.gym_charge_billing_frequency ? t(`frequency_${r.gym_charge_billing_frequency}` as any) : '—'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    );
  }

  function renderTimeline() {
    if (timelineError) {
      return (
        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_timeline')}</p>
          <p style={{ margin: 0, fontSize: 12, color: '#c0392b' }}>{timelineError}</p>
        </div>
      );
    }
    if (!timeline || timeline.periods.length === 0) {
      return (
        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_timeline')}</p>
          <p style={hintSt}>{t('timeline_empty')}</p>
        </div>
      );
    }

    const enrollmentStr = fmtDate(parseDateStr(timeline.periods[0].startsOn), locale);

    return (
      <div style={subSectionSt}>
        <p style={sectionLabelSt}>{t('section_timeline')}</p>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#666' }}>{t('timeline_example_note', { date: enrollmentStr })}</p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thSt}>{t('col_period')}</th>
                <th style={thSt}>{t('col_dates')}</th>
                <th style={thSt}>Status</th>
                <th style={thSt}>{t('col_billing')}</th>
              </tr>
            </thead>
            <tbody>
              {timeline.periods.map((row) => {
                const isFree = row.status === 'free_promotion' || row.status === 'bonus_promotion';
                const isRegular = row.status === 'pay_regular';
                const bg = isFree ? '#f0fdf4' : isRegular ? '#f9fafb' : '#fefce8';
                const statusLabel = t(STATUS_LABEL_KEYS[row.status] as any);
                const billingLabel = billingLabelFor(row);
                return (
                  <tr key={row.period} style={{ background: bg }}>
                    <td style={tdSt}>{row.endsOn ? row.period : `${row.period}+`}</td>
                    <td style={tdSt}>
                      {row.endsOn
                        ? `${fmtDate(parseDateStr(row.startsOn), locale)} – ${fmtDate(parseDateStr(row.endsOn), locale)}`
                        : `From ${fmtDate(parseDateStr(row.startsOn), locale)}`}
                    </td>
                    <td style={{ ...tdSt, fontWeight: 500 }}>{statusLabel}</td>
                    <td style={{ ...tdSt, color: isFree ? '#166534' : isRegular ? '#666' : '#854d0e' }}>{billingLabel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 11, color: '#aaa', fontStyle: 'italic' }}>{t('timeline_disclaimer')}</p>
        <p style={{ margin: '4px 0 0', fontSize: 11, color: '#aaa', fontStyle: 'italic' }}>{t('timeline_monthly_billing_disclaimer')}</p>
      </div>
    );
  }

  // ─── Render helpers ──────────────────────────────────────────────────────────

  function renderEditSection(promoId: number) {
    // #625: the Membership Fee Benefit can never outlast the Promotion, so its
    // duration is capped at the total Promotion duration
    // (free + paid + bonus — Pay Beforehand only reclassifies paid months as
    // prepaid, it never lengthens the Promotion). Recomputed live from the edit
    // form so shrinking the Promotion re-constrains the benefit immediately.
    const mfMaxDurationMonths = promotionDurationFromForm(editForm);
    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>

        {/* General */}
        <p style={sectionLabelSt}>{t('section_general')}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={inlineLabelSt}>{t('label_name')} *</label>
            <input
              ref={nameInputRef}
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              style={inlineInputSt}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={inlineLabelSt}>{t('label_description')}</label>
            <input
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              style={inlineInputSt}
            />
          </div>
          <div>
            <label style={inlineLabelSt}>{t('label_starts')} * <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(Promotion Availability)</span></label>
            <input type="date" value={editForm.starts_at} onChange={(e) => setEditForm({ ...editForm, starts_at: e.target.value })} style={inlineInputSt} />
          </div>
          <div>
            <label style={inlineLabelSt}>{t('label_ends')} * <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(Promotion Availability)</span></label>
            <input type="date" value={editForm.ends_at} onChange={(e) => setEditForm({ ...editForm, ends_at: e.target.value })} style={inlineInputSt} />
          </div>
          <div>
            <label style={inlineLabelSt}>{t('label_lifecycle_status')}</label>
            <select value={editForm.lifecycle_status} onChange={(e) => setEditForm({ ...editForm, lifecycle_status: e.target.value as 'active' | 'inactive' })} style={inlineSelectSt}>
              {LIFECYCLE_STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={editForm.stackable} onChange={(e) => setEditForm({ ...editForm, stackable: e.target.checked })} />
              {t('label_stackable')}
            </label>
          </div>
        </div>

        {/* Suitable Membership Plans (#554) — which active plans this promotion
            can be applied to. Backed by promotion_membership_plans; eligibility
            is enforced server-side both here (active-plan validation on save)
            and at apply-time (membership-promotions.ts checks this same table). */}
        <div style={subSectionSt}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <p style={sectionLabelSt}>{t('section_suitable_plans')}</p>
            {plansStatus === 'error' && (
              <button onClick={loadPlans} style={btnSmall('#888')}>{t('retry')}</button>
            )}
          </div>
          {plansStatus === 'loading' && <p style={hintSt}>{t('plans_loading')}</p>}
          {plansStatus === 'error' && <p style={{ margin: 0, fontSize: 13, color: '#c0392b' }}>{t('plans_load_error')}</p>}
          {plansStatus === 'ready' && plans.length === 0 && <p style={hintSt}>{t('plans_empty')}</p>}
          {plansStatus === 'ready' && plans.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer', fontWeight: 600, paddingBottom: 4, borderBottom: '1px solid var(--gd-card-border, #eee)' }}>
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allPlansSelected}
                  onChange={(e) => toggleSelectAllPlans(e.target.checked)}
                />
                {t('select_all')}
              </label>
              {plans.map((p) => {
                const secondary = formatPlanSecondaryInfo(p);
                return (
                  <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={plansDraft.includes(p.id)}
                      onChange={(e) => setPlansDraft((prev) => e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id))}
                    />
                    <span>{p.name}</span>
                    {secondary && <span style={{ color: '#999', fontSize: 12 }}>({secondary})</span>}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Billing & Duration */}
        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_billing_duration')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0 16px' }}>
            <div>
              <label style={inlineLabelSt}>{t('label_free_months')}</label>
              <input type="number" min="0" value={editForm.free_months} onChange={(e) => setEditForm({ ...editForm, free_months: e.target.value })} style={inlineInputSt} placeholder="0" />
            </div>
            <div>
              <label style={inlineLabelSt}>{t('label_paid_months')}</label>
              <input type="number" min="0" value={editForm.paid_months} onChange={(e) => setEditForm({ ...editForm, paid_months: e.target.value })} style={inlineInputSt} placeholder="0" />
            </div>
            <div>
              <label style={inlineLabelSt}>{t('label_pay_beforehand_months')}</label>
              <input type="number" min="0" value={editForm.pay_beforehand_months} onChange={(e) => setEditForm({ ...editForm, pay_beforehand_months: e.target.value })} style={inlineInputSt} placeholder="0" />
            </div>
            <div>
              <label style={inlineLabelSt}>{t('label_bonus_months')}</label>
              <input type="number" min="0" value={editForm.bonus_months} onChange={(e) => setEditForm({ ...editForm, bonus_months: e.target.value })} style={inlineInputSt} placeholder="0" />
            </div>
          </div>
        </div>

        {/* #626: the Charge Benefits section was removed from the Promotion
            editor. Promotion benefits are now configured only through the
            Session / One-off / Periodical and Membership Fee sections below. */}

        {/* Session / One-off / Periodical Benefits (#550) — Sellable-Item-keyed,
            replacing the old charge_types-pseudo-catalog Included/Period Benefits. */}
        {renderSellableItemBenefitSection({
          titleKey: 'section_session_benefits', addKey: 'add_session_benefit',
          draft: sessionDraft, setDraft: setSessionDraft, categoryItems: activeSessionItems, showFrequency: false,
        })}
        {renderSellableItemBenefitSection({
          titleKey: 'section_oneoff_benefits', addKey: 'add_oneoff_benefit',
          draft: oneoffDraft, setDraft: setOneoffDraft, categoryItems: activeOneoffItems, showFrequency: false,
        })}
        {renderSellableItemBenefitSection({
          titleKey: 'section_period_benefits', addKey: 'add_period_benefit',
          draft: periodicalDraft, setDraft: setPeriodicalDraft, categoryItems: activePeriodicalItems, showFrequency: true,
        })}

        {/* Membership Fee Benefits (#551) — reuses the Period Benefits fields/
            validation/behaviour exactly; the item is hardcoded, never selectable. */}
        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_membership_fee_benefits')}</p>
          {mfDraft && (
            <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 55px 55px 75px 70px 120px 80px 55px', gap: '3px 8px', alignItems: 'center' }}>
              <span style={colHeaderSt}>{t('col_benefit_type')}</span>
              <span style={colHeaderSt}>{t('col_quantity')}</span>
              <span style={colHeaderSt}>{t('label_frequency_interval')}</span>
              <span style={colHeaderSt}>{t('label_frequency_unit')}</span>
              <span style={colHeaderSt}>{t('col_duration_months')}</span>
              <span style={colHeaderSt}>{t('col_action')}</span>
              <span style={colHeaderSt}>{t('col_value')}</span>
              <span style={colHeaderSt}>{t('col_enabled')}</span>
              {(() => {
                const mfAction = mfDraft.action ?? 'no_benefit';
                const mfNeedsValue = ['percentage_discount', 'fixed_discount', 'fixed_price'].includes(mfAction);
                return (
                  <div style={{ display: 'contents' }}>
                    <span style={{ fontSize: 13 }}>{mfDraft.charge_type_name}</span>
                    <input type="number" min="1" value={mfDraft.quantity} onChange={(e) => updateMfDraft({ quantity: parseInt(e.target.value, 10) || 1 })} style={{ ...inlineSelectSt, width: '100%' }} />
                    <input type="number" min="1" value={mfDraft.frequency_interval} onChange={(e) => updateMfDraft({ frequency_interval: parseInt(e.target.value, 10) || 1 })} style={{ ...inlineSelectSt, width: '100%' }} />
                    <select value={mfDraft.frequency_unit} onChange={(e) => updateMfDraft({ frequency_unit: e.target.value as 'week' | 'month' })} style={inlineSelectSt}>
                      {FREQ_UNITS.map((u) => <option key={u} value={u}>{t(`frequency_${u}` as any)}</option>)}
                    </select>
                    <input
                      type="number" min="1"
                      max={mfMaxDurationMonths > 0 ? mfMaxDurationMonths : undefined}
                      value={mfDraft.duration_months ?? ''}
                      // #625: the benefit can never outlast the Promotion, so cap
                      // the entered duration at the Promotion duration (Option A —
                      // prevent an out-of-range value rather than flagging it).
                      onChange={(e) => {
                        const raw = e.target.value ? parseInt(e.target.value, 10) : null;
                        const clamped = raw != null && mfMaxDurationMonths > 0 ? Math.min(raw, mfMaxDurationMonths) : raw;
                        updateMfDraft({ duration_months: clamped });
                      }}
                      placeholder="—"
                      title={mfMaxDurationMonths > 0 ? t('mf_duration_max_hint', { max: mfMaxDurationMonths }) : undefined}
                      style={{ ...inlineSelectSt, width: '100%' }}
                    />
                    <select
                      value={mfAction}
                      onChange={(e) => updateMfDraft({ action: e.target.value, value: '' })}
                      style={inlineSelectSt}
                    >
                      {CHARGE_ACTIONS.map((a) => (
                        <option key={a} value={a}>{t(`cb_action_${a}` as any)}</option>
                      ))}
                    </select>
                    {mfNeedsValue ? (
                      <input
                        type="number" min="0" max={mfAction === 'percentage_discount' ? 100 : undefined} step="0.01"
                        value={mfDraft.value ?? ''}
                        onChange={(e) => updateMfDraft({ value: e.target.value })}
                        placeholder="0"
                        style={{ width: 70, padding: '6px 8px', borderRadius: 4, border: '1px solid #ccc', fontSize: 12 }}
                      />
                    ) : <span />}
                    <label style={{ display: 'flex', justifyContent: 'center' }}>
                      <input type="checkbox" checked={!!mfDraft.enabled} onChange={(e) => updateMfDraft({ enabled: e.target.checked ? 1 : 0 })} />
                    </label>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        {/* Example Timeline — shown as soon as the card opens, kept last so
            Save/Cancel always follow every configuration section. */}
        {renderTimeline()}

        {editError && <p style={{ margin: '16px 0 0', fontSize: 13, color: '#c0392b' }}>{editError}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
          <button onClick={() => handleSave(promoId)} disabled={editSaving} style={btnSmall('#6c63ff')}>
            {editSaving ? t('saving') : t('save_changes')}
          </button>
        </div>

      </div>
    );
  }

  function renderViewSection(promo: Promo) {
    const associatedPlans = cachedPlans[promo.id] ?? [];
    const sessionB = cachedSessionB[promo.id] ?? [];
    const oneoffB = cachedOneoffB[promo.id] ?? [];
    const periodicalB = cachedPeriodicalB[promo.id] ?? [];
    const mf = cachedMf[promo.id] ?? null;

    const free = promo.free_months ?? 0;
    const paid = promo.paid_months ?? 0;
    const payBeforehand = promo.pay_beforehand_months ?? 0;
    const bonus = promo.bonus_months ?? 0;

    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>

        {/* Billing & Duration summary */}
        {(free > 0 || paid > 0 || bonus > 0) && (
          <div style={subSectionSt}>
            <p style={sectionLabelSt}>{t('section_billing_duration')}</p>
            <div style={{ display: 'flex', gap: 24, fontSize: 13, flexWrap: 'wrap' }}>
              {free > 0 && <span><strong>{t('label_free_months')}:</strong> {free}</span>}
              {paid > 0 && <span><strong>{t('label_paid_months')}:</strong> {paid}</span>}
              {payBeforehand > 0 && <span><strong>{t('label_pay_beforehand_months')}:</strong> {payBeforehand}</span>}
              {bonus > 0 && <span><strong>{t('label_bonus_months')}:</strong> {bonus}</span>}
            </div>
          </div>
        )}

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_suitable_plans')}</p>
          {associatedPlans.length === 0
            ? <p style={hintSt}>{t('no_suitable_plans_selected')}</p>
            // Renders directly off GET /promotions/:id/plans' own {id, name}
            // rows (source of truth) rather than resolving against the
            // active-only `plans` list, so a plan that has since gone
            // inactive still shows its real name instead of "#<id>" (#554).
            : associatedPlans.map((p) => (
                <p key={p.id} style={{ margin: '2px 0', fontSize: 13 }}>{p.name}</p>
              ))}
        </div>

        {/* #626: Charge Benefits removed — see renderEditSection. */}

        {renderSellableItemBenefitViewSection('section_session_benefits', 'no_session_benefits', sessionB, false)}
        {renderSellableItemBenefitViewSection('section_oneoff_benefits', 'no_oneoff_benefits', oneoffB, false)}
        {renderSellableItemBenefitViewSection('section_period_benefits', 'no_period_benefits', periodicalB, true)}

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_membership_fee_benefits')}</p>
          {!mf || (mf.action ?? 'no_benefit') === 'no_benefit'
            ? <p style={hintSt}>{t('no_membership_fee_benefit')}</p>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={thSt}>{t('col_benefit_type')}</th>
                    <th style={thSt}>{t('col_quantity')}</th>
                    <th style={thSt}>{t('col_frequency')}</th>
                    <th style={thSt}>{t('col_duration_months')}</th>
                    <th style={thSt}>{t('col_action')}</th>
                    <th style={thSt}>{t('col_value')}</th>
                    <th style={thSt}>{t('col_enabled')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ opacity: mf.enabled ? 1 : 0.45 }}>
                    <td style={tdSt}>{mf.charge_type_name}</td>
                    <td style={tdSt}>{mf.quantity}</td>
                    <td style={tdSt}>{mf.frequency_interval} {t(`frequency_${mf.frequency_unit}` as any)}</td>
                    <td style={tdSt}>{mf.duration_months ?? '—'}</td>
                    <td style={tdSt}>{t(`cb_action_${mf.action}` as any)}</td>
                    <td style={tdSt}>{mf.value ?? '—'}</td>
                    <td style={tdSt}>{mf.enabled ? '✓' : '—'}</td>
                  </tr>
                </tbody>
              </table>
            )}
        </div>

        {/* Example Timeline — shown as soon as the card opens, using the
            promotion's saved values (no need to enter edit mode). */}
        {renderTimeline()}

      </div>
    );
  }

  function renderRow(promo: Promo) {
    const isEditing = editingId === promo.id;
    const isExpanded = isEditing || expandedId === promo.id;

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetailFor(promo) },
      { label: t('edit'), onClick: () => enterEdit(promo), disabled: !canWrite, title: readOnlyTitle },
      { label: t('duplicate'), onClick: () => handleDuplicate(promo), disabled: !canWrite, title: readOnlyTitle },
      { label: t('delete'), onClick: () => setDeleting(promo), danger: true, disabled: !canWrite, title: readOnlyTitle },
    ];

    return (
      <div key={promo.id} style={cardSt}>
        <div style={rowSt} onClick={() => toggleExpand(promo.id)}>
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {promo.name}
          </div>
          <div style={{ flex: 3, fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {truncate(promo.description)}
          </div>
          <div style={{ minWidth: 120, flexShrink: 0, fontSize: 13, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {promo.created_by_name ?? '—'}
          </div>
          <div style={{ minWidth: 90, flexShrink: 0, fontSize: 13, color: '#888' }}>{iso(promo.created_at)}</div>
          <div style={{ minWidth: 90, flexShrink: 0, fontSize: 13, color: '#888' }}>{iso(promo.starts_at)}</div>
          <div style={{ minWidth: 90, flexShrink: 0, fontSize: 13, color: '#888' }}>{iso(promo.ends_at)}</div>
          <div style={{ minWidth: 80, flexShrink: 0 }}>
            <StatusBadge status={promo.lifecycle_status} label={tStatus(promo.lifecycle_status)} />
          </div>
          <span style={{ fontSize: 13, color: '#aaa', flexShrink: 0, display: 'inline-block', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ContextMenu items={menuItems} />
          </div>
        </div>
        {isEditing ? renderEditSection(promo.id) : isExpanded ? renderViewSection(promo) : null}
      </div>
    );
  }

  function renderNewRow() {
    return (
      <div key="new" style={{ ...cardSt, borderColor: '#6c63ff' }}>
        <div style={rowSt}>
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, color: '#6c63ff' }}>{t('add')}</div>
          <div style={{ flex: 3 }} />
          <div style={{ minWidth: 120, flexShrink: 0 }} />
          <div style={{ minWidth: 90, flexShrink: 0 }} />
          <div style={{ minWidth: 90, flexShrink: 0 }} />
          <div style={{ minWidth: 90, flexShrink: 0 }} />
          <div style={{ minWidth: 80, flexShrink: 0 }} />
          <span style={{ minWidth: 13, flexShrink: 0 }}>▾</span>
          <div style={{ minWidth: 32, flexShrink: 0 }} />
        </div>
        {renderEditSection(NEW_ID)}
      </div>
    );
  }

  function renderHeader() {
    return (
      <div style={{ display: 'flex', padding: '6px 20px', marginBottom: 4, color: '#999', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', gap: 12 }}>
        <span style={{ flex: 2 }}>{t('col_name')}</span>
        <span style={{ flex: 3 }}>{t('col_description')}</span>
        <span style={{ minWidth: 120, flexShrink: 0 }}>{t('col_created_by')}</span>
        <span style={{ minWidth: 90, flexShrink: 0 }}>{t('col_created_at')}</span>
        <span style={{ minWidth: 90, flexShrink: 0 }}>{t('col_starts')}</span>
        <span style={{ minWidth: 90, flexShrink: 0 }}>{t('col_ends')}</span>
        <span style={{ minWidth: 80, flexShrink: 0 }}>{t('col_status')}</span>
        <span style={{ minWidth: 13, flexShrink: 0 }} />
        <span style={{ minWidth: 32, flexShrink: 0 }} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={t('search_placeholder')}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, width: 260 }}
          />
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={LIFECYCLE_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={handleNew} title={readOnlyTitle} style={readOnlyStyle(btnStyle('#6c63ff'), !canWrite)} disabled={!canWrite || hasNewRow}>{t('add')}</button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : (
        <>
          {(rows.length > 0 || hasNewRow) && renderHeader()}
          {hasNewRow && renderNewRow()}
          {rows.length === 0 && !hasNewRow && <p style={{ color: '#888' }}>{t('empty')}</p>}
          {rows.map(renderRow)}
        </>
      )}

      <ConfirmDialog
        open={deleting !== null}
        message={t('confirm_delete')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      {detailFor && (
        <PromotionDetailModal
          promotionId={detailFor.id}
          promotionName={detailFor.name}
          onClose={() => setDetailFor(null)}
        />
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardSt: React.CSSProperties = { border: '1px solid var(--gd-card-border, #e2e2e6)', borderRadius: 8, marginBottom: 8, overflow: 'hidden', background: 'var(--gd-card-bg, #fff)' };
const rowSt: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '12px 20px', gap: 12, cursor: 'pointer' };
const inlineLabelSt: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' };
const inlineInputSt: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', marginBottom: 12 };
const inlineSelectSt: React.CSSProperties = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box', background: '#fff', marginBottom: 8 };
const subSectionSt: React.CSSProperties = { paddingTop: 16, marginTop: 16, borderTop: '1px solid var(--gd-card-border, #eee)' };
const sectionLabelSt: React.CSSProperties = { margin: '0 0 10px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' };
const hintSt: React.CSSProperties = { color: '#aaa', fontSize: 13, margin: 0 };
const colHeaderSt: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', paddingBottom: 2 };
const thSt: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: '#888', fontWeight: 600, borderBottom: '1px solid #eee', fontSize: 12 };
const tdSt: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f5f5f5', fontSize: 13 };
