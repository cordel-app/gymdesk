'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { ImpersonationBanner } from './ImpersonationBanner';
import { MemberImpersonationDialog } from './MemberImpersonationDialog';

export function AdminBar() {
  const t = useTranslations('impersonation');
  const { isSuperadmin } = useApp();
  const { isImpersonating } = useImpersonation();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Only render anything for superadmins
  if (!isSuperadmin) return null;

  if (isImpersonating) {
    return <ImpersonationBanner />;
  }

  return (
    <>
      <div style={{
        background: '#1e293b',
        color: '#fff',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
        fontSize: 13,
      }}>
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>Support mode</span>
        <button
          onClick={() => setDialogOpen(true)}
          style={{
            padding: '4px 12px', fontSize: 12, fontWeight: 600, borderRadius: 4, cursor: 'pointer',
            background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.3)',
            color: '#fff',
          }}
        >
          {t('button_impersonate')}
        </button>
      </div>
      {dialogOpen && <MemberImpersonationDialog onClose={() => setDialogOpen(false)} />}
    </>
  );
}
