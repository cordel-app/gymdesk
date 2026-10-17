import React from 'react';
import { listNameBadgeStyle } from '@/components/listChrome';
import { type MuscleRole } from '@/components/exercises/exerciseForm';

/**
 * The primary-muscle cell of both exercise lists (#1704): one chip per principal
 * muscle, `—` when there is none. Presentation only; the labels come from the
 * page's own `muscleLabel`.
 */
export function ExercisePrimaryMuscles({ muscles, muscleLabel }: {
  muscles: { key: string; role: MuscleRole }[] | null | undefined;
  muscleLabel: (key: string) => string;
}) {
  const keys = (muscles ?? []).filter((m) => m.role === 'principal').map((m) => m.key);
  if (keys.length === 0) return <span style={{ color: 'var(--text-muted, #9ca3af)' }}>—</span>;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {keys.map((k) => <span key={k} style={listNameBadgeStyle}>{muscleLabel(k)}</span>)}
    </span>
  );
}
