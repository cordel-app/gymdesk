'use client';

// #631 — ADDITIONAL PERIODIC PRODUCTS on an Assigned Plan.
//
// Inline row CRUD, no modal (#631 §1/§2): the table lists what is attached and
// "+ Add Product" opens one inline draft row, saved or discarded in place.
// Removal is a single click and is future-only on the server (it stamps the
// effective end date), so there is no destructive confirmation to put behind a
// dialog — a service removed by mistake is re-attached with a new start date.
//
// The Sellable Item is the source of truth for the price and the billing
// frequency (#631 §2): the frequency column is what the catalogue says, never a
// per-assignment override, and only items the API classifies as recurring can
// be picked. Nothing is computed here — the amounts the Billing Simulation
// shows come from the server (CLAUDE.md: no business logic in the frontend).
//
// Rendered in two places, both of which own an Assigned Plan: the Assigned
// Plans expanded row, and the current plan card on the Member page — where
// `onChanged` also re-runs the Member's Billing Simulation, so adding or
// removing a service updates it immediately (#631 §6).
//
// #957: the label says *Product*, not Service — the UI copy is the final
// terminology the Service → Product rename (#949) lands everywhere else, so
// nothing here is named after an intermediate state. Only the locale values
// moved: the keys stay `services_*` because renaming identifiers is #949's,
// and a key renamed here would collide with it for no user-visible gain.
//
// Also #957: the add action is a real themed button (`primaryBtnSmall()`, the
// Theme's Buttons group via #912/#954) rather than the lilac text link it was,
// and `canAdd` is what decides whether it is rendered at all — the Member card
// passes its Edit-mode flag, so expanding a Member reads and `⋮ → Edit` writes
// (#797). It defaults to `true` for the Assigned Plans card, which has no edit
// mode of its own and keeps the action it always had.

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { primaryBtnSmall, readOnlyStyle } from '@/components/ui';
import { useToast } from '@/components/Toast';
import type { AssignedPlanService } from './types';

interface SellableItem {
  id: number;
  name: string;
  status: string;
  billing_frequency: string | null;
  amount: string | number | null;
  benefit_category: 'session' | 'oneoff' | 'periodical';
}

// Mirrors ATTACHABLE_STATUSES in api/src/api/user-membership-services.ts: a
// cancelled or expired plan bills nothing further, so there is nothing to
// attach to — its services stay listed as history.
const ATTACHABLE_STATUSES = ['active', 'paused'];

interface Props {
  assignedPlanId: number;
  /** The plan's start date (YYYY-MM-DD or ISO) — a service can never start before it. */
  planStartsAt: string;
  /** The plan's stored status — services can only be attached while it still bills. */
  planStatus: string;
  services: AssignedPlanService[];
  canWrite: boolean;
  /**
   * #957 — whether the add action is offered at all. The Member card passes its
   * Edit-mode flag (the action is absent in the read-only view, not disabled);
   * a surface with no edit mode omits it and keeps the action.
   */
  canAdd?: boolean;
  readOnlyTitle?: string;
  /** Re-fetches whatever embeds this section (and the Billing Simulation, where shown). */
  onChanged: () => void;
}

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
}

