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
// is why each benefit line shows its own unit price rather than the Sellable
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

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { CardDetailRow } from '@/components/CardDetailRow';
import { CardSection } from '@/components/CardSection';
import { SectionEditButton } from '@/components/SectionEditButton';
import { primaryBtnSmall } from '@/components/ui';
import {
  formControlStyle,
  formFieldLabelStyle,
  formHelpTextStyle,
  inlineActionsRowStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import {
  BenefitFrequencyColumn,
  SellableItemBenefitEditor,
  SellableItemBenefitRow,
  SellableItemBenefitView,
  SellableItemOption,
  toBenefitItems,
} from '@/components/SellableItemBenefits';
import type {
  AssignedPlanSnapshot,
  AssignedPlanSnapshotBenefit,
  PersonalFeeBenefitAction,
} from './types';

// Mirrors SNAPSHOT_EDITABLE_STATUSES in api/src/api/user-memberships.ts: a
// cancelled or expired assignment is history — it bills nothing further, so its
// configuration is read-only.
const EDITABLE_STATUSES = ['active', 'paused'];

// Stage 13: Pre-paid Duration beside the Paid Duration it is a slice of —
// the same four fields, in the same order, as the Plan's own section. #892:
// each is a count of this assignment's own Billing Frequency periods.
const DURATION_FIELDS = ['free_periods', 'paid_periods', 'pay_beforehand_periods', 'bonus_periods'] as const;
const BILLING_UNITS = ['day', 'week', 'month', 'year'] as const;

type BenefitSection = 'oneoff' | 'session' | 'periodical';

// #772 — the Assigned Plan's own Membership Fee Benefit offers these two and
// nothing else. Mirrors PERSONAL_FEE_BENEFIT_ACTIONS in
// api/src/domain/personalFeeBenefit.ts, which is what the route validates.
const PERSONAL_FEE_BENEFIT_ACTIONS: readonly PersonalFeeBenefitAction[] = ['no_benefit', 'percentage_discount'];

const BENEFIT_SECTIONS: {
  section: BenefitSection;
  endpoint: string;
  titleKey: string;
  emptyKey: string;
  addKey: string;
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
   * the Sellable Item's own billing frequency, as frozen on the line.
   *
   * The **editor** stays on the item frequency (the prop's default) whichever
   * section is open: the assignment's section `PUT` takes `gym_charge_id` +
   * `quantity` alone and deliberately keeps a kept line's agreed Frequency
   * (#918), so a control here would be one that changes nothing.
   */
  viewFrequencyColumn: BenefitFrequencyColumn;
}[] = [
  { section: 'oneoff', endpoint: 'oneoff-benefits', titleKey: 'benefits_oneoff', emptyKey: 'no_oneoff_benefits', addKey: 'add_oneoff_benefit', snapshotKey: 'oneoff_benefits', showFrequency: true, viewFrequencyColumn: 'item' },
  { section: 'session', endpoint: 'session-benefits', titleKey: 'benefits_session', emptyKey: 'no_session_benefits', addKey: 'add_session_benefit', snapshotKey: 'session_benefits', showFrequency: true, viewFrequencyColumn: 'benefit' },
  { section: 'periodical', endpoint: 'periodical-benefits', titleKey: 'benefits_period', emptyKey: 'no_period_benefits', addKey: 'add_period_benefit', snapshotKey: 'periodical_benefits', showFrequency: true, viewFrequencyColumn: 'item' },
];

interface FeeBenefitForm {
  action: PersonalFeeBenefitAction;
  value: string;
}

interface DurationForm {
  free_periods: string;
  paid_periods: string;
  pay_beforehand_periods: string;
  bonus_periods: string;
  recurring_billing_interval: string;
  recurring_billing_unit: string;
  membership_fee_price: string;
}

interface Props {
  assignedPlanId: number;
  /** The assignment's stored status — a terminal one is read-only. */
  planStatus: string;
  snapshot: AssignedPlanSnapshot;
  /**
   * Whether the card is in Edit mode (#797/#897). Outside it every section is
   * read-only and carries no `Edit` button at all — absent, not disabled.
   */
  cardEditing: boolean;
  canWrite: boolean;
  readOnlyTitle?: string;
  /** Re-reads the expanded card (and with it the Billing Events section). */
  onChanged: () => void;
}

function fmtMoney(v: number | null) {
  return v != null ? `€${v.toFixed(2)}` : '—';
}

const numField = (v: number | null) => (v != null ? String(v) : '');

/**
 * A frozen benefit line as the shared editor's draft row. The snapshot keeps
 * the item's name and frequency as they were agreed, so the picker shows what
 * was agreed even after the Sellable Item is renamed or retired; `status` is
 * 'active' because the snapshot does not carry the catalogue's current state
 * and a frozen line is never "inactive" as far as this assignment goes.
 */
function toDraftRow(b: AssignedPlanSnapshotBenefit): SellableItemBenefitRow {
  return {
    gym_charge_id: b.gym_charge_id,
    quantity: b.quantity,
    gym_charge_name: b.item_name,
    gym_charge_type: b.item_type,
    gym_charge_billing_frequency: b.item_billing_frequency,
    gym_charge_status: 'active',
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
function toViewRow(b: AssignedPlanSnapshotBenefit): SellableItemBenefitRow {
  return {
    ...toDraftRow(b),
    action: b.action,
    value: b.value,
    frequency: b.frequency,
    original_price_incl_tax: b.original_price_incl_tax,
    final_price_incl_tax: b.final_price_incl_tax,
    original_line_price_incl_tax: b.original_line_price_incl_tax,
    final_line_price_incl_tax: b.final_line_price_incl_tax,
  };
}

export function AssignedPlanConfiguration({
  assignedPlanId, planStatus, snapshot, cardEditing, canWrite, readOnlyTitle, onChanged,
}: Props) {
  const t = useTranslations('assigned_plans_page');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const itemsLoadedRef = useRef(false);

  const [editing, setEditing] = useState<'billing' | 'fee_benefit' | BenefitSection | null>(null);
  const [durationForm, setDurationForm] = useState<DurationForm | null>(null);
  const [feeBenefitForm, setFeeBenefitForm] = useState<FeeBenefitForm | null>(null);
  const [benefitDraft, setBenefitDraft] = useState<SellableItemBenefitRow[]>([]);
  const [items, setItems] = useState<SellableItemOption[]>([]);
  const [saving, setSaving] = useState(false);

  const editable = cardEditing && canWrite && EDITABLE_STATUSES.includes(planStatus);
  const editTitle = canWrite ? undefined : readOnlyTitle;

  // Leaving the card's Edit mode closes every section editor with it (#897), and
  // discards whatever was being typed — the same thing the card's own Cancel
  // does on the Membership Plan and Promotion cards.
  useEffect(() => {
    if (!cardEditing) cancelEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardEditing]);

  // The catalogue is only needed to *add* a line, so it is fetched the first
  // time a benefit section is opened rather than with every expanded card.
  async function loadItems() {
    if (itemsLoadedRef.current) return;
    itemsLoadedRef.current = true;
    try {
      // benefit_category is computed server-side (#550) — the same
      // classification the API validates a new line against.
      setItems(await apiFetch<SellableItemOption[]>('/sellable-items'));
    } catch {
      itemsLoadedRef.current = false;
      toast(t('services_items_error'));
    }
  }

  function categoryItems(section: BenefitSection): SellableItemOption[] {
    return items.filter((i) => i.benefit_category === section && i.status === 'active');
  }

  function openDurationEdit() {
    setDurationForm({
      free_periods: numField(snapshot.free_periods),
      paid_periods: numField(snapshot.paid_periods),
      pay_beforehand_periods: numField(snapshot.pay_beforehand_periods),
      bonus_periods: numField(snapshot.bonus_periods),
      recurring_billing_interval: numField(snapshot.recurring_billing_interval),
      recurring_billing_unit: snapshot.recurring_billing_unit ?? '',
      membership_fee_price: numField(snapshot.membership_fee_price),
    });
    setEditing('billing');
  }

  function openFeeBenefitEdit() {
    setFeeBenefitForm({
      action: snapshot.personal_fee_benefit.action,
      value: snapshot.personal_fee_benefit.value != null ? String(snapshot.personal_fee_benefit.value) : '',
    });
    setEditing('fee_benefit');
  }

  function openBenefitEdit(section: BenefitSection, rows: AssignedPlanSnapshotBenefit[]) {
    setBenefitDraft(rows.map(toDraftRow));
    setEditing(section);
    loadItems();
  }

  function cancelEdit() {
    setEditing(null);
    setDurationForm(null);
    setFeeBenefitForm(null);
    setBenefitDraft([]);
  }

  async function saveDuration() {
    if (!durationForm) return;
    setSaving(true);
    try {
      // Every field is sent, blank included: clearing one means "not
      // configured", which the API stores as NULL and reads differently from 0.
      await apiFetch(`/user-memberships/${assignedPlanId}/billing-duration`, {
        method: 'PUT',
        body: JSON.stringify({
          free_periods: durationForm.free_periods === '' ? null : Number(durationForm.free_periods),
          paid_periods: durationForm.paid_periods === '' ? null : Number(durationForm.paid_periods),
          pay_beforehand_periods: durationForm.pay_beforehand_periods === ''
            ? null : Number(durationForm.pay_beforehand_periods),
          bonus_periods: durationForm.bonus_periods === '' ? null : Number(durationForm.bonus_periods),
          recurring_billing_interval: durationForm.recurring_billing_interval === ''
            ? null : Number(durationForm.recurring_billing_interval),
          recurring_billing_unit: durationForm.recurring_billing_unit || null,
          membership_fee_price: durationForm.membership_fee_price === ''
            ? null : Number(durationForm.membership_fee_price),
        }),
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
    if (!feeBenefitForm) return;
    setSaving(true);
    try {
      // Replace-all: the assignment holds one such benefit or none, so the
      // whole configuration is sent. `no_benefit` sends no percentage — the
      // server stores NULL for it rather than remembering the last one.
      await apiFetch(`/user-memberships/${assignedPlanId}/fee-benefit`, {
        method: 'PUT',
        body: JSON.stringify({
          action: feeBenefitForm.action,
          value: feeBenefitForm.action === 'percentage_discount' && feeBenefitForm.value !== ''
            ? Number(feeBenefitForm.value)
            : null,
        }),
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
    setSaving(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/${endpoint}`, {
        method: 'PUT',
        body: JSON.stringify({ items: toBenefitItems(benefitDraft) }),
      });
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
              <input
                type="number" min="0" step="0.01"
                value={durationForm.membership_fee_price}
                onChange={(e) => setDurationForm({ ...durationForm, membership_fee_price: e.target.value })}
                style={inputSt}
              />
            </div>
          </div>
          {/* #892 — the four numbers above are billing periods, and the
              cadence beside them is what one period is. */}
          <p style={hintSt}>{t('duration_periods_hint')}</p>
          <p style={hintSt}>{t('snapshot_edit_hint')}</p>
          <SaveCancel saving={saving} onSave={saveDuration} onCancel={cancelEdit} t={t} />
        </div>
      ) : (
        <div>
          {DURATION_FIELDS.map((field) => (
            <CardDetailRow
              key={field}
              label={t(`label_${field}` as any)}
              value={durationText(snapshot[field] as number | null)}
            />
          ))}
          <CardDetailRow
            label={t('label_billing_frequency')}
            value={snapshot.recurring_billing_interval != null && snapshot.recurring_billing_unit
              ? `${snapshot.recurring_billing_interval} × ${t(`unit_${snapshot.recurring_billing_unit}` as any)}`
              : t('not_configured')}
          />
          <CardDetailRow label={t('label_membership_fee')} value={fmtMoney(snapshot.membership_fee_price)} />
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
      {editing === 'fee_benefit' && feeBenefitForm ? (
        <div style={{ margin: '6px 0 14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 8 }}>
            <div>
              <label style={labelSt}>{t('label_personal_fee_benefit')}</label>
              <select
                value={feeBenefitForm.action}
                onChange={(e) => setFeeBenefitForm({
                  ...feeBenefitForm,
                  action: e.target.value as PersonalFeeBenefitAction,
                })}
                style={inputSt}
              >
                {PERSONAL_FEE_BENEFIT_ACTIONS.map((a) => (
                  <option key={a} value={a}>{t(`personal_fee_benefit_${a}` as any)}</option>
                ))}
              </select>
            </div>
            {feeBenefitForm.action === 'percentage_discount' && (
              <div>
                <label style={labelSt}>{t('label_personal_fee_benefit_percentage')}</label>
                <input
                  type="number" min="0" max="100" step="0.01"
                  value={feeBenefitForm.value}
                  onChange={(e) => setFeeBenefitForm({ ...feeBenefitForm, value: e.target.value })}
                  style={inputSt}
                />
              </div>
            )}
          </div>
          <p style={hintSt}>{t('personal_fee_benefit_hint')}</p>
          <SaveCancel saving={saving} onSave={saveFeeBenefit} onCancel={cancelEdit} t={t} />
        </div>
      ) : (
        <CardDetailRow
          label={t('label_personal_fee_benefit')}
          value={snapshot.personal_fee_benefit.action === 'percentage_discount'
            ? t('personal_fee_benefit_percentage_value', { value: snapshot.personal_fee_benefit.value ?? 0 })
            : t('personal_fee_benefit_no_benefit')}
        />
      )}
      </CardSection>

      {/* §3–§5/§9 — the three Sellable-Item-keyed sections, in the order the
          Plans page lists them so both surfaces read the same way. */}
      {BENEFIT_SECTIONS.map(({
        section, endpoint, titleKey, emptyKey, addKey, snapshotKey, showFrequency, viewFrequencyColumn,
      }) => {
        const rows = snapshot[snapshotKey] ?? [];
        return (
          <CardSection
            key={section}
            label={t(titleKey as any)}
            action={editing === section ? null : editButton(() => openBenefitEdit(section, rows))}
          >
            {editing === section ? (
              <div style={{ margin: '6px 0 4px' }}>
                <SellableItemBenefitEditor
                  t={(key, values) => t(key as any, values as any)}
                  addKey={addKey}
                  draft={benefitDraft}
                  setDraft={setBenefitDraft}
                  categoryItems={categoryItems(section)}
                  showFrequency={showFrequency}
                />
                <p style={hintSt}>{t('snapshot_edit_hint')}</p>
                <SaveCancel saving={saving} onSave={() => saveBenefits(endpoint)} onCancel={cancelEdit} t={t} />
              </div>
            ) : (
              /* #924 stage 1 — the one shared grid every Sellable Item section
                 of every card renders from (#916/#919): Sellable Item,
                 Quantity, Frequency, Benefit, Agreed Price, Final Price, in
                 that order and at the same horizontal positions as the
                 Membership Plan it came from. The hand-rolled table this
                 replaced had its own columns and its own widths, which is the
                 separate visual system §1 forbids.

                 `benefitContext="plan"` is the Plan's option set, which is
                 where these lines came from — it renders the agreed treatment
                 as a column here and stays absent from the editor, whose
                 endpoint takes quantity alone (#896 stage 4). */
              <SellableItemBenefitView
                t={(key, values) => t(key as any, values as any)}
                emptyKey={emptyKey}
                rows={rows.map(toViewRow)}
                showFrequency={showFrequency}
                frequencyColumn={viewFrequencyColumn}
                benefitContext="plan"
                showPrices
              />
            )}
          </CardSection>
        );
      })}
    </>
  );
}

/**
 * A section editor's Cancel/Save pair. #929/#954: the geometry and the neutral
 * colours are `secondaryBtnSmall`, and the primary action takes the Theme's own
 * Primary Button colours through `primaryBtnSmall()` — never a `#111` of this
 * page's own, which no Theme could reach.
 */
function SaveCancel({ saving, onSave, onCancel, t }: {
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div style={{ ...inlineActionsRowStyle, justifyContent: 'flex-end' }}>
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
