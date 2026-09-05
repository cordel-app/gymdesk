'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { btnStyle } from '@/components/ui';
import type { CenterOption } from '@/context/CenterContext';

export interface MemberEditFormValues {
  name: string;
  phone: string;
  date_of_birth: string;
  gender: string;
  address: string;
  emergency_contact: string;
  notes: string;
}

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

  return (
    <div style={panel}>
      <div style={sectionLabelStyle}>{t('section_profile')}</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <div>
          <label style={inlineLabelStyle}>{t('label_name')}</label>
          <input
            style={inlineInputStyle}
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            autoFocus
          />
        </div>
        <div>
          <label style={inlineLabelStyle}>{t('label_phone')}</label>
          <input
            style={inlineInputStyle}
            value={form.phone}
            onChange={(e) => onChange({ ...form, phone: e.target.value })}
            placeholder={t('placeholder_phone')}
          />
        </div>
        <div>
          <label style={inlineLabelStyle}>{t('label_date_of_birth')}</label>
          <input
            type="date"
            style={inlineInputStyle}
            value={form.date_of_birth}
            onChange={(e) => onChange({ ...form, date_of_birth: e.target.value })}
          />
        </div>
        <div>
          <label style={inlineLabelStyle}>{t('label_gender')}</label>
          <input
            style={inlineInputStyle}
            value={form.gender}
            onChange={(e) => onChange({ ...form, gender: e.target.value })}
          />
        </div>
        <div>
          <label style={inlineLabelStyle}>{t('label_address')}</label>
          <input
            style={inlineInputStyle}
            value={form.address}
            onChange={(e) => onChange({ ...form, address: e.target.value })}
            placeholder={t('placeholder_address')}
          />
        </div>
        <div>
          <label style={inlineLabelStyle}>{t('label_emergency_contact')}</label>
          <input
            style={inlineInputStyle}
            value={form.emergency_contact}
            onChange={(e) => onChange({ ...form, emergency_contact: e.target.value })}
            placeholder={t('placeholder_emergency_contact')}
          />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={inlineLabelStyle}>{t('label_notes')}</label>
          <textarea
            style={{ ...inlineInputStyle, height: 70, resize: 'vertical' }}
            value={form.notes}
            onChange={(e) => onChange({ ...form, notes: e.target.value })}
            placeholder={t('placeholder_notes')}
          />
        </div>
      </div>

      {showCenters && (
        <div style={{ marginTop: 14 }}>
          <label style={inlineLabelStyle}>{t('assigned_centers')}</label>
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

          <label style={inlineLabelStyle}>{t('default_center')}</label>
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
        </div>
      )}

      {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16, paddingTop: 14, borderTop: '1px solid #ececf0' }}>
        <button onClick={onCancel} style={cancelBtnStyle} disabled={saving}>{t('cancel')}</button>
        <button onClick={onSave} style={btnStyle()} disabled={saving}>
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
const inlineLabelStyle: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4, marginTop: 10 };
const inlineInputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', background: '#fff' };
const cancelBtnStyle: React.CSSProperties = { background: '#fff', color: '#444', border: '1px solid #ddd', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
