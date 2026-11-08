'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { exerciseCategoryLabel } from '@/lib/exerciseCategories';
import { equipmentLabel } from '@/lib/exerciseEquipment';
import {
  buildExerciseInfo, exerciseInfoFields, type ExerciseInfoFieldId, type ExerciseInfoRow,
} from './exerciseInfoView';

/**
 * #2203 — read-only details of an exercise, opened by clicking its image or
 * name in an Assigned Training Plan: large image, then short description,
 * description, affected muscles and categories. Every field is optional.
 */
const ICON_PATHS: Record<ExerciseInfoFieldId, React.ReactNode> = {
  // The Members App's icons (ExerciseInfo.tsx), so both apps read alike.
  short_description: <path d="M4 7h16M4 12h10" />,
  description: <path d="M4 6h16M4 10h16M4 14h16M4 18h10" />,
  muscles: <path d="M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11" />,
  equipment: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />,
  categories: <><path d="M20 12l-8 8-9-9V3h8z" /><circle cx="7.5" cy="7.5" r="1" /></>,
};

/** Monochrome line icon: strokes in `currentColor`, no colour of its own. */
function FieldIcon({ id }: { id: ExerciseInfoFieldId }) {
  return (
    <svg
      data-testid={`exercise-info-icon-${id}`}
      width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" style={{ flex: '0 0 auto', marginTop: 2 }}
    >
      {ICON_PATHS[id]}
    </svg>
  );
}

export function ExerciseInfoModal({ exerciseId, fallbackName, fallbackImageUrl, gender, onClose }: {
  exerciseId: number;
  fallbackName?: string;
  fallbackImageUrl?: string | null;
  /** The thumbnail that was clicked (#2306): the modal shows that gender's full-size image. */
  gender?: 'male' | 'female' | null;
  onClose: () => void;
}) {
  const t = useTranslations('exercise_info');
  const tCat = useTranslations('exercises');
  const tMuscles = useTranslations('muscles');
  const { apiFetch } = useApiClient();
  const [row, setRow] = useState<ExerciseInfoRow | null>(null);
  const [muscleKeys, setMuscleKeys] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [imageBroken, setImageBroken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ExerciseInfoRow>(`/exercises/${exerciseId}`)
      .then((r) => { if (!cancelled) setRow(r); })
      .catch(() => { if (!cancelled) setFailed(true); });
    apiFetch<{ key: string }[]>('/muscles')
      .then((m) => { if (!cancelled) setMuscleKeys(m.map((x) => x.key)); })
      .catch(() => { /* labels fall back to the humanised key */ });
    return () => { cancelled = true; };
  }, [apiFetch, exerciseId]);

  const info = row ? buildExerciseInfo(row, gender) : null;
  const name = info?.name ?? fallbackName ?? '';
  const imageUrl = info ? info.imageUrl : (fallbackImageUrl ?? null);
  const muscleLabel = (key: string) => (muscleKeys.includes(key)
    ? tMuscles(key as any)
    : key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));

  const field = (id: ExerciseInfoFieldId, label: string, body: React.ReactNode) => (
    <div key={id} style={{ display: 'flex', gap: 10, marginTop: 16 }}>
      <FieldIcon id={id} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, opacity: 0.7 }}>{label}</div>
        <div style={{ fontSize: 14, marginTop: 2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{body}</div>
      </div>
    </div>
  );

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label={name || t('title')}
        style={{ ...modalStyle, width: 'min(520px, 94vw)', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 12px' }}>{name || t('title')}</h2>

        {imageUrl && !imageBroken ? (
          <img
            src={imageUrl} alt={name} onError={() => setImageBroken(true)}
            style={{ display: 'block', width: '100%', height: 'auto', maxHeight: '60vh', objectFit: 'contain', borderRadius: 8, background: '#fafafa' }}
          />
        ) : null}

        {failed && <p style={{ fontSize: 14, marginTop: 16 }}>{t('load_error')}</p>}
        {!info && !failed && <p style={{ fontSize: 14, marginTop: 16 }}>{t('loading')}</p>}

        {info && exerciseInfoFields(info).map((id) => {
          if (id === 'short_description') return field(id, t('short_description'), info.shortDescription);
          if (id === 'description') return field(id, t('description'), info.description);
          if (id === 'muscles') {
            const principal = info.muscles.filter((m) => m.role === 'principal').map((m) => muscleLabel(m.key));
            const secondary = info.muscles.filter((m) => m.role === 'secondary').map((m) => muscleLabel(m.key));
            return field(id, t('muscles'), (
              <>
                {principal.length > 0 && <div>{t('principal')}: {principal.join(', ')}</div>}
                {secondary.length > 0 && <div>{t('secondary')}: {secondary.join(', ')}</div>}
              </>
            ));
          }
          if (id === 'equipment') return field(id, t('equipment'), (info.equipment ?? '').split(',').map((e) => e.trim()).filter(Boolean).map((e) => equipmentLabel(e, (k) => tCat(k as any), (v) => v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))).join(', '));
          return field(id, t('categories'), info.categories
            .map((c) => exerciseCategoryLabel(c, (k) => tCat(k as any), (v) => v.replace(/\b\w/g, (ch) => ch.toUpperCase())))
            .join(', '));
        })}

        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" style={btnStyle('#888')} onClick={onClose}>{t('close')}</button>
        </div>
      </div>
    </div>
  );
}
