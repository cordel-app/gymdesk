'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
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
  next_billing_date: string | null;
  last_billed_at: string | null;
}

interface BillingEvent {
  id: number;
  event_type: string;
  created_at: string;
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

  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [activeMembership, setActiveMembership] = useState<UserMembership | null>(null);
  const [hasFailedCharge, setHasFailedCharge] = useState(false);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [rows, memberships, events] = await Promise.all([
        apiFetch<PaymentRequest[]>(`/payment-requests?member_id=${memberId}`),
        apiFetch<UserMembership[]>(`/user-memberships?member_id=${memberId}&status=active`).catch(() => []),
        apiFetch<BillingEvent[]>(`/billing-events/member/${memberId}?limit=1`).catch(() => []),
      ]);
      setRequests(rows);
      setActiveMembership(memberships[0] ?? null);
      setHasFailedCharge(events[0]?.event_type === 'failed_billing');
    } catch {
      // silently ignore — empty state handles it
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [memberId]);

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
      <div style={{ ...modalStyle, width: 680 }} onClick={(e) => e.stopPropagation()}>
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
                  <td style={td}>
                    {parseFloat(pr.amount).toFixed(2)} {pr.currency}
                  </td>
                  <td style={td}>
                    <StatusBadge status={pr.status} label={t(`member_payments.status_${pr.status}`)} />
                  </td>
                  <td style={td}>{new Date(pr.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid #eee', paddingTop: 16 }}>
          <button
            onClick={requestPayment}
            style={btnStyle('#6c63ff')}
            disabled={requesting || !activeMembership}
          >
            {requesting ? t('member_payments.requesting') : t('member_payments.request_button')}
          </button>

          {error && (
            <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>
          )}

          {checkoutUrl && (
            <div style={{ marginTop: 14, padding: 12, background: '#f8f8f8', borderRadius: 8, border: '1px solid #e0e0e0' }}>
              <p style={{ margin: '0 0 8px', fontSize: 13, color: '#555' }}>
                {t('member_payments.link_label')}
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ fontSize: 12, wordBreak: 'break-all', flex: 1, color: '#333' }}>
                  {checkoutUrl}
                </code>
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
