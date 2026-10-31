'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { exerciseDisplayValue, formatExerciseTimestamp } from '@/components/exercises/exerciseForm';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import type { ProgressSummary } from './progressView';

/**
 * #2198 — `⋮ → Details` of an exercise on the Member's Progress tab. It renders the list row
 * it was handed (no second read, #799) and carries the audit information only: the readings
 * stay in the card below. The logs are member-authored, so "created by" is the member and a
 * staff edit leaves "modified by" empty; no audit_logs row exists for a reading (#1231), hence
 * no View Audit Log link.
 */
export function ProgressExerciseDetailsModal({ exercise, onClose }: { exercise: ProgressSummary | null; onClose: () => void }) {
  const t = useTranslations('members');
  const gym = useGymFormatSettings();
  if (!exercise) return null;
  const row = (label: string, value: string) => (
    <div style={{ display: 'flex', gap: 12, padding: '4px 0', fontSize: 14 }}>
      <span style={{ width: 160, color: '#666', flexShrink: 0 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div role="dialog" aria-label={t('progress_details_title')} style={{ ...modalStyle, width: 480, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('progress_details_title')}</h2>
        <p style={{ margin: '0 0 16px', color: '#666', fontSize: 14 }}>{exercise.exercise_name}</p>
        {row(t('progress_days'), String(exercise.days_exercised))}
        {row(t('progress_created_at'), formatExerciseTimestamp(exercise.created_at ?? null, gym))}
        {row(t('progress_created_by'), exerciseDisplayValue(exercise.created_by ?? null))}
        {row(t('progress_modified_at'), formatExerciseTimestamp(exercise.modified_at ?? null, gym))}
        {row(t('progress_modified_by'), exerciseDisplayValue(exercise.modified_by ?? null))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" onClick={onClose} style={btnStyle('#444')}>{t('progress_close')}</button>
        </div>
      </div>
    </div>
  );
}
