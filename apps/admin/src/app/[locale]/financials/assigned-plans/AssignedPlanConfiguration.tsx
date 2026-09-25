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

import React, { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import {
  SellableItemBenefitEditor,
  SellableItemBenefitRow,
  SellableItemOption,
  toBenefitItems,
} from '@/components/SellableItemBenefits';
import type { AssignedPlanSnapshot, AssignedPlanSnapshotBenefit } from './types';

// Mirrors SNAPSHOT_EDITABLE_STATUSES in api/src/api/user-memberships.ts: a
// cancelled or expired assignment is history — it bills nothing further, so its
// configuration is read-only.
const EDITABLE_STATUSES = ['draft', 'awaiting_payment', 'active', 'paused'];

// Stage 13: Pre-paid Duration beside the Paid Duration it is a slice of —
// the same four fields, in the same order, as the Plan's own section.
const DURATION_FIELDS = ['free_months', 'paid_months', 'pay_beforehand_months', 'bonus_months'] as const;
const BILLING_UNITS = ['day', 'week', 'month', 'year'] as const;

type BenefitSection = 'oneoff' | 'session' | 'periodical';

const BENEFIT_SECTIONS: {
  section: BenefitSection;
  endpoint: string;
  titleKey: string;
  emptyKey: string;
  addKey: string;
  snapshotKey: keyof Pick<AssignedPlanSnapshot, 'oneoff_benefits' | 'session_benefits' | 'periodical_benefits'>;
  showFrequency: boolean;
}[] = [
  { section: 'oneoff', endpoint: 'oneoff-benefits', titleKey: 'benefits_oneoff', emptyKey: 'no_oneoff_benefits', addKey: 'add_oneoff_benefit', snapshotKey: 'oneoff_benefits', showFrequency: false },
  { section: 'session', endpoint: 'session-benefits', titleKey: 'benefits_session', emptyKey: 'no_session_benefits', addKey: 'add_session_benefit', snapshotKey: 'session_benefits', showFrequency: false },
  { section: 'periodical', endpoint: 'periodical-benefits', titleKey: 'benefits_period', emptyKey: 'no_period_benefits', addKey: 'add_period_benefit', snapshotKey: 'periodical_benefits', showFrequency: true },
];

interface DurationForm {
  free_months: string;
  paid_months: string;
  pay_beforehand_months: string;
  bonus_months: string;
  recurring_billing_interval: string;
  recurring_billing_unit: string;
  membership_fee_price: string;
}

interface Props {
  assignedPlanId: number;
  /** The assignment's stored status — a terminal one is read-only. */
  planStatus: string;
  snapshot: AssignedPlanSnapshot;
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

export function AssignedPlanConfiguration({
  assignedPlanId, planStatus, snapshot, canWrite, readOnlyTitle, onChanged,
}: Props) {
  const t = useTranslations('assigned_plans_page');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const itemsLoadedRef = useRef(false);

  const [editing, setEditing] = useState<'billing' | BenefitSection | null>(null);
  const [durationForm, setDurationForm] = useState<DurationForm | null>(null);
  const [benefitDraft, setBenefitDraft] = useState<SellableItemBenefitRow[]>([]);
  const [items, setItems] = useState<SellableItemOption[]>([]);
  const [saving, setSaving] = useState(false);

  const editable = canWrite && EDITABLE_STATUSES.includes(planStatus);
  const editTitle = canWrite ? undefined : readOnlyTitle;

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
      free_months: numField(snapshot.free_months),
      paid_months: numField(snapshot.paid_months),
      pay_beforehand_months: numField(snapshot.pay_beforehand_months),
      bonus_months: numField(snapshot.bonus_months),
      recurring_billing_interval: numField(snapshot.recurring_billing_interval),
      recurring_billing_unit: snapshot.recurring_billing_unit ?? '',
      membership_fee_price: numField(snapshot.membership_fee_price),
    });
    setEditing('billing');
  }

  function openBenefitEdit(section: BenefitSection, rows: AssignedPlanSnapshotBenefit[]) {
    setBenefitDraft(rows.map(toDraftRow));
    setEditing(section);
    loadItems();
  }

  function cancelEdit() {
    setEditing(null);
    setDurationForm(null);
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
          free_months: durationForm.free_months === '' ? null : Number(durationForm.free_months),
          paid_months: durationForm.paid_months === '' ? null : Number(durationForm.paid_months),
          pay_beforehand_months: durationForm.pay_beforehand_months === ''
            ? null : Number(durationForm.pay_beforehand_months),
          bonus_months: durationForm.bonus_months === '' ? null : Number(durationForm.bonus_months),
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

  function editButton(onClick: () => void) {
    if (!editable) return null;
    return (
      <button onClick={onClick} disabled={editing !== null} title={editTitle} style={linkBtn}>
        {t('action_edit')}
      </button>
    );
  }

  return (
    <div>
      {/* §7/§9 — Billing & Duration, the Promotion's Free Period / Paid
          Duration / Bonus Duration, plus the cadence and the regular
          Membership Fee this assignment was agreed at. */}
      <SectionHeader title={t('section_billing_duration')} action={editing === 'billing' ? null : editButton(openDurationEdit)} />
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
          <p style={hintSt}>{t('snapshot_edit_hint')}</p>
          <SaveCancel saving={saving} onSave={saveDuration} onCancel={cancelEdit} t={t} />
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          {DURATION_FIELDS.map((field) => (
            <DetailRow
              key={field}
              label={t(`label_${field}` as any)}
              value={snapshot[field] != null ? t('months_value', { n: snapshot[field] as number }) : t('not_configured')}
            />
          ))}
          <DetailRow
            label={t('label_billing_frequency')}
            value={snapshot.recurring_billing_interval != null && snapshot.recurring_billing_unit
              ? `${snapshot.recurring_billing_interval} × ${t(`unit_${snapshot.recurring_billing_unit}` as any)}`
              : t('not_configured')}
          />
          <DetailRow label={t('label_membership_fee')} value={fmtMoney(snapshot.membership_fee_price)} />
        </div>
      )}

      {/* §3–§5/§9 — the three Sellable-Item-keyed sections, in the order the
          Plans page lists them so both surfaces read the same way. */}
      {BENEFIT_SECTIONS.map(({ section, endpoint, titleKey, emptyKey, addKey, snapshotKey, showFrequency }) => {
        const rows = snapshot[snapshotKey] ?? [];
        return (
          <div key={section} style={{ marginBottom: 14 }}>
            <SectionHeader
              title={t(titleKey as any)}
              action={editing === section ? null : editButton(() => openBenefitEdit(section, rows))}
            />
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
              <SnapshotBenefitView rows={rows} emptyLabel={t(emptyKey as any)} showFrequency={showFrequency} t={t} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The read-only view of a section. Unlike the Plan's own (which reads the live
 * catalogue), every column here comes from the frozen line — including the
 * price, which is the whole point of the snapshot (§17).
 */
function SnapshotBenefitView({ rows, emptyLabel, showFrequency, t }: {
  rows: AssignedPlanSnapshotBenefit[];
  emptyLabel: string;
  showFrequency: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  if (rows.length === 0) return <p style={emptySt}>{emptyLabel}</p>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>
          <th style={thSt}>{t('col_sellable_item')}</th>
          <th style={thSt}>{t('col_quantity')}</th>
          {showFrequency && <th style={thSt}>{t('col_frequency')}</th>}
          <th style={thSt}>{t('col_snapshot_price')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td style={tdSt}>{r.item_name}</td>
            <td style={tdSt}>{r.quantity}</td>
            {showFrequency && (
              <td style={tdSt}>
                {r.item_billing_frequency ? t(`frequency_${r.item_billing_frequency}` as any) : '—'}
              </td>
            )}
            <td style={tdSt}>{fmtMoney(r.unit_price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SectionHeader({ title, action }: { title: string; action: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <div style={sectionLabelSt}>{title}</div>
      {action}
    </div>
  );
}

function SaveCancel({ saving, onSave, onCancel, t }: {
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
      <button onClick={onCancel} disabled={saving} style={btnSt}>{t('cancel')}</button>
      <button onClick={onSave} disabled={saving} style={{ ...btnSt, background: '#111', color: '#fff', borderColor: '#111' }}>
        {saving ? t('saving') : t('save_changes')}
      </button>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 4 }}>
      <span style={{ color: '#888', minWidth: 140, fontSize: 13 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const sectionLabelSt: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase',
  letterSpacing: '0.07em',
};
const labelSt: React.CSSProperties = { display: 'block', fontSize: 12, color: '#888', marginBottom: 4 };
const inputSt: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 10px',
  border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff',
};
const btnSt: React.CSSProperties = {
  background: 'none', border: '1px solid #d0d0d0', borderRadius: 4,
  padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: '#444',
};
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#6c63ff', cursor: 'pointer',
  fontSize: 12, padding: 0,
};
const emptySt: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
const hintSt: React.CSSProperties = { color: '#888', fontSize: 12, margin: '8px 0 0' };
const thSt: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px 4px 0', fontSize: 11, fontWeight: 600,
  color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};
const tdSt: React.CSSProperties = { padding: '4px 8px 4px 0', fontSize: 13 };
