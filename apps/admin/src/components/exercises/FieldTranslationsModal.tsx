'use client';

import React, { useEffect, useState } from 'react';
import { modalStyle, overlayStyle, primaryBtnStyle } from '@/components/ui';
import { modalActionsRowStyle, secondaryBtnStyle } from '@/components/formChrome';

/** One language row of the modal; `code` is the locale, `label` its resolved name. */
export interface TranslationLocale { code: string; label: string }

/**
 * #2300: the globe icon beside a multilingual field. Presentational: the caller
 * resolves every label and owns where the values are stored.
 */
export function GlobeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--gd-link, #6c63ff)', display: 'inline-flex', alignItems: 'center' }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    </button>
  );
}

const inputSt: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--gd-input-border, #ccc)', background: 'var(--gd-input-bg, #fff)', fontSize: 14, boxSizing: 'border-box', fontFamily: 'inherit' };

export function FieldTranslationsModal({
  open, title, locales, values, multiline, readOnly, saveLabel, cancelLabel, closeLabel, emptyLabel, onSave, onClose,
}: {
  open: boolean;
  title: string;
  locales: TranslationLocale[];
  values: Record<string, string>;
  multiline?: boolean;
  readOnly?: boolean;
  saveLabel: string;
  cancelLabel: string;
  closeLabel: string;
  emptyLabel: string;
  onSave: (values: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(values);
  // A fresh draft every time the modal opens: Cancel discards what was typed.
  useEffect(() => { if (open) setDraft(values); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, maxWidth: 560, width: 'calc(100% - 32px)', maxHeight: '90vh', overflowY: 'auto' }} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{title}</h2>
        {locales.map((l) => (
          <div key={l.code} style={{ marginBottom: 12 }}>
            <label htmlFor={`ftm-${l.code}`} style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{l.label}</label>
            {readOnly ? (
              <p style={{ margin: 0, fontSize: 14, whiteSpace: 'pre-wrap' }}>{draft[l.code]?.trim() ? draft[l.code] : emptyLabel}</p>
            ) : multiline ? (
              <textarea id={`ftm-${l.code}`} rows={4} value={draft[l.code] ?? ''} onChange={(e) => setDraft({ ...draft, [l.code]: e.target.value })} style={{ ...inputSt, resize: 'vertical' }} />
            ) : (
              <input id={`ftm-${l.code}`} value={draft[l.code] ?? ''} onChange={(e) => setDraft({ ...draft, [l.code]: e.target.value })} style={inputSt} />
            )}
          </div>
        ))}
        <div style={modalActionsRowStyle}>
          {readOnly ? (
            <button type="button" onClick={onClose} style={secondaryBtnStyle}>{closeLabel}</button>
          ) : (
            <>
              <button type="button" onClick={onClose} style={secondaryBtnStyle}>{cancelLabel}</button>
              <button type="button" onClick={() => onSave(draft)} style={primaryBtnStyle()}>{saveLabel}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export type TranslatedField = 'name' | 'short_description' | 'description';

interface TranslationSource {
  name: string;
  short_description: string;
  description: string;
  translations: Record<string, string>;
  description_translations: Record<string, { short_description?: string; description?: string }>;
}

/** `{ locale: value }` for one field, the base locale's being the entity's own column. */
export function translationValues(field: TranslatedField, base: string, src: TranslationSource): Record<string, string> {
  const out: Record<string, string> = { [base]: src[field] ?? '' };
  for (const [loc, v] of Object.entries(src.translations ?? {})) if (field === 'name') out[loc] = v ?? '';
  if (field !== 'name') {
    for (const [loc, v] of Object.entries(src.description_translations ?? {})) out[loc] = v?.[field] ?? '';
  }
  return out;
}
