'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { localeLabel } from '@/lib/localeLabels';
import {
  EXERCISE_EMPTY_VALUE,
  exerciseDisplayValue,
  resultTypeLabel,
  type ExerciseReadOnlyRow,
  type ResultTypeRow,
} from './exerciseForm';
import {
  exerciseFieldGridStyle,
  exerciseFieldLabelStyle,
  exerciseFieldValueStyle,
  exerciseFieldWideStyle,
  exerciseOptionRowStyle,
  exerciseResultTypeGridStyle,
  exerciseSectionLabelStyle,
  exerciseSubSectionStyle,
} from './exerciseFieldChrome';

/**
 * The read-only counterpart of `ExerciseEditor` (#965).
 *
 * Expanding an Exercise card shows **the Edit view with the controls replaced by
 * values**: the same five sections, in the same order, under the same headings,
 * with the same labels on the same grid (§2, §14, §15). The order and the field
 * lists are `exerciseForm.ts`'s, and the chrome is `exerciseFieldChrome.ts`'s, so
 * a field added to the form appears here too and neither half can be restyled
 * without the other.
 *
 *   GENERAL  ·  CONFIGURATION  ·  ALLOWED RESULT TYPES  ·  MUSCLES  ·  MEDIA
 *
 * ### What it deliberately does not hold
 *
 * **Any control.** No `<input>`, `<select>`, `<textarea>`, checkbox, `onChange`,
 * Save, Cancel or Edit affordance: `⋮ → Edit` is the single entry point into the
 * form and is gated like every other write (#797–#800, #806 §12). Allowed Result
 * Types shows the whole catalogue with the allowed ones in the Edit form's
 * selected colour, as plain `<span>`s rather than disabled checkboxes (§6, and
 * #799's rule for the Nutrition Library), so there is nothing to click and no
 * state to change.
 *
 * **Any technical metadata, and the Audit Log link.** Created At, Modified At and
 * internal identifiers are not part of an exercise's configuration and belong in
 * `⋮ → Details`, which is the one place that carries them (§9, §10, §13). The
 * media controls are the same story one step over: this view *shows* the image and
 * the video and the editor is what uploads, replaces and removes them.
 *
 * It renders the **list row** it was handed — never a detail endpoint of its own —
 * which is what keeps it and the form it seeds from reading the same exercise.
 */
