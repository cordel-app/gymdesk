'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { listNameBadgeStyle } from '@/components/listChrome';
import { exerciseSectionLabelStyle } from './exerciseFieldChrome';
import { EXERCISE_EMPTY_VALUE, resultTypeLabel, type ResultTypeRow } from './exerciseForm';

/**
 * #2225: Recorded Metrics are configured per exercise (the category only seeds a
 * new exercise's default). Read-only: the stored metrics as chips. Editing: one
 * checkbox per result type of the catalogue, independent of the category.
 */
export function RecordedMetrics({
  stored, editable, catalogue, selected, onToggle, isNew,
}: {
  stored?: ResultTypeRow[] | null;
  editable?: boolean;
  catalogue?: ResultTypeRow[];
  selected?: Set<number>;
  onToggle?: (id: number) => void;
  /** Creation form: nothing selected means "use the category's default set". */
  isNew?: boolean;
}) {
  const t = useTranslations('exercises');
  const label = (rt: ResultTypeRow) => resultTypeLabel(rt, (key) => t(key as any));
  if (editable && catalogue) {
    return (
      <div>
        <p style={exerciseSectionLabelStyle}>{t('label_recorded_metrics')}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          {catalogue.map((rt) => (
            <label key={rt.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={!!selected?.has(rt.id)} onChange={() => onToggle?.(rt.id)} />
              {label(rt)}
            </label>
          ))}
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#888' }}>
          {t(isNew ? 'recorded_metrics_help_new' : 'recorded_metrics_help')}
        </p>
      </div>
    );
  }
  const rows = stored ?? [];
  return (
    <div>
      <p style={exerciseSectionLabelStyle}>{t('label_recorded_metrics')}</p>
      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: '#888' }}>{EXERCISE_EMPTY_VALUE}</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {rows.map((rt) => (
            <span key={rt.slug} style={{ ...listNameBadgeStyle, marginLeft: 0 }}>{label(rt)}</span>
          ))}
        </div>
      )}
    </div>
  );
}
