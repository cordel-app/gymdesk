'use client';

/**
 * #3403 — the Start Date / End Date pair an expanded Assigned Nutrition Plan or
 * Assigned Training Plan shows, so both dates stay reachable on a phone, where
 * the list's date columns are hidden. The values are `assignedPlanDateTexts()`'s,
 * the same the collapsed row shows; the labels are the page's.
 */
import React from 'react';
import { CardDetailRow } from './CardDetailRow';

export function AssignedPlanDateFields({ startLabel, endLabel, start, end }: {
  startLabel: string;
  endLabel: string;
  start: string;
  end: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 20px' }}>
      <CardDetailRow label={startLabel} value={start} />
      <CardDetailRow label={endLabel} value={end} />
    </div>
  );
}
