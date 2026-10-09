'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { primaryBtnStyle } from '@/components/ui';
import {
  cardSectionLabelStyle,
  formActionsRowStyle,
  formCheckboxLabelStyle,
  formControlStyle,
  formErrorStyle,
  formFieldErrorStyle,
  formHelpTextStyle,
  innerCardStyle,
  secondaryBtnStyle,
} from '@/components/formChrome';
import type { CenterOption } from '@/context/CenterContext';
import { validateDocumentId } from '@/lib/documentId';
import {
  MEMBER_GENDER_OPTIONS,
  memberGenderLabelKey,
  newMemberAnnounceKey,
  newMemberValueKey,
  type MemberEditableFieldSpec,
  type MemberEditFormValues,
} from './memberProfile';
import { MemberProfileLayout, NewMemberValue } from './MemberProfileLayout';

// #797: the field set itself lives in memberProfile.ts, shared with the
// read-only PROFILE section of the expanded row so the two cannot drift apart.
// #882: so does the layout — this form renders MemberProfileLayout, and what it
// adds is the control inside each cell plus the Save/Cancel pair.
// #929: and the chrome is the app's (`components/formChrome.ts`) — the section
// header, the card the fields sit in, the control box, the help and error lines
// and the secondary button are the same objects the read-only card uses, so the
// two modes are one card with the values swapped for inputs. Save is a primary
// action and takes the Theme's primary-button colours (#912), not `btnStyle()`'s
// `--brand`, which is the sidebar's selected-item colour.
export type { MemberEditFormValues };

export function MemberEditForm({
  form, isNewMember, error, saving,
  showCenters, centers, assignedCenterIds, defaultCenterId,
  onChange, onToggleCenter, onDefaultCenterChange,
  onSave, onCancel,
}: {
  form: MemberEditFormValues;
  /**
   * #927 §4/§5 — the Member's calculated `New Member` status, shown here
   * exactly as the read-only Profile shows it. It is not form state: there is
   * no value to change, so it is never submitted and the `PUT` is untouched.
   */
  isNewMember: boolean;
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

  const renderField = (field: MemberEditableFieldSpec) => {
    const placeholder = field.placeholderKey ? t(field.placeholderKey) : undefined;
    const value = form[field.key];
    const update = (next: string) => onChange({ ...form, [field.key]: next });

    if (field.kind === 'multiline') {
      return (
        <textarea
          style={{ ...formControlStyle, height: 70, resize: 'vertical' }}
          value={value}
          onChange={(e) => update(e.target.value)}
          placeholder={placeholder}
        />
      );
    }

    if (field.kind === 'gender') {
      const legacy = value && !(MEMBER_GENDER_OPTIONS as readonly string[]).includes(value) ? value : null;
      return (
        <select style={formControlStyle} value={value} onChange={(e) => update(e.target.value)}>
          <option value="">—</option>
          {MEMBER_GENDER_OPTIONS.map((g) => (
            <option key={g} value={g}>{t(memberGenderLabelKey(g)!)}</option>
          ))}
          {legacy && <option value={legacy}>{legacy}</option>}
        </select>
      );
    }

    return (
      <>
        <input
          type={field.kind === 'date' ? 'date' : undefined}
          style={formControlStyle}
          value={value}
          onChange={(e) => update(e.target.value)}
          placeholder={placeholder}
          autoFocus={field.key === 'name'}
        />
        {field.key === 'nif_nie_passport' && showDocError ? (
          <p style={formFieldErrorStyle}>{t('error_document_invalid')}</p>
        ) : field.helpKey ? (
          <p style={formHelpTextStyle}>{t(field.helpKey)}</p>
        ) : null}
      </>
    );
  };

  return (
    <div style={panel}>
      <div style={cardSectionLabelStyle}>{t('section_profile')}</div>

      {/* The same card the read-only PROFILE section renders in, so switching
          modes swaps the controls and moves nothing else (#929 §3). */}
      <div style={innerCardStyle}>
        <MemberProfileLayout
          fieldLabel={(field) => t(field.editLabelKey)}
          renderField={renderField}
          renderCalculated={() => (
            <NewMemberValue
              isNewMember={isNewMember}
              label={t(newMemberValueKey(isNewMember))}
              announce={t(newMemberAnnounceKey(isNewMember))}
            />
          )}
          centers={
            showCenters
              ? {
                  assignedLabel: t('assigned_centers'),
                  assigned: (
                    <div style={centerListStyle}>
                      {centers.map((c) => (
                        <label key={c.id} style={formCheckboxLabelStyle}>
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
                      style={formControlStyle}
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

        {error && <p style={formErrorStyle}>{error}</p>}

        <div style={formActionsRowStyle}>
          <button onClick={onCancel} style={secondaryBtnStyle} disabled={saving}>{t('cancel')}</button>
          <button onClick={onSave} style={primaryBtnStyle()} disabled={saving || showDocError}>
            {saving ? t('saving') : t('save_changes')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The expanded body's own inset — the read-only half's `panel`, with no bottom
 * padding: the first section below supplies its own, so the two panels do not
 * stack two insets into one gap.
 */
const panel: React.CSSProperties = { padding: '16px 24px 0' };

/** The Assigned Centers checkbox list: scrolls rather than growing the card. */
const centerListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  maxHeight: 140,
  overflowY: 'auto',
  border: '1px solid var(--gd-input-border, #d1d5db)',
  borderRadius: 6,
  padding: 10,
  background: 'var(--gd-input-bg, #ffffff)',
};
