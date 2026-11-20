'use client';

// #635 stage 6 — the Assigned Plan's own commercial configuration.
//
// §9: the Assigned Membership Plan exposes the same structure as the Membership
// Plan it came from — BILLING & DURATION plus ONE-OFF / SESSION / PERIOD
// BENEFITS. §10: each section carries its own Edit / Save / Cancel, only the
// section being edited is unlocked, and there is no modal.
//
// What is shown is the assignment's *snapshot* (§11–§14), never the live
// catalogue: the prices are the ones frozen when the plan was assigned, which
// is why each benefit line shows its own unit price rather than the Product
// Item's current one. Saving a section edits this member's snapshot alone
// (§15) — the source Plan and every other assignment of it are untouched — and
// since stage 3 that is also what the assignment bills, so the Billing
// Simulation moves with it.
//
// Nothing is computed here (CLAUDE.md: no business logic in the frontend): the
// server returns the section after each save and the card re-reads the rest.
//
// #924 stage 5 — these five are the card's own sections, not a nested group:
// they are the contiguous slice of `ASSIGNED_PLAN_SECTION_ORDER` named
// `ASSIGNED_PLAN_CONFIGURATION_SECTIONS` (assignedPlanProfile.ts), rendered with
// the same `CardSection` heading and hairline as every other section of the
// card, so an Assigned Plan reads at one level exactly as a Membership Plan does
// (§1). The section `Edit` buttons are `SectionEditButton` (#901) and exist only
// while the card is in Edit mode (#897): `cardEditing` is the card's flag, and
// leaving the mode closes whichever section editor was open.

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BILLING_FREQUENCY_NAMESPACE, cadenceFrequencyLabel, planBillingFrequencyOf } from '@/lib/billingFrequency';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { CardSection } from '@/components/CardSection';
import { BillingDurationExplanations } from '@/components/BillingDurationExplanations';
import { BillingDurationSummary, billingDurationItems } from '@/components/BillingDurationSummary';
import { benefitTreatmentLabel } from '@/components/ProductBenefits';
import {
  CircularThumbnail, DraftPromotionPicker, PlanPromotionRow, ProductDetailModal, PromotionDetailModal,
  useAppliedPromotionToggle,
} from './AssignedPlanPromotions';
import { thumbnailSrc } from './promotionPlacement';
import { SectionEditButton } from '@/components/SectionEditButton';
import { memberAllocations, splitLineAmount } from '@/lib/planUnitAssignees';
import { planAccessLabel, type PlanAccessEntry } from '@/lib/planAccess';
import {
  feeMemberDiscountsPayload, feeRowDiscountText, feeRowFinalPrice, membershipFeeRowSlots, type FeeBeneficiary,
} from '@/lib/membershipFeeRows';
import { membershipFeeScopeLabelKey } from '@/lib/membershipFeeScope';
import { primaryBtnSmall } from '@/components/ui';
import {
  formControlStyle,
  formFieldLabelStyle,
  formHelpTextStyle,
  inlineActionsRowStyle,
  rowRemoveBtnStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import {
  BenefitFrequencyColumn,
  ProductBenefitRow,
  ProductBenefitView,
} from '@/components/ProductBenefits';
import {
  LineEntry,
  canRemoveLine,
  feeDiscountPayload,
  feeDiscountValue,
  isValidDiscountPercent,
  pairLineEntries,
  withEntryDiscount,
  withoutEntry,
} from './inlineLineEdit';
import { clampBenefitValue, saveBenefitSection } from '@/lib/benefitEditing';
import { billingDurationPayload, durationFormError } from '@/lib/durationEditing';
import type {
  AppliedPromotion,
  AssignedPlanSnapshot,
  AssignedPlanSnapshotBenefit,
} from './types';

// Mirrors SNAPSHOT_EDITABLE_STATUSES in api/src/api/user-memberships.ts (a Draft
// is fully editable, #1108): a
// cancelled or expired assignment is history — it bills nothing further, so its
// configuration is read-only.
const EDITABLE_STATUSES = ['in_cart', 'active', 'paused'];

// Stage 13: Pre-paid Duration beside the Paid Duration it is a slice of —
// the same four fields, in the same order, as the Plan's own section. #892:
// each is a count of this assignment's own Billing Frequency periods.
const DURATION_FIELDS = ['free_periods', 'paid_periods', 'pay_beforehand_periods', 'bonus_periods'] as const;
const BILLING_UNITS = ['day', 'week', 'month', 'year'] as const;

type BenefitSection = 'oneoff' | 'session' | 'periodical';

const BENEFIT_SECTIONS: {
  section: BenefitSection;
  endpoint: string;
  titleKey: string;
  emptyKey: string;
  snapshotKey: keyof Pick<AssignedPlanSnapshot, 'oneoff_benefits' | 'session_benefits' | 'periodical_benefits'>;
  /**
   * #924 stage 1: true for all three sections, as on the Membership Plan card
   * (#916). The column is what a One-off line has no value for, and it must
   * still occupy its place with a "—" rather than disappear and shift every
   * column after it — the three sections have to read as one table.
   */
  showFrequency: boolean;
  /**
   * #918/#924 §5 — *which* Frequency the read-only column shows. The Session
   * section shows the renewal Frequency this assignment was agreed
   * ("2 sessions every week"), which the snapshot carries; the other two show
   * the Product's own billing frequency, as frozen on the line.
   *
   * The **editor** stays on the item frequency (the prop's default) whichever
   * section is open: the assignment's section `PUT` takes `product_id` +
   * `quantity` alone and deliberately keeps a kept line's agreed Frequency
   * (#918), so a control here would be one that changes nothing.
   */
  viewFrequencyColumn: BenefitFrequencyColumn;
}[] = [
  { section: 'oneoff', endpoint: 'oneoff-benefits', titleKey: 'benefits_oneoff', emptyKey: 'no_oneoff_benefits', snapshotKey: 'oneoff_benefits', showFrequency: true, viewFrequencyColumn: 'item' },
  { section: 'session', endpoint: 'session-benefits', titleKey: 'benefits_session', emptyKey: 'no_session_benefits', snapshotKey: 'session_benefits', showFrequency: true, viewFrequencyColumn: 'benefit' },
  { section: 'periodical', endpoint: 'periodical-benefits', titleKey: 'benefits_period', emptyKey: 'no_period_benefits', snapshotKey: 'periodical_benefits', showFrequency: true, viewFrequencyColumn: 'item' },
];

interface DurationForm {
  free_periods: string;
  paid_periods: string;
  pay_beforehand_periods: string;
  bonus_periods: string;
  recurring_billing_interval: string;
  recurring_billing_unit: string;
}

interface Props {
  assignedPlanId: number;
  /** The assignment's stored status — a terminal one is read-only. */
  planStatus: string;
  snapshot: AssignedPlanSnapshot;
  /** #2483 — the applied Promotions (each from its own snapshot), to name the ones touching each line and the fee. */
  promotions?: AppliedPromotion[];
  /** #2483 — the fee quoted VAT-inclusive and the one the engine resolves for the current cycle. */
  feeInclTax?: number | null;
  feeTaxPercent?: number | null;
  currentFee?: number | null;
  /** #2802 — the access the plan grants each beneficiary, drawn as €0 rows under the fee. */
  planAccess?: PlanAccessEntry[];
  /**
   * #2834 stage 2 — the assignment's Membership Fee scope (its plan snapshot's) and its
   * beneficiaries: one fee row for a `per_family` plan, one per beneficiary for `per_member`.
   */
  feeScope?: string | null;
  beneficiaries?: FeeBeneficiary[];
  /** #2945 — the current-cycle fee of each beneficiary whose fee carries its own discount. */
  currentFeeByMember?: Record<string, number> | null;
  /**
   * Whether the card is in Edit mode (#797/#897). Outside it every section is
   * read-only and carries no `Edit` button at all — absent, not disabled.
   */
  cardEditing: boolean;
  canWrite: boolean;
  readOnlyTitle?: string;
  /**
   * #2853 — the Draft's plan takes Promotions now (`promotions_selectable`, the
   * apply path's rule), with the plan and the owner the catalogue is read for:
   * in Edit mode the Plan Promotions section then offers every available one.
   */
  promotionsSelectable?: boolean;
  membershipPlanId?: number | null;
  ownerMemberId?: number | null;
  /** Re-reads the expanded card (and with it the Billing Events section). */
  onChanged: () => void;
}

function fmtMoney(v: number | string | null) {
  return v != null ? `€${Number(v).toFixed(2)}` : '—';
}

const numField = (v: number | null) => (v != null ? String(v) : '');

/**
 * A frozen benefit line as the shared editor's draft row. The snapshot keeps
 * the item's name and frequency as they were agreed, so the picker shows what
 * was agreed even after the Product is renamed or retired; `status` is
 * 'active' because the snapshot does not carry the catalogue's current state
 * and a frozen line is never "inactive" as far as this assignment goes.
 */
function toDraftRow(b: AssignedPlanSnapshotBenefit): ProductBenefitRow {
  return {
    product_id: b.product_id,
    quantity: b.quantity,
    product_name: b.item_name,
    product_type: b.item_type,
    product_billing_frequency: b.item_billing_frequency,
    product_status: 'active',
    // #2093 stage 2: the agreed treatment and renewal Frequency travel with the
    // draft, so the shared engine edits them and an unedited line round-trips.
    action: b.action,
    value: b.value,
    ...(b.frequency !== undefined && { frequency: b.frequency }),
    // #2624 stage 2: whether the line may be removed, and its own Direct
    // Discount, the one thing staff change on an agreed line (§5).
    mandatory: b.mandatory !== false,
    direct_discount_percent: b.direct_discount_percent ?? null,
    // #2657 stage 3: a line held per member keeps its member, so its own Direct
    // Discount and ✕ edit that member's line alone.
    ...(b.assigned_member_id != null && {
      assigned_member_id: b.assigned_member_id,
      member_name: b.unit_assignees?.[0]?.name ?? null,
    }),
  };
}

/**
 * #924 stage 1 — the same frozen line as the shared read-only grid's row.
 *
 * Everything the card shows is the snapshot's: the agreed treatment, the agreed
 * renewal Frequency and the two prices the server computed from the frozen
 * price (§17). It is built on `toDraftRow()` rather than beside it, so the half
 * that reads and the half that writes cannot disagree about what a line is
 * (#797) — what the editor adds to it is nothing, and what it leaves out of the
 * payload is the point: `toBenefitItems()` sends only the keys a draft row
 * carries, and the assignment's `PUT` takes quantity alone.
 */
function toViewRow(
  b: AssignedPlanSnapshotBenefit, promotionNames: Map<number, string[]>,
  promotionBenefits: Map<number, string[]>,
): ProductBenefitRow {
  return {
    ...toDraftRow(b),
    applied_tax_percent: b.applied_tax_percent ?? null,
    applied_promotions: promotionNames.get(b.product_id) ?? [],
    applied_promotion_benefits: promotionBenefits.get(b.product_id) ?? [],
    direct_discount_line_incl_tax: b.direct_discount_line_incl_tax ?? null,
    frequency: b.frequency,
    original_price_incl_tax: b.original_price_incl_tax,
    final_price_incl_tax: b.final_price_incl_tax,
    original_line_price_incl_tax: b.original_line_price_incl_tax,
    final_line_price_incl_tax: b.final_line_price_incl_tax,
  };
}

/**
 * #2657 stage 2 — a frozen line as the rows of the Member column: one row per family
 * member who holds units of an Individual Product, each with the units it holds, and one
 * row with an empty Member for a Shared Product (`memberAllocations()`). The per-unit
 * prices are the server's as they are; the line totals are the server's spread over the
 * rows' units so the rows add up to the line (`splitLineAmount()`). Each row keeps its
 * source line for the thumbnail.
 */
function toAllocationRows(
  b: AssignedPlanSnapshotBenefit, promotionNames: Map<number, string[]>,
  promotionBenefits: Map<number, string[]>,
): { line: AssignedPlanSnapshotBenefit; row: ProductBenefitRow }[] {
  const base = toViewRow(b, promotionNames, promotionBenefits);
  const allocations = memberAllocations(b);
  if (allocations.length === 1) {
    return [{ line: b, row: { ...base, member_name: allocations[0].member_name } }];
  }
  const qty = allocations.map((a) => a.quantity);
  const original = splitLineAmount(b.original_line_price_incl_tax, qty);
  const final = splitLineAmount(b.final_line_price_incl_tax, qty);
  const discount = splitLineAmount(b.direct_discount_line_incl_tax, qty);
  return allocations.map((a, i) => ({
    line: b,
    row: {
      ...base,
      member_name: a.member_name,
      quantity: a.quantity,
      original_line_price_incl_tax: original[i],
      final_line_price_incl_tax: final[i],
      direct_discount_line_incl_tax: discount[i],
    },
  }));
}

export function AssignedPlanConfiguration({
  assignedPlanId, planStatus, snapshot, promotions = [], feeInclTax = null, feeTaxPercent = null, currentFee = null, planAccess = [], feeScope = null, beneficiaries = [], currentFeeByMember = null, cardEditing, canWrite, readOnlyTitle,
  promotionsSelectable = false, membershipPlanId = null, ownerMemberId = null, onChanged,
}: Props) {
  const t = useTranslations('assigned_plans_page');
  // #1128: the frozen cadence reads as the frequency it is ("Monthly"), not as
  // the stored pair ("1 × Month").
  const tFreq = useTranslations(BILLING_FREQUENCY_NAMESPACE);
  const tp = useTranslations('promotions');
  const tPlans = useTranslations('plans');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  // #2483 — which applied Promotions grant each Product, and which touch the
  // Membership Fee. Names only: every amount stays the server's.
  const applied = promotions.filter((p) => p.status === 'applied');
  const promotionNamesByProduct = new Map<number, string[]>();
  const promotionBenefitsByProduct = new Map<number, string[]>();
  for (const p of applied) {
    for (const g of [...p.session_grants, ...p.oneoff_grants, ...p.periodical_grants]) {
      if (g.product_id == null) continue;
      const names = promotionNamesByProduct.get(g.product_id) ?? [];
      const benefits = promotionBenefitsByProduct.get(g.product_id) ?? [];
      if (!names.includes(p.promotion_name)) {
        names.push(p.promotion_name);
        // The grant's own frozen action/value (#635 §16), worded in the Promotion's voice.
        benefits.push(benefitTreatmentLabel(tp as any, 'promotion', { action: g.action, value: g.value } as any));
      }
      promotionNamesByProduct.set(g.product_id, names);
      promotionBenefitsByProduct.set(g.product_id, benefits);
    }
  }
  const feePromotions = applied
    .filter((p) => p.membership_fee_benefits.some((b) => b.enabled && b.action && b.action !== 'no_benefit'));
  // #2626 — the Membership Fee as one row of the shared Product grid. The
  // Benefit column is the Personal Membership Fee Benefit (#772, the direct
  // benefit agreed with this member); the Promotions touching the fee and their
  // own frozen treatment fill the Promotion columns; the two prices are the
  // VAT-inclusive fee and the one the billing engine resolves for this cycle.
  const feeRow: ProductBenefitRow = {
    product_id: 0,
    quantity: 1,
    product_name: t('fee_breakdown_fee'),
    product_type: 'membership_fee',
    product_billing_frequency: planBillingFrequencyOf(
      snapshot.recurring_billing_interval, snapshot.recurring_billing_unit,
    ),
    product_status: 'active',
    action: snapshot.personal_fee_benefit.action,
    value: snapshot.personal_fee_benefit.value,
    // #2835: the fee's Direct Discount (%) is that same benefit's percentage,
    // the one figure staff edit on the fee in place.
    direct_discount_percent: feeDiscountValue(snapshot.personal_fee_benefit) || null,
    mandatory: true,
    applied_tax_percent: feeTaxPercent,
    applied_promotions: feePromotions.map((p) => p.promotion_name),
    applied_promotion_benefits: feePromotions.flatMap((p) => p.membership_fee_benefits
      .filter((b) => b.enabled && b.action && b.action !== 'no_benefit')
      .map((b) => benefitTreatmentLabel(tp as any, 'promotion', { action: b.action, value: b.value } as any))),
    direct_discount_line_incl_tax: null,
    original_price_incl_tax: feeInclTax ?? (snapshot.membership_fee_price != null ? Number(snapshot.membership_fee_price) : null),
    final_price_incl_tax: currentFee,
    // #3093: a pre-paid duration charges several periods up front, so the Base Price says
    // how many it is multiplied by (display only; the Final Price is the engine's).
    original_price_note: Number(snapshot.pay_beforehand_periods) > 1
      ? t('fee_prepaid_multiplier', { count: Number(snapshot.pay_beforehand_periods) }) : null,
    original_line_price_incl_tax: null,
    final_line_price_incl_tax: null,
  };
  // #2834 stage 2 (#2800's rule) — `per_family`: one fee row, Member column *Family*;
  // `per_member`: one fee row per beneficiary, naming that beneficiary. Each row is one
  // fee at the server's price; the engine is what multiplies the charge.
  // #2945 — each row reads its own Direct Discount and the fee priced with it.
  const feeSlots = membershipFeeRowSlots(feeScope, beneficiaries);
  const sharedDiscountText = feeDiscountValue(snapshot.personal_fee_benefit);
  const feeRows: ProductBenefitRow[] = feeSlots.map((slot) => {
    const text = feeRowDiscountText(slot, sharedDiscountText);
    return {
      ...feeRow,
      member_name: slot.family ? t('fee_member_family') : slot.member_name,
      direct_discount_percent: text === '' ? null : Number(text),
      final_price_incl_tax: feeRowFinalPrice(slot, currentFee, currentFeeByMember),
    };
  });
  // #2802 — the access the plan grants (its centers, On-line), one row per beneficiary at
  // quantity 1 and €0. The entries are the server's, from the plan's own access
  // configuration; the rows are display only and no total reads them.
  const accessRows: ProductBenefitRow[] = planAccess.flatMap((entry, i) => {
    const label = planAccessLabel(entry);
    if (!label) return [];
    return [{
      product_id: -(i + 1),
      quantity: 1,
      product_name: t(label.key as any, label.values as any),
      product_type: 'plan_access',
      // #3094: access follows the Membership Fee's Billing Frequency.
      product_billing_frequency: feeRow.product_billing_frequency,
      product_status: 'active',
      action: 'no_benefit',
      value: null,
      member_name: entry.member_name,
      applied_tax_percent: null,
      applied_promotions: [],
      applied_promotion_benefits: [],
      direct_discount_line_incl_tax: null,
      original_price_incl_tax: 0,
      final_price_incl_tax: 0,
      original_line_price_incl_tax: null,
      final_line_price_incl_tax: null,
    } as ProductBenefitRow];
  });

  // #2657 — a Promotion applies to the whole plan, so each application (standing
  // or spent) is drawn once, in its own row below Period Benefits, rather than
  // under every Product line it grants (#2478). One toggle per card.
  const promotionToggle = useAppliedPromotionToggle(assignedPlanId, onChanged);
  const toggleGate = { cardEditing, canWrite, readOnlyTitle };
  // #2853: a Draft's Plan Promotions are chosen from the live catalogue, in Edit mode.
  const draftPicker = cardEditing && planStatus === 'in_cart' && promotionsSelectable
    && membershipPlanId != null && ownerMemberId != null;
  const [productDetail, setProductDetail] = useState<AssignedPlanSnapshotBenefit | null>(null);
  const [promotionDetail, setPromotionDetail] = useState<AppliedPromotion | null>(null);

  const [editing, setEditing] = useState<'billing' | 'fee_benefit' | BenefitSection | null>(null);
  const [durationForm, setDurationForm] = useState<DurationForm | null>(null);
  // #2835: the fee's Direct Discount (%) as typed in its own cell. #2945: one per fee row, so a
  // per-member plan's rows are edited independently.
  const [feeDiscounts, setFeeDiscounts] = useState<string[]>([]);
  // #2835: the open section's rows, each the drawn row beside the row its
  // replace-all `PUT` sends (`inlineLineEdit.ts`).
  const [lineEntries, setLineEntries] = useState<LineEntry<AssignedPlanSnapshotBenefit>[]>([]);
  const [saving, setSaving] = useState(false);

  const editable = cardEditing && canWrite && EDITABLE_STATUSES.includes(planStatus);
  const editTitle = canWrite ? undefined : readOnlyTitle;

  // Leaving the card's Edit mode closes every section editor with it (#897), and
  // discards whatever was being typed — the same thing the card's own Cancel
  // does on the Membership Plan and Promotion cards.
  useEffect(() => {
    // #2375: entering Edit mode opens nothing by itself (it used to open
    // Billing & Duration on a Draft, #1814), so every section shows an enabled
    // `Edit` and staff choose which one to open.
    if (!cardEditing) cancelEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardEditing]);

  function openDurationEdit() {
    setDurationForm({
      free_periods: numField(snapshot.free_periods),
      paid_periods: numField(snapshot.paid_periods),
      pay_beforehand_periods: numField(snapshot.pay_beforehand_periods),
      bonus_periods: numField(snapshot.bonus_periods),
      recurring_billing_interval: numField(snapshot.recurring_billing_interval),
      recurring_billing_unit: snapshot.recurring_billing_unit ?? '',
    });
    setEditing('billing');
  }

  function openFeeBenefitEdit() {
    setFeeDiscounts(feeSlots.map((slot) => feeRowDiscountText(slot, sharedDiscountText)));
    setEditing('fee_benefit');
  }

  function openBenefitEdit(section: BenefitSection, rows: AssignedPlanSnapshotBenefit[]) {
    // #2835: the section keeps its grid; each drawn row is paired with the row
    // its `PUT` sends. #2657 stage 3: an Individual Product is edited one
    // member's line at a time — a line the server still holds unsplit opens as
    // its members' rows (the units each holds), exactly the rows the grid
    // already draws, and saving them is what stores one line per member.
    const views = rows.flatMap((b) => toAllocationRows(b, promotionNamesByProduct, promotionBenefitsByProduct));
    const drafts = rows.flatMap((b) => {
      const row = toDraftRow(b);
      if (b.assigned_member_id != null) return [row];
      const allocations = memberAllocations(b);
      if (allocations.every((a) => a.member_id == null)) return [row];
      return allocations.map((a) => ({ ...row, assigned_member_id: a.member_id, member_name: a.member_name, quantity: a.quantity }));
    });
    setLineEntries(pairLineEntries(views, drafts));
    setEditing(section);
  }

  function cancelEdit() {
    setEditing(null);
    setDurationForm(null);
    setFeeDiscounts([]);
    setLineEntries([]);
  }

  async function saveDuration() {
    if (!durationForm) return;
    // #2093 stage 3: validate every field before the first request (#2092), so
    // nothing is half saved. A failure keeps the editor open with the input.
    const problem = durationFormError(durationForm);
    if (problem) {
      toast(t(problem));
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/billing-duration`, {
        method: 'PUT',
        body: JSON.stringify(billingDurationPayload(durationForm)),
      });
      cancelEdit();
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function saveFeeBenefit() {
    // #2835: the fee's Direct Discount (%) is its Personal Membership Fee
    // Benefit (#772). Replace-all: empty or 0 is `no_benefit`, which the server
    // stores with no percentage rather than remembering the last one.
    // #2945: a per-member plan's rows each carry their own discount; only the rows staff changed
    // are sent, so an untouched one keeps what it stores.
    if (feeDiscounts.some((v) => !isValidDiscountPercent(v))) {
      toast(t('direct_discount_invalid'));
      return;
    }
    const memberDiscounts = feeMemberDiscountsPayload(
      feeSlots, feeSlots.map((slot) => feeRowDiscountText(slot, sharedDiscountText)), feeDiscounts,
    );
    const payload = memberDiscounts ? { member_discounts: memberDiscounts } : feeDiscountPayload(feeDiscounts[0] ?? '');
    if (!payload) {
      toast(t('direct_discount_invalid'));
      return;
    }
    if (memberDiscounts && memberDiscounts.length === 0) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/fee-benefit`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      cancelEdit();
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function saveBenefits(endpoint: string) {
    if (lineEntries.some((e) => !isValidDiscountPercent(e.draft.direct_discount_percent))) {
      toast(t('direct_discount_invalid'));
      return;
    }
    setSaving(true);
    try {
      // #2093 stage 2: the Plans card's engine — every line is validated before
      // anything is sent, and a failure keeps the editor open with the input.
      const result = await saveBenefitSection({
        save: async (items) => {
          await apiFetch(`/user-memberships/${assignedPlanId}/${endpoint}`, {
            method: 'PUT',
            body: JSON.stringify({ items }),
          });
        },
      }, lineEntries.map((e) => e.draft));
      if (!result.ok) {
        toast(t('benefit_value_required', { item: result.row.product_name }));
        return;
      }
      cancelEdit();
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  /**
   * #892 — a duration reads in the unit it is counted in. An assignment billed
   * monthly (or one with no cadence at all, which prices as `1 month`) still
   * reads "2 months"; anything else reads as billing periods, with the Billing
   * Frequency row right below naming what one of them is. The cadence is
   * free-form here — this is the assignment's own snapshot, not the Plan's
   * two-choice dropdown — so it is never spelled into the value itself.
   */
  function durationText(value: number | null): string {
    if (value == null) return t('not_configured');
    const monthly = snapshot.recurring_billing_unit == null
      || (Number(snapshot.recurring_billing_interval) === 1 && snapshot.recurring_billing_unit === 'month');
    return monthly ? t('months_value', { n: value }) : t('periods_value_plain', { n: value });
  }

  // #897: outside Edit mode this answers `null`, so the button is absent rather
  // than disabled. Inside it, the one shared subsection action (#901) — never a
  // text link or a colour of this page's own.
  function editButton(onClick: () => void) {
    if (!editable) return null;
    return (
      <SectionEditButton
        label={t('action_edit')}
        onClick={onClick}
        disabled={editing !== null}
        title={editTitle}
      />
    );
  }

  // #2835 — the one inline control a line offers: its Direct Discount (%).
  // The value is clamped to the percentage's own range as it is typed, as the
  // shared editor did; the server still validates it (`benefitConfigError()`).
  function discountInput(value: string, onChange: (v: string) => void, product: string) {
    return (
      <input
        type="number" min="0" max="100" step="0.01"
        value={value}
        onChange={(e) => onChange(clampBenefitValue('percentage_discount', e.target.value) as string)}
        disabled={saving}
        aria-label={`${t('col_direct_discount_percent')} — ${product}`}
        style={{ ...inputSt, width: 80, padding: '4px 6px', textAlign: 'right' }}
      />
    );
  }

  // #2677 — the open section's Save/Cancel closes that section: it is rendered
  // inside the section's own editor, after its fields and hint, so it sits
  // before the next section begins (reversing #2391's single pair at the foot
  // of the block). One section is editable at a time, so there is one pair.
  function sectionActions(onSave: () => unknown) {
    return (
      <div style={{ marginTop: 14 }}>
        <SaveCancel saving={saving} onSave={() => { void onSave(); }} onCancel={cancelEdit} t={t} />
      </div>
    );
  }

  return (
    <>
      {/* §7/§9 — Billing & Duration, the Promotion's Free Period / Paid
          Duration / Bonus Duration, plus the cadence and the regular
          Membership Fee this assignment was agreed at. */}
      <CardSection
        label={t('section_billing_duration')}
        action={editing === 'billing' ? null : editButton(openDurationEdit)}
      >
      {editing === 'billing' && durationForm ? (
        <div style={{ margin: '6px 0 14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 8 }}>
            {DURATION_FIELDS.map((field) => (
              <div key={field}>
                <label style={labelSt}>{t(`label_${field}` as any)}</label>
                <input
                  type="number" min="0" placeholder="0"
                  value={durationForm[field]}
                  onChange={(e) => setDurationForm({ ...durationForm, [field]: e.target.value })}
                  style={inputSt}
                />
              </div>
            ))}
            <div>
              <label style={labelSt}>{t('label_billing_interval')}</label>
              <input
                type="number" min="1"
                value={durationForm.recurring_billing_interval}
                onChange={(e) => setDurationForm({ ...durationForm, recurring_billing_interval: e.target.value })}
                style={inputSt}
              />
            </div>
            <div>
              <label style={labelSt}>{t('label_billing_unit')}</label>
              <select
                value={durationForm.recurring_billing_unit}
                onChange={(e) => setDurationForm({ ...durationForm, recurring_billing_unit: e.target.value })}
                style={inputSt}
              >
                <option value="">{t('not_configured')}</option>
                {BILLING_UNITS.map((u) => <option key={u} value={u}>{t(`unit_${u}` as any)}</option>)}
              </select>
            </div>
            <div>
              <label style={labelSt}>{t('label_membership_fee')}</label>
              <div style={{ ...inputSt, background: 'transparent', border: '1px solid transparent' }}>
                {fmtMoney(snapshot.membership_fee_price)}
              </div>
            </div>
          </div>
          {/* #892 — the four numbers above are billing periods, and the
              cadence beside them is what one period is. */}
          <p style={hintSt}>{t('duration_periods_hint')}</p>
          <p style={hintSt}>{t('snapshot_edit_hint')}</p>
          {sectionActions(saveDuration)}
        </div>
      ) : (
        <div style={{ marginBottom: 10 }}>
          {/* #1243 — the Membership Plan card's own compact summary, so the
              frozen agreement reads horizontally instead of one row per value. */}
          <BillingDurationSummary
            items={billingDurationItems([
              ...DURATION_FIELDS.map((field) => ({
                key: field,
                label: t(`label_${field}` as any),
                value: durationText(snapshot[field] as number | null),
              })),
              {
                key: 'billing_frequency',
                label: t('label_billing_frequency'),
                value: snapshot.recurring_billing_interval != null && snapshot.recurring_billing_unit
                  ? cadenceFrequencyLabel(
                    snapshot.recurring_billing_interval,
                    snapshot.recurring_billing_unit,
                    tFreq,
                  )
                  : t('not_configured'),
              },
              {
                key: 'membership_fee',
                label: t('label_membership_fee'),
                value: fmtMoney(snapshot.membership_fee_price),
              },
              // #2834 stage 2 — whether that fee is charged per member or per family.
              {
                key: 'membership_fee_scope',
                label: tPlans('label_fee_scope'),
                value: tPlans(membershipFeeScopeLabelKey(feeScope) as any),
              },
            ])}
          />
          <BillingDurationExplanations
            config={{
              free_periods: snapshot.free_periods,
              paid_periods: snapshot.paid_periods,
              pay_beforehand_periods: snapshot.pay_beforehand_periods,
              bonus_periods: snapshot.bonus_periods,
              recurring_billing_interval: snapshot.recurring_billing_interval,
              recurring_billing_unit: snapshot.recurring_billing_unit,
            }}
          />
        </div>
      )}
      </CardSection>

      {/* #772 — the Personal Membership Fee Benefit. Its own section, right
          under the fee it discounts: it is neither a Promotion benefit (it
          never expires) nor part of the frozen snapshot (it is agreed with
          this member, not captured from the catalogue). */}
      <CardSection
        label={t('section_membership_fee_benefit')}
        action={editing === 'fee_benefit' ? null : editButton(openFeeBenefitEdit)}
      >
      {/* #2835: the same grid in both modes; Edit turns the fee's Direct
          Discount (%) cell into an input and nothing else. */}
      {/* #2626 — the Membership Fee is a product row of the same shared grid
          the three Product sections render, so the breakdown #2483 drew as a
          list of label/value rows reads in the same columns: the fee, the tax,
          the Promotions touching it, the Personal Membership Fee Benefit in
          the Benefit column and the price the engine resolves for the current
          cycle. Every figure is the server's; nothing is priced here. */}
        <ProductBenefitView
          t={(key, values) => t(key as any, values as any)}
          emptyKey="no_oneoff_benefits"
          rows={[...feeRows, ...accessRows]}
          showFrequency
          benefitContext="plan"
          showPrices
          showBreakdown
          showMember
          showDirectDiscount
          renderDirectDiscountPercent={(row, idx) => {
            if (editing !== 'fee_benefit') return undefined;
            // Only the fee row carries a discount; an access row stays a value.
            if (row.product_type !== 'membership_fee') return '—';
            // #2945: every fee row has its own input; a per-member plan's rows are independent.
            if (idx >= feeDiscounts.length) return undefined;
            return discountInput(feeDiscounts[idx], (v: string) => setFeeDiscounts((cur) => cur.map((x, i) => (i === idx ? v : x))),
              row.member_name ? `${row.product_name} — ${row.member_name}` : row.product_name);
          }}
          renderRowAction={() => null}
        />
      {editing === 'fee_benefit' && (
        <>
          <p style={hintSt}>{t('personal_fee_benefit_hint')}</p>
          {sectionActions(saveFeeBenefit)}
        </>
      )}
      </CardSection>

      {/* §3–§5/§9 — the three Product-keyed sections, in the order the
          Plans page lists them so both surfaces read the same way. */}
      {BENEFIT_SECTIONS.map(({
        section, endpoint, titleKey, emptyKey, snapshotKey, showFrequency, viewFrequencyColumn,
      }) => {
        const rows = snapshot[snapshotKey] ?? [];
        const sectionEditing = editing === section;
        // #2657 stage 2 — one row per member for an Individual Product, one for a Shared one.
        // #2835: while the section is edited, the draft's rows (a removed line gone,
        // a typed discount on its cell); otherwise the snapshot's.
        const viewRows = sectionEditing
          ? lineEntries.map((e) => ({ line: e.line, row: e.view }))
          : rows.flatMap((r) => toAllocationRows(r, promotionNamesByProduct, promotionBenefitsByProduct));
        return (
          <CardSection
            key={section}
            label={t(titleKey as any)}
            action={editing === section ? null : editButton(() => openBenefitEdit(section, rows))}
          >
            {/* #2835: one grid in both modes. Edit keeps every row, column and
                price where it was; only the Direct Discount (%) cell becomes an
                input and an Optional line gains a ✕ (#2624 stage 2's rule). */}
              <ProductBenefitView
                t={(key, values) => t(key as any, values as any)}
                emptyKey={emptyKey}
                rows={viewRows.map((v) => v.row)}
                showFrequency={showFrequency}
                frequencyColumn={viewFrequencyColumn}
                benefitContext="plan"
                showPrices
                showBreakdown
                showMember
                showLineMandatory
                showDirectDiscount
                renderDirectDiscountPercent={(row, idx) => (sectionEditing
                  ? discountInput(
                    String(row.direct_discount_percent ?? ''),
                    (v) => setLineEntries((prev) => withEntryDiscount(prev, idx, v)),
                    row.product_name,
                  )
                  : undefined)}
                renderRowAction={(row, idx) => (sectionEditing && canRemoveLine(lineEntries[idx]?.draft ?? row)
                  ? (
                    <button
                      type="button"
                      onClick={() => setLineEntries((prev) => withoutEntry(prev, idx))}
                      disabled={saving}
                      style={rowRemoveBtnStyle}
                      aria-label={t('remove_optional_line', { product: row.product_name })}
                      title={t('remove_optional_line', { product: row.product_name })}
                    >
                      ✕
                    </button>
                  )
                  : null)}
                renderItemPrefix={(_row, idx) => {
                  const line = viewRows[idx].line;
                  return (
                    <CircularThumbnail
                      src={thumbnailSrc(line.image_thumbnail_url, line.image_url)}
                      label={t('product_open_details', { product: line.item_name })}
                      onOpen={() => setProductDetail(line)}
                    />
                  );
                }}
              />
            {sectionEditing && (
              <>
                <p style={hintSt}>{t('assigned_line_edit_hint')}</p>
                <p style={hintSt}>{t('snapshot_edit_hint')}</p>
                {sectionActions(() => saveBenefits(endpoint))}
              </>
            )}
          </CardSection>
        );
      })}

      {/* #2657 — the plan's Promotions, each drawn once, right below Period
          Benefits: a Promotion belongs to the whole Membership Plan. The
          square thumbnail opens the detail modal with the original image. */}
      <CardSection label={t('section_plan_promotions')}>
        {promotions.length === 0 ? (
          <p style={hintSt}>{t('no_plan_promotions')}</p>
        ) : promotions.map((p) => (
          <PlanPromotionRow
            key={p.id}
            promotion={p}
            // #2853: on a Draft whose Promotions are chosen below, the picker
            // holds the selection, so the row carries no second checkbox.
            checkbox={draftPicker ? null : promotionToggle.checkbox(p, toggleGate)}
            onOpen={() => setPromotionDetail(p)}
          />
        ))}
        {draftPicker && membershipPlanId != null && ownerMemberId != null && (
          <DraftPromotionPicker
            assignedPlanId={assignedPlanId}
            membershipPlanId={membershipPlanId}
            ownerMemberId={ownerMemberId}
            applied={promotions}
            canWrite={canWrite}
            onChanged={onChanged}
          />
        )}
      </CardSection>

      {promotionToggle.dialogs}
      <ProductDetailModal product={productDetail} onClose={() => setProductDetail(null)} />
      <PromotionDetailModal promotion={promotionDetail} onClose={() => setPromotionDetail(null)} />
    </>
  );
}

/**
 * A section editor's Cancel/Save pair. #929/#954: the geometry and the neutral
 * colours are `secondaryBtnSmall`, and the primary action takes the Theme's own
 * Primary Button colours through `primaryBtnSmall()` — never a `#111` of this
 * page's own, which no Theme could reach.
 *
 * #1028: and the row is the shared one as it stands, with no `justifyContent` of
 * its own — a form's action group is left-aligned everywhere, so the override
 * that pushed this pair to the right of the card is gone.
 */
function SaveCancel({ saving, onSave, onCancel, t }: {
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div style={inlineActionsRowStyle}>
      <button onClick={onCancel} disabled={saving} style={secondaryBtnSmall}>{t('cancel')}</button>
      <button onClick={onSave} disabled={saving} style={primaryBtnSmall()}>
        {saving ? t('saving') : t('save_changes')}
      </button>
    </div>
  );
}

// #929: the card's chrome is `components/formChrome.ts`, so this page restates
// no field label, no control box and no hint sentence of its own.
const labelSt = formFieldLabelStyle;
const inputSt = formControlStyle;
const hintSt: React.CSSProperties = { ...formHelpTextStyle, margin: '8px 0 0' };
