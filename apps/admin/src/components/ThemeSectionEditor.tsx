'use client';

import { useRef } from 'react';
import { FormLabel, FormInput } from '@/components/CrudModal';
import { btnSmall } from '@/components/ui';

// Shared expanded-card editor chrome for the two Theme screens (#678):
// Custom Themes (`[locale]/themes`) and Base Themes (`[locale]/system/themes`).
//
// The Custom Themes editor is the reference implementation — these components
// are its section wrapper and its Branding block lifted out verbatim, so the
// two screens render one structure instead of two that drift apart. The colour
// and typography controls were already shared (`ThemeTokensEditor`); this file
// closes the remaining gap.
//
// Both components are presentational: they never fetch, never persist and never
// decide when a change is previewed — the page owns the draft and the calls.

interface ThemeSectionProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

/** One collapsible section of the expanded theme card (Branding, Colors, …). */
export function ThemeSection({ title, open, onToggle, children }: ThemeSectionProps) {
  return (
    <div style={{ borderTop: '1px solid var(--gd-border, #eee)' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: 'var(--gd-section-heading-text, #888888)', textAlign: 'left', fontFamily: 'inherit' }}
      >
        {title}
        <span style={{ fontSize: 12, color: '#aaa', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
      </button>
      {open && <div style={{ paddingBottom: 16 }}>{children}</div>}
    </div>
  );
}

export interface ThemeBrandingValues {
  name: string;
  description: string;
  logoContainsGymName: boolean;
}

interface ThemeBrandingEditorProps {
  values: ThemeBrandingValues;
  onChange: (next: Partial<ThemeBrandingValues>) => void;
  // Typed loosely — callers pass their namespaced `useTranslations()` result,
  // whose key union is narrower than the shared label keys used here.
  t: (key: any) => string;
  logoPreview: string | null;
  onLogoPick: (file: File) => void;
  onLogoRemove: () => void;
  /** Hidden while creating a theme that does not exist yet (no id to upload to). */
  showLogo?: boolean;
  /** A Base Theme viewed from a gym: every control is disabled, nothing saves. */
  readOnly?: boolean;
  autoFocusName?: boolean;
  /** Extra controls rendered under Name — the Base editor's Status select. */
  children?: React.ReactNode;
}

/** Name / description / logo — the Branding section of both theme editors. */
export function ThemeBrandingEditor({
  values,
  onChange,
  t,
  logoPreview,
  onLogoPick,
  onLogoRemove,
  showLogo = true,
  readOnly = false,
  autoFocusName = false,
  children,
}: ThemeBrandingEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onLogoPick(file);
  }

  return (
    <div>
      <FormLabel>{t('label_name')}</FormLabel>
      <FormInput
        value={values.name}
        disabled={readOnly}
        autoFocus={autoFocusName}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="My Brand"
      />

      {children}

      <FormLabel>{t('label_description')}</FormLabel>
      <textarea
        value={values.description}
        disabled={readOnly}
        onChange={(e) => onChange({ description: e.target.value })}
        rows={2}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
      />

      {showLogo && (
        <>
          <FormLabel>{t('label_logo')}</FormLabel>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>{t('logo_hint')}</p>
          {logoPreview ? (
            <div style={{ marginBottom: 8 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoPreview} alt="logo preview" style={{ maxHeight: 60, maxWidth: 200, objectFit: 'contain', display: 'block', border: '1px solid #eee', borderRadius: 6, padding: 4 }} />
            </div>
          ) : (
            readOnly && <p style={{ margin: '0 0 8px', fontSize: 13, color: '#888' }}>{t('logo_no_preview')}</p>
          )}
          {!readOnly && (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => fileInputRef.current?.click()} style={btnSmall('#444')}>{t('logo_upload')}</button>
                {logoPreview && (
                  <button type="button" onClick={onLogoRemove} style={btnSmall('#c0392b')}>{t('logo_clear')}</button>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" style={{ display: 'none' }} onChange={handleFileChange} />
            </>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 14, cursor: readOnly ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              checked={values.logoContainsGymName}
              disabled={readOnly}
              onChange={(e) => onChange({ logoContainsGymName: e.target.checked })}
            />
            {t('logo_contains_gym_name')}
          </label>
        </>
      )}
    </div>
  );
}
