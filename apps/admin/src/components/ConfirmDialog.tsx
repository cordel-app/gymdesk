'use client';

import React from 'react';
import { overlayStyle, modalStyle, btnStyle } from './ui';

interface ConfirmDialogProps {
  open: boolean;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ConfirmDialog({ open, message, confirmLabel, cancelLabel, onConfirm, onCancel, busy }: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={{ ...modalStyle, width: 380 }} onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>{message}</p>

        <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={btnStyle('#aaa')} disabled={busy}>{cancelLabel}</button>
          <button onClick={onConfirm} style={btnStyle('#c0392b')} disabled={busy}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
