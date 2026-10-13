'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { cardSurfaceStyle } from '@/components/ui';
import { exerciseName } from '@/lib/exerciseNames';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { type ExerciseReadOnlyRow } from './exerciseForm';

/** An exercise as the card needs it: the list row, plus the optional equipment facet. */
export type ExerciseCardRow = ExerciseReadOnlyRow & { equipment?: string | null };

/** Muscle chips shown before the rest collapse into a `+N` chip, so a card never grows without bound. */
const MAX_MUSCLE_CHIPS = 6;

/**
 * The responsive card grid (#1530), driven by the width of its own container
 * rather than the viewport (the sidebar changes the room a page has): one card per
 * row on a phone, two on a tablet, three by default and four only once each card
 * can keep about 300px. Layout only — it filters and sorts nothing.
 */
const GRID_CSS = `
.gd-exercise-grid-wrap { container-type: inline-size; }
.gd-exercise-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@container (min-width: 640px) { .gd-exercise-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; } }
@container (min-width: 960px) { .gd-exercise-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; } }
@container (min-width: 1272px) { .gd-exercise-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
`;

export function ExerciseCardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="gd-exercise-grid-wrap">
      <style>{GRID_CSS}</style>
      <div className="gd-exercise-grid">{children}</div>
    </div>
  );
}

// Two distinct accessible pairs (light background, dark text); the variables are the theme's own when set.
const PRIMARY_CHIP: React.CSSProperties = {
  background: 'var(--gd-chip-primary-bg, #dbeafe)', color: 'var(--gd-chip-primary-text, #1e3a8a)',
};
const SECONDARY_CHIP: React.CSSProperties = {
  background: 'var(--gd-chip-secondary-bg, #ede9fe)', color: 'var(--gd-chip-secondary-text, #4c1d95)',
};
const CHIP_BASE: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
};

/**
 * An image-first, read-only Exercise card (#1386, redesigned in #1530). It renders
 * the same list row the list view does; edits happen in the page's inline editor,
 * which replaces the card (`⋮ → Edit`), so there is still one editor. The card
 * never expands in place: *View full details* opens the page's Details view. The
 * image is the API's own `effective_image_url` — the fallback to a muscle's image
 * is the server's — with the standard placeholder when missing or broken.
 */
export function ExerciseCard({
  exercise, muscleLabel, menuItems, onViewDetails,
}: {
  exercise: ExerciseCardRow;
  muscleLabel: (key: string) => string;
  menuItems: ContextMenuItem[];
  onViewDetails: () => void;
}) {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  const [broken, setBroken] = React.useState(false);

  const name = exerciseName(exercise);
  const src = exercise.effective_image_url ?? null;
  const showImage = !!src && SAFE_IMAGE_SRC.test(src) && !broken;
  const muscles = exercise.muscles ?? [];
  const chips = [
    ...muscles.filter((m) => m.role === 'principal').map((m) => ({ key: `p-${m.key}`, label: muscleLabel(m.key), style: PRIMARY_CHIP })),
    ...muscles.filter((m) => m.role === 'secondary').map((m) => ({ key: `s-${m.key}`, label: muscleLabel(m.key), style: SECONDARY_CHIP })),
  ];
  const shownChips = chips.slice(0, MAX_MUSCLE_CHIPS);
  const hiddenChips = chips.length - shownChips.length;
  const cacheBust = exercise.modified_at ?? exercise.created_at;
  const description = exercise.display_short_description ?? exercise.display_description ?? exercise.description;

  // Only the values the exercise really has; a missing one is left out, never defaulted.
  const params: string[] = [];
  if (exercise.sets_default != null) params.push(t('card_param_sets', { count: exercise.sets_default }));
  const { min_reps_default: minReps, max_reps_default: maxReps } = exercise;
  if (minReps != null && maxReps != null && minReps !== maxReps) params.push(t('card_param_reps_range', { min: minReps, max: maxReps }));
  else if (minReps != null || maxReps != null) params.push(t('card_param_reps', { count: (minReps ?? maxReps) as number }));
  if (exercise.rest_default_seconds != null) params.push(t('card_param_rest', { count: exercise.rest_default_seconds }));

  return (
    <div style={{ ...cardSurfaceStyle, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ aspectRatio: '4 / 3', background: 'var(--gd-app-bg, #f3f4f6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${src}${src!.includes('?') ? '&' : '?'}v=${encodeURIComponent(cacheBust ?? '')}`}
            alt={name}
            loading="lazy"
            onError={() => setBroken(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{ fontSize: 13, color: 'var(--gd-text-muted, #9ca3af)' }}>{t('card_no_image')}</span>
        )}
      </div>

      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
            <strong style={{ fontSize: 17, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{name}</strong>
            <StatusBadge status={exercise.status} label={tStatus(exercise.status as any)} />
          </div>
          {/* The menu is its own control, top right of the header. */}
          <ContextMenu items={menuItems} />
        </div>

        {description && (
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: '#666', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
            {description}
          </p>
        )}

        {shownChips.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {shownChips.map((c) => <span key={c.key} style={{ ...CHIP_BASE, ...c.style }}>{c.label}</span>)}
            {hiddenChips > 0 && (
              <span style={{ ...CHIP_BASE, background: 'var(--gd-app-bg, #f3f4f6)', color: '#555' }}>{t('card_more_muscles', { count: hiddenChips })}</span>
            )}
          </div>
        )}

        {params.length > 0 && (
          <p aria-label={t('card_params_label')} style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#444' }}>
            {params.join(' · ')}
          </p>
        )}

        <div style={{ marginTop: 'auto', paddingTop: 4 }}>
          <button
            type="button"
            onClick={onViewDetails}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, color: 'var(--gd-link, #6c63ff)', textAlign: 'left' }}
          >
            {t('card_view_details')}
          </button>
        </div>
      </div>
    </div>
  );
}
