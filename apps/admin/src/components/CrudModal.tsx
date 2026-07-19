'use client';

import React, { ReactNode } from 'react';
import { overlayStyle, modalStyle, btnStyle } from './ui';

interface CrudModalProps {
  open: boolean;
  title: string;
  error?: string | null;
  saving?: boolean;
  saveDisabled?: boolean;
  cancelLabel: string;
  saveLabel: string;
  onCancel: () => void;
  onSave: () => void;
  children: ReactNode;
}

export function CrudModal({ open, title, error, saving, saveDisabled, cancelLabel, saveLabel, onCancel, onSave, children }: CrudModalProps) {
  if (!open) return null;

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 20px' }}>{title}</h2>

        {children}

        {error && <p style={{ color: '#c0392b', margin: '8px 0 0', fontSize: 14 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={btnStyle('#aaa')} disabled={saving}>{cancelLabel}</button>
          <button onClick={onSave} style={btnStyle('#6c63ff')} disabled={saving || saveDisabled}>{saveLabel}</button>
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

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 14, fontWeight: 500, marginBottom: 4, marginTop: 14, color: '#333' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' };
