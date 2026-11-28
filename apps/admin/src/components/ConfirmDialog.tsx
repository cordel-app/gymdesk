'use client';

import React from 'react';
import { overlayStyle, modalStyle, btnStyle, primaryBtnStyle } from './ui';
import { secondaryBtnStyle } from './formChrome';

interface ConfirmDialogProps {
  open: boolean;
  message: string;
  /** #2481: an optional heading above the message. */
  title?: string;
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
  /** #3059: a closing question under the details. */
  question?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** #2125: an optional third answer, drawn between Cancel and the confirm button. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  busy?: boolean;
  /**
   * #3477: what the confirm button is. `destructive` (the default, every
   * existing caller) keeps the red confirm and the blue third answer;
   * `primary` is a non-destructive choice — Cancel and the third answer wear
   * the theme's secondary button and the confirm the theme's primary one, so
   * nothing in the dialog is a colour the gym's Theme cannot move.
   */
  tone?: 'destructive' | 'primary';
}

export function ConfirmDialog({ open, title, message, details, question, confirmLabel, cancelLabel, onConfirm, onCancel, secondaryLabel, onSecondary, busy, tone = 'destructive' }: ConfirmDialogProps) {
  if (!open) return null;
  const primary = tone === 'primary';
  const cancelStyle = primary ? secondaryBtnStyle : btnStyle('#aaa');
  const secondaryStyle = primary ? secondaryBtnStyle : btnStyle('#2c7be5');
  const confirmStyle = primary ? primaryBtnStyle() : btnStyle('#c0392b');

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={{ ...modalStyle, width: 380 }} onClick={(e) => e.stopPropagation()}>
        {title && <h3 style={{ margin: '0 0 10px', fontSize: 17 }}>{title}</h3>}
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>{message}</p>
        {details && <div style={{ marginTop: 14 }}>{details}</div>}
        {question && <p style={{ margin: '14px 0 0', fontSize: 15 }}>{question}</p>}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={cancelStyle} disabled={busy}>{cancelLabel}</button>
          {secondaryLabel && onSecondary && (
            <button onClick={onSecondary} style={secondaryStyle} disabled={busy}>{secondaryLabel}</button>
          )}
          <button onClick={onConfirm} style={confirmStyle} disabled={busy}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
