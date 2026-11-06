'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { muscleLabel } from '@/lib/memberProgress';
import { equipmentLabelKey } from '@/lib/exerciseEquipment';
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
  /** Subset of `muscles` with the principal role; drawn as chips ahead of the rest. */
  primary_muscles?: string[] | null;
  category?: string | null;
  equipment?: string | null;
}

const filled = (v?: string | null) => (v && v.trim() ? v : null);

const ICON = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false } as const;
const ICONS: Record<string, React.ReactNode> = {
  short: <svg {...ICON}><path d="M4 7h16M4 12h10" /></svg>,
  description: <svg {...ICON}><path d="M4 6h16M4 10h16M4 14h16M4 18h10" /></svg>,
  muscles: <svg {...ICON}><path d="M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11" /></svg>,
  equipment: <svg {...ICON}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" /></svg>,
  category: <svg {...ICON}><path d="M20 12l-8 8-9-9V3h8z" /><circle cx="7.5" cy="7.5" r="1" /></svg>,
};

export function ExerciseInfo({ info }: { info: ExerciseInfoFields }) {
  const t = useTranslations();
  const muscles = (info.muscles ?? []).filter(Boolean);
  const category = filled(info.category);
  const equipment = filled(info.equipment);
  const primary = (info.primary_muscles ?? []).filter(Boolean);
  const secondary = muscles.filter((m) => !primary.includes(m));
  // #2403: categories are stored as lowercase slugs; resolve the member's locale
  // key, falling back to the humanised stored value (decided before t() is called).
  const categoryLabel = (c: string) => {
    const key = `exercise_media.category_${c.trim().toLowerCase().replace(/[\s-]+/g, '_')}`;
    return t.has(key) ? t(key) : muscleLabel(c);
  };
  const sections: Array<{ key: string; label: string; value: string }> = [];
  const short = filled(info.short_description);
  const description = filled(info.description);
  if (short) sections.push({ key: 'short', label: t('exercise_media.short_description'), value: short });
  if (description) sections.push({ key: 'description', label: t('exercise_media.description'), value: description });
  if (muscles.length && primary.length === 0) sections.push({ key: 'muscles', label: t('exercise_media.muscles'), value: muscles.map(muscleLabel).join(', ') });
  if (equipment) sections.push({ key: 'equipment', label: t('exercise_media.equipment'), value: equipment.split(',').map((e) => e.trim()).filter(Boolean).map((e) => { const k = equipmentLabelKey(e); return t.has(k) ? t(k) : muscleLabel(e); }).join(', ') });
  if (category) sections.push({ key: 'category', label: t('exercise_media.category'), value: categoryLabel(category) });
  if (sections.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {sections.map((s) => (
        <div key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: memberTheme.textSecondary }}>
            {ICONS[s.key]}{s.label}
          </span>
          <p style={text}>{s.value}</p>
        </div>
      ))}
      {primary.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: memberTheme.textSecondary }}>
            {ICONS.muscles}{t('exercise_media.muscles')}
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 14, color: memberTheme.text }}>
            {primary.map((m) => <span key={m} style={chip}>{muscleLabel(m)}</span>)}
            {secondary.length > 0 && <span style={{ overflowWrap: 'anywhere' }}>{secondary.map(muscleLabel).join(', ')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const text: React.CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.5, color: memberTheme.text, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };

const chip: React.CSSProperties = { background: `color-mix(in srgb, ${memberTheme.primaryButton} 14%, ${memberTheme.surface})`, color: memberTheme.primaryButton, borderRadius: 999, padding: '3px 10px', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' };
