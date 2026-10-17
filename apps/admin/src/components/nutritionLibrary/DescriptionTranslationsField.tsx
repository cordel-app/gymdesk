'use client';

import React from 'react';
import { formHelpTextStyle } from '@/components/formChrome';

/**
 * One description textarea per translatable language (#1720), shared by the gym
 * and Cordel Nutrition Library forms. The base (English) description is the
 * form's own Description field; a language left blank falls back to it. The
 * language list is the API's, never a list here, and the labels arrive resolved.
 */
export function DescriptionTranslationsField({
  locales,
  values,
  onChange,
  localeLabel,
  label,
  hint,
  placeholderFor,
  labelStyle,
  inputStyle,
}: {
  locales: string[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  localeLabel: (locale: string) => string;
  label: string;
  hint: string;
  placeholderFor: (language: string) => string;
  /** The host page's own inline label/input styles, so the field matches its siblings. */
  labelStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
}) {
  if (locales.length === 0) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}</label>
      <p style={formHelpTextStyle}>{hint}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {locales.map((loc) => (
          <div key={loc} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ width: 80, flexShrink: 0, fontSize: 12.5, color: '#555', paddingTop: 8 }}>{localeLabel(loc)}</span>
            <textarea
              value={values[loc] ?? ''}
              onChange={(e) => onChange({ ...values, [loc]: e.target.value })}
              placeholder={placeholderFor(localeLabel(loc))}
              rows={2}
              aria-label={placeholderFor(localeLabel(loc))}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
