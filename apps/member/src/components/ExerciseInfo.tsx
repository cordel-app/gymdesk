'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { muscleLabel } from '@/lib/memberProgress';
import { memberTheme } from '@/lib/memberChrome';

/**
 * #2320 — what the Members App says about an exercise beneath its enlarged
 * image: short description, description, muscles, category and equipment.
 * Presentational; every value arrives localized by the API, and a blank one
 * leaves no section behind.
 */
export interface ExerciseInfoFields {
  short_description?: string | null;
  description?: string | null;
  muscles?: string[] | null;
  category?: string | null;
  equipment?: string | null;
}

const filled = (v?: string | null) => (v && v.trim() ? v : null);

export function ExerciseInfo({ info }: { info: ExerciseInfoFields }) {
  const t = useTranslations();
  const short = filled(info.short_description);
  const description = filled(info.description);
  const muscles = (info.muscles ?? []).filter(Boolean);
  const category = filled(info.category);
  const equipment = filled(info.equipment);
  const facts: Array<[string, string]> = [];
  if (muscles.length) facts.push([t('exercise_media.muscles'), muscles.map(muscleLabel).join(', ')]);
  if (category) facts.push([t('exercise_media.category'), muscleLabel(category)]);
  if (equipment) facts.push([t('exercise_media.equipment'), muscleLabel(equipment)]);
  if (!short && !description && facts.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {short && <p style={{ ...text, fontWeight: 600 }}>{short}</p>}
      {description && <p style={text}>{description}</p>}
      {facts.map(([label, value]) => (
        <p key={label} style={{ ...text, color: memberTheme.textSecondary }}>
          <strong>{label}:</strong> {value}
        </p>
      ))}
    </div>
  );
}

const text: React.CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.5, color: memberTheme.text, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };
