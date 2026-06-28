'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';

export default function DashboardPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, gyms, loading: gymsLoading } = useGym();
  const [health, setHealth] = useState<{ status: string } | null>(null);
  const [memberCount, setMemberCount] = useState<number>(0);

  // Redirect users with no gym
  useEffect(() => {
    if (!gymsLoading && gyms.length === 0) {
      router.replace(`/${locale}/no-gym`);
    }
  }, [gymsLoading, gyms, locale, router]);

  useEffect(() => {
    fetch('/api/proxy/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    if (!activeGymId) return;
    apiFetch<{ count: number }>('/members/count')
      .then((data) => setMemberCount(data.count))
      .catch(() => setMemberCount(0));
  }, [activeGymId]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 40 }}>
        <h1 style={{ margin: 0 }}>{t('dashboard.title')}</h1>
        <span style={{
          padding: '4px 10px',
          borderRadius: 12,
          fontSize: 13,
          background: health?.status === 'ok' ? '#d4edda' : '#f8d7da',
          color: health?.status === 'ok' ? '#155724' : '#721c24',
        }}>
          {health?.status === 'ok' ? t('dashboard.api_online') : t('dashboard.api_offline')}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        <div style={{
          background: '#fff',
          borderRadius: 12,
          padding: '24px 32px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          minWidth: 160,
        }}>
          <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>{t('dashboard.total_members')}</div>
          <div style={{ fontSize: 36, fontWeight: 700, color: '#1a1a2e' }}>{memberCount}</div>
        </div>
      </div>
    </div>
  );
}
