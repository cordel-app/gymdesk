'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ViewAuditLogButton, AuditLogScope } from '@/components/ViewAuditLogButton';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { NutritionLibraryItemRow, displayValue, formatTimestamp } from './nutritionItemProfile';

/**
 * #799 §9–§14, §23: `⋮ → Details` for a Nutrition Library item — the item's name,
 * its description and its complete audit information, plus the shared View Audit
 * Log deep link. Read-only: no input, no Save, no Edit action.
 *
 * It renders the list row it was handed rather than fetching a detail endpoint of
 * its own: `description` and the three actor pairs (migration 196) come back with
 * the row, so there is no second Nutrition Library model to keep in step (§25).
 *
 * The audit columns are snapshots taken at write time, not a join, because the
 * actor who administers a base food is a superadmin with no `gym_memberships`
 * row — see migration 196. Rows written before it carry no name and render the
 * em dash; the Audit Log link is what covers their history.
 *
 * Two values are legitimately empty here rather than missing. A system food read
 * from a gym has its actor names masked by `GET /nutrition-library` (they are
 * Cordel employees'), and a gym-owned food has no delete route at all, so its
 * Deleted At / Deleted By are always the em dash on that side — the modal serves
 * both libraries and states the same fields for each.
 *
 * One component serves both libraries; `scope` is what decides which Audit Log
 * it opens ('platform' for Cordel → Base Nutrition Library).
 */
export function NutritionItemDetailsModal({ item, scope = 'gym', onClose }: {
  item: NutritionLibraryItemRow;
  scope?: AuditLogScope;
  onClose: () => void;
}) {
  const t = useTranslations('nutrition_library');

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 520, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 20px' }}>{t('details')}</h2>

        {/* The full value, never the truncated one the list header may show (§10, §11). */}
        <Field label={t('label_name')} value={displayValue(item.display_name || item.name)} />
        <Field label={t('label_description')} value={displayValue(item.description)} wrap />

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid var(--card-border, #f0f0f0)' }}>
          <p style={sectionLabelStyle}>{t('section_audit')}</p>
          <Field label={t('created_at')} value={formatTimestamp(item.created_at)} />
          <Field label={t('created_by')} value={displayValue(item.created_by_name)} />
          <Field label={t('modified_at')} value={formatTimestamp(item.modified_at)} />
          <Field label={t('modified_by')} value={displayValue(item.modified_by_name)} />
          {/* An item that was never deleted still shows both rows, with the same
              empty-value convention every other Details modal uses (§13). */}
          <Field label={t('deleted_at')} value={formatTimestamp(item.deleted_at)} />
          <Field label={t('deleted_by')} value={displayValue(item.deleted_by_name)} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          {/* #675: the shared deep link, filtered to this item — never a hand-rolled one. */}
          <ViewAuditLogButton entityType="nutrition_library_item" entityId={item.id} scope={scope} onNavigate={onClose} />
          <button type="button" onClick={onClose} style={btnStyle('#444')}>{t('close')}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, wrap }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--card-border, #f5f5f5)' }}>
      <span style={{ width: 150, flexShrink: 0, fontSize: 13, color: 'var(--text-muted, #888)', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--gd-text, #333)', ...(wrap ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } : {}) }}>
        {value}
      </span>
    </div>
  );
}

const sectionLabelStyle: React.CSSProperties = {
  margin: '0 0 4px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted, #aaa)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
};
