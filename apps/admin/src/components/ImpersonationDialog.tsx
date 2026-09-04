'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useUser } from '@clerk/nextjs';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useToast } from '@/components/Toast';

interface Target {
  id: string;
  name: string;
  type: 'member' | 'staff';
  role: string;
  status?: string;
  gymId: string;
}

interface Props {
  onClose: () => void;
}

export function ImpersonationDialog({ onClose }: Props) {
  const t = useTranslations('impersonation');
  const { apiFetch } = useApiClient();
  const { activeGymId } = useGym();
  const { startImpersonation } = useImpersonation();
  const { user } = useUser();
  const { toast } = useToast();

  const [query, setQuery] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const search = useCallback(async (q: string) => {
    if (!activeGymId) return;
    setLoading(true);
    setSearchError(null);
    try {
      const results = await apiFetch<Target[]>(
        `/platform/impersonation/targets?q=${encodeURIComponent(q)}&gym_id=${activeGymId}`,
      );
      setTargets(results);
    } catch (err) {
      setTargets([]);
      setSearchError(t('error_search'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, apiFetch, t]);

  useEffect(() => {
    const timer = setTimeout(() => search(query), 300);
    return () => clearTimeout(timer);
  }, [query, search]);

  useEffect(() => { search(''); }, [search]);

  async function handleImpersonate(target: Target) {
    if (starting) return;
    setStarting(target.id);
    try {
      const data = await apiFetch<{
        id: string; name: string; role: string; gym_id: string; gymIds: string[];
      }>(`/platform/impersonation/${encodeURIComponent(target.id)}`, {
        method: 'POST',
        body: JSON.stringify({ targetType: target.type }),
      });

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
      toast(err.message ?? t('error_start'));
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
        paddingTop: 80,
      }}
    >
      <div style={{
        background: 'var(--gd-app-bg, #fff)', borderRadius: 8,
        width: '100%', maxWidth: 480, boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border, #e5e5e5)' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{t('dialog_title')}</h2>
        </div>

        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border, #e5e5e5)' }}>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search_placeholder')}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '8px 12px',
              border: '1px solid var(--border, #e5e5e5)', borderRadius: 6,
              fontSize: 14, outline: 'none', background: 'transparent',
              color: 'inherit',
            }}
          />
        </div>

        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {loading && (
            <div style={{ padding: '16px 20px', color: 'var(--muted, #6b7280)', fontSize: 14 }}>
              {t('searching')}
            </div>
          )}
          {!loading && searchError && (
            <div style={{ padding: '16px 20px', color: '#dc2626', fontSize: 14 }}>
              {searchError}
            </div>
          )}
          {!loading && !searchError && targets.length === 0 && (
            <div style={{ padding: '16px 20px', color: 'var(--muted, #6b7280)', fontSize: 14 }}>
              {t('search_empty')}
            </div>
          )}
          {targets.map((c) => (
            <button
              key={c.id}
              onClick={() => handleImpersonate(c)}
              disabled={starting === c.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                width: '100%', padding: '12px 20px', border: 'none',
                background: 'none', cursor: 'pointer', textAlign: 'left',
                borderBottom: '1px solid var(--border, #f0f0f0)',
                opacity: starting && starting !== c.id ? 0.5 : 1,
              }}
            >
              <div style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                background: c.type === 'member' ? '#dbeafe' : '#dcfce7',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, fontWeight: 600,
                color: c.type === 'member' ? '#1d4ed8' : '#15803d',
              }}>
                {c.name.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted, #6b7280)', marginTop: 2 }}>
                  {c.type === 'member'
                    ? t('type_member')
                    : [t('type_staff'), c.role, c.status].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div style={{
                fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                background: c.type === 'member' ? '#dbeafe' : '#dcfce7',
                color: c.type === 'member' ? '#1d4ed8' : '#15803d',
                flexShrink: 0,
              }}>
                {c.type === 'member' ? t('type_member') : t('type_staff')}
              </div>
            </button>
          ))}
        </div>

        <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '7px 16px', border: '1px solid var(--border, #e5e5e5)',
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
