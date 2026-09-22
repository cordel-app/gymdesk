'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useFeatureFlags } from '@/context/FeatureFlagsContext';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

interface MemberDetail {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  date_of_birth: string | null;
  gender: string | null;
  address: string | null;
  emergency_contact: string | null;
  notes: string | null;
  nif_nie_passport: string | null;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
}

export function MemberDetailModal({ memberId, memberName, onClose }: {
  memberId: number;
  memberName: string;
  onClose: () => void;
}) {
  const t = useTranslations('members');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGym, isSuperadmin } = useGym();
  const { flags } = useFeatureFlags();
  const [detail, setDetail] = useState<MemberDetail | null>(null);

  useEffect(() => {
    apiFetch<MemberDetail>(`/members/${memberId}`)
      .then(setDetail)
      .catch(() => {});
  }, [memberId]);

  // Configuration → Audit Log is admin-only (guarded again in AuditLogView and the API),
  // and hidden when its feature flag is off — same rule the sidebar applies.
  const auditEnabled = isSuperadmin || (flags['system'] !== false && flags['system.audit'] !== false);
  const canViewAudit = (isSuperadmin || activeGym?.role === 'admin') && auditEnabled;

  /**
   * #642: close first, then deep-link to the Audit Log already filtered to this
   * member by entity id — never by name, which is neither unique nor stable.
   */
  function openAuditLog() {
    onClose();
    router.push(`/${locale}/audit?entity_type=member&entity_id=${memberId}`);
  }

  const field = (label: string, value: string | null | undefined) => (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5' }}>
      <span style={{ width: 180, flexShrink: 0, fontSize: 13, color: '#888', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#333' }}>{value || '—'}</span>
    </div>
  );

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 540, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('detail_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{memberName}</p>

        {!detail ? (
          <p style={{ color: '#888', fontSize: 13 }}>{t('expanded_loading')}</p>
        ) : (
          <>
            <p style={sectionLabel}>{t('section_profile')}</p>
            {field(t('col_name'), detail.name)}
            {field(t('label_email'), detail.email)}
            {field(t('label_phone'), detail.phone)}
            {field(t('label_date_of_birth'), detail.date_of_birth?.slice(0, 10) ?? null)}
            {field(t('label_gender'), detail.gender)}
            {field(t('label_address'), detail.address)}
            {field(t('label_emergency_contact'), detail.emergency_contact)}
            {field(t('label_document'), detail.nif_nie_passport)}
            {field(t('label_notes'), detail.notes)}

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid #f0f0f0' }}>
              <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('col_audit')}</p>
              {field(t('col_created_by'), detail.created_by_name)}
              {field(t('col_created_at'), detail.created_at?.slice(0, 10))}
              {field(t('col_modified_by'), detail.modified_by_name)}
              {field(t('col_modified_at'), detail.modified_at?.slice(0, 10) ?? null)}
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          {canViewAudit && (
            <button onClick={openAuditLog} style={btnStyle()}>{t('action_view_audit_log')}</button>
          )}
          <button onClick={onClose} style={btnStyle('#444')}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  margin: '0 0 4px',
  fontSize: 11,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};