export function ExerciseReadOnlyView({
  exercise,
  muscleKeys,
  muscleLabel,
  resultTypes,
  media,
}: {
  exercise: ExerciseReadOnlyRow;
  /** The muscle catalogue, as the context's lookup endpoint returned it. */
  muscleKeys: string[];
  /** A muscle key's label — `useMuscleLabel()`. */
  muscleLabel: (key: string) => string;
  /** The result-type catalogue, as the context's lookup endpoint returned it. */
  resultTypes: ResultTypeRow[];
  /** The MEDIA section's previews — `<ExerciseMediaPreview>`, built by the page. */
  media: React.ReactNode;
}) {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  // #967: the language names live in the root namespace, resolved by `localeLabel`.
  const tRoot = useTranslations();

  const roleOf = new Map((exercise.muscles ?? []).map((m) => [m.key, m.role]));
  // The catalogue plus any legacy key already on the exercise, exactly as the
  // editor's picker does — a muscle dropped from `MUSCLE_KEYS` must still be
  // visible on the exercise that carries it.
  const principal = [...muscleKeys, ...Array.from(roleOf.keys()).filter((k) => !muscleKeys.includes(k))]
    .filter((key) => roleOf.get(key) === 'principal');
  const secondary = [...muscleKeys, ...Array.from(roleOf.keys()).filter((k) => !muscleKeys.includes(k))]
    .filter((key) => roleOf.get(key) === 'secondary');
  const allowedIds = new Set((exercise.allowed_result_types ?? []).map((rt) => rt.id));
  // A result type the catalogue no longer offers but the exercise still allows.
  const offered = resultTypes.length > 0 ? resultTypes : (exercise.allowed_result_types ?? []);

  return (
    <>
      <p style={exerciseSectionLabelStyle}>{t('section_general')}</p>
      <div style={exerciseFieldGridStyle}>
        {/* #967 §6: the read-only half of the editor's NAME, which is one input
            per supported language — so the card lists the base name and every
            translation the exercise actually stores, in the same grid, under the
            same label. It needs no locale list of its own: the row's own
            `translations` map is the languages it has, and `⋮ → Details` stays
            the technical metadata alone (#965 §12). A list row and a workout
            still show one name. */}
        <Field wide label={t('label_name')} value={exercise.name} />
        {Object.entries(exercise.translations ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([loc, value]) => (
            <Field
              key={loc}
              wide
              label={`${t('label_name')} — ${localeLabel(loc, (key) => tRoot(key as any))}`}
              value={exerciseDisplayValue(value)}
            />
          ))}
        <Field wide label={t('label_description')} value={exerciseDisplayValue(exercise.description)} />
        <div>
          <p style={exerciseFieldLabelStyle}>{t('label_status')}</p>
          <div style={{ ...exerciseFieldValueStyle, marginBottom: 8 }}>
            <StatusBadge status={exercise.status} label={tStatus(exercise.status as any)} />
          </div>
        </div>
      </div>

      <div style={exerciseSubSectionStyle}>
        <p style={exerciseSectionLabelStyle}>{t('section_configuration')}</p>
        <div style={exerciseFieldGridStyle}>
          <Field label={t('label_min_reps_default')} value={exerciseDisplayValue(exercise.min_reps_default)} />
          <Field label={t('label_max_reps_default')} value={exerciseDisplayValue(exercise.max_reps_default)} />
          <Field label={t('label_sets_default')} value={exerciseDisplayValue(exercise.sets_default)} />
          <Field label={t('label_rest_default_seconds')} value={exerciseDisplayValue(exercise.rest_default_seconds)} />
          <Field wide label={t('label_notes_default')} value={exerciseDisplayValue(exercise.notes_default)} />
        </div>
      </div>

      <div style={exerciseSubSectionStyle}>
        <p style={exerciseSectionLabelStyle}>{t('label_result_types')}</p>
        {offered.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: '#888' }}>{EXERCISE_EMPTY_VALUE}</p>
        ) : (
          <div style={exerciseResultTypeGridStyle}>
            {offered.map((rt) => {
              const allowed = allowedIds.has(rt.id);
              return (
                <span key={rt.id} style={exerciseOptionRowStyle}>
                  <span aria-hidden="true" style={markStyle(allowed)}>{allowed ? '✓' : ''}</span>
                  <span style={allowed ? { color: '#222', fontWeight: 600 } : { color: '#9ca3af' }}>
                    {resultTypeLabel(rt, (key) => t(key as any))}
                  </span>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div style={exerciseSubSectionStyle}>
        <p style={exerciseSectionLabelStyle}>{t('section_muscles')}</p>
        <div style={exerciseFieldGridStyle}>
          <Field
            label={t('role_principal')}
            value={principal.length > 0 ? principal.map(muscleLabel).join(', ') : EXERCISE_EMPTY_VALUE}
          />
          <Field
            label={t('role_secondary')}
            value={secondary.length > 0 ? secondary.map(muscleLabel).join(', ') : EXERCISE_EMPTY_VALUE}
          />
        </div>
      </div>

      {/* #805 §9: MEDIA is the last section in the editor, so it is the last one
          here — the two views cannot answer "what comes last" differently. */}
      <div style={exerciseSubSectionStyle}>
        <p style={exerciseSectionLabelStyle}>{t('section_media')}</p>
        {media}
      </div>
    </>
  );
}

/** One `LABEL` over its value, in the box the editor's input occupies (#929). */
function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div style={wide ? exerciseFieldWideStyle : undefined}>
      <p style={exerciseFieldLabelStyle}>{label}</p>
      <p style={exerciseFieldValueStyle}>{value}</p>
    </div>
  );
}

/**
 * The tick beside an allowed result type. It reads as the editor's checked
 * checkbox without being one — a disabled `<input type="checkbox">` is what §3
 * asks not to render, and a glyph carries no state a browser could change.
 */
function markStyle(allowed: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 15,
    height: 15,
    flexShrink: 0,
    borderRadius: 3,
    fontSize: 11,
    lineHeight: 1,
    border: allowed ? '1px solid var(--gd-link, #6c63ff)' : '1px solid #d1d5db',
    background: allowed ? 'var(--gd-link, #6c63ff)' : 'transparent',
    color: '#fff',
  };
}
