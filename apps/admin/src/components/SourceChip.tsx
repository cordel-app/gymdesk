'use client';

import React from 'react';

/**
 * The Source chip — *System sourced* for a row that came from the platform's
 * catalogue (the System row itself, or a gym's import of one) and *Custom* for
 * one the gym wrote. One look for every list that shows it (Exercises since
 * #718, Nutrition Plan Templates since #3333); the label is the page's.
 */
export function SourceChip({ system, label }: { system: boolean; label: string }) {
  return (
    <span style={system ? SYSTEM_CHIP : CUSTOM_CHIP}>{label}</span>
  );
}

const CHIP_BASE: React.CSSProperties = { fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap' };
const SYSTEM_CHIP: React.CSSProperties = { ...CHIP_BASE, background: '#e8f4fd', color: '#1a6da8' };
const CUSTOM_CHIP: React.CSSProperties = { ...CHIP_BASE, background: '#f0f9eb', color: '#3a7c3a' };
