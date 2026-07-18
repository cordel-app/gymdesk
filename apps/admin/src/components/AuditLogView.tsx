'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { btnStyle } from '@/components/ui';

interface AuditRow {
  id: number;
  gym_name: string | null;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  previous_values: any;
  new_values: any;
  source: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

const PAGE = 50;

/**
 * #66: one audit table, two scopes. 'gym' shows the active gym's events and is
 * open to gym admins; 'all' is the platform-wide view (Cordel section), guarded
 * to superadmins here and again in the API, with an extra Gym column.
 */
export default function AuditLogView({ scope }: { scope: 'gym' | 'all' }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [entityType, setEntityType] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const platformScope = scope === 'all';
  const canView = platformScope ? isSuperadmin : isSuperadmin || activeGym?.role === 'admin';
  useEffect(() => { if (!gymLoading && !canView) router.replace(`/${locale}`); }, [gymLoading, canView]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (platformScope) q.set('scope', 'all');
      if (entityType) q.set('entity_type', entityType);
      if (actorUserId) q.set('actor_user_id', actorUserId);
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      q.set('limit', String(PAGE));
      q.set('offset', String(offset));
      const data = await apiFetch<{ items: AuditRow[]; total: number }>(`/audit-logs?${q}`);
      setRows(data.items); setTotal(data.total);
    } catch (err: any) { toast(err.message ?? t('audit.error_generic')); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (!gymLoading && canView) load(); }, [activeGymId, gymLoading, canView, entityType, actorUserId, from, to, offset]);

  if (gymLoading || !canView) return null;

  const cols = platformScope ? 7 : 6;

  return (
    <div>
      <h1 style={{ margin: '0 0 16px' }}>{platformScope ? t('audit.title_platform') : t('audit.title')}</h1>

      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <label style={label}>{t('audit.filter_entity')}
          <input value={entityType} onChange={(e) => { setEntityType(e.target.value); setOffset(0); }}
                 style={input} placeholder="member, user_membership…" />
        </label>
        <label style={label}>{t('audit.filter_actor')}
          <input value={actorUserId} onChange={(e) => { setActorUserId(e.target.value); setOffset(0); }}
                 style={input} placeholder="user_..." />
        </label>
        <label style={label}>{t('audit.filter_from')}
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} style={input} />
        </label>
        <label style={label}>{t('audit.filter_to')}
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} style={input} />
        </label>
      </div>

      {loading ? <p>{t('audit.loading')}</p> : rows.length === 0 ? <p>{t('audit.empty')}</p> : (
        <div style={{ background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
                <th style={th}>{t('audit.col_when')}</th>
                {platformScope && <th style={th}>{t('audit.col_gym')}</th>}
                <th style={th}>{t('audit.col_actor')}</th>
                <th style={th}>{t('audit.col_action')}</th>
                <th style={th}>{t('audit.col_entity')}</th>
                <th style={th}>{t('audit.col_source')}</th>
                <th style={{ ...th, width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <>
                  <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
                    <td style={td}>{r.created_at.slice(0, 19).replace('T', ' ')}</td>
                    {platformScope && <td style={td}>{r.gym_name ?? '—'}</td>}
                    <td style={td}>{r.actor_user_id?.slice(0, 12) ?? '—'}…</td>
                    <td style={td}>{r.action}</td>
                    <td style={td}>{r.entity_type}#{r.entity_id ?? '—'}</td>
                    <td style={td}>{r.source ?? '—'}</td>
                    <td style={td}>
                      <button onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                              style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>
                        {expanded === r.id ? '−' : '+'}
                      </button>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr>
                      <td colSpan={cols} style={{ padding: 12, background: '#fafafa' }}>
                        <div style={{ display: 'flex', gap: 12 }}>
                          <div style={{ flex: 1 }}>
                            <div style={diffHead}>{t('audit.previous')}</div>
                            <pre style={diffCode}>{JSON.stringify(r.previous_values ?? null, null, 2)}</pre>
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={diffHead}>{t('audit.next')}</div>
                            <pre style={diffCode}>{JSON.stringify(r.new_values ?? null, null, 2)}</pre>
                          </div>
                        </div>
                        {r.ip && <div style={{ fontSize: 12, color: '#666', marginTop: 8 }}>IP: {r.ip}</div>}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: '#666' }}>{t('audit.page_info', { start: offset + 1, end: Math.min(offset + PAGE, total), total })}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0} style={btnStyle('#888')}>‹</button>
          <button onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= total} style={btnStyle('#888')}>›</button>
        </div>
      </div>
    </div>
  );
}

const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#555' };
const input: React.CSSProperties = { padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 };
const th: React.CSSProperties = { padding: '12px 16px', fontSize: 14, fontWeight: 600 };
const td: React.CSSProperties = { padding: '10px 16px', fontSize: 13, fontVariantNumeric: 'tabular-nums' };
const diffHead: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };
const diffCode: React.CSSProperties = { background: '#fff', padding: 8, borderRadius: 4, fontSize: 11, overflow: 'auto', maxHeight: 300, margin: 0 };
