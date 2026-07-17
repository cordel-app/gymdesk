'use client';

import React from 'react';
import Link from 'next/link';
import { overlayStyle, modalStyle, btnStyle } from './ui';

/**
 * #62: warns before editing/deleting a shared catalog entity that other
 * records depend on. Generic: pages fetch GET /<entity>/:id/references and
 * feed the result here; new catalog entities reuse it as-is.
 */

export interface ReferenceReport {
  entityId: number;
  usageCount: number;
  references: { id: number; name: string }[];
}

interface DependencyDialogProps {
  open: boolean;
  message: string;
  question: string;
  references: { id: number; name: string }[];
  /** how many references exist beyond the listed ones */
  moreLabel: string | null;
  /** list page the referenced entities live on (per-item detail routes don't exist yet) */
  referenceHref?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function DependencyDialog({
  open, message, question, references, moreLabel, referenceHref,
  confirmLabel, cancelLabel, onConfirm, onCancel, busy,
}: DependencyDialogProps) {
  if (!open) return null;

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={{ ...modalStyle, width: 440 }} onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, fontWeight: 600 }}>{message}</p>

        <ul style={{
          margin: '14px 0 0', padding: '10px 14px', listStyle: 'none',
          maxHeight: 220, overflowY: 'auto', background: '#f7f7fa',
          border: '1px solid #ececf0', borderRadius: 8,
        }}>
          {references.map((r) => (
            <li key={r.id} style={{ padding: '3px 0', fontSize: 14 }}>
              {referenceHref ? (
                <Link href={referenceHref} style={{ color: '#4b45c6', textDecoration: 'none' }}>{r.name}</Link>
              ) : r.name}
            </li>
          ))}
          {moreLabel && <li style={{ padding: '3px 0', fontSize: 13, color: '#888' }}>{moreLabel}</li>}
        </ul>

        <p style={{ margin: '14px 0 0', fontSize: 15 }}>{question}</p>

        <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={btnStyle('#aaa')} disabled={busy}>{cancelLabel}</button>
          <button onClick={onConfirm} style={btnStyle('#c0392b')} disabled={busy}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
