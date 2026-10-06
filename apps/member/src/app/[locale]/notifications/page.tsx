'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';
import { memberTheme, secondaryButtonStyle, sectionCardStyle } from '@/lib/memberChrome';

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

/**
 * #979: the notification types that carry a second explanatory line
 * (`notifications.detail_<type>`). It is a declared list rather than a `t()`
 * fallback because next-intl has no `defaultValue` option and prints a missing
 * key verbatim (CLAUDE.md), so asking for a detail line every type does not
 * have would render `notifications.detail_booking_confirmed` on screen.
 *
 * `event_reactivated` needs one: the type label alone says the class is back,
 * and the member also has to be told their own booking still stands rather
 * than wondering whether they must book again (#979 section 6).
 *
 * #980 stage 2's two need one for the same reason, and they are two types
 * rather than one because they are two different promises: `waitlist_closed`
 * says the list itself is gone, so there is nothing to rejoin, while
 * `waitlist_removed` says this member was taken off a list that is still open
 * and can be joined again. A member told the wrong one of those either gives
 * up a place they could still have, or waits for a queue that no longer
 * exists.
 */
// #1113 §2: `booking_reminder_2h` joins them — the type label is the heading
// (*Training reminder*) and the detail is the sentence that carries the two
// hours, with the occurrence's name and its start time already rendered below
// from the payload. Both halves are locale keys, because next-intl prints a
// missing key verbatim and a `t()` fallback is not one (CLAUDE.md).
const DETAIL_TYPES = ['event_reactivated', 'waitlist_closed', 'waitlist_removed', 'booking_reminder_2h'];

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
              style={{ ...styles.item, ...(n.read_at ? null : styles.itemUnread) }}
              onClick={() => !n.read_at && markRead(n.id)}
            >
              <div style={styles.itemTop}>
                <span style={styles.typeLabel}>{typeLabel(n.type)}</span>
                <span style={styles.timeLabel}>{timeAgo(n.created_at, locale)}</span>
              </div>
              {n.payload?.title && (
                <div style={styles.title2}>{n.payload.title}</div>
              )}
              {DETAIL_TYPES.includes(n.type) && (
                <div style={styles.sub}>{t(`detail_${n.type}` as any)}</div>
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
  title: { margin: 0, fontSize: 22, fontWeight: 700, color: memberTheme.title1 },
  markAllBtn: {
    ...secondaryButtonStyle,
    padding: '6px 12px', fontSize: 13, fontWeight: 500,
  },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  item: {
    ...sectionCardStyle,
    position: 'relative', borderRadius: 10, padding: '12px 14px', marginBottom: 8,
    cursor: 'pointer', transition: 'background 0.15s',
  },
  // An unread alert is tinted with the theme's own accent rather than a fixed
  // lilac wash: the same `color-mix` the status pills use (#983).
  itemUnread: { background: `color-mix(in srgb, ${memberTheme.primaryButton} 8%, ${memberTheme.surface})` },
  itemTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  typeLabel: { fontSize: 12, fontWeight: 600, color: memberTheme.primaryButton, textTransform: 'uppercase', letterSpacing: '0.04em' },
  timeLabel: { fontSize: 12, color: memberTheme.textMuted },
  title2: { fontSize: 15, fontWeight: 600, color: memberTheme.text },
  sub: { fontSize: 13, color: memberTheme.textMuted, marginTop: 2 },
  unreadDot: {
    position: 'absolute', top: 12, right: 12, width: 8, height: 8,
    borderRadius: '50%', background: memberTheme.primaryButton,
  },
  hint: { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '40px 0' },
};
