'use client';

import { listNameBadgeStyle } from '@/components/listChrome';

/** #1883 — a compact, read-only chip; the label is resolved by the caller's namespace. */
export function ItemOriginChip({ label }: { label: string }) {
  return <span style={listNameBadgeStyle}>{label}</span>;
}
