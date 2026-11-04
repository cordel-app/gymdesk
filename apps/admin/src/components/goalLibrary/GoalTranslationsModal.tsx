'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { btnStyle, modalStyle, overlayStyle, primaryBtnStyle } from '@/components/ui';
import { formControlStyle, formFieldLabelStyle, modalActionsRowStyle } from '@/components/formChrome';
import { localeLabel } from '@/lib/localeLabels';

export type TranslatedField = 'name' | 'description';
export type TranslationMap = Record<string, { name?: string | null; description?: string | null }>;

/**
 * #2332 — the translations of ONE multilingual field (Name or Description), one input per
 * supported locale. Presentational: the locales, the stored map and what Save does with
 * the result are the caller's, so it names no endpoint and keeps no copy of its own; the
 * draft lives here only until Save (Cancel discards it). `editable = false` is the
 * read-only view of the same list, with no Save.
 */
export function GoalTranslationsModal({
  field, title, locales, translations, editable, label, onSave, onClose,
}: {
  field: TranslatedField;
  title: string;
  locales: string[];
  translations: TranslationMap;
  editable: boolean;
  label: (key: string) => string;
  onSave: (next: TranslationMap) => void;
  onClose: () => void;
}) {
  const tRoot = useTranslations();
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const loc of locales) initial[loc] = translations[loc]?.[field] ?? '';
    setDraft(initial);
    // seeded once per opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function save() {
    const next: TranslationMap = { ...translations };
    for (const loc of locales) {
      const prev = translations[loc] ?? { name: '', description: '' };
      next[loc] = { ...prev, [field]: draft[loc] ?? '' };
    }
    onSave(next);
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        style={{ ...modalStyle, width: 480, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 16px' }}>{title}</h2>
        {locales.map((loc) => {
          const text = localeLabel(loc, (key) => tRoot(key as any));
          return (
            <div key={loc} style={{ marginBottom: 12 }}>
              <label style={formFieldLabelStyle}>{text}</label>
              {field === 'description' ? (
                <textarea
                  value={draft[loc] ?? ''}
                  readOnly={!editable}
                  aria-label={`${title} — ${text}`}
                  onChange={(e) => setDraft({ ...draft, [loc]: e.target.value })}
                  rows={3}
                  style={{ ...formControlStyle, resize: 'vertical' }}
                />
              ) : (
                <input
                  value={draft[loc] ?? ''}
                  readOnly={!editable}
                  aria-label={`${title} — ${text}`}
                  onChange={(e) => setDraft({ ...draft, [loc]: e.target.value })}
                  style={formControlStyle}
                />
              )}
            </div>
          );
        })}
        <div style={editable ? modalActionsRowStyle : { ...modalActionsRowStyle, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnStyle('#aaa')}>
            {editable ? label('cancel') : label('close')}
          </button>
          {editable && <button type="button" onClick={save} style={primaryBtnStyle()}>{label('save')}</button>}
        </div>
      </div>
    </div>
  );
}

/** The globe button beside a multilingual field's label. */
export function TranslationsGlobeButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: 'var(--gd-link, currentColor)', display: 'inline-flex', verticalAlign: 'middle' }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20z" />
      </svg>
    </button>
  );
}
