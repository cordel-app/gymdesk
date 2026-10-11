'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { filterControlStyle } from '@/components/FilterBar';
import {
  DEFAULT_EXERCISE_VIEW_MODE,
  EXERCISE_VIEW_MODES,
  readExerciseViewMode,
  writeExerciseViewMode,
  type ExerciseViewMode,
} from '@/lib/exerciseViewMode';

/**
 * The saved view, resolved after mount (`localStorage` does not exist on the
 * server, so the first render is always the default — a hydration-safe read).
 */
export function useExerciseViewMode(): [ExerciseViewMode, (mode: ExerciseViewMode) => void] {
  const [mode, setMode] = useState<ExerciseViewMode>(DEFAULT_EXERCISE_VIEW_MODE);
  useEffect(() => {
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* blocked */ }
    setMode(readExerciseViewMode(storage));
  }, []);
  function choose(next: ExerciseViewMode) {
    setMode(next);
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* blocked */ }
    writeExerciseViewMode(storage, next);
  }
  return [mode, choose];
}

/** The List / Cards switch (#1386), one component for both Exercise pages. */
export function ExerciseViewToggle({ value, onChange }: {
  value: ExerciseViewMode;
  onChange: (mode: ExerciseViewMode) => void;
}) {
  const t = useTranslations('exercises');
  return (
    <div role="group" aria-label={t('view_toggle_label')} style={{ display: 'inline-flex', gap: 0 }}>
      {EXERCISE_VIEW_MODES.map((mode, i) => {
        const selected = value === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(mode)}
            style={{
              ...filterControlStyle,
              cursor: 'pointer',
              borderRadius: i === 0 ? '6px 0 0 6px' : '0 6px 6px 0',
              marginLeft: i === 0 ? 0 : -1,
              fontWeight: selected ? 700 : 500,
              borderColor: selected ? 'var(--brand, #6c63ff)' : undefined,
              color: selected ? 'var(--brand, #6c63ff)' : undefined,
            }}
          >
            {t(`view_${mode}`)}
          </button>
        );
      })}
    </div>
  );
}
