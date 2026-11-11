'use client';

import React from 'react';
import { formFieldLabelStyle } from '@/components/formChrome';

/** #2623: one boolean setting's row — label left, toggle (or Yes/No) right. */
export const productFlagRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  columnGap: 16,
};

/** The label half of a flag row: the field label's look, without its bottom margin. */
const productFlagLabelStyle: React.CSSProperties = {
  ...formFieldLabelStyle,
  marginBottom: 0,
  minWidth: 0,
};

/**
 * #2623: one boolean product setting on one line — its label on the left, the
 * control (`YesNoToggle` in Edit mode, the Yes/No value otherwise) on the right,
 * so every flag of the group shares one right edge. Both product forms (Gym
 * Products and Base Products) draw their flags through it. It holds no state and
 * resolves no locale key: the label and the control are the page's.
 */
export function ProductFlagRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={productFlagRowStyle}>
      <span style={productFlagLabelStyle}>{label}</span>
      {children}
    </div>
  );
}
