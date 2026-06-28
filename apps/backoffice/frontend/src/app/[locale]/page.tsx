import { getTranslations } from 'next-intl/server';

async function getHealth(): Promise<{ status: string } | null> {
  try {
    const res = await fetch(`${process.env.BACKEND_URL}/health`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function getMemberCount(): Promise<number> {
  try {
    const res = await fetch(`${process.env.BACKEND_URL}/members/count`, { cache: 'no-store' });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.count ?? 0;
  } catch {
    return 0;
  }
}

export default async function DashboardPage() {
  const t = await getTranslations();
  const [health, memberCount] = await Promise.all([getHealth(), getMemberCount()]);

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
