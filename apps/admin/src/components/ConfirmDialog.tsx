'use client';

import React from 'react';
import { overlayStyle, modalStyle, btnStyle } from './ui';

interface ConfirmDialogProps {
  open: boolean;
  message: string;
  /**
   * Anything the lead sentence alone cannot carry, rendered under it in the
   * same dialog — #956 stage 2's replacement warning names both Membership
   * Plans and the current one's start date, which is structure rather than a
   * longer sentence. Optional, so every existing caller is unchanged, and the
   * dialog keeps owning the overlay, the modal, the button pair and the busy
   * state: a confirmation that needs more words must not become a second
   * dialog of its own.
   */
  details?: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ConfirmDialog({ open, message, details, confirmLabel, cancelLabel, onConfirm, onCancel, busy }: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={{ ...modalStyle, width: 380 }} onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>{message}</p>
        {details && <div style={{ marginTop: 14 }}>{details}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={btnStyle('#aaa')} disabled={busy}>{cancelLabel}</button>
          <button onClick={onConfirm} style={btnStyle('#c0392b')} disabled={busy}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
