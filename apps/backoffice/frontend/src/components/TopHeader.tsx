'use client';

import { LanguagePicker } from './LanguagePicker';

export function TopHeader() {
  return (
    <header style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      height: 52,
      background: '#1a1a2e',
      borderBottom: '1px solid rgba(255,255,255,0.1)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 24px',
      zIndex: 50,
      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    }}>
      <strong style={{ color: '#fff', fontSize: 18 }}>Gymdesk</strong>
      <LanguagePicker />
    </header>
  );
}
