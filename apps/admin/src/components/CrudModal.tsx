'use client';

import React, { ReactNode } from 'react';
import { btnStyle, modalStyle, overlayStyle, primaryBtnStyle } from './ui';
import { modalActionsRowStyle } from './formChrome';

interface CrudModalProps {
  open: boolean;
  title: string;
  error?: string | null;
  saving?: boolean;
  saveDisabled?: boolean;
  hideSave?: boolean;
  cancelLabel: string;
  saveLabel: string;
  onCancel: () => void;
  onSave: () => void;
  children: ReactNode;
  /** Optional node rendered before the Cancel/Save buttons (e.g. a Delete button). */
  extraFooter?: ReactNode;
  /** #3498 — optional node at the header's right (the payment modal's amount); the header wraps on a narrow screen. */
  headerAside?: ReactNode;
}

export function CrudModal({ open, title, error, saving, saveDisabled, hideSave, cancelLabel, saveLabel, onCancel, onSave, children, extraFooter, headerAside }: CrudModalProps) {
  if (!open) return null;

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {headerAside ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, margin: '0 0 20px' }}>
            <h2 style={{ margin: 0 }}>{title}</h2>
            {headerAside}
          </div>
        ) : (
          <h2 style={{ margin: '0 0 20px' }}>{title}</h2>
        )}

        {children}

        {error && <p style={{ color: '#c0392b', margin: '8px 0 0', fontSize: 14 }}>{error}</p>}

        {/*
          * #1028: a form's action group is left-aligned, from the one shared
          * declaration (`modalActionsRowStyle`), so the Modal CRUD shape and the
          * inline card forms put Cancel/Save in the same place.
          *
          * `hideSave` is the one exception, and it is not a form: it is how this
          * component renders a read-only Details view, whose single Close button
          * keeps the dialog convention every standalone Details modal in the app
          * already uses. The order inside the row is untouched either way —
          * `extraFooter` (a Delete, a View Audit Log link) still comes first.
          */}
        <div style={hideSave ? { ...modalActionsRowStyle, justifyContent: 'flex-end' } : modalActionsRowStyle}>
          {extraFooter}
          <button onClick={onCancel} style={btnStyle('#aaa')} disabled={saving}>{cancelLabel}</button>
          {!hideSave && <button onClick={onSave} style={primaryBtnStyle()} disabled={saving || saveDisabled}>{saveLabel}</button>}
        </div>
      </div>
    </div>
  );
}

export function FormLabel({ children }: { children: ReactNode }) {
  return <label style={labelStyle}>{children}</label>;
}

export function FormInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ ...inputStyle, ...props.style }} />;
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 14, fontWeight: 500, marginBottom: 4, marginTop: 14, color: 'var(--gd-text-secondary, #374151)' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--gd-input-border, #d1d5db)', background: 'var(--gd-input-bg, #ffffff)', fontSize: 15, boxSizing: 'border-box' };
