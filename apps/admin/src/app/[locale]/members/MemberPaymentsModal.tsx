'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@clerk/nextjs';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { StatusBadge } from '@/components/StatusBadge';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';

interface PaymentRequest {
  id: number;
  amount: string;
  currency: string;
  status: 'pending' | 'completed' | 'failed' | 'expired';
  source: string;
  created_at: string;
  completed_at: string | null;
}

interface UserMembership {
  id: number;
  status: string;
  final_price: string | null;
  currency: string | null;
  next_billing_date: string | null;
  last_billed_at: string | null;
}

interface BillingEvent {
  id: number;
  event_type: string;
  charge_type_code: string | null;
  amount: string | null;
  notes: string | null;
  created_at: string;
  receipt_number: string | null;
  member_name: string | null;
}

interface ChargeType {
  id: number;
  code: string;
  active: boolean;
}

export function MemberPaymentsModal({
  memberId,
  memberName,
  onClose,
}: {
  memberId: number;
  memberName: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { getToken } = useAuth();
  const { activeGymId } = useGym();

  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [billingEvents, setBillingEvents] = useState<BillingEvent[]>([]);
  const [activeMembership, setActiveMembership] = useState<UserMembership | null>(null);
  const [hasFailedCharge, setHasFailedCharge] = useState(false);
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Cash payment form state
  const [showCashForm, setShowCashForm] = useState(false);
  const [cashAmount, setCashAmount] = useState('');
  const [cashChargeTypeId, setCashChargeTypeId] = useState('');
  const [cashNotes, setCashNotes] = useState('');
  const [cashSubmitting, setCashSubmitting] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);
  const [cashSuccess, setCashSuccess] = useState(false);

  // Receipt generation state: eventId -> 'generating' | 'done' | 'error'
  const [receiptState, setReceiptState] = useState<Record<number, 'generating' | 'done' | 'error'>>({});

  async function load() {
    setLoading(true);
    try {
      const [rows, memberships, events, types] = await Promise.all([
        apiFetch<PaymentRequest[]>(`/payment-requests?member_id=${memberId}`),
        apiFetch<UserMembership[]>(`/user-memberships?member_id=${memberId}&status=active`).catch(() => []),
        apiFetch<{ items: BillingEvent[] }>(`/payments/member/${memberId}?limit=50`).catch(() => ({ items: [] })),
        apiFetch<ChargeType[]>('/charge-types').catch(() => []),
      ]);
      setRequests(rows);
      setActiveMembership(memberships[0] ?? null);
      const allEvents = events.items ?? [];
      setHasFailedCharge(allEvents.some((e) => e.event_type === 'failed_billing'));
      setBillingEvents(allEvents.filter((e) => e.event_type === 'payment_recorded'));
      setChargeTypes(types.filter((ct) => ct.active));
    } catch {
      // silently ignore — empty state handles it
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [memberId]);

  function openCashForm() {
    setCashAmount(activeMembership?.final_price ? parseFloat(activeMembership.final_price).toFixed(2) : '');
    const membershipFee = chargeTypes.find((ct) => ct.code === 'membership_fee');
    setCashChargeTypeId(membershipFee ? String(membershipFee.id) : (chargeTypes[0] ? String(chargeTypes[0].id) : ''));
    setCashNotes('');
    setCashError(null);
    setCashSuccess(false);
    setShowCashForm(true);
  }

  function closeCashForm() {
    setShowCashForm(false);
    setCashError(null);
  }

  async function submitCashPayment() {
    if (!cashChargeTypeId) { setCashError(t('member_payments.error_generic')); return; }
    const parsedAmount = parseFloat(cashAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) { setCashError(t('member_payments.error_generic')); return; }
    setCashSubmitting(true);
    setCashError(null);
    try {
      await apiFetch('/payments', {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'payment_recorded',
          source: 'admin',
          member_id: memberId,
          user_membership_id: activeMembership?.id ?? null,
          amount: parsedAmount,
          charge_type_id: Number(cashChargeTypeId),
          notes: cashNotes.trim() || null,
        }),
      });
      setCashSuccess(true);
      setShowCashForm(false);
      load();
    } catch (err: any) {
      setCashError(err.message ?? t('member_payments.error_generic'));
    } finally {
      setCashSubmitting(false);
    }
  }

  async function pdfFetch(path: string, method: 'GET' | 'POST' = 'GET'): Promise<Blob> {
    const token = await getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (activeGymId) headers['x-gym-id'] = activeGymId;
    const res = await fetch(`/api/proxy${path}`, { method, headers });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.blob();
  }

  async function generateReceipt(eventId: number) {
    setReceiptState((s) => ({ ...s, [eventId]: 'generating' }));
    try {
      const blob = await pdfFetch(`/payments/${eventId}/receipt`, 'POST');
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setReceiptState((s) => ({ ...s, [eventId]: 'done' }));
      load();
    } catch {
      setReceiptState((s) => ({ ...s, [eventId]: 'error' }));
    }
  }

  async function downloadReceipt(eventId: number) {
    try {
      const blob = await pdfFetch(`/payments/${eventId}/receipt`, 'GET');
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch {
      // silently ignore — PDF not ready
    }
  }

  async function requestPayment() {
    if (!activeMembership) {
      setError(t('member_payments.error_no_active_membership'));
      return;
    }
    setRequesting(true);
    setError(null);
    setCheckoutUrl(null);
    try {
      const result = await apiFetch<{ id: number; checkoutUrl: string }>(
        '/payment-requests',
        { method: 'POST', body: JSON.stringify({ user_membership_id: activeMembership.id }) },
      );
      setCheckoutUrl(result.checkoutUrl);
      load();
    } catch (err: any) {
      setError(err.message ?? t('member_payments.error_generic'));
    } finally {
      setRequesting(false);
    }
  }

  function copyLink() {
    if (!checkoutUrl) return;
    navigator.clipboard.writeText(checkoutUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 720 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('member_payments.title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{memberName}</p>

        {/* Billing dates from active membership */}
        {activeMembership && (activeMembership.next_billing_date || activeMembership.last_billed_at) && (
          <div style={{ display: 'flex', gap: 24, marginBottom: 16, fontSize: 13, color: '#555' }}>
            {activeMembership.last_billed_at && (
              <span>
                <strong>{t('member_payments.last_billed_at')}:</strong>{' '}
                {new Date(activeMembership.last_billed_at).toLocaleDateString()}
              </span>
            )}
            {activeMembership.next_billing_date && (
              <span>
                <strong>{t('member_payments.next_billing_date')}:</strong>{' '}
                {new Date(activeMembership.next_billing_date).toLocaleDateString()}
              </span>
            )}
            {hasFailedCharge && (
              <StatusBadge status="failed" label={t('member_payments.badge_failed_charge')} />
            )}
          </div>
        )}

        {/* Online payment requests */}
        {loading ? (
          <p style={{ color: '#666' }}>{t('member_payments.loading')}</p>
        ) : requests.length === 0 ? (
          <p style={{ color: '#666', marginBottom: 20 }}>{t('member_payments.empty')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                <th style={th}>{t('member_payments.col_amount')}</th>
                <th style={th}>{t('member_payments.col_status')}</th>
                <th style={th}>{t('member_payments.col_date')}</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((pr) => (
                <tr key={pr.id} style={{ borderBottom: '1px solid #f4f4f4' }}>
                  <td style={td}>{parseFloat(pr.amount).toFixed(2)} {pr.currency}</td>
                  <td style={td}>
                    <StatusBadge status={pr.status} label={t(`member_payments.status_${pr.status}`)} />
                  </td>
                  <td style={td}>{new Date(pr.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Cash payments (payment_recorded billing events) */}
        {!loading && billingEvents.length > 0 && (
          <>
            <h3 style={{ margin: '20px 0 8px', fontSize: 14, fontWeight: 600, color: '#444' }}>
              {t('member_payments.cash_payments_heading')}
            </h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                  <th style={th}>{t('member_payments.col_amount')}</th>
                  <th style={th}>{t('member_payments.col_concept')}</th>
                  <th style={th}>{t('member_payments.col_date')}</th>
                  <th style={th}>{t('member_payments.col_receipt')}</th>
                </tr>
              </thead>
              <tbody>
                {billingEvents.map((ev) => {
                  const rs = receiptState[ev.id];
                  return (
                    <tr key={ev.id} style={{ borderBottom: '1px solid #f4f4f4' }}>
                      <td style={td}>{ev.amount ? parseFloat(ev.amount).toFixed(2) : '—'} EUR</td>
                      <td style={td}>{ev.charge_type_code ?? '—'}</td>
                      <td style={td}>{new Date(ev.created_at).toLocaleDateString()}</td>
                      <td style={td}>
                        {ev.receipt_number ? (
                          <button
                            onClick={() => downloadReceipt(ev.id)}
                            style={btnSmall('#1e7e40')}
                          >
                            {ev.receipt_number} ↓
                          </button>
                        ) : (
                          <button
                            onClick={() => generateReceipt(ev.id)}
                            style={btnSmall(rs === 'error' ? '#c0392b' : '#555')}
                            disabled={rs === 'generating'}
                          >
                            {rs === 'generating'
                              ? t('member_payments.receipt_generating')
                              : rs === 'error'
                              ? t('member_payments.receipt_error')
                              : t('member_payments.receipt_generate')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {cashSuccess && (
          <p style={{ color: '#1e7e40', margin: '0 0 12px', fontSize: 14 }}>
            {t('member_payments.cash_success')}
          </p>
        )}

        {/* Cash payment inline form */}
        {showCashForm && (
          <div style={{ marginBottom: 16, padding: 16, background: '#f8f8f8', borderRadius: 8, border: '1px solid #e0e0e0' }}>
            <p style={{ margin: '0 0 12px', fontWeight: 600, fontSize: 14 }}>{t('member_payments.cash_form_title')}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={labelStyle}>
                {t('member_payments.cash_amount_label')}
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={cashAmount}
                  onChange={(e) => setCashAmount(e.target.value)}
                  style={inputStyle}
                />
              </label>
              <label style={labelStyle}>
                {t('member_payments.cash_concept_label')}
                <select
                  value={cashChargeTypeId}
                  onChange={(e) => setCashChargeTypeId(e.target.value)}
                  style={inputStyle}
                >
                  {chargeTypes.map((ct) => (
                    <option key={ct.id} value={ct.id}>{ct.code}</option>
                  ))}
                </select>
              </label>
              <label style={labelStyle}>
                {t('member_payments.cash_notes_label')}
                <input
                  type="text"
                  value={cashNotes}
                  onChange={(e) => setCashNotes(e.target.value)}
                  placeholder={t('member_payments.cash_notes_placeholder')}
                  style={inputStyle}
                />
              </label>
            </div>
            {cashError && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{cashError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={submitCashPayment} style={btnStyle('#1e7e40')} disabled={cashSubmitting}>
                {cashSubmitting ? t('member_payments.cash_submitting') : t('member_payments.cash_submit')}
              </button>
              <button onClick={closeCashForm} style={btnStyle('#888')} disabled={cashSubmitting}>
                {t('member_payments.cash_cancel')}
              </button>
            </div>
          </div>
        )}

        <div style={{ borderTop: '1px solid #eee', paddingTop: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={requestPayment}
              style={btnStyle('#6c63ff')}
              disabled={requesting || !activeMembership}
            >
              {requesting ? t('member_payments.requesting') : t('member_payments.request_button')}
            </button>
            {!showCashForm && (
              <button
                onClick={openCashForm}
                style={btnStyle('#2d7a2d')}
                disabled={!activeMembership}
              >
                {t('member_payments.cash_button')}
              </button>
            )}
          </div>

          {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}

          {checkoutUrl && (
            <div style={{ marginTop: 14, padding: 12, background: '#f8f8f8', borderRadius: 8, border: '1px solid #e0e0e0' }}>
              <p style={{ margin: '0 0 8px', fontSize: 13, color: '#555' }}>{t('member_payments.link_label')}</p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ fontSize: 12, wordBreak: 'break-all', flex: 1, color: '#333' }}>{checkoutUrl}</code>
                <button onClick={copyLink} style={btnSmall(copied ? '#1e7e40' : '#444')}>
                  {copied ? t('member_payments.copied') : t('member_payments.copy_button')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('member_payments.close')}</button>
        </div>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 10px', fontSize: 13, fontWeight: 600, color: '#555' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14 };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#444' };
const inputStyle: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d0d0', fontSize: 14, width: '100%', boxSizing: 'border-box' };
