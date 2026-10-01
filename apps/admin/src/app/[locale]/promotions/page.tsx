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
import { btnSmall, btnStyle, cardSurfaceStyle, readOnlyStyle } from '@/components/ui';
import { SectionEditButton } from '@/components/SectionEditButton';
import { ExampleTimeline, ExampleTimelineTone } from '@/components/ExampleTimeline';
import { BillingDurationSummary, billingDurationItems } from '@/components/BillingDurationSummary';
import {
  SellableItemBenefitEditor,
  SellableItemBenefitRow,
  SellableItemBenefitView,
  invalidBenefitValueRow,
  toBenefitItems,
} from '@/components/SellableItemBenefits';
import { PromotionDetailModal } from './PromotionDetailModal';
import { mfDurationOptions, promotionTimelineMonths } from './membershipFeeDuration';
import { isAllSelected, isIndeterminate, toggleSelectAll } from '@/lib/suitablePlansSelection';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Promo {
  id: number;
  name: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  stackable: number;
  only_applicable_for_new_members: number;
  lifecycle_status: PromotionLifecycleStatus;
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
// The Membership Fee Benefit singleton (#551). #635 stage 5 gave it a table
// of its own (`promotion_membership_fee_benefits`), so it no longer carries a
// `charge_type_*` triplet: there is exactly one per Promotion and the item is
// always the membership fee, which is why the section labels the row with
// `membershipFeeName` rather than a field off the payload.
// #814: Duration, Action, Value and Enabled are the whole benefit. The
// Quantity / Every / Unit triplet this section used to render came from the
// Period Benefit shape it was built on ("2 sessions every 3 months") and said
// nothing about a membership fee, whose cadence is the Assigned Plan's own
// Billing frequency; migration 199 dropped the columns. Do not add a
// recurrence back.
interface MembershipFeeBenefit {
  id: number;
  duration_months: number | null;
  enabled: number;
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
// #896 stage 4: the row shape is the shared component's, not a second copy of
// it. The three sections are rendered by `SellableItemBenefitEditor` /
// `SellableItemBenefitView` now — the markup was duplicated here from the day
// Plans got the same sections (#635 stage 1), and the (action, value) pair this
// ticket adds is exactly the kind of field the two copies would have drifted on.
type SellableItemBenefit = SellableItemBenefitRow;

// #627: Promotion editing is split by section — the main Promotion
// configuration (General, Suitable Membership Plans, Billing & Duration) and
// each Benefit section save independently, and the whole Promotion is never
// written at once.
//
// #897 puts both behind one door. `editingId` is the card's own Edit mode,
// entered only from `⋮ → Edit`: while it is set the main configuration renders
// as a form and every Benefit section shows its Edit button, and while it is
// not the expanded card is read-only with no Edit affordance anywhere in it.
// `openSection` is which Benefit section's editor is open inside that mode —
// at most one, which is what keeps the single set of drafts below unambiguous.
type BenefitSection = 'session' | 'oneoff' | 'periodical' | 'membership_fee';
type SellableBenefitSection = Exclude<BenefitSection, 'membership_fee'>;

const SELLABLE_BENEFIT_ENDPOINT: Record<SellableBenefitSection, string> = {
  session: 'session-benefits',
  oneoff: 'oneoff-benefits',
  periodical: 'periodical-benefits',
};

// The three Sellable-Item-keyed Benefit sections (#550), each rendered — and
// since #627 edited and saved — independently of the others.
const SELLABLE_BENEFIT_SECTIONS: {
  section: SellableBenefitSection;
  titleKey: string;
  emptyKey: string;
  addKey: string;
  showFrequency: boolean;
}[] = [
  // #919/#920: `showFrequency` is true for all three, not only the Periodical
  // section. The flag is the *page's* now rather than the section's — one grid
  // for the three, so `QUANTITY`, `FREQUENCY` and `PROMOTION` sit at the same
  // horizontal position in each, and a Session or One-off item whose Sellable
  // Item carries no frequency keeps its cell with a "—" instead of letting the
  // columns after it shift. Same answer #916 gave the Membership Plan card.
  { section: 'session', titleKey: 'section_session_benefits', emptyKey: 'no_session_benefits', addKey: 'add_session_benefit', showFrequency: true },
  { section: 'oneoff', titleKey: 'section_oneoff_benefits', emptyKey: 'no_oneoff_benefits', addKey: 'add_oneoff_benefit', showFrequency: true },
  { section: 'periodical', titleKey: 'section_period_benefits', emptyKey: 'no_period_benefits', addKey: 'add_period_benefit', showFrequency: true },
];

// #900: `Expired` is a status the sweep writes (POST /promotion-lifecycle/run),
// never something a gym picks — it means "this Promotion reached its End Date",
// and offering it in the form would make it a second way of saying Inactive.
// So the two lists are not the same one: the filter offers all three (§10 — an
// expired Promotion must be findable, and not lumped in with the inactive
// ones), the editor offers the two a gym decides between, and a row that is
// already `expired` renders it as a disabled option so the select shows the
// status it actually holds instead of silently reading as Active.
type PromotionLifecycleStatus = 'active' | 'inactive' | 'expired';
const LIFECYCLE_FILTER_STATUSES: readonly PromotionLifecycleStatus[] = ['active', 'inactive', 'expired'];
const LIFECYCLE_EDIT_STATUSES: readonly PromotionLifecycleStatus[] = ['active', 'inactive'];
const CHARGE_ACTIONS = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'] as const;
const VALUED_CHARGE_ACTIONS = ['percentage_discount', 'fixed_discount', 'fixed_price'];
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
  const n = (v: string) => parseInt(v, 10) || 0;
  return promotionTimelineMonths(n(form.free_months), n(form.paid_months), n(form.bonus_months));
}

// Same ceiling, computed from a saved Promotion instead of the edit form —
// needed now that a Benefit section can be edited (#627) without the main
// configuration being in edit mode.
function promotionDurationFromPromo(promo: Promo): number {
  return promotionTimelineMonths(promo.free_months, promo.paid_months, promo.bonus_months);
}

// PUT body for the Membership Fee Benefit singleton (#551) — `value` is only
// sent for the actions that take one.
function membershipFeeBody(mf: MembershipFeeBenefit, durationMonths: number | null) {
  const action = mf.action || 'no_benefit';
  return {
    duration_months: durationMonths,
    enabled: mf.enabled,
    action,
    value: VALUED_CHARGE_ACTIONS.includes(action) ? (parseFloat(mf.value ?? '') || 0) : null,
  };
}

function emptyEditForm(promo?: Promo) {
  return {
    name: promo?.name ?? '',
    description: promo?.description ?? '',
    starts_at: promo ? iso(promo.starts_at) : '',
    ends_at: promo ? iso(promo.ends_at) : '',
    stackable: promo ? !!promo.stackable : false,
    // #633: checked by default on create; on edit it mirrors the stored value.
    only_applicable_for_new_members: promo ? !!promo.only_applicable_for_new_members : true,
    lifecycle_status: (promo?.lifecycle_status ?? 'active') as PromotionLifecycleStatus,
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
  // #897: the card in Edit mode — `⋮ → Edit` is its only entry point, and
  // everything editable inside the expanded card is gated on it.
  const [editingId, setEditingId] = useState<number | null>(null);
  // #627 + #897: which Benefit section of `editingId`'s card has its editor
  // open. `null` means only the main configuration is being edited. The
  // new-Promotion row never sets it: the Promotion has no id yet, so there is
  // nothing to hang per-section saves off and creation stays a single form.
  const [openSection, setOpenSection] = useState<BenefitSection | null>(null);
  // A Benefit section's own save error, kept apart from the main form's so a
  // failed section save cannot print its message under the main configuration.
  const [sectionError, setSectionError] = useState<string | null>(null);

  // Full { id, name } objects for whatever plans are currently associated
  // with a promotion — from GET /promotions/:id/plans, which is not limited
  // to active plans, so a plan that has since gone inactive still resolves
  // to its name instead of falling back to "#<id>" (#554).
  const [cachedPlans, setCachedPlans] = useState<Record<number, AssociatedPlan[]>>({});
  const [cachedMf, setCachedMf] = useState<Record<number, MembershipFeeBenefit | null>>({});
  const [cachedSessionB, setCachedSessionB] = useState<Record<number, SellableItemBenefit[]>>({});
  const [cachedOneoffB, setCachedOneoffB] = useState<Record<number, SellableItemBenefit[]>>({});
  const [cachedPeriodicalB, setCachedPeriodicalB] = useState<Record<number, SellableItemBenefit[]>>({});

  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm());
  const [plansDraft, setPlansDraft] = useState<number[]>([]);
  const [mfDraft, setMfDraft] = useState<MembershipFeeBenefit | null>(null);
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
  // since deactivated is merged in separately per-row by the shared editor's
  // benefitRowOptions().
  const activeSessionItems = gymCharges.filter((gc) => gc.benefit_category === 'session');
  const activeOneoffItems = gymCharges.filter((gc) => gc.benefit_category === 'oneoff');
  const activePeriodicalItems = gymCharges.filter((gc) => gc.benefit_category === 'periodical');

  function defaultMfDraft(): MembershipFeeBenefit {
    return {
      id: -1, duration_months: null, enabled: 1,
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
  //
  // #627: with editing split by section, each half of the forecast's input
  // follows its own section — the Billing & Duration months come from the edit
  // form only while the main configuration is being edited, and the Membership
  // Fee Benefit from its draft only while that section is being edited. Either
  // half falls back to the promotion's saved values otherwise. The new-Promotion
  // row edits both at once, so it uses the drafts for both.
  useEffect(() => {
    if (expandedId === null) { setTimeline(null); setTimelineError(null); return; }
    const editingHere = editingId === expandedId;
    // #897: the main configuration is a form for as long as the card is in Edit
    // mode, so the forecast follows the unsaved form throughout it.
    const useForm = editingHere;
    const useMfDraft = editingHere && (openSection === 'membership_fee' || expandedId === NEW_ID);

    const promo = expandedId !== NEW_ID ? rows.find((r) => r.id === expandedId) : undefined;
    if (!useForm && !promo) { setTimeline(null); setTimelineError(null); return; }

    const { free_months, paid_months, pay_beforehand_months, bonus_months } = useForm
      ? editForm
      : {
          free_months: promo!.free_months != null ? String(promo!.free_months) : '',
          paid_months: promo!.paid_months != null ? String(promo!.paid_months) : '',
          pay_beforehand_months: promo!.pay_beforehand_months != null ? String(promo!.pay_beforehand_months) : '',
          bonus_months: promo!.bonus_months != null ? String(promo!.bonus_months) : '',
        };
    const mf = useMfDraft ? mfDraft : (cachedMf[expandedId] ?? null);
    const mfAction = mf?.action || 'no_benefit';
    const mfEnabled = !!mf?.enabled;
    const mfValue = mf?.value ?? null;
    const mfDurationMonths = mf?.duration_months ?? null;

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
    expandedId, editingId, openSection, rows, cachedMf,
    editForm.free_months, editForm.paid_months, editForm.pay_beforehand_months, editForm.bonus_months,
    mfDraft?.action, mfDraft?.value, mfDraft?.enabled, mfDraft?.duration_months,
  ]);

  // #625: when the Promotion duration shrinks while editing (e.g. reducing
  // free/paid/bonus months), an already-entered Membership Fee Benefit duration
  // must be re-constrained down to the new maximum so it never outlasts the
  // Promotion. Only clamps an explicit (non-null) over-long value; a null
  // (unbounded) duration is left alone.
  //
  // #899 replaced the Duration input with a selector, so this is the one place
  // a selection can still fall out of range: the value was valid when it was
  // picked and the Promotion shrank underneath it. Without this the select
  // would simply render blank while the draft still carried the old number.
  useEffect(() => {
    if (editingId == null) return;
    const max = mfMaxDurationMonths(editingId);
    setMfDraft((prev) => {
      if (!prev || prev.duration_months == null) return prev;
      if (max > 0 && prev.duration_months > max) return { ...prev, duration_months: max };
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, openSection, rows, editForm.free_months, editForm.paid_months, editForm.bonus_months]);

  // #625 + #627: the ceiling for the Membership Fee Benefit duration. While the
  // card is in Edit mode (or a Promotion is being created) that is the unsaved
  // form's duration — the main configuration is editable throughout Edit mode
  // since #897; for a card that is merely expanded it is the saved duration.
  function mfMaxDurationMonths(promoId: number): number {
    if (promoId === NEW_ID || editingId === promoId) {
      return promotionDurationFromForm(editForm);
    }
    const promo = rows.find((r) => r.id === promoId);
    return promo ? promotionDurationFromPromo(promo) : 0;
  }

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
        apiFetch<MembershipFeeBenefit | null>(`/promotions/${promoId}/membership-fee-benefit`),
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
        ap: [] as AssociatedPlan[], mf: null as MembershipFeeBenefit | null,
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

  // Context-menu Edit (#627, #897) — the only way into Edit mode. It opens the
  // main Promotion configuration as a form and makes the Benefit sections'
  // own Edit buttons available; it expands the card too, so leaving Edit mode
  // reveals the read-only view rather than collapsing the row.
  async function enterEdit(promo: Promo) {
    setExpandedId(promo.id);
    setEditingId(promo.id);
    setOpenSection(null);
    setSectionError(null);
    setEditForm(emptyEditForm(promo));
    setEditError(null);
    // Still loads every sub-resource: the Benefit sections are rendered
    // read-only underneath the form and the forecast reads the saved
    // Membership Fee Benefit.
    const { ap } = await loadSubResources(promo.id);
    setPlansDraft(ap.map((p) => p.id));
    setTimeout(() => nameInputRef.current?.focus(), 60);
  }

  // A Benefit section's own Edit button (#627) — seeds only that section's
  // draft, from freshly reloaded saved values, and leaves every other section
  // untouched. Reachable only from inside Edit mode since #897, which is why it
  // never enters that mode itself.
  async function enterSectionEdit(promo: Promo, section: BenefitSection) {
    setExpandedId(promo.id);
    setOpenSection(section);
    setSectionError(null);
    const { mf, sessionB, oneoffB, periodicalB } = await loadSubResources(promo.id);
    if (section === 'membership_fee') setMfDraft(mf ? { ...mf } : defaultMfDraft());
    if (section === 'session') setSessionDraft(sessionB.map((b) => ({ ...b })));
    if (section === 'oneoff') setOneoffDraft(oneoffB.map((b) => ({ ...b })));
    if (section === 'periodical') setPeriodicalDraft(periodicalB.map((b) => ({ ...b })));
  }

  // Cancelling a Benefit section discards that section's draft and nothing
  // else — the card stays in Edit mode, on that section's read-only view.
  function cancelSectionEdit() {
    setOpenSection(null);
    setSectionError(null);
  }

  // Cancelling Edit mode (#897) returns the Promotion to its read-only expanded
  // view — every section editor closes with it, and no Edit button is left in
  // the card. The new-Promotion row is the one case that still collapses:
  // cancelling it discards a Promotion that was never created.
  function cancelEdit() {
    if (editingId === NEW_ID) { setHasNewRow(false); setExpandedId(null); }
    setEditingId(null);
    setOpenSection(null);
    setSectionError(null);
    setEditError(null);
  }

  // ─── New Promotion (temp row) ────────────────────────────────────────────────

  function handleNew() {
    if (hasNewRow) return;
    setHasNewRow(true);
    setExpandedId(NEW_ID);
    setEditingId(NEW_ID);
    setOpenSection(null);
    setSectionError(null);
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

  function validateMainForm(): string | null {
    if (!editForm.name.trim() || !editForm.starts_at || !editForm.ends_at) return t('error_required');
    if (new Date(editForm.starts_at) > new Date(editForm.ends_at)) return t('error_dates');
    return null;
  }

  function mainBody() {
    return {
      name: editForm.name.trim(),
      description: editForm.description.trim() || null,
      starts_at: editForm.starts_at,
      ends_at: editForm.ends_at,
      stackable: editForm.stackable,
      only_applicable_for_new_members: editForm.only_applicable_for_new_members,
      lifecycle_status: editForm.lifecycle_status,
      free_months: editForm.free_months !== '' ? parseInt(editForm.free_months, 10) : null,
      paid_months: editForm.paid_months !== '' ? parseInt(editForm.paid_months, 10) : null,
      pay_beforehand_months: editForm.pay_beforehand_months !== '' ? parseInt(editForm.pay_beforehand_months, 10) : 0,
      bonus_months: editForm.bonus_months !== '' ? parseInt(editForm.bonus_months, 10) : null,
    };
  }

  // Creating a Promotion stays a single form (#627): there is no Promotion id
  // yet to hang per-section saves off, so the create row writes the main
  // configuration and every Benefit section in one go, exactly as before.
  async function handleCreate() {
    const invalid = validateMainForm();
    if (invalid) { setEditError(invalid); return; }
    setEditSaving(true);
    setEditError(null);
    try {
      const created = await apiFetch<Promo>('/promotions', { method: 'POST', body: JSON.stringify(mainBody()) });
      const id = created.id;
      setHasNewRow(false);

      await apiFetch(`/promotions/${id}/plans`, {
        method: 'PUT',
        body: JSON.stringify({ membership_plan_ids: plansDraft }),
      });

      // #550: Session / One-off / Periodical Benefits, keyed to a real
      // Sellable Item — server-side classification (classifySellableItem())
      // is the enforcement backstop, this is just the replace-all payload shape.
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
        await apiFetch(`/promotions/${id}/membership-fee-benefit`, {
          method: 'PUT',
          body: JSON.stringify(membershipFeeBody(mfDraft, mfDraft.duration_months)),
        });
      }

      finishEdit();
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // #627: the main Promotion configuration — General, Suitable Membership
  // Plans and Billing & Duration. Benefit sections are untouched here; each one
  // saves itself through handleSaveBenefitSection below.
  async function handleSaveMain(promoId: number) {
    const invalid = validateMainForm();
    if (invalid) { setEditError(invalid); return; }
    setEditSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/promotions/${promoId}`, { method: 'PUT', body: JSON.stringify(mainBody()) });
      await apiFetch(`/promotions/${promoId}/plans`, {
        method: 'PUT',
        body: JSON.stringify({ membership_plan_ids: plansDraft }),
      });
      await clampSavedMembershipFeeDuration(promoId);
      // #897: saving leaves Edit mode but keeps the card open, so the staff
      // member lands on the read-only view of what they just saved. The
      // sub-resources are reloaded because that view renders off their caches.
      await loadSubResources(promoId);
      finishEdit();
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // #625 + #627: a Membership Fee Benefit can never outlast its Promotion, and
  // the backend rejects (400) a duration above the Promotion's. The benefit is
  // no longer saved alongside the Promotion, so shortening the Promotion here
  // has to re-constrain an already-saved, now-too-long duration itself —
  // otherwise that benefit would be stuck un-saveable until it was shortened by
  // hand. A null duration already means "the whole Promotion" and is left alone.
  async function clampSavedMembershipFeeDuration(promoId: number) {
    const mf = cachedMf[promoId];
    if (!mf || mf.duration_months == null) return;
    const max = promotionDurationFromForm(editForm);
    if (max > 0 && mf.duration_months <= max) return;
    const clamped = max > 0 ? max : null;
    await apiFetch(`/promotions/${promoId}/membership-fee-benefit`, {
      method: 'PUT',
      body: JSON.stringify(membershipFeeBody(mf, clamped)),
    });
    setCachedMf((prev) => ({ ...prev, [promoId]: { ...mf, duration_months: clamped } }));
  }

  // #627: one Benefit section, saved on its own. Only that section's endpoint
  // is written — nothing else about the Promotion is touched.
  async function handleSaveBenefitSection(promoId: number, section: BenefitSection) {
    setEditSaving(true);
    setSectionError(null);
    try {
      if (section === 'membership_fee') {
        if (mfDraft) {
          await apiFetch(`/promotions/${promoId}/membership-fee-benefit`, {
            method: 'PUT',
            body: JSON.stringify(membershipFeeBody(mfDraft, mfDraft.duration_months)),
          });
        }
      } else {
        // #896 §6: an action that asks for a value must carry one. The API
        // refuses the same shape; catching it here names the item instead of
        // reporting a bare field error.
        const draft = sellableSectionDraft(section);
        const incomplete = invalidBenefitValueRow(draft);
        if (incomplete) {
          setSectionError(t('benefit_value_required', { item: incomplete.gym_charge_name }));
          return;
        }
        await apiFetch(`/promotions/${promoId}/${SELLABLE_BENEFIT_ENDPOINT[section]}`, {
          method: 'PUT',
          body: JSON.stringify({ items: toBenefitItems(draft) }),
        });
      }
      await loadSubResources(promoId);
      // #897: only this section closes — the card stays in Edit mode, so the
      // other sections' Edit buttons are still there to be used.
      cancelSectionEdit();
    } catch (err: any) {
      setSectionError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  function finishEdit() {
    setEditingId(null);
    setOpenSection(null);
    setSectionError(null);
    setEditError(null);
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
      if (expandedId === deleting.id) { setExpandedId(null); finishEdit(); }
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Membership Fee benefit draft helper (#551 — singleton) ──────────────

  function updateMfDraft(patch: Partial<MembershipFeeBenefit>) {
    setMfDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  // ─── Section editing state (#627) ─────────────────────────────────────────

  // #897: the expanded card is read-only unless it is the one in Edit mode.
  function isEditingCard(promoId: number) {
    return editingId === promoId;
  }

  function isEditingSection(promoId: number, section: BenefitSection) {
    return editingId === promoId && openSection === section;
  }

  // Only one section is ever editable at a time, so every other section's Edit
  // button is disabled while one is open — a second Edit would otherwise
  // silently discard the unsaved draft it shares state with.
  const sectionEditBusy = openSection !== null;

  function sellableSectionDraft(section: SellableBenefitSection): SellableItemBenefit[] {
    if (section === 'session') return sessionDraft;
    if (section === 'oneoff') return oneoffDraft;
    return periodicalDraft;
  }

  function sellableSectionSetDraft(section: SellableBenefitSection) {
    if (section === 'session') return setSessionDraft;
    if (section === 'oneoff') return setOneoffDraft;
    return setPeriodicalDraft;
  }

  function sellableSectionItems(section: SellableBenefitSection): GymCharge[] {
    if (section === 'session') return activeSessionItems;
    if (section === 'oneoff') return activeOneoffItems;
    return activePeriodicalItems;
  }

  function sellableSectionSaved(promoId: number, section: SellableBenefitSection): SellableItemBenefit[] {
    if (section === 'session') return cachedSessionB[promoId] ?? [];
    if (section === 'oneoff') return cachedOneoffB[promoId] ?? [];
    return cachedPeriodicalB[promoId] ?? [];
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

  // Which of the shared table's three tones a period is drawn in (#818 moved the
  // colours into `ExampleTimeline`; the mapping stays with the statuses).
  function timelineTone(status: PromotionTimelineStatus): ExampleTimelineTone {
    if (status === 'free_promotion' || status === 'bonus_promotion') return 'free';
    if (status === 'pay_regular') return 'regular';
    return 'benefit';
  }

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

  // #550/#635: the Session / One-off / Periodical Promotion sections are the
  // same grid the Membership Plan card renders, so since #896 stage 4 there is
  // one implementation of it — `SellableItemBenefitEditor`. These two wrappers
  // stay because the sections are picked by name elsewhere on the page (#627's
  // one-section-at-a-time shell) and because this is where the Promotion's own
  // context is named: five options, and every label out of the `promotions`
  // namespace, which is what makes the very same stored `no_benefit` read as
  // *No promotion* here and *No benefit* on the Plans page (§3).
  function renderSellableItemBenefitEditor(opts: {
    addKey: string;
    draft: SellableItemBenefit[];
    setDraft: (fn: (prev: SellableItemBenefit[]) => SellableItemBenefit[]) => void;
    categoryItems: GymCharge[];
    showFrequency: boolean;
  }) {
    return (
      <SellableItemBenefitEditor
        t={(key, values) => t(key as any, values as any)}
        addKey={opts.addKey}
        draft={opts.draft}
        setDraft={opts.setDraft}
        categoryItems={opts.categoryItems}
        showFrequency={opts.showFrequency}
        benefitContext="promotion"
      />
    );
  }

  // Read-only counterpart of renderSellableItemBenefitEditor — what a section
  // shows until its own Edit button is pressed (#627).
  function renderSellableItemBenefitView(
    emptyKey: string, rows: SellableItemBenefit[], showFrequency: boolean,
  ) {
    return (
      <SellableItemBenefitView
        t={(key, values) => t(key as any, values as any)}
        emptyKey={emptyKey}
        rows={rows}
        showFrequency={showFrequency}
        benefitContext="promotion"
        // #920: Regular Price and Final Price, both VAT-inclusive and both the
        // server's (`withSellableItemBenefitPrices`) — the page does no
        // arithmetic of its own (#817). The two columns are labelled from the
        // `promotions` namespace, which is why the shared `col_original_price`
        // reads *Regular Price* here and *Original price* on the Plans card.
        showPrices
      />
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

    // #818: the table itself is the shared `ExampleTimeline` the Membership Plan
    // card renders too — the classification, the labels and the Billing column
    // stay here, where the Promotion's own Membership Fee Benefit lives.
    return (
      <div style={subSectionSt}>
        <p style={sectionLabelSt}>{t('section_timeline')}</p>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#666' }}>{t('timeline_example_note', { date: enrollmentStr })}</p>
        <ExampleTimeline
          labels={{ period: t('col_period'), dates: t('col_dates'), status: t('col_status'), billing: t('col_billing') }}
          rows={timeline.periods.map((row) => ({
            key: row.period,
            period: row.endsOn ? String(row.period) : `${row.period}+`,
            dates: row.endsOn
              ? `${fmtDate(parseDateStr(row.startsOn), locale)} – ${fmtDate(parseDateStr(row.endsOn), locale)}`
              : t('timeline_dates_from', { date: fmtDate(parseDateStr(row.startsOn), locale) }),
            status: t(STATUS_LABEL_KEYS[row.status] as any),
            billing: billingLabelFor(row),
            tone: timelineTone(row.status),
          }))}
          footnotes={
            <>
              <p style={{ margin: '8px 0 0', fontSize: 11, color: '#aaa', fontStyle: 'italic' }}>{t('timeline_disclaimer')}</p>
              <p style={{ margin: '4px 0 0', fontSize: 11, color: '#aaa', fontStyle: 'italic' }}>{t('timeline_monthly_billing_disclaimer')}</p>
            </>
          }
        />
      </div>
    );
  }

  // ─── Render helpers ──────────────────────────────────────────────────────────

  // #627: the editable main Promotion configuration — General, Suitable
  // Membership Plans and Billing & Duration, and nothing else. Shared by the
  // context-menu Edit action on an existing Promotion and by the create form.
  function renderMainFields() {
    return (
      <>

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
            <select value={editForm.lifecycle_status} onChange={(e) => setEditForm({ ...editForm, lifecycle_status: e.target.value as PromotionLifecycleStatus })} style={inlineSelectSt}>
              {LIFECYCLE_EDIT_STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
              {/* #900: only while the form holds it — selectable never, visible
                  so that saving an expired Promotion's other fields does not
                  quietly reactivate it. Choosing Active is how a gym revives
                  one, and the sweep expires it again unless its End Date moved. */}
              {!LIFECYCLE_EDIT_STATUSES.includes(editForm.lifecycle_status) && (
                <option value={editForm.lifecycle_status} disabled>{tStatus(editForm.lifecycle_status)}</option>
              )}
            </select>
          </div>
          {/* #633: the two Promotion booleans are grouped in one cell, the new
              "only applicable for new members" flag directly below Stackable. */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8, paddingBottom: 12 }}>
            <label style={checkboxLabelSt}>
              <input type="checkbox" checked={editForm.stackable} onChange={(e) => setEditForm({ ...editForm, stackable: e.target.checked })} />
              {t('label_stackable')}
            </label>
            <label style={checkboxLabelSt}>
              <input
                type="checkbox"
                checked={editForm.only_applicable_for_new_members}
                onChange={(e) => setEditForm({ ...editForm, only_applicable_for_new_members: e.target.checked })}
              />
              {t('label_only_applicable_for_new_members')}
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

      </>
    );
  }

  // Membership Fee Benefits (#551) — the item is hardcoded, never selectable.
  // #627: controls only; the section shell owns the title and Edit/Save/Cancel.
  // #814: Duration, Action, Value, Enabled — the Quantity / Every / Unit
  // columns it inherited from the Period Benefits shape are gone.
  function renderMembershipFeeEditor(promoId: number) {
    // #625: the Membership Fee Benefit can never outlast the Promotion, so its
    // duration is bounded by the total Promotion duration
    // (free + paid + bonus — Pay Beforehand only reclassifies paid months as
    // prepaid, it never lengthens the Promotion). #899 made that bound the
    // Duration selector's own option list rather than a cap applied after the
    // fact, so there is nothing left to truncate on the way in.
    const maxDuration = mfMaxDurationMonths(promoId);
    return (
      <>
      {mfDraft && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 70px 120px 80px 55px', gap: '3px 8px', alignItems: 'center' }}>
          <span style={colHeaderSt}>{t('col_benefit_type')}</span>
          <span style={colHeaderSt}>{t('col_duration')}</span>
          <span style={colHeaderSt}>{t('col_action')}</span>
          <span style={colHeaderSt}>{t('col_value')}</span>
          <span style={colHeaderSt}>{t('col_enabled')}</span>
          {(() => {
            const mfAction = mfDraft.action ?? 'no_benefit';
            const mfNeedsValue = ['percentage_discount', 'fixed_discount', 'fixed_price'].includes(mfAction);
            return (
              <div style={{ display: 'contents' }}>
                <span style={{ fontSize: 13 }}>{membershipFeeName}</span>
                {/* #899: a selector, not a free-text number. The options are
                    the durations the Promotion can actually carry (1..max, plus
                    "—" for the whole Promotion), so an out-of-range value cannot
                    be typed and then silently truncated — it is simply not
                    offered. A Promotion with no periods at all (max 0) offers
                    "—" alone, which is what keeps a positive duration off a
                    zero-period Promotion. */}
                <select
                  value={mfDraft.duration_months ?? ''}
                  onChange={(e) => updateMfDraft({
                    duration_months: e.target.value ? parseInt(e.target.value, 10) : null,
                  })}
                  title={maxDuration > 0 ? t('mf_duration_max_hint', { max: maxDuration }) : undefined}
                  style={{ ...inlineSelectSt, width: '100%' }}
                >
                  <option value="">—</option>
                  {mfDurationOptions(maxDuration).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
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
      </>
    );
  }

  // Read-only counterpart of renderMembershipFeeEditor (#627).
  function renderMembershipFeeView(mf: MembershipFeeBenefit | null) {
    if (!mf || (mf.action ?? 'no_benefit') === 'no_benefit') {
      return <p style={hintSt}>{t('no_membership_fee_benefit')}</p>;
    }
    return (
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={thSt}>{t('col_benefit_type')}</th>
            <th style={thSt}>{t('col_duration')}</th>
            <th style={thSt}>{t('col_action')}</th>
            <th style={thSt}>{t('col_value')}</th>
            <th style={thSt}>{t('col_enabled')}</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ opacity: mf.enabled ? 1 : 0.45 }}>
            <td style={tdSt}>{membershipFeeName}</td>
            <td style={tdSt}>{mf.duration_months ?? '—'}</td>
            <td style={tdSt}>{t(`cb_action_${mf.action}` as any)}</td>
            <td style={tdSt}>{mf.value ?? '—'}</td>
            <td style={tdSt}>{mf.enabled ? '✓' : '—'}</td>
          </tr>
        </tbody>
      </table>
    );
  }

  // ─── Section shells (#627) ────────────────────────────────────────────────

  // A section header: its title plus, only while the card is in Edit mode and
  // this section's own editor is closed, its Edit button (#897 — the caller
  // passes `null` for it in every other state, so a read-only expanded card
  // carries no Edit affordance at all). Only one section can be open at a time,
  // so every other section's button is disabled while one is.
  function renderSectionHeader(titleKey: string, onEdit: (() => void) | null) {
    const disabled = !canWrite || sectionEditBusy;
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <p style={sectionLabelSt}>{t(titleKey as any)}</p>
        {onEdit && (
          <SectionEditButton
            label={t('edit')}
            onClick={onEdit}
            disabled={disabled}
            title={!canWrite ? readOnlyTitle : sectionEditBusy ? t('edit_busy_hint') : undefined}
          />
        )}
      </div>
    );
  }

  // Save / Cancel for whichever part of the card is being edited. Saving one
  // section never writes another; cancelling discards only that part's draft —
  // a Benefit section's Cancel closes that section (#897), the main
  // configuration's leaves Edit mode. Each renders its own error, so a failed
  // section save never prints its message under the main form.
  function renderSectionActions(
    onSave: () => void,
    opts: { onCancel?: () => void; error?: string | null } = {},
  ) {
    const { onCancel = cancelEdit, error = editError } = opts;
    return (
      <>
        {error && <p style={{ margin: '16px 0 0', fontSize: 13, color: '#c0392b' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onCancel} style={btnSmall('#888')}>{t('cancel')}</button>
          <button onClick={onSave} disabled={editSaving} style={btnSmall('#6c63ff')}>
            {editSaving ? t('saving') : t('save_changes')}
          </button>
        </div>
      </>
    );
  }

  function renderSellableBenefitSection(promo: Promo, cfg: (typeof SELLABLE_BENEFIT_SECTIONS)[number]) {
    const editing = isEditingSection(promo.id, cfg.section);
    return (
      <div key={cfg.section} style={subSectionSt}>
        {renderSectionHeader(
          cfg.titleKey,
          isEditingCard(promo.id) && !editing ? () => enterSectionEdit(promo, cfg.section) : null,
        )}
        {editing ? (
          <>
            {renderSellableItemBenefitEditor({
              addKey: cfg.addKey,
              draft: sellableSectionDraft(cfg.section),
              setDraft: sellableSectionSetDraft(cfg.section),
              categoryItems: sellableSectionItems(cfg.section),
              showFrequency: cfg.showFrequency,
            })}
            {renderSectionActions(
              () => handleSaveBenefitSection(promo.id, cfg.section),
              { onCancel: cancelSectionEdit, error: sectionError },
            )}
          </>
        ) : renderSellableItemBenefitView(cfg.emptyKey, sellableSectionSaved(promo.id, cfg.section), cfg.showFrequency)}
      </div>
    );
  }

  function renderMembershipFeeSection(promo: Promo) {
    const editing = isEditingSection(promo.id, 'membership_fee');
    return (
      <div style={subSectionSt}>
        {renderSectionHeader(
          'section_membership_fee_benefits',
          isEditingCard(promo.id) && !editing ? () => enterSectionEdit(promo, 'membership_fee') : null,
        )}
        {editing ? (
          <>
            {renderMembershipFeeEditor(promo.id)}
            {renderSectionActions(
              () => handleSaveBenefitSection(promo.id, 'membership_fee'),
              { onCancel: cancelSectionEdit, error: sectionError },
            )}
          </>
        ) : renderMembershipFeeView(cachedMf[promo.id] ?? null)}
      </div>
    );
  }

  // ─── Expanded card (#627, #897) ───────────────────────────────────────────
  // One body for both states: each section renders itself either read-only or
  // in edit mode, so the Promotion is never editable as a whole. Expanding the
  // card reads it — every editor in here, the main configuration's included, is
  // behind `⋮ → Edit`.
  function renderExpandedSection(promo: Promo) {
    const editing = isEditingCard(promo.id);
    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
        {editing
          ? <>{renderMainFields()}{renderSectionActions(() => handleSaveMain(promo.id))}</>
          : renderMainView(promo)}

        {/* #626: the Charge Benefits section was removed from the Promotion
            editor. Promotion benefits are configured only through the
            Session / One-off / Periodical and Membership Fee sections below. */}
        {SELLABLE_BENEFIT_SECTIONS.map((cfg) => renderSellableBenefitSection(promo, cfg))}
        {renderMembershipFeeSection(promo)}

        {/* Example Timeline — always read-only, kept last. */}
        {renderTimeline()}
      </div>
    );
  }

  // The new-Promotion row: no id yet, so creation stays one form covering the
  // main configuration and every Benefit section, with a single Save/Cancel.
  function renderCreateSection() {
    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
        {renderMainFields()}
        {SELLABLE_BENEFIT_SECTIONS.map((cfg) => (
          <div key={cfg.section} style={subSectionSt}>
            {renderSectionHeader(cfg.titleKey, null)}
            {renderSellableItemBenefitEditor({
              addKey: cfg.addKey,
              draft: sellableSectionDraft(cfg.section),
              setDraft: sellableSectionSetDraft(cfg.section),
              categoryItems: sellableSectionItems(cfg.section),
              showFrequency: cfg.showFrequency,
            })}
          </div>
        ))}
        <div style={subSectionSt}>
          {renderSectionHeader('section_membership_fee_benefits', null)}
          {renderMembershipFeeEditor(NEW_ID)}
        </div>
        {renderTimeline()}
        {renderSectionActions(handleCreate)}
      </div>
    );
  }

  function renderMainView(promo: Promo) {
    const associatedPlans = cachedPlans[promo.id] ?? [];

    const free = promo.free_months ?? 0;
    const paid = promo.paid_months ?? 0;
    const payBeforehand = promo.pay_beforehand_months ?? 0;
    const bonus = promo.bonus_months ?? 0;

    return (
      <>

        {/* Billing & Duration summary */}
        {(free > 0 || paid > 0 || bonus > 0) && (
          <div style={subSectionSt}>
            <p style={sectionLabelSt}>{t('section_billing_duration')}</p>
            {/* #879: the look of this summary now lives in the shared
                component, so the Membership Plan card renders the same one.
                Which items appear stays the Promotion's own decision — an
                unconfigured month count is simply omitted here. */}
            <BillingDurationSummary
              items={billingDurationItems([
                free > 0 && { key: 'free_months', label: t('label_free_months'), value: free },
                paid > 0 && { key: 'paid_months', label: t('label_paid_months'), value: paid },
                payBeforehand > 0 && { key: 'pay_beforehand_months', label: t('label_pay_beforehand_months'), value: payBeforehand },
                bonus > 0 && { key: 'bonus_months', label: t('label_bonus_months'), value: bonus },
              ])}
            />
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

      </>
    );
  }

  function renderRow(promo: Promo) {
    const isExpanded = editingId === promo.id || expandedId === promo.id;

    // #627 + #897: the context-menu Edit action is the single entry point into
    // everything this card can edit — the main Promotion configuration opens as
    // a form and each Benefit section's own Edit button appears with it. It is
    // disabled while a section of a card is already being edited, so it can
    // never silently discard that section's unsaved draft.
    const editDisabled = !canWrite || sectionEditBusy;
    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetailFor(promo) },
      {
        label: t('edit'),
        onClick: () => enterEdit(promo),
        disabled: editDisabled,
        title: !canWrite ? readOnlyTitle : sectionEditBusy ? t('edit_busy_hint') : readOnlyTitle,
      },
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
        {isExpanded ? renderExpandedSection(promo) : null}
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
        {renderCreateSection()}
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
            options={LIFECYCLE_FILTER_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
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

const cardSt: React.CSSProperties = { ...cardSurfaceStyle, marginBottom: 8, overflow: 'hidden' };
const rowSt: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '12px 20px', gap: 12, cursor: 'pointer' };
const inlineLabelSt: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' };
const inlineInputSt: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', marginBottom: 12 };
const inlineSelectSt: React.CSSProperties = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box', background: '#fff', marginBottom: 8 };
const subSectionSt: React.CSSProperties = { paddingTop: 16, marginTop: 16, borderTop: '1px solid var(--gd-card-border, #eee)' };
const sectionLabelSt: React.CSSProperties = { margin: '0 0 10px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' };
const hintSt: React.CSSProperties = { color: '#aaa', fontSize: 13, margin: 0 };
const checkboxLabelSt: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' };
const colHeaderSt: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', paddingBottom: 2 };
const thSt: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: '#888', fontWeight: 600, borderBottom: '1px solid #eee', fontSize: 12 };
const tdSt: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f5f5f5', fontSize: 13 };
