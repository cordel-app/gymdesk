'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { profileValueStyle } from './MemberProfileLayout';

/** #2422: the server's `GET /members/:id/centers/effective-access`. */
export interface EffectiveCenterAccess {
  all: boolean;
  online: boolean;
  default_center: { granted: true; center: { id: number; name: string } | null } | null;
  specific_centers: { id: number; name: string }[];
}

/** The entries to draw, in order; empty when the Member has no access at all. */
export type CenterAccessEntry =
  | { kind: 'all' }
  | { kind: 'default'; name: string | null }
  | { kind: 'specific'; names: string[] }
  | { kind: 'online' };

/** Pure: shapes the server's resolved access into display entries (no access rules here). */
export function centerAccessEntries(a: EffectiveCenterAccess): CenterAccessEntry[] {
  const out: CenterAccessEntry[] = [];
  if (a.all) out.push({ kind: 'all' });
  else {
    if (a.default_center) out.push({ kind: 'default', name: a.default_center.center?.name ?? null });
    if (a.specific_centers.length > 0) out.push({ kind: 'specific', names: a.specific_centers.map((c) => c.name) });
  }
  if (a.online) out.push({ kind: 'online' });
  return out;
}

/** Read-only effective center access, derived on every read from the Member's live plans. */
export function MemberCenterAccess({ memberId, refreshKey }: { memberId: number | string; refreshKey?: unknown }) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const [entries, setEntries] = useState<CenterAccessEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    apiFetch<EffectiveCenterAccess>(`/members/${memberId}/centers/effective-access`)
      .then((a) => { if (live) setEntries(centerAccessEntries(a)); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [memberId, refreshKey]);

  if (failed) return <p style={profileValueStyle}>{t('center_access_error')}</p>;
  if (!entries) return null;
  if (entries.length === 0) return <p style={profileValueStyle} data-testid="center-access-none">{t('center_access_none')}</p>;
  return (
    <div data-testid="center-access" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {entries.map((e) => (
        <div key={e.kind}>
          {e.kind === 'all' && <p style={profileValueStyle}>{t('center_access_all')}</p>}
          {e.kind === 'online' && <p style={profileValueStyle}>{t('center_access_online')}</p>}
          {e.kind === 'default' && (
            <>
              <p style={profileValueStyle}>{t('center_access_default')}</p>
              <p style={profileValueStyle}>{e.name ?? t('center_access_default_none')}</p>
            </>
          )}
          {e.kind === 'specific' && (
            <>
              <p style={profileValueStyle}>{t('center_access_specific')}</p>
              <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                {e.names.map((n) => <li key={n} style={profileValueStyle}>{n}</li>)}
              </ul>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
