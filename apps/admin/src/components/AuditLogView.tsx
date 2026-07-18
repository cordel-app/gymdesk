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
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  previous_values: any;
  new_values: any;
  source: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

interface AuditMeta {
  entityTypes: { value: string; label: string }[];
  actions: string[];
}

const PAGE = 50;
const SOURCES = ['admin', 'employee', 'customer'];

/**
 * #66: one audit table, two scopes. 'gym' shows the active gym's events and is
 * open to gym admins; 'all' is the platform-wide view (Cordel section), guarded
 * to superadmins here and again in the API, with an extra Gym column.
 * #69: snapshot columns (actor_name, entity_name), dropdown filters, enriched display.
 */
export default function AuditLogView({ scope }: { scope: 'gym' | 'all' }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows]           = useState<AuditRow[]>([]);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [meta, setMeta]           = useState<AuditMeta>({ entityTypes: [], actions: [] });
  const [offset, setOffset]       = useState(0);
  const [entityType, setEntityType] = useState('');
  const [entityName, setEntityName] = useState('');
  const [actor, setActor]         = useState('');
  const [action, setAction]       = useState('');
  const [source, setSource]       = useState('');
  const [from, setFrom]           = useState('');
  const [to, setTo]               = useState('');
  const [expanded, setExpanded]   = useState<number | null>(null);

  const platformScope = scope === 'all';
  const canView = platformScope ? isSuperadmin : isSuperadmin || activeGym?.role === 'admin';
  useEffect(() => { if (!gymLoading && !canView) router.replace(`/${locale}`); }, [gymLoading, canView]);

  useEffect(() => {
    if (!activeGymId || !canView) return;
    apiFetch<AuditMeta>('/audit-logs/meta').then(setMeta).catch(() => {});
  }, [activeGymId, canView]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (platformScope) q.set('scope', 'all');
      if (entityType) q.set('entity_type', entityType);
      if (entityName) q.set('entity_name', entityName);
      if (actor)      q.set('actor', actor);
      if (action)     q.set('action', action);
      if (source)     q.set('source', source);
      if (from)       q.set('from', from);
      if (to)         q.set('to', to);
      q.set('limit', String(PAGE));
      q.set('offset', String(offset));
      const data = await apiFetch<{ items: AuditRow[]; total: number }>(`/audit-logs?${q}`);
      setRows(data.items); setTotal(data.total);
    } catch (err: any) { toast(err.message ?? t('audit.error_generic')); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (!gymLoading && canView) load();
  }, [activeGymId, gymLoading, canView, entityType, entityName, actor, action, source, from, to, offset]);

  function resetFilters() {
    setEntityType(''); setEntityName(''); setActor('');
    setAction(''); setSource(''); setFrom(''); setTo('');
    setOffset(0);
  }

  if (gymLoading || !canView) return null;

  const cols = platformScope ? 7 : 6;

  return (
    <div>
      <h1 style={{ margin: '0 0 16px' }}>{platformScope ? t('audit.title_platform') : t('audit.title')}</h1>

      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={labelSt}>
          {t('audit.filter_entity_type')}
          <select value={entityType} onChange={(e) => { setEntityType(e.target.value); setOffset(0); }} style={selectSt}>
            <option value="">{t('audit.filter_all')}</option>
            {meta.entityTypes.map((et) => (
              <option key={et.value} value={et.value}>{et.label}</option>
            ))}
          </select>
        </label>
        <label style={labelSt}>
          {t('audit.filter_entity_name')}
          <input value={entityName} onChange={(e) => { setEntityName(e.target.value); setOffset(0); }}
                 style={inputSt} placeholder={t('audit.filter_entity_name_placeholder')} />
        </label>
        <label style={labelSt}>
          {t('audit.filter_actor')}
          <input value={actor} onChange={(e) => { setActor(e.target.value); setOffset(0); }}
                 style={inputSt} placeholder={t('audit.filter_actor_placeholder')} />
        </label>
        <label style={labelSt}>
          {t('audit.filter_action')}
          <select value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }} style={selectSt}>
            <option value="">{t('audit.filter_all')}</option>
            {meta.actions.map((a) => (
              <option key={a} value={a}>{t(`audit.action.${a}`, { fallback: a })}</option>
            ))}
          </select>
        </label>
        <label style={labelSt}>
          {t('audit.filter_source')}
          <select value={source} onChange={(e) => { setSource(e.target.value); setOffset(0); }} style={selectSt}>
            <option value="">{t('audit.filter_all')}</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>{t(`audit.source.${s}`, { fallback: s })}</option>
            ))}
          </select>
        </label>
        <label style={labelSt}>
          {t('audit.filter_from')}
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} style={inputSt} />
        </label>
        <label style={labelSt}>
          {t('audit.filter_to')}
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} style={inputSt} />
        </label>
        <button onClick={resetFilters} style={{ ...btnStyle('#888'), alignSelf: 'flex-end' }}>
          {t('audit.filter_reset')}
        </button>
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
                    <td style={td}>{r.actor_name ?? t('audit.unknown_user')}</td>
                    <td style={td}>{t(`audit.action.${r.action}`, { fallback: r.action })}</td>
                    <td style={td}>
                      <span style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>
                        {r.entity_type}#{r.entity_id ?? '—'}
                      </span>
                      {r.entity_name && (
                        <div style={{ fontSize: 13, marginTop: 2 }}>{r.entity_name}</div>
                      )}
                    </td>
                    <td style={td}>{r.source ? t(`audit.source.${r.source}`, { fallback: r.source }) : '—'}</td>
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
                        <div style={{ marginTop: 8, fontSize: 12, color: '#666', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                          {r.ip && <span>IP: {r.ip}</span>}
                          {r.source && <span>{t('audit.col_source')}: {r.source}</span>}
                          {r.actor_user_id && <span style={{ fontFamily: 'monospace' }}>uid: {r.actor_user_id}</span>}
                        </div>
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
        <span style={{ fontSize: 13, color: '#666' }}>
          {t('audit.page_info', { start: offset + 1, end: Math.min(offset + PAGE, total), total })}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0} style={btnStyle('#888')}>‹</button>
          <button onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= total} style={btnStyle('#888')}>›</button>
        </div>
      </div>
    </div>
  );
}

const labelSt: React.CSSProperties  = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#555' };
const inputSt: React.CSSProperties  = { padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 };
const selectSt: React.CSSProperties = { padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff' };
const th: React.CSSProperties = { padding: '12px 16px', fontSize: 14, fontWeight: 600 };
const td: React.CSSProperties = { padding: '10px 16px', fontSize: 13, fontVariantNumeric: 'tabular-nums' };
const diffHead: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };
const diffCode: React.CSSProperties = { background: '#fff', padding: 8, borderRadius: 4, fontSize: 11, overflow: 'auto', maxHeight: 300, margin: 0 };
