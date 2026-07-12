'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';

interface Membership {
  id: number;
  member_id: number;
  member_name: string;
  plan_name: string | null;
}

interface BillingEvent {
  id: number;
  event_type: 'charge_created' | 'payment_recorded' | 'status_changed' | 'adjustment';
  charge_type_id: number | null;
  charge_type_code: string | null;
  previous_status: string | null;
  new_status: string | null;
  amount: string | null;
  notes: string | null;
  source: string;
  actor_user_id: string | null;
  created_at: string;
}

interface ChargeType { id: number; code: string; active: boolean }

const emptyPayment = { event_type: 'payment_recorded', charge_type_id: '', amount: '', notes: '' };

export function MembershipLedgerModal({
  membership, canRecord, onClose,
}: { membership: Membership; canRecord: boolean; onClose: () => void }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [events, setEvents] = useState<BillingEvent[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);
  const [loading, setLoading] = useState(true);
  const [payOpen, setPayOpen] = useState(false);
  const [payForm, setPayForm] = useState(emptyPayment);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [ledger, cts] = await Promise.all([
        apiFetch<{ items: BillingEvent[] }>(`/billing-events?user_membership_id=${membership.id}&limit=100`),
        apiFetch<ChargeType[]>('/charge-types'),
      ]);
      setEvents(ledger.items);
      setChargeTypes(cts.filter((c) => c.active));
    } catch (err: any) {
      toast(err.message ?? t('memberships.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [membership.id]);

  async function recordPayment() {
    const parsed = parseFloat(payForm.amount);
    if (isNaN(parsed) || parsed <= 0) { setError(t('memberships.error_amount')); return; }
    if (!payForm.charge_type_id) { setError(t('memberships.error_charge_type')); return; }
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/billing-events', {
        method: 'POST',
        body: JSON.stringify({
          event_type: payForm.event_type,
          user_membership_id: membership.id,
          charge_type_id: parseInt(payForm.charge_type_id, 10),
          amount: parsed,
          notes: payForm.notes.trim() || undefined,
        }),
      });
      setPayForm(emptyPayment);
      setPayOpen(false);
      load();
    } catch (err: any) {
      setError(err.message ?? t('memberships.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 720 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('memberships.ledger_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>
          {membership.member_name}{membership.plan_name ? ` — ${membership.plan_name}` : ''}
        </p>

        {loading ? (
          <p style={{ color: '#666' }}>{t('memberships.loading')}</p>
        ) : events.length === 0 ? (
          <p style={{ color: '#666' }}>{t('memberships.ledger_empty')}</p>
        ) : (
          <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', background: '#fafafa', position: 'sticky', top: 0 }}>
                  <th style={th}>{t('memberships.ledger_when')}</th>
                  <th style={th}>{t('memberships.ledger_event')}</th>
                  <th style={th}>{t('memberships.ledger_detail')}</th>
                  <th style={{ ...th, textAlign: 'right' }}>{t('memberships.ledger_amount')}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                    <td style={td}>{e.created_at.slice(0, 16).replace('T', ' ')}</td>
                    <td style={td}>{t(`memberships.event.${e.event_type}`)}</td>
                    <td style={td}>{renderDetail(e, t)}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {e.amount ? parseFloat(e.amount).toFixed(2) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canRecord && !payOpen && (
          <div style={{ marginTop: 20 }}>
            <button onClick={() => { setPayForm(emptyPayment); setError(null); setPayOpen(true); }} style={btnStyle('#1e7e40')}>
              {t('memberships.record_payment')}
            </button>
          </div>
        )}

        {canRecord && payOpen && (
          <div style={{ borderTop: '1px solid #eee', marginTop: 20, paddingTop: 16 }}>
            <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>{t('memberships.record_heading')}</p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label={t('memberships.pay_type')}>
                <select value={payForm.event_type} onChange={(e) => setPayForm({ ...payForm, event_type: e.target.value })} style={input}>
                  <option value="payment_recorded">{t('memberships.event.payment_recorded')}</option>
                  <option value="charge_created">{t('memberships.event.charge_created')}</option>
                </select>
              </Field>
              <Field label={t('memberships.pay_charge_type')}>
                <select value={payForm.charge_type_id} onChange={(e) => setPayForm({ ...payForm, charge_type_id: e.target.value })} style={input}>
                  <option value="">—</option>
                  {chargeTypes.map((c) => (
                    <option key={c.id} value={c.id}>{t(`charge_type.${c.code}`)}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('memberships.pay_amount')}>
                <input type="number" min="0.01" step="0.01" value={payForm.amount}
                       onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
                       style={{ ...input, width: 110 }} placeholder="0.00" />
              </Field>
              <Field label={t('memberships.pay_notes')}>
                <input type="text" value={payForm.notes}
                       onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })}
                       style={{ ...input, minWidth: 200 }} />
              </Field>
              <button onClick={recordPayment} style={btnStyle('#1e7e40')} disabled={saving}>
                {saving ? t('memberships.saving') : t('memberships.pay_save')}
              </button>
              <button onClick={() => setPayOpen(false)} style={btnStyle('#aaa')} disabled={saving}>
                {t('memberships.cancel')}
              </button>
            </div>
            {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('memberships.close')}</button>
        </div>
      </div>
    </div>
  );
}

function renderDetail(e: BillingEvent, t: any): string {
  if (e.event_type === 'status_changed') {
    return t('memberships.status_transition', {
      from: e.previous_status ? t(`status.${e.previous_status}`) : '—',
      to: e.new_status ? t(`status.${e.new_status}`) : '—',
    });
  }
  const parts: string[] = [];
  if (e.charge_type_code) parts.push(t(`charge_type.${e.charge_type_code}`));
  if (e.notes) parts.push(e.notes);
  return parts.join(' — ') || '—';
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: '#666' }}>{label}</span>
      {children}
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 12px', fontSize: 13, fontWeight: 600, color: '#555' };
const td: React.CSSProperties = { padding: '8px 12px', fontSize: 14 };
const input: React.CSSProperties = { padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' };
