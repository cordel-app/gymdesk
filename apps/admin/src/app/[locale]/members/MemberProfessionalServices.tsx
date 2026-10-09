'use client';

// #1227 stage 1 — the Member's Professional Services section.
//
// One row per Professional Service the gym has switched on, with the balance
// the booking gate itself reads (`GET /members/:id/professional-services/wallet`
// — the existing derived balance, never a second one) and a per-row ⋮ menu:
// `Edit` opens an inline form where staff enter the desired final balance
// (the API stores the signed delta with the balance before and after) and
// `History` lists adjustments and spent / returned sessions.
//
// Everything is decided by the API; this file formats. A read-only role sees
// the balances and the history, with `Edit` disabled and explained.

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { ContextMenu } from '@/components/ContextMenu';
import { primaryBtnSmall } from '@/components/ui';
import {
  cardMutedTextStyle,
  formControlStyle,
  formErrorStyle,
  formFieldLabelStyle,
  inlineActionsRowStyle,
  innerCardStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';

interface WalletRow {
  professional_service_id: number;
  name: string;
  available_items: number;
}

interface HistoryEntry {
  kind: 'adjustment' | 'consumption';
  at: string;
  quantity: number;
  reason: string | null;
  balance_before: number | null;
  balance_after: number | null;
  actor: string | null;
}

const CONSUMPTION_REASONS = ['attendance', 'late_cancel', 'no_show', 'returned'];

export function MemberProfessionalServices({ memberId }: { memberId: number }) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const { canWrite, readOnlyTitle } = useModuleAccess('MEMBERS');
  const [rows, setRows] = useState<WalletRow[] | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [balance, setBalance] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await apiFetch<WalletRow[]>(`/members/${memberId}/professional-services/wallet`));
    } catch {
      setRows([]);
    }
  }, [apiFetch, memberId]);

  useEffect(() => { void load(); }, [load]);

  async function openHistory(serviceId: number) {
    if (historyId === serviceId) { setHistoryId(null); return; }
    setHistoryId(serviceId);
    try {
      setHistory(await apiFetch<HistoryEntry[]>(`/members/${memberId}/professional-services/${serviceId}/history`));
    } catch {
      setHistory([]);
    }
  }

  function startEdit(row: WalletRow) {
    setEditingId(row.professional_service_id);
    setBalance(String(row.available_items));
    setReason('');
    setError(null);
  }

  async function save(serviceId: number) {
    const value = Number(balance);
    if (balance.trim() === '' || !Number.isInteger(value) || value < 0) {
      setError(t('prof_services_balance_invalid'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/members/${memberId}/professional-services/${serviceId}/adjust`, {
        method: 'POST',
        body: JSON.stringify({ new_balance: value, reason: reason.trim() || null }),
      });
      toast(t('prof_services_saved'), 'success');
      setEditingId(null);
      await load();
      if (historyId === serviceId) {
        setHistory(await apiFetch<HistoryEntry[]>(`/members/${memberId}/professional-services/${serviceId}/history`));
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('prof_services_save_failed'));
    } finally {
      setSaving(false);
    }
  }

  function historyLabel(h: HistoryEntry): string {
    if (h.kind === 'adjustment') return t('prof_services_history_adjustment');
    return CONSUMPTION_REASONS.includes(h.reason ?? '')
      ? t(`prof_services_history_${h.reason}`)
      : t('prof_services_history_consumption');
  }

  if (rows === null) return <p style={cardMutedTextStyle}>{t('prof_services_loading')}</p>;
  if (rows.length === 0) return <p style={cardMutedTextStyle}>{t('prof_services_empty')}</p>;

  return (
    <div>
      {rows.map((row) => {
        const id = row.professional_service_id;
        return (
          <div key={id} style={innerCardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{row.name}</div>
                <div style={cardMutedTextStyle}>
                  {t('prof_services_available')}: <strong>{row.available_items}</strong>
                </div>
              </div>
              <ContextMenu
                ariaLabel={row.name}
                items={[
                  {
                    label: t('prof_services_edit'),
                    onClick: () => startEdit(row),
                    disabled: !canWrite,
                    title: canWrite ? undefined : readOnlyTitle,
                  },
                  { label: t('prof_services_history'), onClick: () => void openHistory(id) },
                ]}
              />
            </div>

            {editingId === id && (
              <div style={{ marginTop: 10 }}>
                <label style={formFieldLabelStyle}>
                  {t('prof_services_new_balance')}
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={balance}
                    onChange={(e) => setBalance(e.target.value)}
                    style={formControlStyle}
                    disabled={saving}
                  />
                </label>
                <label style={{ ...formFieldLabelStyle, marginTop: 8 }}>
                  {t('prof_services_reason')}
                  <input
                    type="text"
                    maxLength={255}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    style={formControlStyle}
                    disabled={saving}
                  />
                </label>
                {error && <div style={formErrorStyle}>{error}</div>}
                <div style={inlineActionsRowStyle}>
                  <button type="button" style={primaryBtnSmall()} disabled={saving} onClick={() => void save(id)}>
                    {t('prof_services_save')}
                  </button>
                  <button type="button" style={secondaryBtnSmall} disabled={saving} onClick={() => setEditingId(null)}>
                    {t('prof_services_cancel')}
                  </button>
                </div>
              </div>
            )}

            {historyId === id && (
              <div style={{ marginTop: 10 }}>
                {history.length === 0 ? (
                  <p style={cardMutedTextStyle}>{t('prof_services_history_empty')}</p>
                ) : (
                  history.map((h, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 13, padding: '3px 0' }}>
                      <span>{new Date(h.at).toLocaleString()}</span>
                      <strong>{h.quantity > 0 ? `+${h.quantity}` : h.quantity}</strong>
                      <span>{historyLabel(h)}</span>
                      {h.balance_before !== null && h.balance_after !== null && (
                        <span style={cardMutedTextStyle}>{h.balance_before} → {h.balance_after}</span>
                      )}
                      {h.kind === 'adjustment' && h.reason && <span style={cardMutedTextStyle}>{h.reason}</span>}
                      {h.actor && <span style={cardMutedTextStyle}>{h.actor}</span>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
