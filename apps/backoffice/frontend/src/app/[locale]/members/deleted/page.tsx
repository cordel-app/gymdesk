'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';

interface Member {
  id: number;
  name: string;
  email: string;
  phone: string | null;
}

export default function DeletedMembersPage() {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { activeGymId, loading: gymLoading } = useGym();
  const [deleted, setDeleted] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    if (!activeGymId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<Member[]>('/members/deleted');
      setDeleted(data);
    } catch {
      setDeleted([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  async function handleRestore(id: number) {
    try {
      await apiFetch(`/members/${id}/restore`, { method: 'POST' });
      load();
    } catch (err: any) {
      alert(err.message);
    }
  }

  return (
    <div>
      <h1 style={{ margin: '0 0 24px' }}>{t('deleted_members.title')}</h1>

      {loading ? (
        <p style={{ color: '#666' }}>{t('deleted_members.loading')}</p>
      ) : deleted.length === 0 ? (
        <p style={{ color: '#666' }}>{t('deleted_members.empty')}</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
              <th style={th}>{t('members.col_name')}</th>
              <th style={th}>{t('members.col_email')}</th>
              <th style={th}>{t('members.col_phone')}</th>
              <th style={{ ...th, width: 100 }}>{t('members.col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {deleted.map((m) => (
              <tr key={m.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ ...td, color: '#999', textDecoration: 'line-through' }}>{m.name}</td>
                <td style={{ ...td, color: '#999', textDecoration: 'line-through' }}>{m.email}</td>
                <td style={{ ...td, color: '#999' }}>{m.phone ?? '—'}</td>
                <td style={td}>
                  <button onClick={() => handleRestore(m.id)} style={btnRestore}>{t('deleted_members.restore')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' };
const th: React.CSSProperties = { padding: '12px 16px', fontWeight: 600, fontSize: 15 };
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 15 };
const btnRestore: React.CSSProperties = { background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: 13 };
