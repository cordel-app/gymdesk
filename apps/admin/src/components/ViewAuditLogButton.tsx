'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useGym } from '@/context/GymContext';
import { useFeatureFlags } from '@/context/FeatureFlagsContext';
import { btnStyle, btnSmall } from './ui';

/**
 * #675: "View Audit Log" is offered from every entity's Details view, deep-linking
 * to the Audit Log already filtered to that record. The pattern was introduced for
 * Members in #642 (MemberDetailModal) and lives here so every Details view shares
 * one implementation — permission rule, entity-type vocabulary and URL shape alike.
 *
 * `entityType` must be the canonical key the audit system writes
 * (`recordAudit({ entityType })` / AUDIT_ENTITY_REGISTRY in the API), never a
 * display name, and `entityId` the record's own primary key.
 *
 * Two scopes, matching the two Audit Log pages:
 *  - 'gym'      → Configuration → Audit Log (`/audit`), the active gym's events.
 *  - 'platform' → Cordel → Audit Log (`/cordel/audit`), superadmin-only, for
 *                 entities administered outside a single gym (gyms, base themes,
 *                 the platform nutrition library).
 */
export type AuditLogScope = 'gym' | 'platform';

export function useAuditLogLink(scope: AuditLogScope = 'gym') {
  const locale = useLocale();
  const router = useRouter();
  const { activeGym, isSuperadmin } = useGym();
  const { flags } = useFeatureFlags();

  // Configuration → Audit Log is admin-only (guarded again in AuditLogView and the
  // API), and hidden when its feature flag is off — same rule the sidebar applies.
  // The platform log is superadmin-only and not feature-flagged.
  const auditEnabled = isSuperadmin || (flags['system'] !== false && flags['system.audit'] !== false);
  const canViewAuditLog = scope === 'platform'
    ? isSuperadmin
    : (isSuperadmin || activeGym?.role === 'admin') && auditEnabled;

  /**
   * Navigate to the Audit Log filtered to one record. `onNavigate` runs first so a
   * Details modal can close itself before the route changes.
   */
  function openAuditLog(entityType: string, entityId: string | number, onNavigate?: () => void) {
    onNavigate?.();
    const q = new URLSearchParams({ entity_type: entityType, entity_id: String(entityId) });
    router.push(`/${locale}/${scope === 'platform' ? 'cordel/audit' : 'audit'}?${q}`);
  }

  return { canViewAuditLog, openAuditLog };
}

export function ViewAuditLogButton({
  entityType,
  entityId,
  onNavigate,
  scope = 'gym',
  color,
  size = 'default',
}: {
  entityType: string;
  entityId: string | number | null | undefined;
  /** Called before navigating — typically the Details modal's own onClose. */
  onNavigate?: () => void;
  scope?: AuditLogScope;
  color?: string;
  /** 'small' matches the inline controls of an expanded row; 'default' a modal footer. */
  size?: 'default' | 'small';
}) {
  const t = useTranslations('common');
  const { canViewAuditLog, openAuditLog } = useAuditLogLink(scope);

  if (!canViewAuditLog || entityId == null || entityId === '') return null;

  return (
    <button
      type="button"
      onClick={() => openAuditLog(entityType, entityId, onNavigate)}
      style={size === 'small' ? btnSmall(color) : btnStyle(color)}
    >
      {t('action_view_audit_log')}
    </button>
  );
}
