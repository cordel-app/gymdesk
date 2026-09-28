'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { btnStyle } from '@/components/ui';
import type { CenterOption } from '@/context/CenterContext';
import { validateDocumentId } from '@/lib/documentId';
import type { MemberEditFormValues, MemberProfileFieldSpec } from './memberProfile';
import { MemberProfileLayout } from './MemberProfileLayout';

// #797: the field set itself lives in memberProfile.ts, shared with the
// read-only PROFILE section of the expanded row so the two cannot drift apart.
// #882: so does the layout — this form renders MemberProfileLayout, and what it
// adds is the control inside each cell plus the Save/Cancel pair.
export type { MemberEditFormValues };

export function MemberEditForm({
  form, error, saving,
  showCenters, centers, assignedCenterIds, defaultCenterId,
  onChange, onToggleCenter, onDefaultCenterChange,
  onSave, onCancel,
}: {
  form: MemberEditFormValues;
  error: string | null;
  saving: boolean;
  showCenters: boolean;
  centers: CenterOption[];
  assignedCenterIds: Set<number>;
  defaultCenterId: number | null;
  onChange: (form: MemberEditFormValues) => void;
  onToggleCenter: (id: number, checked: boolean) => void;
  onDefaultCenterChange: (id: number | null) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('members');
  const docCheck = validateDocumentId(form.nif_nie_passport);
  const showDocError = form.nif_nie_passport !== '' && !docCheck.valid;

  const renderField = (field: MemberProfileFieldSpec) => {
    const placeholder = field.placeholderKey ? t(field.placeholderKey) : undefined;
    const value = form[field.key];
    const update = (next: string) => onChange({ ...form, [field.key]: next });

    if (field.kind === 'multiline') {
      return (
        <textarea
          style={{ ...inlineInputStyle, height: 70, resize: 'vertical' }}
          value={value}
          onChange={(e) => update(e.target.value)}
          placeholder={placeholder}
        />
      );
    }

    return (
      <>
        <input
          type={field.kind === 'date' ? 'date' : undefined}
          style={inlineInputStyle}
          value={value}
          onChange={(e) => update(e.target.value)}
          placeholder={placeholder}
          autoFocus={field.key === 'name'}
        />
        {field.key === 'nif_nie_passport' && showDocError ? (
          <p style={fieldErrorStyle}>{t('error_document_invalid')}</p>
        ) : field.helpKey ? (
          <p style={helpTextStyle}>{t(field.helpKey)}</p>
        ) : null}
      </>
    );
  };

  return (
    <div style={panel}>
      <div style={sectionLabelStyle}>{t('section_profile')}</div>

      <MemberProfileLayout
        fieldLabel={(field) => t(field.editLabelKey)}
        renderField={renderField}
        centers={
          showCenters
            ? {
                assignedLabel: t('assigned_centers'),
                assigned: (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 140, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6, padding: 10, background: '#fff' }}>
                    {centers.map((c) => (
                      <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                        <input
                          type="checkbox"
                          checked={assignedCenterIds.has(c.id)}
                          onChange={(e) => onToggleCenter(c.id, e.target.checked)}
                        />
                        {c.name}
                      </label>
                    ))}
                  </div>
                ),
                defaultLabel: t('default_center'),
                default: (
                  <select
                    style={inlineInputStyle}
                    value={defaultCenterId ?? ''}
                    onChange={(e) => onDefaultCenterChange(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">{t('default_center_none')}</option>
                    {centers.filter((c) => assignedCenterIds.has(c.id)).map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                ),
              }
            : null
        }
      />

      {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16, paddingTop: 14, borderTop: '1px solid #ececf0' }}>
        <button onClick={onCancel} style={cancelBtnStyle} disabled={saving}>{t('cancel')}</button>
        <button onClick={onSave} style={btnStyle()} disabled={saving || showDocError}>
          {saving ? t('saving') : t('save_changes')}
        </button>
      </div>
    </div>
  );
}

const panel: React.CSSProperties = { padding: '16px 24px', background: '#f4f4fb', borderBottom: '1px solid #e4e4f0' };
const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase',
  letterSpacing: '0.07em', marginBottom: 10,
};
// #882: the field labels are the layout's, so the two modes cannot place or
// style the same field differently — only the control below it differs.
const inlineInputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', background: '#fff' };
const helpTextStyle: React.CSSProperties = { margin: '4px 0 0', fontSize: 12, color: '#888' };
const fieldErrorStyle: React.CSSProperties = { margin: '4px 0 0', fontSize: 12, color: '#c0392b' };
const cancelBtnStyle: React.CSSProperties = { background: '#fff', color: '#444', border: '1px solid #ddd', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
