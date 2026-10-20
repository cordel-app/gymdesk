'use client';

import type { ReactNode } from 'react';

// Small glyphs for the Home dashboard (stroke = currentColor, same 24×24 grid
// and round joins as the navigation icons).
function Shell({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      {children}
    </svg>
  );
}

type P = { size?: number };

export function CheckIcon({ size = 20 }: P) {
  return <Shell size={size}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.8 2.8L16 9.5" /></Shell>;
}

export function UserCheckIcon({ size = 20 }: P) {
  return <Shell size={size}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="m16.5 11 2 2 3.5-4" /></Shell>;
}

export function UserPlusIcon({ size = 20 }: P) {
  return <Shell size={size}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M19 8v6M16 11h6" /></Shell>;
}

export function ClipboardCheckIcon({ size = 20 }: P) {
  return <Shell size={size}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9z" /><path d="m9 14 2 2 4-4" /></Shell>;
}

export function CalendarClockIcon({ size = 20 }: P) {
  return <Shell size={size}><path d="M20 11V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5" /><path d="M4 9h16M8 2.5V6M16 2.5V6" /><circle cx="17" cy="17" r="4" /><path d="M17 15.2V17l1.2.8" /></Shell>;
}

export function WalletIcon({ size = 20 }: P) {
  return <Shell size={size}><path d="M4 7a2 2 0 0 1 2-2h11v4" /><path d="M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2z" /><circle cx="16.5" cy="14.5" r="1" /></Shell>;
}

export function ContactsIcon({ size = 20 }: P) {
  return <Shell size={size}><circle cx="12" cy="9" r="3.5" /><path d="M5.5 20c0-3.4 2.9-5.5 6.5-5.5s6.5 2.1 6.5 5.5" /><path d="M2.5 7v4M21.5 7v4" /></Shell>;
}

export function PlusIcon({ size = 20 }: P) {
  return <Shell size={size}><path d="M12 5v14M5 12h14" /></Shell>;
}

export function ArrowRightIcon({ size = 16 }: P) {
  return <Shell size={size}><path d="M5 12h14M13 6l6 6-6 6" /></Shell>;
}

export function PartyIcon({ size = 16 }: P) {
  return <Shell size={size}><path d="m4 20 4.5-12 7.5 7.5Z" /><path d="M14 4v2M19 9h2M17 3l-1 1.5M20 13l-1.5-1" /></Shell>;
}

export function XCircleIcon({ size = 16 }: P) {
  return <Shell size={size}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></Shell>;
}

export function ListIcon({ size = 16 }: P) {
  return <Shell size={size}><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></Shell>;
}
