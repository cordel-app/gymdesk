'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface Notification {
  id: number;
  type: string;
  entity_type: 'session' | null;
  entity_id: number | null;
  payload: { title?: string; starts_at?: string; [key: string]: unknown } | null;
  read_at: string | null;
  created_at: string;
}

function timeAgo(iso: string, locale: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default function NotificationsPage() {
  const t = useTranslations('notifications');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading, refreshUnreadCount } = useApp();

  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<{ items: Notification[]; unread: number }>('/me/notifications');
      setItems(data.items);
      setUnread(data.unread);
    } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    load();
  }, [appLoading, isLinked, locale]);

  async function markAllRead() {
    setMarking(true);
    try {
      await apiFetch('/me/notifications/read-all', { method: 'PUT' });
      setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
      setUnread(0);
      refreshUnreadCount();
    } catch {}
    finally { setMarking(false); }
  }

  async function markRead(id: number) {
    try {
      await apiFetch(`/me/notifications/${id}/read`, { method: 'PUT' });
      setItems((prev) => prev.map((n) => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
      setUnread((c) => Math.max(0, c - 1));
      refreshUnreadCount();
    } catch {}
  }

  function typeLabel(type: string): string {
    const key = `type_${type}` as any;
    try { return t(key); } catch { return type; }
  }

  return (
    <main style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>{t('title')}</h1>
        {unread > 0 && (
          <button style={styles.markAllBtn} onClick={markAllRead} disabled={marking}>
            {t('mark_all_read')}
          </button>
        )}
      </div>

      {loading ? (
        <p style={styles.hint}>{t('loading')}</p>
      ) : items.length === 0 ? (
        <p style={styles.hint}>{t('empty')}</p>
      ) : (
        <ul style={styles.list}>
          {items.map((n) => (
            <li
              key={n.id}
              style={{ ...styles.item, background: n.read_at ? '#fff' : '#f0f4ff' }}
              onClick={() => !n.read_at && markRead(n.id)}
            >
              <div style={styles.itemTop}>
                <span style={styles.typeLabel}>{typeLabel(n.type)}</span>
                <span style={styles.timeLabel}>{timeAgo(n.created_at, locale)}</span>
              </div>
              {n.payload?.title && (
                <div style={styles.title2}>{n.payload.title}</div>
              )}
              {n.payload?.starts_at && (
                <div style={styles.sub}>
                  {new Date(n.payload.starts_at).toLocaleString(locale, {
                    weekday: 'short', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </div>
              )}
              {!n.read_at && <div style={styles.unreadDot} />}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, maxWidth: 720, margin: '0 auto', paddingBottom: 80 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  title: { margin: 0, fontSize: 22, fontWeight: 700, color: '#18181b' },
  markAllBtn: {
    padding: '6px 12px', background: 'transparent', color: '#18181b',
    border: '1px solid #d4d4d8', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
  },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  item: {
    position: 'relative', borderRadius: 10, padding: '12px 14px', marginBottom: 8,
    cursor: 'pointer', transition: 'background 0.15s',
  },
  itemTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  typeLabel: { fontSize: 12, fontWeight: 600, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.04em' },
  timeLabel: { fontSize: 12, color: '#9ca3af' },
  title2: { fontSize: 15, fontWeight: 600, color: '#18181b' },
  sub: { fontSize: 13, color: '#71717a', marginTop: 2 },
  unreadDot: {
    position: 'absolute', top: 12, right: 12, width: 8, height: 8,
    borderRadius: '50%', background: '#6366f1',
  },
  hint: { color: '#71717a', fontSize: 14, textAlign: 'center', margin: '40px 0' },
};
