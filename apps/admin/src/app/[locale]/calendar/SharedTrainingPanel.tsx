'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { btnSmall } from '@/components/ui';

interface SharedRequest {
  id: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requesting_member_name: string;
  activity_type_name: string;
  created_at: string;
}

interface Props {
  sessionId: number;
  canWrite: boolean;
  onClose: () => void;
}

export function SharedTrainingPanel({ sessionId, canWrite, onClose }: Props) {
  const t = useTranslations('schedule');
  const { apiFetch } = useApiClient();
  const [requests, setRequests] = useState<SharedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<SharedRequest[]>(
        `/shared-training-requests?status=pending&class_session_id=${sessionId}`,
      );
      setRequests(data);
    } catch (e: any) {
      setError(e.message);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [sessionId]);

  async function approve(id: number) {
    try {
      await apiFetch(`/shared-training-requests/${id}/approve`, { method: 'POST' });
      load();
    } catch (e: any) { setError(e.message); }
  }

  async function reject(id: number) {
    try {
      await apiFetch(`/shared-training-requests/${id}/reject`, { method: 'POST' });
      load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 420, height: '100%', background: '#fff', boxShadow: '-4px 0 20px rgba(0,0,0,0.1)', overflow: 'auto', padding: 24 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{t('shared_training_requests')}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {error && <p style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</p>}

        {loading ? (
          <p style={{ color: '#666', fontSize: 13 }}>{t('loading')}</p>
        ) : requests.length === 0 ? (
          <p style={{ color: '#666', fontSize: 13 }}>{t('no_shared_requests')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {requests.map((r) => (
              <div key={r.id} style={{ padding: '12px 14px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{r.requesting_member_name}</div>
                <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 10 }}>{r.activity_type_name}</div>
                {canWrite && r.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => approve(r.id)} style={btnSmall('#16a34a')}>{t('shared_approve')}</button>
                    <button onClick={() => reject(r.id)} style={btnSmall('#dc2626')}>{t('shared_reject')}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
