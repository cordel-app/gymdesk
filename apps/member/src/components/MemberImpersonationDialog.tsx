'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useUser } from '@clerk/nextjs';
import { useAuth } from '@clerk/nextjs';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApp } from '@/context/AppContext';

interface Candidate {
  userId: string;
  name: string;
  type: 'member' | 'staff';
  role: string;
  gymId: string;
}

interface Props {
  onClose: () => void;
}

export function MemberImpersonationDialog({ onClose }: Props) {
  const t = useTranslations('impersonation');
  const { getToken } = useAuth();
  const { gymId } = useApp();
  const { startImpersonation } = useImpersonation();
  const { user } = useUser();

  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async (q: string) => {
    if (!gymId) return;
    setLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(
        `/api/proxy/platform/impersonation/candidates?q=${encodeURIComponent(q)}&gym_id=${gymId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error();
      setCandidates(await res.json());
    } catch {
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, [gymId, getToken]);

  useEffect(() => {
    const timer = setTimeout(() => search(query), 300);
    return () => clearTimeout(timer);
  }, [query, search]);

  useEffect(() => { search(''); }, [search]);

  async function handleImpersonate(candidate: Candidate) {
    if (starting) return;
    setStarting(candidate.userId);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`/api/proxy/platform/impersonation/${candidate.userId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          ...(gymId ? { 'x-gym-id': gymId } : {}) },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? t('error_start'));
      }
      const data = await res.json();
      startImpersonation({
        effectiveUserId: data.id,
        effectiveName: data.name,
        effectiveRole: data.role,
        gymId: data.gym_id,
        gymIds: data.gymIds,
        authenticatorName: user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? 'Admin',
        startedAt: Date.now(),
      });
      onClose();
    } catch (err: any) {
      setError(err.message ?? t('error_start'));
    } finally {
      setStarting(null);
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 60,
      }}
    >
      <div style={{
        background: '#fff', borderRadius: 8,
        width: 'calc(100% - 32px)', maxWidth: 480,
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)', overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #e5e5e5' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('dialog_title')}</h2>
        </div>

        <div style={{ padding: '10px 16px', borderBottom: '1px solid #e5e5e5' }}>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search_placeholder')}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '8px 12px',
              border: '1px solid #e5e5e5', borderRadius: 6, fontSize: 14, outline: 'none',
            }}
          />
        </div>

        {error && (
          <div style={{ padding: '8px 16px', color: '#dc2626', fontSize: 13 }}>{error}</div>
        )}

        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {loading && (
            <div style={{ padding: '14px 16px', color: '#6b7280', fontSize: 14 }}>{t('searching')}</div>
          )}
          {!loading && candidates.length === 0 && (
            <div style={{ padding: '14px 16px', color: '#6b7280', fontSize: 14 }}>{t('search_empty')}</div>
          )}
          {candidates.map((c) => (
            <button
              key={c.userId}
              onClick={() => handleImpersonate(c)}
              disabled={!!starting}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '10px 16px', border: 'none',
                background: 'none', cursor: 'pointer', textAlign: 'left',
                borderBottom: '1px solid #f0f0f0',
                opacity: starting && starting !== c.userId ? 0.5 : 1,
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                background: c.type === 'member' ? '#dbeafe' : '#dcfce7',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 700,
                color: c.type === 'member' ? '#1d4ed8' : '#15803d',
              }}>
                {c.name.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  {c.type === 'member' ? t('type_member') : `${t('type_staff')} · ${c.role}`}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div style={{ padding: '10px 16px', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '7px 14px', border: '1px solid #e5e5e5',
              borderRadius: 6, background: 'none', cursor: 'pointer', fontSize: 14,
            }}
          >
            {t('cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
