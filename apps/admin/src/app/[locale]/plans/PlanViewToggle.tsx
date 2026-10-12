'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { filterControlStyle } from '@/components/FilterBar';
import {
  DEFAULT_PLAN_VIEW_MODE,
  PLAN_VIEW_MODES,
  readPlanViewMode,
  writePlanViewMode,
  type PlanViewMode,
} from '@/lib/planViewMode';

/** The saved view, resolved after mount so the first render matches the server's. */
export function usePlanViewMode(): [PlanViewMode, (mode: PlanViewMode) => void] {
  const [mode, setMode] = useState<PlanViewMode>(DEFAULT_PLAN_VIEW_MODE);
  useEffect(() => {
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* blocked */ }
    setMode(readPlanViewMode(storage));
  }, []);
  function choose(next: PlanViewMode) {
    setMode(next);
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* blocked */ }
    writePlanViewMode(storage, next);
  }
  return [mode, choose];
}

/** The List / Cards switch (#1369). */
export function PlanViewToggle({ value, onChange }: { value: PlanViewMode; onChange: (mode: PlanViewMode) => void }) {
  const t = useTranslations('plans');
  return (
    <div role="group" aria-label={t('view_toggle_label')} style={{ display: 'inline-flex' }}>
      {PLAN_VIEW_MODES.map((mode, i) => {
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
