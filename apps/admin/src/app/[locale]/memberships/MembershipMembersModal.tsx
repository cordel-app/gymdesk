'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';

interface Membership {
  id: number;
  member_name: string;
  plan_name: string | null;
}

interface CoveredMember {
  member_id: number;
  is_owner: boolean;
  name: string;
  email: string;
}

interface MemberOption { id: number; name: string; email: string }

export function MembershipMembersModal({
  membership, canWrite, allMembers, onClose,
}: {
  membership: Membership;
  canWrite: boolean;
  allMembers: MemberOption[];
  onClose: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [members, setMembers] = useState<CoveredMember[]>([]);
  const [memberLimit, setMemberLimit] = useState<'1' | '2' | 'family'>('1');
  const [loading, setLoading] = useState(true);
  const [addingId, setAddingId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch<{ member_limit: '1' | '2' | 'family'; members: CoveredMember[] }>(
        `/user-memberships/${membership.id}/members`,
      );
      setMembers(res.members);
      setMemberLimit(res.member_limit);
    } catch (err: any) {
      toast(err.message ?? t('memberships.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [membership.id]);

  const limitCount = memberLimit === 'family' ? Infinity : parseInt(memberLimit, 10);
  const atLimit = members.length >= limitCount;
  const availableMembers = allMembers.filter((m) => !members.some((cm) => cm.member_id === m.id));

  async function handleAdd() {
    if (!addingId) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/user-memberships/${membership.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ member_id: parseInt(addingId, 10) }),
      });
      setAddingId('');
      load();
    } catch (err: any) {
      setError(err.message ?? t('memberships.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(memberId: number) {
    try {
      await apiFetch(`/user-memberships/${membership.id}/members/${memberId}`, { method: 'DELETE' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('memberships.error_generic'));
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 480 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('memberships.members_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>
          {membership.member_name}{membership.plan_name ? ` — ${membership.plan_name}` : ''}
        </p>

        {loading ? (
          <p style={{ color: '#666' }}>{t('memberships.loading')}</p>
        ) : (
          <>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#666' }}>
              {t('memberships.members_limit_hint', { limit: t(`plans.member_limit_${memberLimit}`) })}
            </p>
            <div style={{ border: '1px solid #eee', borderRadius: 6 }}>
              {members.map((m) => (
                <div
                  key={m.member_id}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid #f0f0f0' }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>
                      {m.name}
                      {m.is_owner && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: '#6c63ff', fontWeight: 600 }}>
                          {t('memberships.owner_badge')}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#888' }}>{m.email}</div>
                  </div>
                  {canWrite && !m.is_owner && (
                    <button onClick={() => handleRemove(m.member_id)} style={btnSmall('#c0392b')}>{t('memberships.remove')}</button>
                  )}
                </div>
              ))}
            </div>

            {canWrite && (
              <div style={{ marginTop: 16 }}>
                {atLimit ? (
                  <p style={{ fontSize: 13, color: '#b26a00' }}>{t('memberships.members_limit_reached')}</p>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select
                      value={addingId}
                      onChange={(e) => setAddingId(e.target.value)}
                      style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff' }}
                    >
                      <option value="">{t('memberships.pick_member')}</option>
                      {availableMembers.map((m) => (
                        <option key={m.id} value={m.id}>{m.name} — {m.email}</option>
                      ))}
                    </select>
                    <button onClick={handleAdd} disabled={!addingId || saving} style={btnStyle('#6c63ff')}>
                      {saving ? t('memberships.saving') : t('memberships.add_member')}
                    </button>
                  </div>
                )}
                {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('memberships.close')}</button>
        </div>
      </div>
    </div>
  );
}
