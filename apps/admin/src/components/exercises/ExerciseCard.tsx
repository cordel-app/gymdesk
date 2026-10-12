'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { listNameBadgeStyle } from '@/components/listChrome';
import { cardSurfaceStyle } from '@/components/ui';
import { exerciseName } from '@/lib/exerciseNames';
import { exerciseFacetValueLabel } from '@/lib/exerciseFilters';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { EXERCISE_EMPTY_VALUE, exerciseDisplayValue, type ExerciseReadOnlyRow } from './exerciseForm';
import {
  exerciseFieldLabelStyle,
  exerciseFieldValueStyle,
  exerciseSectionLabelStyle,
} from './exerciseFieldChrome';

/** An exercise as the card needs it: the list row, plus the optional equipment facet. */
export type ExerciseCardRow = ExerciseReadOnlyRow & { equipment?: string | null };

/**
 * The responsive card grid (#1386): one column on a phone, more as the width
 * allows. Layout only — it filters and sorts nothing.
 */
export function ExerciseCardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
      {children}
    </div>
  );
}

/**
 * An image-first, read-only Exercise card (#1386). It renders the same list row
 * the list view does; edits happen in the page's inline editor, which replaces the
 * card (`⋮ → Edit`), so there is still one editor. The image is the API's own
 * `effective_image_url` — the fallback to a muscle's image is the server's — with
 * the standard placeholder when it is missing or fails to load.
 */
export function ExerciseCard({
  exercise, muscleLabel, menuItems, expanded, onToggle,
}: {
  exercise: ExerciseCardRow;
  muscleLabel: (key: string) => string;
  menuItems: ContextMenuItem[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  const [broken, setBroken] = React.useState(false);

  const name = exerciseName(exercise);
  const src = exercise.effective_image_url ?? exercise.image_url ?? null;
  const showImage = !!src && SAFE_IMAGE_SRC.test(src) && !broken;
  const muscles = exercise.muscles ?? [];
  const primary = muscles.filter((m) => m.role === 'principal').map((m) => m.key);
  const secondary = muscles.filter((m) => m.role === 'secondary').map((m) => m.key);
  const cacheBust = exercise.modified_at ?? exercise.created_at;

  return (
    <div style={{ ...cardSurfaceStyle, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ aspectRatio: '1 / 1', background: 'var(--gd-app-bg, #f3f4f6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <strong style={{ fontSize: 15, minWidth: 0, overflowWrap: 'anywhere' }}>{name}</strong>
          <StatusBadge status={exercise.status} label={tStatus(exercise.status as any)} />
        </div>

        {(primary.length > 0 || exercise.equipment) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {primary.map((k) => <span key={k} style={listNameBadgeStyle}>{muscleLabel(k)}</span>)}
            {exercise.equipment && <span style={listNameBadgeStyle}>{exerciseFacetValueLabel(exercise.equipment)}</span>}
          </div>
        )}

        {!expanded && (exercise.display_short_description ?? exercise.display_description ?? exercise.description) && (
          <p style={{ margin: 0, fontSize: 13, color: '#666', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
            {exercise.display_short_description ?? exercise.display_description ?? exercise.description}
          </p>
        )}

        {expanded && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <p style={exerciseSectionLabelStyle}>{t('card_full_description')}</p>
              <p style={exerciseFieldValueStyle}>{exerciseDisplayValue(exercise.display_description ?? exercise.description)}</p>
            </div>
            <div>
              <p style={exerciseSectionLabelStyle}>{t('card_muscles_worked')}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {primary.map((k) => (
                  <span key={k} style={{ ...listNameBadgeStyle, fontWeight: 700 }}>{muscleLabel(k)}</span>
                ))}
                {secondary.map((k) => <span key={k} style={listNameBadgeStyle}>{muscleLabel(k)}</span>)}
                {primary.length + secondary.length === 0 && <span style={exerciseFieldValueStyle}>{EXERCISE_EMPTY_VALUE}</span>}
              </div>
            </div>
            <div>
              <p style={exerciseSectionLabelStyle}>{t('card_default_values')}</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                <DefaultValue label={t('label_sets_default')} value={exercise.sets_default} />
                <DefaultValue label={t('label_rest_default_seconds')} value={exercise.rest_default_seconds} />
                <DefaultValue label={t('label_min_reps_default')} value={exercise.min_reps_default} />
                <DefaultValue label={t('label_max_reps_default')} value={exercise.max_reps_default} />
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingTop: 4 }}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, color: 'var(--gd-link, #6c63ff)', textAlign: 'left' }}
          >
            {expanded ? t('card_hide_details') : t('card_view_details')}
          </button>
          {/* The menu is its own control: opening it must not expand the card. */}
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DefaultValue({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div>
      <p style={exerciseFieldLabelStyle}>{label}</p>
      <p style={exerciseFieldValueStyle}>{exerciseDisplayValue(value)}</p>
    </div>
  );
}