function fmtMoney(v: string | number | null) {
  return v != null ? `€${parseFloat(String(v)).toFixed(2)}` : '—';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function AdditionalPeriodicServices({
  assignedPlanId, planStartsAt, planStatus, services, canWrite, canAdd = true,
  readOnlyTitle, onChanged,
}: Props) {
  const t = useTranslations('assigned_plans_page');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const itemsLoadedRef = useRef(false);

  const [items, setItems] = useState<SellableItem[]>([]);
  const [adding, setAdding] = useState(false);
  const [draftItemId, setDraftItemId] = useState('');
  const [draftQuantity, setDraftQuantity] = useState('1');
  const [draftStartsAt, setDraftStartsAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const planStart = planStartsAt.slice(0, 10);

  useEffect(() => {
    if (!adding || itemsLoadedRef.current) return;
    itemsLoadedRef.current = true;
    (async () => {
      try {
        // benefit_category is computed server-side (#550) — the recurring items
        // are exactly the ones the API accepts here.
        const rows = await apiFetch<SellableItem[]>('/sellable-items');
        setItems(rows.filter((i) => i.benefit_category === 'periodical' && i.status === 'active'));
      } catch {
        setError(t('services_items_error'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);

  function startAdd() {
    setDraftItemId('');
    setDraftQuantity('1');
    setDraftStartsAt(planStart > todayISO() ? planStart : todayISO());
    setError(null);
    setAdding(true);
  }

  function cancelAdd() {
    setAdding(false);
    setError(null);
  }

  async function saveAdd() {
    if (!draftItemId) {
      setError(t('services_select_item'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/services`, {
        method: 'POST',
        body: JSON.stringify({
          gym_charge_id: Number(draftItemId),
          quantity: Number(draftQuantity) || 1,
          starts_at: draftStartsAt || undefined,
        }),
      });
      setAdding(false);
      onChanged();
    } catch (err: any) {
      setError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(service: AssignedPlanService) {
    setBusyId(service.id);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/services/${service.id}`, { method: 'DELETE' });
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setBusyId(null);
    }
  }

  const frequencyLabel = (frequency: string | null) =>
    frequency ? t(`services_frequency_${frequency}` as any) : '—';

  const canAttach = ATTACHABLE_STATUSES.includes(planStatus);
  const write = canWrite ? {} : { disabled: true, title: readOnlyTitle };

  return (
    <div>
      {services.length === 0 && !adding ? (
        <p style={dim}>{t('services_none')}</p>
      ) : (
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>{t('services_col_item')}</th>
              <th style={th}>{t('services_col_quantity')}</th>
              <th style={th}>{t('services_col_frequency')}</th>
              <th style={th}>{t('services_col_price')}</th>
              <th style={th}>{t('services_col_start_date')}</th>
              <th style={th}>{t('services_col_end_date')}</th>
              <th style={{ ...th, textAlign: 'right' }}>{t('services_col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              // `ends_at`, not `active`: a service removed today is still
              // billable through today (so the API reports it active), but it
              // has already been removed and cannot be removed again.
              <tr key={s.id} style={{ opacity: s.ends_at == null ? 1 : 0.6 }}>
                <td style={td}>
                  {s.sellable_item_name}
                  {/* The item was retired after it was attached: it keeps
                      billing (the attachment owns the window), but it can no
                      longer be picked for a new one. */}
                  {s.sellable_item_retired && <span style={dim}> ({t('services_item_retired')})</span>}
                </td>
                <td style={td}>{s.quantity}</td>
                <td style={td}>{frequencyLabel(s.billing_frequency)}</td>
                <td style={td}>{fmtMoney(s.unit_price)}</td>
                <td style={td}>{fmtDate(s.starts_at)}</td>
                <td style={td}>{s.ends_at ? fmtDate(s.ends_at) : '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  {s.ends_at == null ? (
                    <button
                      onClick={() => remove(s)}
                      disabled={!canWrite || busyId === s.id}
                      title={canWrite ? undefined : readOnlyTitle}
                      style={linkBtn}
                    >
                      {busyId === s.id ? t('saving') : t('services_remove')}
                    </button>
                  ) : (
                    <span style={dim}>{t('services_removed')}</span>
                  )}
                </td>
              </tr>
            ))}

            {adding && (
              <tr>
                <td style={td}>
                  <select value={draftItemId} onChange={(e) => setDraftItemId(e.target.value)} style={inputStyle}>
                    <option value="">{t('services_select_item')}</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </select>
                </td>
                <td style={td}>
                  <input
                    type="number" min={1} step={1} value={draftQuantity}
                    onChange={(e) => setDraftQuantity(e.target.value)}
                    style={{ ...inputStyle, minWidth: 70 }}
                  />
                </td>
                <td style={td}>
                  {frequencyLabel(items.find((i) => String(i.id) === draftItemId)?.billing_frequency ?? null)}
                </td>
                <td style={td}>
                  {fmtMoney(items.find((i) => String(i.id) === draftItemId)?.amount ?? null)}
                </td>
                <td style={td}>
                  <input
                    type="date" min={planStart} value={draftStartsAt}
                    onChange={(e) => setDraftStartsAt(e.target.value)}
                    style={inputStyle}
                  />
                </td>
                <td style={td}>—</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={cancelAdd} disabled={saving} style={linkBtn}>{t('cancel')}</button>
                  <button onClick={saveAdd} disabled={saving} style={{ ...linkBtn, fontWeight: 600 }}>
                    {saving ? t('saving') : t('services_save')}
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {error && <p style={{ color: '#c0392b', fontSize: 12, margin: '6px 0 0' }}>{error}</p>}

      {!adding && canAttach && canAdd && (
        <button
          onClick={startAdd}
          {...write}
          style={readOnlyStyle({ ...primaryBtnSmall(), marginTop: 8 }, !canWrite)}
        >
          {t('services_add')}
        </button>
      )}
    </div>
  );
}

const dim: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th: React.CSSProperties = {
  textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#888',
  textTransform: 'uppercase', letterSpacing: '0.04em', padding: '0 8px 4px 0',
};
const td: React.CSSProperties = { padding: '6px 8px 6px 0', borderTop: '1px solid #f0f0f3', verticalAlign: 'middle' };
const inputStyle: React.CSSProperties = {
  padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, minWidth: 130,
};
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#6c63ff', cursor: 'pointer',
  fontSize: 13, padding: '0 8px',
};
